import fs from 'fs'
import path from 'path'
import os from 'os'
import { shell } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'
import type {
  ApplyResult,
  DetectResult,
  Provider,
  RemoteSkillPackage,
  SkillCatalogResult
} from '../../shared/types'
import { providerToWorkBuddyModel } from '../../shared/url'
import { atomicWriteText, backupFile } from '../store'
import { installSkillPackage } from '../skills/installer'
import { downloadSkillPackage, fetchSkillCatalog } from '../skills/catalog'
import { compareVersions } from '../skills/version'
import type {
  AppAdapter,
  McpServerEntry
} from './types'

type WorkBuddyModel = ReturnType<typeof providerToWorkBuddyModel>
const execFileAsync = promisify(execFile)

function homeWorkbuddyDir(): string {
  return path.join(os.homedir(), '.workbuddy')
}

function modelsPath(): string {
  return path.join(homeWorkbuddyDir(), 'models.json')
}

function mcpPath(): string {
  return path.join(homeWorkbuddyDir(), 'mcp.json')
}

function settingsPath(): string {
  return path.join(homeWorkbuddyDir(), 'settings.json')
}

function skillsPath(): string {
  return path.join(homeWorkbuddyDir(), 'skills')
}

function workBuddyAppVersion(): string | undefined {
  for (const dir of findInstallDirs()) {
    const file = path.join(dir, 'resources', 'install-manifest.json')
    if (!fs.existsSync(file)) continue
    try {
      const manifest = JSON.parse(fs.readFileSync(file, 'utf-8')) as { appVersion?: unknown }
      const version = typeof manifest.appVersion === 'string' ? manifest.appVersion.trim() : ''
      if (version) return version
    } catch {
      // 安装清单异常不阻塞 Skill 安装
    }
  }
  return undefined
}

async function isWorkBuddyRunning(): Promise<boolean> {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync(
        'tasklist',
        ['/FI', 'IMAGENAME eq WorkBuddy.exe', '/FO', 'CSV', '/NH'],
        { windowsHide: true }
      )
      return stdout.includes('WorkBuddy.exe')
    }
    if (process.platform === 'darwin') {
      await execFileAsync('pgrep', ['-x', 'WorkBuddy'], { windowsHide: true })
      return true
    }
  } catch {
    return false
  }
  return false
}

function findInstallDirs(): string[] {
  const dirs: string[] = []
  const local = process.env.LOCALAPPDATA
  if (local) {
    dirs.push(path.join(local, 'Programs', 'WorkBuddy'))
    dirs.push(path.join(local, 'WorkBuddy'))
  }
  if (process.platform === 'darwin') {
    dirs.push('/Applications/WorkBuddy.app')
  }
  return dirs
}

function parseModels(raw: string): WorkBuddyModel[] {
  const data = JSON.parse(raw)
  if (Array.isArray(data)) return data
  if (data && Array.isArray(data.models)) return data.models
  return []
}

function serializeModels(models: WorkBuddyModel[]): string {
  // WorkBuddy on this machine uses a bare array
  return `${JSON.stringify(models, null, 2)}\n`
}

async function detect(): Promise<DetectResult> {
  const configDir = homeWorkbuddyDir()
  const configExists = fs.existsSync(configDir)
  const installHit = findInstallDirs().some((d) => fs.existsSync(d))
  const installed = configExists || installHit
  return {
    installed,
    configPath: modelsPath(),
    detail: installed
      ? configExists
        ? '已检测到 WorkBuddy 配置目录'
        : '已检测到 WorkBuddy 安装目录'
      : '未检测到 WorkBuddy'
  }
}

async function readLive(): Promise<unknown> {
  const file = modelsPath()
  if (!fs.existsSync(file)) return []
  return parseModels(fs.readFileSync(file, 'utf-8'))
}

async function writeLive(provider: Provider): Promise<ApplyResult> {
  const file = modelsPath()
  const dir = homeWorkbuddyDir()
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  const backupPath = backupFile('workbuddy', file)
  let models: WorkBuddyModel[] = []
  if (fs.existsSync(file)) {
    try {
      models = parseModels(fs.readFileSync(file, 'utf-8'))
    } catch {
      models = []
    }
  }

  const next = providerToWorkBuddyModel(provider)
  const idx = models.findIndex((m) => m.id === next.id)
  if (idx >= 0) {
    models[idx] = { ...models[idx], ...next }
  } else {
    models.push(next)
  }

  atomicWriteText(file, serializeModels(models))
  return {
    ok: true,
    message: `已写入 WorkBuddy models.json（模型 ${next.id}）`,
    backupPath
  }
}

async function writeMcp(
  merge: Record<string, McpServerEntry>,
  removeKeys: string[] = []
): Promise<ApplyResult> {
  const file = mcpPath()
  const dir = homeWorkbuddyDir()
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  const backupPath = backupFile('workbuddy', file)
  let servers: Record<string, McpServerEntry> = {}
  if (fs.existsSync(file)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as {
        mcpServers?: Record<string, McpServerEntry>
      }
      if (parsed && parsed.mcpServers && typeof parsed.mcpServers === 'object') {
        servers = { ...parsed.mcpServers }
      }
    } catch {
      servers = {}
    }
  }

  servers = { ...servers, ...merge }
  for (const key of removeKeys) {
    delete servers[key]
  }

  atomicWriteText(file, `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`)
  const merged = Object.keys(merge)
  const removed = removeKeys.filter((k) => !merged.includes(k))
  return {
    ok: true,
    message:
      removed.length > 0
        ? `已从 WorkBuddy mcp.json 移除 ${removed.join(', ')}`
        : `已合并 MCP 配置到 WorkBuddy mcp.json（${merged.join(', ') || '无'}）`,
    backupPath
  }
}

async function launch(): Promise<void> {
  if (process.platform === 'darwin') {
    await shell.openPath('/Applications/WorkBuddy.app')
    return
  }
  const candidates = [
    ...findInstallDirs().map((d) => path.join(d, 'WorkBuddy.exe')),
    ...findInstallDirs().flatMap((d) => {
      try {
        return fs
          .readdirSync(d)
          .filter((n) => n.toLowerCase().endsWith('.exe'))
          .map((n) => path.join(d, n))
      } catch {
        return [] as string[]
      }
    })
  ]
  for (const exe of candidates) {
    if (fs.existsSync(exe)) {
      await shell.openPath(exe)
      return
    }
  }
  throw new Error('未找到 WorkBuddy 可执行文件')
}

async function listSkills(force = false) {
  const catalog = await fetchSkillCatalog(force)
  const installedSkills = readInstalledSkills()
  const overrides = readSkillOverrides()
  const skills = catalog.skills.map((skill: RemoteSkillPackage) => {
    const local = installedSkills.get(skill.id)
    if (!local) return skill
    return {
      ...skill,
      installed: true,
      enabled: overrides[local.name] !== 'off',
      localVersion: local.version,
      updateAvailable: skill.version !== 'unknown' &&
        compareVersions(skill.version, local.version || '0') > 0
    }
  })
  const result: SkillCatalogResult = { ...catalog, skills }
  return result
}

interface InstalledSkill {
  id: string
  name: string
  version?: string
  dirName: string
  description?: string
}

function parseSkillFrontmatter(raw: string): {
  name?: string
  description?: string
  version?: string
} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw)
  if (!match) return {}
  const pick = (field: string) => {
    const pattern = new RegExp(`^${field}:\\s*(?:"([^"]*)"|'([^']*)'|(.+))\\s*$`, 'mi')
    const value = pattern.exec(match[1])
    return (value?.[1] || value?.[2] || value?.[3] || '').trim()
  }
  return {
    name: pick('name') || undefined,
    description: pick('description') || undefined,
    version: pick('version') || undefined
  }
}

function readInstalledSkills(): Map<string, InstalledSkill> {
  const root = skillsPath()
  const result = new Map<string, InstalledSkill>()
  if (!fs.existsSync(root)) return result

  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'dist') continue
    const skillFile = path.join(root, entry.name, 'SKILL.md')
    if (!fs.existsSync(skillFile)) continue
    try {
      const meta = parseSkillFrontmatter(fs.readFileSync(skillFile, 'utf-8'))
      const id = (meta.name || entry.name).toLowerCase()
      result.set(id, {
        id,
        name: meta.name || entry.name,
        version: meta.version,
        dirName: entry.name,
        description: meta.description
      })
    } catch {
      // 无法读取的本地 Skill 不阻塞远端目录展示
    }
  }
  return result
}

function readSkillOverrides(): Record<string, string> {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath(), 'utf-8')) as {
      skillOverrides?: Record<string, string>
    }
    return parsed.skillOverrides && typeof parsed.skillOverrides === 'object'
      ? { ...parsed.skillOverrides }
      : {}
  } catch {
    return {}
  }
}

async function setSkillEnabled(id: string, enabled: boolean): Promise<ApplyResult> {
  const local = readInstalledSkills().get(id.trim().toLowerCase())
  if (!local) throw new Error(`本地未安装 Skill：${id}`)

  const file = settingsPath()
  let settings: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('settings.json 不是有效的 JSON 对象')
    }
    settings = parsed as Record<string, unknown>
  } catch (err) {
    if (err instanceof SyntaxError) throw new Error('settings.json 不是有效的 JSON，已停止写入')
    throw err
  }

  const overrides = readSkillOverrides()
  if (enabled) delete overrides[local.name]
  else overrides[local.name] = 'off'

  const backupPath = fs.existsSync(file) ? backupFile('workbuddy', file) : undefined
  atomicWriteText(
    file,
    `${JSON.stringify({ ...settings, skillOverrides: overrides }, null, 2)}\n`
  )
  return {
    ok: true,
    message: `已${enabled ? '启用' : '停用'} Skill：${local.name}`,
    backupPath
  }
}

async function updateSkill(
  id: string
): Promise<ApplyResult> {
  const { skill, data } = await downloadSkillPackage(id)

  if (skill.minWorkBuddyVersion) {
    const appVersion = workBuddyAppVersion()
    if (!appVersion) throw new Error(`无法确认 WorkBuddy 版本；Skill 要求最低 v${skill.minWorkBuddyVersion}`)
    if (compareVersions(appVersion, skill.minWorkBuddyVersion) < 0) {
      throw new Error(`WorkBuddy v${appVersion} 低于 Skill 要求的 v${skill.minWorkBuddyVersion}`)
    }
  }

  const local = readInstalledSkills().get(skill.id)
  if (local?.version && compareVersions(skill.version, local.version) <= 0) {
    return {
      ok: true,
      message: skill.version === local.version
        ? `${skill.name} 已是最新版本（v${local.version}）`
        : `${skill.name} 本地版本更新（v${local.version}），已跳过远端 v${skill.version}`
    }
  }

  const targetDir = local ? path.join(skillsPath(), local.dirName) : path.join(skillsPath(), skill.id)

  const workBuddyRunning = await isWorkBuddyRunning()
  if (workBuddyRunning) {
    throw new Error('WorkBuddy 正在运行；请先手动关闭 WorkBuddy，再点击安装/更新')
  }

  try {
    const result = await installSkillPackage({
      skillsRoot: skillsPath(),
      targetDir,
      remote: skill,
      data,
      previousVersion: local?.version
    })
    return result
  } catch (err) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'EPERM') {
      throw new Error('替换 Skill 目录被系统拒绝，已保留原版本；请确认 WorkBuddy 已完全退出后重试')
    }
    throw err
  }
}

export const workbuddyAdapter: AppAdapter = {
  id: 'workbuddy',
  name: 'WorkBuddy',
  implemented: true,
  detect,
  readLive,
  writeLive,
  writeMcp,
  listSkills,
  setSkillEnabled,
  updateSkill,
  isRunning: isWorkBuddyRunning,
  launch
}
