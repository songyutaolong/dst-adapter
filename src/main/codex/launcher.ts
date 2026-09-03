import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFile, execFileSync, spawn } from 'child_process'
import { promisify } from 'util'
import type { Provider } from '../../shared/types'
import { injectCodexTarget } from './cdp'

const DEBUG_PORT = 9229
const execFileAsync = promisify(execFile)

export function codexExecutableCandidates(): string[] {
  const home = os.homedir()
  const local = process.env.LOCALAPPDATA || ''
  const programs = process.env.ProgramFiles || 'C:\\Program Files'
  const candidates = process.platform === 'darwin'
    ? [
        '/Applications/Codex.app/Contents/MacOS/Codex',
        '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT'
      ]
    : [
        path.join(local, 'Programs', 'Codex', 'Codex.exe'),
        path.join(local, 'Programs', 'OpenAI Codex', 'Codex.exe'),
        path.join(local, 'Programs', 'OpenAI', 'Codex', 'Codex.exe'),
        path.join(local, 'Programs', 'ChatGPT', 'ChatGPT.exe'),
        path.join(programs, 'Codex', 'Codex.exe'),
        path.join(programs, 'ChatGPT', 'ChatGPT.exe'),
        path.join(home, 'AppData', 'Local', 'Programs', 'Codex', 'Codex.exe')
      ]
  return [...new Set(candidates)]
}

type StorePackageInfo = {
  fullName: string
  familyName: string
  installLocation: string
  executable: string
}

function storePackageInfo(): StorePackageInfo | null {
  if (process.platform !== 'win32') return null
  try {
    const output = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "$p=Get-AppxPackage OpenAI.Codex | Sort-Object Version -Descending | Select-Object -First 1; if($p){Write-Output ($p.PackageFullName+'|'+$p.PackageFamilyName+'|'+$p.InstallLocation)}"
      ],
      { encoding: 'utf-8', windowsHide: true }
    ).trim()
    const [fullName, familyName, installLocation] = output.split('|')
    if (!fullName || !familyName || !installLocation) return null

    const candidates = [
      path.join(installLocation, 'app', 'ChatGPT.exe'),
      path.join(installLocation, 'app', 'Codex.exe')
    ]
    const executable =
      candidates.find((candidate) => {
        try {
          return fs.existsSync(candidate)
        } catch {
          return false
        }
      }) || candidates[0]

    return { fullName, familyName, installLocation, executable }
  } catch {
    return null
  }
}

function setUserOpenAiKey(apiKey: string): void {
  if (process.platform !== 'win32') return
  try {
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `[Environment]::SetEnvironmentVariable('OPENAI_API_KEY', '${apiKey.replace(/'/g, "''")}', 'User')`
      ],
      { windowsHide: true }
    )
  } catch {
    // Best-effort for Store launches that still probe the user environment.
  }
}

async function quitCodexProcesses(): Promise<void> {
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      const child = spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          "Get-Process ChatGPT,Codex -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue"
        ],
        { windowsHide: true, stdio: 'ignore' }
      )
      child.once('exit', () => resolve())
      child.once('error', () => resolve())
    })
  } else if (process.platform === 'darwin') {
    await new Promise<void>((resolve) => {
      const child = spawn('pkill', ['-f', 'Codex|ChatGPT'], {
        stdio: 'ignore'
      })
      child.once('exit', () => resolve())
      child.once('error', () => resolve())
    })
  }
  await new Promise((resolve) => setTimeout(resolve, 800))
}

async function activateStoreCodex(
  aumid: string,
  args: string[]
): Promise<void> {
  const source = `
using System;
using System.Runtime.InteropServices;

[ComImport, Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")]
class ApplicationActivationManager {}

[ComImport, Guid("2e941141-7f97-4756-ba1d-9decde894a3d"),
 InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IApplicationActivationManager {
  [PreserveSig]
  int ActivateApplication(
    [MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
    [MarshalAs(UnmanagedType.LPWStr)] string arguments,
    uint options,
    out uint processId);
  [PreserveSig] int ActivateForFile(IntPtr a, IntPtr b, IntPtr c, out uint d);
  [PreserveSig] int ActivateForProtocol(IntPtr a, IntPtr b, IntPtr c, out uint d);
}

public static class DasuantouAppActivator {
  public static uint Launch(string appId, string arguments) {
    var manager = (IApplicationActivationManager)new ApplicationActivationManager();
    uint processId;
    int hr = manager.ActivateApplication(appId, arguments, 0, out processId);
    if (hr != 0) {
      Marshal.ThrowExceptionForHR(hr);
    }
    return processId;
  }
}`
  const escapedSource = source.replace(/'/g, "''")
  const appId = aumid.replace(/'/g, "''")
  const activationArgs = args.join(' ').replace(/'/g, "''")
  const command = [
    `Add-Type -TypeDefinition '${escapedSource}'`,
    `[void][DasuantouAppActivator]::Launch('${appId}','${activationArgs}')`
  ].join(';')
  const encoded = Buffer.from(command, 'utf16le').toString('base64')
  await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
    { windowsHide: true }
  )
}

export function findCodexExecutable(): string | undefined {
  const unpackaged = codexExecutableCandidates().find((candidate) =>
    fs.existsSync(candidate)
  )
  if (unpackaged) return unpackaged
  return storePackageInfo()?.executable
}

export function isCodexInstalled(): boolean {
  return Boolean(
    codexExecutableCandidates().some((candidate) => fs.existsSync(candidate)) ||
      storePackageInfo()
  )
}

async function waitForTargets(timeoutMs = 20000): Promise<any[]> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`)
      if (response.ok) {
        const targets = (await response.json()) as any[]
        const pages = targets.filter(
          (target) => target.type === 'page' && target.webSocketDebuggerUrl
        )
        if (pages.length) return pages
      }
    } catch {
      // Codex is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return []
}

async function spawnDetached(
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, {
      detached: true,
      stdio: 'ignore',
      env
    })
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
    child.once('error', reject)
  })
}

export async function launchCodex(
  provider: Provider,
  enhancements: boolean
): Promise<{ injected: boolean; executable: string }> {
  const store = storePackageInfo()
  const unpackaged = codexExecutableCandidates().find((candidate) =>
    fs.existsSync(candidate)
  )
  const executable = unpackaged || store?.executable
  if (!executable) throw new Error('未找到 Codex，请先点击“下载”安装')

  const apiKey = provider.apiKey.trim()
  setUserOpenAiKey(apiKey)

  const args = enhancements
    ? [
        `--remote-debugging-port=${DEBUG_PORT}`,
        `--remote-allow-origins=http://127.0.0.1:${DEBUG_PORT}`,
        '--remote-allow-origins=*'
      ]
    : []
  const env = {
    ...process.env,
    OPENAI_API_KEY: apiKey,
    CODEX_API_KEY: apiKey
  }

  // Existing instances ignore new Chromium flags and keep the old env.
  await quitCodexProcesses()

  let launched = false
  let launchedPath = executable

  if (store && !unpackaged) {
    const aumids = [`${store.familyName}!App`, `${store.fullName}!App`]
    for (const aumid of aumids) {
      try {
        await activateStoreCodex(aumid, args)
        launched = true
        launchedPath = store.installLocation
        break
      } catch {
        // Try the next AUMID format.
      }
    }
  }

  if (!launched) {
    try {
      await spawnDetached(executable, args, env)
      launched = true
      launchedPath = executable
    } catch (error) {
      if (!store) throw error
      await spawnDetached(
        'explorer.exe',
        [`shell:AppsFolder\\${store.familyName}!App`],
        env
      )
      launched = true
      launchedPath = store.installLocation
      if (enhancements) {
        return { injected: false, executable: launchedPath }
      }
    }
  }

  if (!enhancements) return { injected: false, executable: launchedPath }

  const targets = await waitForTargets()
  if (!targets.length) {
    return { injected: false, executable: launchedPath }
  }

  // Give the first paint a moment, then inject twice so late React trees are covered.
  await new Promise((resolve) => setTimeout(resolve, 1200))
  try {
    const pages = await waitForTargets(5000)
    const list = pages.length ? pages : targets
    await Promise.all(
      list.map((target) => injectCodexTarget(target.webSocketDebuggerUrl))
    )
    await new Promise((resolve) => setTimeout(resolve, 1500))
    const again = await waitForTargets(3000)
    if (again.length) {
      await Promise.all(
        again.map((target) => injectCodexTarget(target.webSocketDebuggerUrl))
      )
    }
    return { injected: true, executable: launchedPath }
  } catch {
    return { injected: false, executable: launchedPath }
  }
}
