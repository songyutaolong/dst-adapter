import fs from 'fs'
import os from 'os'
import path from 'path'
import { parse as parseToml } from 'smol-toml'
import type {
  ApplyResult,
  DetectResult,
  Model,
  Provider,
  RemoteSkillPackage,
  SkillCatalogResult
} from '../../shared/types'
import { toOpenAiRoot } from '../../shared/url'
import {
  atomicWriteText,
  backupFile,
  backupsDir,
  getSettings,
  listModels,
  listProviders
} from '../store'
import {
  findCodexExecutable,
  isCodexInstalled,
  isCodexRunning,
  launchCodex
} from '../codex/launcher'
import { startCodexProxy, stopCodexProxy } from '../codex/proxy'
import { downloadSkillPackage, fetchSkillCatalog } from '../skills/catalog'
import { installSkillPackage } from '../skills/installer'
import { compareVersions } from '../skills/version'
import {
  deleteCodexSession,
  listCodexSessions,
  readCodexSessionMessages
} from './sessions'
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
  // 管理块结构由 buildConfig 完全确定：注释行 + 若干顶层标量 +
  // [model_providers.dasuantou] 段（以 experimental_bearer_token 行结尾）。
  // 必须按此边界精确剥除：首次改写后，原文件的顶层键（notify /
  // disable_response_storage 等）物理位置会紧跟管理块，若沿用
  // "跳到下一个 [ 段才停"的旧逻辑，第二次及以后的改写会把它们误吃掉。
  let i = 0
  if (i < lines.length && /^\s*#\s*dasuantou-managed/.test(lines[i])) {
    i++
    while (i < lines.length && !/^\s*\[/.test(lines[i])) i++
    while (i < lines.length && !/^\s*experimental_bearer_token\s*=/.test(lines[i])) i++
    i++
    if (i < lines.length && lines[i].trim() === '') i++
  }
  // 剩余部分：剥掉历史遗留的原 provider 顶层标量（仅首个 section 之前）
  const result: string[] = []
  let inSection = false
  for (; i < lines.length; i++) {
    const line = lines[i]
    if (/^\s*\[/.test(line)) inSection = true
    if (
      !inSection &&
      /^\s*(model|model_provider|model_catalog_json|model_reasoning_effort)\s*=/.test(line)
    ) {
      continue
    }
    result.push(line)
  }
  return result.join('\n').trim()
}

function catalogEntry(
  slug: string,
  config?: Model['config']
): Record<string, unknown> {
  const displayName = slug
  const contextWindow = config?.contextWindow ?? 200000
  return {
    slug,
    // display_name 直接用模型 ID：模型选择器里应显示模型名而非 provider 名
    display_name: displayName,
    description: `${displayName}（通过 Up software Ai控制台）`,
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
    context_window: contextWindow,
    max_context_window: contextWindow,
    input_modalities: ['text', 'image']
  }
}

/**
 * 生成 model_catalog_json：所有启用模型各一条，provider.model（当前连接模型）
 * 排第一；不在启用集合时补一条合成条目，保证 Codex 打开时始终有可用模型。
 */
function buildModelCatalog(provider: Provider, enabledModels: Model[]): unknown {
  const activeModel = (provider.model || 'default').trim()
  const active = enabledModels.find((m) => m.modelId === activeModel)
  const rest = enabledModels.filter((m) => m.modelId !== activeModel)
  const entries = [
    catalogEntry(activeModel, active?.config),
    ...rest.map((m) => catalogEntry(m.modelId, m.config))
  ]
  return { models: entries }
}

/** catalog 中实际存在的模型 slug 集合，用于 config.toml 的 model 校验。 */
function allowedModelSlugs(provider: Provider, enabledModels: Model[]): string[] {
  const activeModel = (provider.model || 'default').trim()
  return [activeModel, ...enabledModels.map((m) => m.modelId)]
}

/** 读取现有 config.toml 里的 model 值（无效 TOML 时返回 undefined）。 */
function readExistingModel(raw: string): string | undefined {
  if (!raw.trim()) return undefined
  try {
    const parsed = parseCodexConfig(raw)
    return typeof parsed.model === 'string' ? parsed.model.trim() || undefined : undefined
  } catch {
    return undefined
  }
}

function buildConfig(
  existing: string,
  provider: Provider,
  baseUrl: string,
  catalogFile: string,
  wireApi: 'responses' | 'chat_completions',
  allowedModels: string[],
  activeModel?: string
): string {
  const preserved = stripManagedConfig(existing)
  const displayName = (provider.name || '大算头').trim() || '大算头'
  // 激活模型优先级：显式指定（模型页点"启用"）> 用户在 Codex 内已选
  // （仍在允许列表时）> provider.model。不保留 Codex 侧选择的话，
  // 任何一次 writeLive（如启动、改设置）都会把用户选的模型重置。
  let model = (provider.model || 'default').trim()
  const previous = readExistingModel(existing)
  if (previous && allowedModels.includes(previous)) model = previous
  if (activeModel && allowedModels.includes(activeModel)) model = activeModel
  // Store/GUI launches cannot inherit shell env vars; a direct env_key lookup
  // would therefore fail even though auth.json contains the API key.
  const managed = [
    '# dasuantou-managed: Codex pure API provider',
    `model = ${tomlString(model)}`,
    'model_provider = "dasuantou"',
    `model_catalog_json = ${tomlString(catalogFile)}`,
    '',
    '[model_providers.dasuantou]',
    `name = ${tomlString(displayName)}`,
    `base_url = ${tomlString(baseUrl)}`,
    `wire_api = "${wireApi}"`,
    'requires_openai_auth = false',
    `experimental_bearer_token = ${tomlString(provider.apiKey.trim())}`
  ].join('\n')
  return `${managed}${preserved ? `\n\n${preserved}` : ''}\n`
}

/** 路由开关（按应用）+ 上游协议共同决定是否经本地代理做协议转换。 */
function shouldProxyCodex(provider: Provider): boolean {
  if (provider.wireApi !== 'chat_completions') return false
  return getSettings().routing?.codex ?? true
}

async function resolveBaseUrl(
  provider: Provider
): Promise<{ url: string; wireApi: 'responses' | 'chat_completions' }> {
  if (!shouldProxyCodex(provider)) {
    // 直连：顺手停掉不再需要的代理（未运行时为 no-op）
    await stopCodexProxy()
    return { url: toOpenAiRoot(provider.endpoint), wireApi: provider.wireApi ?? 'responses' }
  }
  const port = await startCodexProxy(provider)
  return { url: `http://127.0.0.1:${port}/v1`, wireApi: 'responses' }
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

/** 按 provider + 启用模型集合重建 model_catalog_json 和 config.toml。 */
async function writeCodexModelConfig(
  provider: Provider,
  existing: string,
  enabledModels: Model[],
  activeModel?: string
): Promise<void> {
  const { url: baseUrl, wireApi } = await resolveBaseUrl(provider)
  const catalogFile = catalogPath()
  const catalog = buildModelCatalog(provider, enabledModels)
  atomicWriteText(catalogPath(), `${JSON.stringify(catalog, null, 2)}\n`)
  atomicWriteText(
    configPath(),
    buildConfig(
      existing,
      provider,
      baseUrl,
      catalogFile.replace(/\\/g, '/'),
      wireApi,
      allowedModelSlugs(provider, enabledModels),
      activeModel
    )
  )
}

/** 当前启用 provider 下已启用的模型（仅当前 API 源）。 */
function enabledModelsOf(provider: Provider): Model[] {
  return listModels('codex').filter(
    (m) => m.enabled && m.providerId === provider.id
  )
}

async function writeLive(
  provider: Provider,
  opts?: { activeModel?: string }
): Promise<ApplyResult> {
  fs.mkdirSync(codexDir(), { recursive: true })
  const configBackup = backupFile('codex', configPath())
  const authBackup = backupFile('codex', authPath())
  const existing = fs.existsSync(configPath())
    ? fs.readFileSync(configPath(), 'utf8')
    : ''
  if (existing.trim()) parseCodexConfig(existing)

  await writeCodexModelConfig(
    provider,
    existing,
    enabledModelsOf(provider),
    opts?.activeModel
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

async function removeModel(modelId: string): Promise<ApplyResult> {
  const provider = listProviders('codex').find((item) => item.enabled)
  if (!provider) {
    return { ok: true, message: '无启用的 Codex Provider，跳过配置更新' }
  }
  const enabledModels = enabledModelsOf(provider)
  if (!enabledModels.some((m) => m.modelId === modelId)) {
    return { ok: true, message: `模型 ${modelId} 不在 Codex 模型列表中，无需移除` }
  }
  const configBackup = backupFile('codex', configPath())
  const existing = fs.existsSync(configPath())
    ? fs.readFileSync(configPath(), 'utf8')
    : ''
  if (existing.trim()) parseCodexConfig(existing)

  await writeCodexModelConfig(
    provider,
    existing,
    enabledModels.filter((m) => m.modelId !== modelId)
  )
  return {
    ok: true,
    message: `已从 Codex 模型列表移除 ${modelId}`,
    backupPath: configBackup
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
  removeModel,
  writeMcp,
  readMcp,
  listSkills,
  setSkillEnabled,
  updateSkill,
  isRunning: isCodexRunning,
  listSessions: listCodexSessions,
  readSessionMessages: readCodexSessionMessages,
  deleteSession: deleteCodexSession,
  launch
}
