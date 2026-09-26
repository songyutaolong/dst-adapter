import fs from 'fs'
import os from 'os'
import path from 'path'
import { parse as parseToml } from 'smol-toml'
import type {
  ApplyResult,
  DetectResult,
  Provider,
  RemoteSkillPackage,
  SkillCatalogResult
} from '../../shared/types'
import { toOpenAiRoot } from '../../shared/url'
import { atomicWriteText, backupFile, backupsDir, listProviders } from '../store'
import {
  findCodexExecutable,
  isCodexInstalled,
  isCodexRunning,
  launchCodex
} from '../codex/launcher'
import { startCodexProxy } from '../codex/proxy'
import { downloadSkillPackage, fetchSkillCatalog } from '../skills/catalog'
import { installSkillPackage } from '../skills/installer'
import { compareVersions } from '../skills/version'
import type { AppAdapter, McpServerEntry } from './types'

function codexDir(): string {
  return path.join(os.homedir(), '.codex')
}

function configPath(): string {
  return path.join(codexDir(), 'config.toml')
}

function authPath(): string {
  return path.join(codexDir(), 'auth.json')
}

function catalogPath(): string {
  return path.join(codexDir(), 'dasuantou-models.json')
}

function skillsPath(): string {
  return path.join(codexDir(), 'skills')
}

function disabledSkillsPath(): string {
  return path.join(codexDir(), 'skills.disabled')
}

function tomlString(value: string): string {
  return JSON.stringify(value)
}

function decodeTomlString(value: string): string {
  if (value.startsWith('"')) {
    try {
      return String(JSON.parse(value))
    } catch {
      return value.slice(1, -1)
    }
  }
  return value.slice(1, -1)
}

const mcpNestedSectionPattern =
  /^\s*\[mcp_servers\.(?:"((?:\\.|[^"])*)"|'([^']+)'|([A-Za-z0-9_-]+))(?:\.[^\]]+)?\s*\]\s*(?:#.*)?$/

function mcpSectionKey(match: RegExpExecArray): string {
  const raw = match[1] || match[2] || match[3] || ''
  return match[1] ? decodeTomlString(`"${raw}"`) : raw
}

function managedTomlSection(key: string, server: McpServerEntry): string {
  if (!key.trim()) throw new Error('Codex MCP 服务 key 不能为空')
  const header = `# dasuantou-managed\n[mcp_servers.${tomlString(key)}]`
  if ('url' in server) {
    return [
      header,
      `url = ${tomlString(server.url)}`,
      ...(server.name ? [`name = ${tomlString(server.name)}`] : [])
    ].join('\n')
  }

  if (!server.command.trim()) throw new Error(`Codex MCP 服务 ${key} 缺少 command`)
  return [
    header,
    `command = ${tomlString(server.command)}`,
    ...(server.args?.length
      ? [`args = [${server.args.map((arg) => tomlString(arg)).join(', ')}]`]
      : []),
    ...(server.disabled === false ? ['disabled = false'] : [])
  ].join('\n')
}

function stripManagedMcpSections(raw: string, keys: string[] = []): string {
  const removeSet = new Set(keys)
  const lines = raw.split(/\r?\n/)
  const result: string[] = []
  let skipping = false

  for (const line of lines) {
    const section = mcpNestedSectionPattern.exec(line)
    if (section) {
      skipping = removeSet.has(mcpSectionKey(section))
      if (skipping) {
        const previous = result[result.length - 1]
        if (previous && /^\s*#\s*dasuantou-managed\s*$/.test(previous)) result.pop()
        continue
      }
    } else if (skipping && /^\s*\[/.test(line)) {
      skipping = false
    }

    if (!skipping) result.push(line)
  }

  return result.join('\n').replace(/^\s*[\r\n]+/, '').replace(/\s+$/, '')
}

function parseCodexConfig(raw: string): Record<string, unknown> {
  try {
    return parseToml(raw) as Record<string, unknown>
  } catch (err) {
    throw new Error(
      `Codex config.toml 不是有效 TOML，已停止写入：${
        err instanceof Error ? err.message : String(err)
      }`
    )
  }
}

function stripManagedConfig(raw: string): string {
  const lines = raw.split(/\r?\n/)
  const result: string[] = []
  let skippingManagedSection = false
  let inSection = false

  for (const line of lines) {
    if (/^\s*\[model_providers\.dasuantou(?:[.\]].*)?$/.test(line)) {
      skippingManagedSection = true
      continue
    }
    if (skippingManagedSection && /^\s*\[/.test(line)) {
      if (/^\s*\[model_providers\.dasuantou(?:[.\]].*)?$/.test(line)) continue
      skippingManagedSection = false
    }
    if (skippingManagedSection) continue
    if (/^\s*\[/.test(line)) inSection = true
    if (
      !inSection &&
      /^\s*(model|model_provider|model_catalog_json|model_reasoning_effort)\s*=/.test(line)
    ) {
      continue
    }
    if (/^\s*#\s*dasuantou-managed/.test(line)) continue
    result.push(line)
  }
  return result.join('\n').trim()
}

function buildModelCatalog(provider: Provider): unknown {
  const slug = (provider.model || 'default').trim()
  const displayName = (provider.name || provider.model || '大算头').trim() || slug
  return {
    models: [
      {
        slug,
        display_name: displayName,
        description: `${displayName}（通过 dst adapter）`,
        default_reasoning_level: 'medium',
        supported_reasoning_levels: [
          { effort: 'low', description: '快速' },
          { effort: 'medium', description: '均衡' },
          { effort: 'high', description: '深入' }
        ],
        shell_type: 'shell_command',
        visibility: 'list',
        supported_in_api: true,
        priority: 0,
        availability_nux: null,
        upgrade: null,
        base_instructions:
          'You are Codex, a coding agent. You help the user with software engineering tasks.',
        supports_reasoning_summaries: true,
        support_verbosity: false,
        default_verbosity: null,
        apply_patch_tool_type: null,
        truncation_policy: { mode: 'tokens', limit: 10000 },
        supports_parallel_tool_calls: true,
        experimental_supported_tools: [],
        context_window: 200000,
        max_context_window: 200000,
        input_modalities: ['text', 'image']
      }
    ]
  }
}

function buildConfig(
  existing: string,
  provider: Provider,
  baseUrl: string,
  catalogFile: string
): string {
  const preserved = stripManagedConfig(existing)
  const displayName = (provider.name || '大算头').trim() || '大算头'
  // Store/GUI launches cannot inherit shell env vars; a direct env_key lookup
  // would therefore fail even though auth.json contains the API key.
  const managed = [
    '# dasuantou-managed: Codex pure API provider',
    `model = ${tomlString(provider.model || 'default')}`,
    'model_provider = "dasuantou"',
    `model_catalog_json = ${tomlString(catalogFile)}`,
    '',
    '[model_providers.dasuantou]',
    `name = ${tomlString(displayName)}`,
    `base_url = ${tomlString(baseUrl)}`,
    'wire_api = "responses"',
    'requires_openai_auth = false',
    `experimental_bearer_token = ${tomlString(provider.apiKey.trim())}`
  ].join('\n')
  return `${managed}${preserved ? `\n\n${preserved}` : ''}\n`
}

async function resolveBaseUrl(provider: Provider): Promise<string> {
  if (provider.wireApi === 'responses') {
    return toOpenAiRoot(provider.endpoint)
  }
  const port = await startCodexProxy(provider)
  return `http://127.0.0.1:${port}/v1`
}

async function detect(): Promise<DetectResult> {
  const executable = findCodexExecutable()
  const configExists = fs.existsSync(codexDir())
  return {
    installed: isCodexInstalled() || configExists,
    configPath: configPath(),
    running: await isCodexRunning(),
    detail: executable
      ? `已检测到 Codex：${executable}`
      : configExists
        ? '检测到 Codex 配置，但未找到桌面应用'
        : '未检测到 Codex，点击下载前往官网'
  }
}

async function readLive(): Promise<unknown> {
  return {
    config: fs.existsSync(configPath())
      ? fs.readFileSync(configPath(), 'utf8')
      : '',
    auth: fs.existsSync(authPath())
      ? JSON.parse(fs.readFileSync(authPath(), 'utf8'))
      : null
  }
}

async function writeLive(provider: Provider): Promise<ApplyResult> {
  fs.mkdirSync(codexDir(), { recursive: true })
  const configBackup = backupFile('codex', configPath())
  const authBackup = backupFile('codex', authPath())
  const existing = fs.existsSync(configPath())
    ? fs.readFileSync(configPath(), 'utf8')
    : ''
  if (existing.trim()) parseCodexConfig(existing)

  const baseUrl = await resolveBaseUrl(provider)
  const catalogFile = catalogPath()
  atomicWriteText(
    catalogPath(),
    `${JSON.stringify(buildModelCatalog(provider), null, 2)}\n`
  )
  atomicWriteText(
    configPath(),
    buildConfig(existing, provider, baseUrl, catalogFile.replace(/\\/g, '/'))
  )

  // Pure API mode: keep only the API key, no ChatGPT OAuth tokens.
  atomicWriteText(
    authPath(),
    `${JSON.stringify({ OPENAI_API_KEY: provider.apiKey.trim() }, null, 2)}\n`
  )

  return {
    ok: true,
    message: '已启用 Codex 纯 API（无需 OpenAI 账号）',
    backupPath: configBackup || authBackup
  }
}

async function launch(): Promise<{ message: string }> {
  const provider = listProviders('codex').find((item) => item.enabled)
  if (!provider) throw new Error('请先启用一个 Codex Provider')

  await writeLive(provider)
  const result = await launchCodex(provider)
  return {
    message: result.alreadyRunning
      ? 'Codex 已在运行；新配置需完全退出并重新打开 Codex 后生效'
      : 'Codex 已启动'
  }
}

async function readMcp(): Promise<Record<string, McpServerEntry>> {
  if (!fs.existsSync(configPath())) return {}
  const parsed = parseCodexConfig(fs.readFileSync(configPath(), 'utf8'))
  const servers = parsed.mcp_servers
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return {}

  const result: Record<string, McpServerEntry> = {}
  for (const [key, value] of Object.entries(servers)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const entry = value as Record<string, unknown>
    if (typeof entry.url === 'string' && entry.url.trim()) {
      result[key] = {
        type: 'http',
        url: entry.url,
        ...(typeof entry.name === 'string' && entry.name ? { name: entry.name } : {}),
        disabled: entry.disabled === true
      }
      continue
    }
    if (typeof entry.command === 'string' && entry.command.trim()) {
      result[key] = {
        command: entry.command,
        ...(Array.isArray(entry.args) && entry.args.length
          ? { args: entry.args.filter((arg): arg is string => typeof arg === 'string') }
          : {}),
        disabled: entry.disabled === true || entry.enabled === false
      }
    }
  }
  return result
}

async function writeMcp(
  merge: Record<string, McpServerEntry>,
  removeKeys: string[] = []
): Promise<ApplyResult> {
  const file = configPath()
  fs.mkdirSync(codexDir(), { recursive: true })
  const backupPath = backupFile('codex', file)
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  if (existing.trim()) parseCodexConfig(existing)
  const removed = stripManagedMcpSections(existing, [
    ...Object.keys(merge),
    ...removeKeys
  ])
  const sections = Object.entries(merge).map(([key, server]) =>
    managedTomlSection(key, server)
  )
  const next = [removed, ...sections].filter((part) => part.trim()).join('\n\n') + '\n'

  atomicWriteText(file, next)
  const removedNames = removeKeys.filter((key) => !(key in merge))
  return {
    ok: true,
    message: removedNames.length > 0
      ? `已从 Codex config.toml 移除 ${removedNames.join(', ')}`
      : `已合并 MCP 配置到 Codex config.toml（${Object.keys(merge).join(', ') || '无'}）`,
    backupPath
  }
}

interface InstalledSkill {
  id: string
  version?: string
  dirName: string
  enabled: boolean
  path: string
}

function parseSkillFrontmatter(raw: string): {
  name?: string
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
    version: pick('version') || undefined
  }
}

function readInstalledSkills(): Map<string, InstalledSkill> {
  const result = new Map<string, InstalledSkill>()
  const roots: Array<{ root: string; enabled: boolean }> = [
    { root: skillsPath(), enabled: true },
    { root: disabledSkillsPath(), enabled: false }
  ]

  for (const { root, enabled } of roots) {
    if (!fs.existsSync(root)) continue
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'dist') continue
      const skillFile = path.join(root, entry.name, 'SKILL.md')
      if (!fs.existsSync(skillFile)) continue
      try {
        const meta = parseSkillFrontmatter(fs.readFileSync(skillFile, 'utf8'))
        const id = (meta.name || entry.name).toLowerCase()
        result.set(id, {
          id,
          version: meta.version,
          dirName: entry.name,
          enabled,
          path: path.join(root, entry.name)
        })
      } catch {
        // An unreadable local skill should not block the catalog.
      }
    }
  }
  return result
}

async function listSkills(force = false): Promise<SkillCatalogResult> {
  const catalog = await fetchSkillCatalog(force)
  const installedSkills = readInstalledSkills()
  const skills = catalog.skills.map((skill: RemoteSkillPackage) => {
    const local = installedSkills.get(skill.id)
    if (!local) return skill
    return {
      ...skill,
      installed: true,
      enabled: local.enabled,
      localVersion: local.version,
      updateAvailable: skill.version !== 'unknown' &&
        compareVersions(skill.version, local.version || '0') > 0
    }
  })
  return { ...catalog, skills }
}

async function setSkillEnabled(id: string, enabled: boolean): Promise<ApplyResult> {
  const local = readInstalledSkills().get(id.trim().toLowerCase())
  if (!local) throw new Error(`本地未安装 Skill：${id}`)
  if (local.enabled === enabled) {
    return { ok: true, message: `Skill 已处于${enabled ? '启用' : '停用'}状态` }
  }

  const source = local.path
  const destinationRoot = enabled ? skillsPath() : disabledSkillsPath()
  const destination = path.join(destinationRoot, local.dirName)
  if (fs.existsSync(destination)) {
    throw new Error(`目标 Skill 目录已存在：${destination}`)
  }
  fs.mkdirSync(destinationRoot, { recursive: true })
  fs.renameSync(source, destination)
  return { ok: true, message: `已${enabled ? '启用' : '停用'} Skill：${id}` }
}

async function updateSkill(id: string): Promise<ApplyResult> {
  const { skill, data } = await downloadSkillPackage(id)
  const local = readInstalledSkills().get(skill.id)
  if (local?.version && compareVersions(skill.version, local.version) <= 0) {
    return {
      ok: true,
      message: skill.version === local.version
        ? `${skill.name} 已是最新版本（v${local.version}）`
        : `${skill.name} 本地版本更新（v${local.version}），已跳过远端 v${skill.version}`
    }
  }

  if (await isCodexRunning()) {
    throw new Error('Codex 正在运行；请先完全退出 Codex，再点击安装/更新')
  }

  const targetRoot = local && !local.enabled ? disabledSkillsPath() : skillsPath()
  const targetDirName = local?.dirName || skill.id
  const result = await installSkillPackage({
    skillsRoot: targetRoot,
    targetDir: path.join(targetRoot, targetDirName),
    remote: skill,
    data,
    previousVersion: local?.version,
    backupRoot: backupsDir('codex-skills')
  })
  return result
}

export const codexAdapter: AppAdapter = {
  id: 'codex',
  name: 'Codex',
  implemented: true,
  detect,
  readLive,
  writeLive,
  writeMcp,
  readMcp,
  listSkills,
  setSkillEnabled,
  updateSkill,
  isRunning: isCodexRunning,
  launch
}
