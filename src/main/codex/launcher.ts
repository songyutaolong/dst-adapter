import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFile, execFileSync, spawn } from 'child_process'
import { promisify } from 'util'
import type { Provider } from '../../shared/types'

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

let storePackageCache: StorePackageInfo | null | undefined
let storePackageCacheAt = 0
const STORE_PACKAGE_CACHE_MS = 30_000

function storePackageInfo(): StorePackageInfo | null {
  if (process.platform !== 'win32') return null
  if (
    storePackageCache !== undefined &&
    Date.now() - storePackageCacheAt < STORE_PACKAGE_CACHE_MS
  ) {
    return storePackageCache
  }

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
    if (!fullName || !familyName || !installLocation) {
      storePackageCache = null
      storePackageCacheAt = Date.now()
      return null
    }

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

    storePackageCache = { fullName, familyName, installLocation, executable }
    storePackageCacheAt = Date.now()
    return storePackageCache
  } catch {
    storePackageCache = null
    storePackageCacheAt = Date.now()
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
  aumid: string
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
  const command = [
    `Add-Type -TypeDefinition '${escapedSource}'`,
    `[void][DasuantouAppActivator]::Launch('${appId}','')`
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
  provider: Provider
): Promise<{ executable: string }> {
  const store = storePackageInfo()
  const unpackaged = codexExecutableCandidates().find((candidate) =>
    fs.existsSync(candidate)
  )
  const executable = unpackaged || store?.executable
  if (!executable) throw new Error('未找到 Codex，请先点击“下载”安装')

  const apiKey = provider.apiKey.trim()
  setUserOpenAiKey(apiKey)

  const env = {
    ...process.env,
    OPENAI_API_KEY: apiKey,
    CODEX_API_KEY: apiKey
  }

  // Existing instances keep the old env; restart to load the new API config.
  await quitCodexProcesses()

  let launched = false
  let launchedPath = executable

  if (store && !unpackaged) {
    const aumids = [`${store.familyName}!App`, `${store.fullName}!App`]
    for (const aumid of aumids) {
      try {
        await activateStoreCodex(aumid)
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
      await spawnDetached(executable, [], env)
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
    }
  }

  return { executable: launchedPath }
}
