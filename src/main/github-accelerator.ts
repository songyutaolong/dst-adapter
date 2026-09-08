import { execFile, spawn } from 'child_process'
import fs from 'fs'
import net from 'net'
import os from 'os'
import path from 'path'
import { promisify } from 'util'
import type { GithubAccelerationResult } from '../shared/types'
import { backupFile, getSettings, updateSettings } from './store'

const BEGIN_MARKER = '# >>> dst-adapter github-acceleration >>>'
const END_MARKER = '# <<< dst-adapter github-acceleration <<<'

const GITHUB_HOSTS = [
  'github.com',
  'api.github.com',
  'codeload.github.com',
  'raw.githubusercontent.com',
  'gist.githubusercontent.com',
  'objects.githubusercontent.com',
  'cloud.githubusercontent.com',
  'avatars.githubusercontent.com'
]

const DOH_ENDPOINTS = [
  'https://dns.alidns.com/resolve',
  'https://doh.pub/dns-query'
]

const execFileAsync = promisify(execFile)

interface GithubDohAnswer {
  type?: number
  data?: string | number
}

interface GithubDohResponse {
  Status?: number
  Answer?: GithubDohAnswer[]
}

interface HostsEntry {
  hostname: string
  ip: string
}

function hostsPath(): string {
  if (process.platform === 'win32') {
    return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts')
  }
  return '/etc/hosts'
}

function normalizeHost(content: string): string {
  const begin = content.indexOf(BEGIN_MARKER)
  const end = content.indexOf(END_MARKER)
  if (begin < 0 && end < 0) return content
  if (begin < 0 || end < 0 || end < begin) {
    throw new Error('hosts 中存在不完整的 GitHub 加速配置块，请先手工检查该文件')
  }

  const before = content.slice(0, begin).replace(/\s+$/, '')
  const after = content.slice(end + END_MARKER.length).replace(/^\s+/, '')
  return [before, after].filter(Boolean).join('\n')
}

function managedEntryCount(content: string | null): number {
  if (!content) return 0
  return content
    .split(/\r?\n/)
    .filter((line) => /^\s*\d{1,3}(?:\.\d{1,3}){3}\s+\S+/.test(line)).length
}

export function getGithubAccelerationStatus(): GithubAccelerationResult {
  const filePath = hostsPath()
  let managed: string | null = null
  try {
    if (fs.existsSync(filePath)) {
      const block = fs.readFileSync(filePath, 'utf-8')
      const begin = block.indexOf(BEGIN_MARKER)
      const end = block.indexOf(END_MARKER)
      if (begin >= 0 && end >= begin) {
        managed = block.slice(begin, end + END_MARKER.length)
      }
    }
  } catch {
    managed = null
  }

  return {
    ok: true,
    enabled: getSettings().githubAccelerationEnabled,
    managed: Boolean(managed),
    entryCount: managedEntryCount(managed),
    hostsPath: filePath,
    message: managed ? `已管理 ${managedEntryCount(managed)} 条 GitHub hosts 记录` : '未写入 GitHub hosts 配置'
  }
}

function buildHostsContent(entries: HostsEntry[]): string {
  return [
    BEGIN_MARKER,
    `# Updated by dst-adapter at ${new Date().toISOString()}`,
    ...entries.map((entry) => `${entry.ip}\t${entry.hostname}`),
    END_MARKER
  ].join('\n')
}

async function fetchDoh(endpoint: string, hostname: string): Promise<string> {
  const url = `${endpoint}?name=${encodeURIComponent(hostname)}&type=A`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5000)
  try {
    const res = await fetch(url, {
      headers: { accept: 'application/dns-json' },
      signal: controller.signal
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const body = (await res.json()) as GithubDohResponse
    if (body.Status !== 0) throw new Error(`DNS status ${body.Status}`)
    const ip = (body.Answer || [])
      .filter((answer) => answer.type === 1)
      .map((answer) => String(answer.data || '').trim())
      .find((value) => net.isIP(value) === 4)
    if (!ip) throw new Error('响应中没有可用的 A 记录')
    return ip
  } finally {
    clearTimeout(timer)
  }
}

async function resolveHostIp(hostname: string): Promise<HostsEntry> {
  let lastError = '未知错误'
  for (const endpoint of DOH_ENDPOINTS) {
    try {
      return { hostname, ip: await fetchDoh(endpoint, hostname) }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
    }
  }
  throw new Error(`${hostname} 解析失败（${lastError}）`)
}

async function resolveGithubIps(): Promise<HostsEntry[]> {
  const settled = await Promise.allSettled(GITHUB_HOSTS.map(resolveHostIp))
  const failures = settled
    .filter((item): item is PromiseRejectedResult => item.status === 'rejected')
    .map((item) => item.reason instanceof Error ? item.reason.message : String(item.reason))

  if (failures.length > 0) {
    throw new Error(`GitHub IP 获取失败：${failures[0]}`)
  }
  return settled.map((item) => {
    if (item.status === 'rejected') {
      throw item.reason
    }
    return item.value
  })
}

function ensureHostsFile(filePath: string): void {
  if (!fs.existsSync(filePath)) {
    throw new Error(`hosts 文件不存在：${filePath}`)
  }
}

function isAccessDenied(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code
  return code === 'EPERM' || code === 'EACCES'
}

function writeHostsDirect(filePath: string, content: string): void {
  const tempPath = `${filePath}.dst-adapter-${process.pid}-${Date.now()}.tmp`
  try {
    fs.writeFileSync(tempPath, content, 'utf-8')
    fs.renameSync(tempPath, filePath)
  } catch (err) {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath)
    } catch {
      // The original write failure is more actionable than cleanup failure.
    }
    throw err
  }
}

function escapePowerShellSingleQuoted(value: string): string {
  return value.replace(/'/g, "''")
}

async function writeHostsWithElevation(filePath: string, content: string): Promise<void> {
  const stamp = Date.now()
  const contentPath = path.join(os.tmpdir(), `dst-adapter-hosts-${process.pid}-${stamp}.hosts`)
  const helperPath = path.join(os.tmpdir(), `dst-adapter-hosts-${process.pid}-${stamp}.ps1`)
  const helper = [
    'param([string]$HostsPath, [string]$ContentPath)',
    '$ErrorActionPreference = "Stop"',
    '$content = [System.IO.File]::ReadAllText($ContentPath)',
    `$backup = "$HostsPath.dst-adapter-${stamp}.bak"`,
    'Copy-Item -LiteralPath $HostsPath -Destination $backup -Force',
    '[System.IO.File]::WriteAllText($HostsPath, $content, [System.Text.Encoding]::ASCII)'
  ].join('\r\n')

  const bootstrap = [
    '$powerShell = Join-Path $env:SystemRoot \'System32\\WindowsPowerShell\\v1.0\\powershell.exe\'',
    `$helperPath = '${escapePowerShellSingleQuoted(helperPath)}'`,
    `$targetPath = '${escapePowerShellSingleQuoted(filePath)}'`,
    `$sourcePath = '${escapePowerShellSingleQuoted(contentPath)}'`,
    `$argumentList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $helperPath, '-HostsPath', $targetPath, '-ContentPath', $sourcePath)`,
    '$process = Start-Process -FilePath $powerShell -ArgumentList $argumentList -Verb RunAs -Wait -PassThru',
    'exit $process.ExitCode'
  ].join('\r\n')

  try {
    fs.writeFileSync(contentPath, content, 'utf-8')
    fs.writeFileSync(helperPath, helper, 'utf-8')
    const encoded = Buffer.from(bootstrap, 'utf16le').toString('base64')
    await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { windowsHide: true, timeout: 120_000 }
    )
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    if (/canceled|cancelled|denied|1223/i.test(detail)) {
      throw new Error('已在管理员授权弹窗中取消，hosts 未修改')
    }
    throw new Error(`Windows 管理员写入 hosts 失败：${detail}`)
  } finally {
    for (const tempPath of [contentPath, helperPath]) {
      try {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath)
      } catch {
        // Temporary files in the user's own temp directory are harmless if locked.
      }
    }
  }
}

async function writeHosts(filePath: string, content: string): Promise<'direct' | 'elevated'> {
  try {
    writeHostsDirect(filePath, content)
    return 'direct'
  } catch (err) {
    if (process.platform !== 'win32' || !isAccessDenied(err)) throw err
    await writeHostsWithElevation(filePath, content)
    return 'elevated'
  }
}

function flushDnsCache(): void {
  try {
    if (process.platform === 'win32') {
      spawn('ipconfig', ['/flushdns'], { stdio: 'ignore' }).unref()
    } else if (process.platform === 'darwin') {
      spawn('dscacheutil', ['-flushcache'], { stdio: 'ignore' }).unref()
    }
  } catch {
    // 新记录会随系统 DNS 缓存过期生效，刷新失败不影响本次写入。
  }
}

export async function setGithubAcceleration(enabled: boolean): Promise<GithubAccelerationResult> {
  const filePath = hostsPath()
  try {
    ensureHostsFile(filePath)

    let content: string
    let backupPath: string | undefined
    let entryCount = 0
    let writeMode: 'direct' | 'elevated' = 'direct'

    if (enabled) {
      const entries = await resolveGithubIps()
      ensureHostsFile(filePath)
      content = normalizeHost(fs.readFileSync(filePath, 'utf-8'))
      content = `${content ? `${content}\n\n` : ''}${buildHostsContent(entries)}\n`
      entryCount = entries.length
      backupPath = backupFile('hosts', filePath)
      writeMode = await writeHosts(filePath, content)
    } else {
      content = normalizeHost(fs.readFileSync(filePath, 'utf-8'))
      const hasManagedBlock = getGithubAccelerationStatus().managed
      if (hasManagedBlock) {
        backupPath = backupFile('hosts', filePath)
        content = `${content}\n`
        writeMode = await writeHosts(filePath, content)
      }
    }

    updateSettings({ githubAccelerationEnabled: enabled })
    flushDnsCache()

    return {
      ok: true,
      enabled,
      managed: enabled,
      entryCount,
      hostsPath: filePath,
      backupPath,
      message: enabled
        ? `已启用 GitHub 加速，写入 ${entryCount} 条 hosts 记录${
            writeMode === 'elevated' ? '（管理员授权）' : ''
          }`
        : '已关闭 GitHub 加速，hosts 配置已恢复'
    }
  } catch (err) {
    return {
      ...getGithubAccelerationStatus(),
      ok: false,
      message: err instanceof Error ? err.message : String(err)
    }
  }
}
