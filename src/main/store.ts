import fs from 'fs'
import path from 'path'
import os from 'os'
import { randomUUID } from 'crypto'
import type { AppId, AppSettings, Provider, McpService, Model, ModelInfo, ModelConfig } from '../shared/types'
import {
  DEFAULT_SETTINGS,
  BUILTIN_MCP_IMAGE_ID,
  BUILTIN_MCP_IMAGE_DEFAULTS,
  BUILTIN_MCP_VIDEO_ID,
  BUILTIN_MCP_VIDEO_DEFAULTS
} from '../shared/types'
import { getMcpRuntime } from './mcp/launcher'

export interface DataStore {
  version: number
  settings: AppSettings
  providers: Provider[]
  mcpServices: McpService[]
  models: Model[]
  lastSyncAt?: string
}

function dataDir(): string {
  return path.join(os.homedir(), '.dst-adapter')
}

function dbPath(): string {
  return path.join(dataDir(), 'db.json')
}

export function backupsDir(app?: string): string {
  const base = path.join(dataDir(), 'backups')
  return app ? path.join(base, app) : base
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
}

function emptyStore(): DataStore {
  return {
    version: 1,
    settings: { ...DEFAULT_SETTINGS },
    providers: [],
    mcpServices: [],
    models: [],
    lastSyncAt: undefined
  }
}

function atomicWriteJson(filePath: string, data: unknown): void {
  ensureDir(path.dirname(filePath))
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8')
  fs.renameSync(tmp, filePath)
}

export function loadStore(): DataStore {
  ensureDir(dataDir())
  const file = dbPath()
  if (!fs.existsSync(file)) {
    const store = emptyStore()
    atomicWriteJson(file, store)
    return store
  }
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf-8')
  } catch (err) {
    // 读取失败（文件被占用/权限异常等）：先留存现场再重建，绝不静默覆盖
    preserveCorruptDb(file, err instanceof Error ? err.message : String(err))
    const store = emptyStore()
    atomicWriteJson(file, store)
    return store
  }
  try {
    const parsed = JSON.parse(raw) as DataStore
    const mcpServices = Array.isArray(parsed.mcpServices) ? parsed.mcpServices : []
    // running/port 是会话级状态：应用重启后真实进程已不存在，
    // 清掉持久化的旧值，避免启动按钮被陈旧状态禁用
    for (const s of mcpServices) {
      s.running = false
      s.port = undefined
    }
    return {
      version: parsed.version ?? 1,
      settings: { ...DEFAULT_SETTINGS, ...(parsed.settings || {}) },
      providers: Array.isArray(parsed.providers) ? parsed.providers : [],
      mcpServices,
      models: Array.isArray(parsed.models) ? parsed.models : [],
      lastSyncAt: parsed.lastSyncAt
    }
  } catch (err) {
    // JSON 损坏/半写：把原文件改名留存（db.json.corrupt-<ts>），
    // 再重建空 store，避免 catch 分支覆盖掉可能仍可抢救的数据
    preserveCorruptDb(file, err instanceof Error ? err.message : String(err))
    const store = emptyStore()
    atomicWriteJson(file, store)
    return store
  }
}

/**
 * 把损坏/不可读的 db.json 复制留存为 db.json.corrupt-<ts>，
 * 供事后手工恢复，然后再由调用方重建新 store。
 */
function preserveCorruptDb(file: string, reason: string): void {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    fs.copyFileSync(file, path.join(dataDir(), `db.json.corrupt-${stamp}`))
    console.error(`[store] db.json 损坏，已留存现场: ${reason}`)
  } catch {
    // 复制失败则不动原文件，由调用方尝试重建
    console.error(`[store] db.json 损坏且无法留存现场: ${reason}`)
  }
}

export function saveStore(store: DataStore): void {
  const file = dbPath()
  // 写前把当前版本备份到 backups/db/，恢复"配置丢失"的兜底手段
  if (fs.existsSync(file)) {
    backupDbBeforeWrite(store.settings?.backupKeep ?? DEFAULT_SETTINGS.backupKeep)
  }
  atomicWriteJson(file, store)
}

/** 写盘前把旧 db.json 复制到 backups/db/，并按 backupKeep 轮转清理。 */
function backupDbBeforeWrite(keep: number): void {
  const file = dbPath()
  const dir = backupsDir('db')
  ensureDir(dir)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dest = path.join(dir, `${stamp}.json`)
  try {
    fs.copyFileSync(file, dest)
  } catch {
    return // 备份失败不阻塞正常保存
  }
  rotateBackups('db', keep)
}

export function listProviders(app?: AppId): Provider[] {
  const store = loadStore()
  const list = store.providers
  return app ? list.filter((p) => p.app === app) : list
}

export function getProvider(id: string): Provider | undefined {
  return loadStore().providers.find((p) => p.id === id)
}

export function createProvider(
  input: Omit<Provider, 'id' | 'createdAt' | 'updatedAt' | 'enabled'> & {
    enabled?: boolean
  }
): Provider {
  const store = loadStore()
  const now = new Date().toISOString()
  const provider: Provider = {
    id: randomUUID(),
    name: input.name,
    app: input.app,
    endpoint: input.endpoint,
    apiKey: input.apiKey,
    model: input.model,
    wireApi: input.wireApi || 'chat_completions',
    vendor: input.vendor || 'dst',
    supportsToolCall: input.supportsToolCall ?? true,
    supportsImages: input.supportsImages ?? false,
    supportsReasoning: input.supportsReasoning ?? false,
    enabled: false,
    createdAt: now,
    updatedAt: now
  }
  store.providers.push(provider)
  saveStore(store)
  return provider
}

export function updateProvider(
  id: string,
  patch: Partial<Omit<Provider, 'id' | 'createdAt'>>
): Provider {
  const store = loadStore()
  const idx = store.providers.findIndex((p) => p.id === id)
  if (idx < 0) throw new Error('Provider not found')
  store.providers[idx] = {
    ...store.providers[idx],
    ...patch,
    id,
    updatedAt: new Date().toISOString()
  }
  saveStore(store)
  return store.providers[idx]
}

export function deleteProvider(id: string): void {
  const store = loadStore()
  const target = store.providers.find((p) => p.id === id)
  if (!target) throw new Error('Provider not found')
  if (target.enabled) {
    throw new Error('不能删除当前启用的 Provider，请先切换到其他配置')
  }
  store.providers = store.providers.filter((p) => p.id !== id)
  saveStore(store)
}

export function markEnabled(app: AppId, providerId: string): void {
  const store = loadStore()
  for (const p of store.providers) {
    if (p.app === app) {
      p.enabled = p.id === providerId
      p.updatedAt = new Date().toISOString()
    }
  }
  saveStore(store)
}

export function getSettings(): AppSettings {
  return loadStore().settings
}

export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  const store = loadStore()
  store.settings = { ...store.settings, ...patch }
  saveStore(store)
  return store.settings
}

export function backupFile(app: string, sourcePath: string): string | undefined {
  if (!fs.existsSync(sourcePath)) return undefined
  const dir = backupsDir(app)
  ensureDir(dir)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dest = path.join(dir, `${stamp}${path.extname(sourcePath) || '.json'}`)
  fs.copyFileSync(sourcePath, dest)
  rotateBackups(app, getSettings().backupKeep)
  return dest
}

function rotateBackups(app: string, keep: number): void {
  const dir = backupsDir(app)
  if (!fs.existsSync(dir)) return
  const files = fs
    .readdirSync(dir)
    .map((name) => ({ name, full: path.join(dir, name) }))
    .map((f) => ({ ...f, mtime: fs.statSync(f.full).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
  for (const f of files.slice(Math.max(keep, 1))) {
    try {
      fs.unlinkSync(f.full)
    } catch {
      /* ignore */
    }
  }
}

export function atomicWriteText(filePath: string, content: string): void {
  ensureDir(path.dirname(filePath))
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, content, 'utf-8')
  fs.renameSync(tmp, filePath)
}

export function getDataDir(): string {
  return dataDir()
}

// ── MCP Services ──

/** 内置图片生成服务模板；如不存在则创建（不可删除、不可重复添加）。 */
function builtinMcpImageService(): McpService {
  const now = new Date().toISOString()
  return {
    id: BUILTIN_MCP_IMAGE_ID,
    name: BUILTIN_MCP_IMAGE_DEFAULTS.name,
    type: BUILTIN_MCP_IMAGE_DEFAULTS.type,
    provider: BUILTIN_MCP_IMAGE_DEFAULTS.provider,
    baseUrl: BUILTIN_MCP_IMAGE_DEFAULTS.baseUrl,
    modelId: BUILTIN_MCP_IMAGE_DEFAULTS.models[0],
    apiKey: '',
    enabled: false,
    running: false,
    builtin: true,
    createdAt: now,
    updatedAt: now
  }
}

/** 内置视频生成服务模板；如不存在则创建（不可删除、不可重复添加）。 */
function builtinMcpVideoService(): McpService {
  const now = new Date().toISOString()
  return {
    id: BUILTIN_MCP_VIDEO_ID,
    name: BUILTIN_MCP_VIDEO_DEFAULTS.name,
    type: BUILTIN_MCP_VIDEO_DEFAULTS.type,
    provider: BUILTIN_MCP_VIDEO_DEFAULTS.provider,
    baseUrl: BUILTIN_MCP_VIDEO_DEFAULTS.baseUrl,
    modelId: BUILTIN_MCP_VIDEO_DEFAULTS.models[0],
    apiKey: '',
    enabled: false,
    running: false,
    builtin: true,
    createdAt: now,
    updatedAt: now
  }
}

export function listMcpServices(): McpService[] {
  const store = loadStore()
  let changed = false

  // 确保图片生成服务存在
  const builtinImage = store.mcpServices.find((s) => s.id === BUILTIN_MCP_IMAGE_ID)
  if (!builtinImage) {
    store.mcpServices.unshift(builtinMcpImageService())
    changed = true
  } else if (!BUILTIN_MCP_IMAGE_DEFAULTS.models.includes(builtinImage.modelId)) {
    builtinImage.modelId = BUILTIN_MCP_IMAGE_DEFAULTS.models[0]
    builtinImage.updatedAt = new Date().toISOString()
    changed = true
  }

  // 确保视频生成服务存在
  const builtinVideo = store.mcpServices.find((s) => s.id === BUILTIN_MCP_VIDEO_ID)
  if (!builtinVideo) {
    store.mcpServices.push(builtinMcpVideoService())
    changed = true
  } else {
    // 迁移：更新 provider 和 modelId
    if (builtinVideo.provider !== BUILTIN_MCP_VIDEO_DEFAULTS.provider) {
      builtinVideo.provider = BUILTIN_MCP_VIDEO_DEFAULTS.provider
      changed = true
    }
    if (!BUILTIN_MCP_VIDEO_DEFAULTS.models.includes(builtinVideo.modelId)) {
      builtinVideo.modelId = BUILTIN_MCP_VIDEO_DEFAULTS.models[0]
      changed = true
    }
    if (changed) {
      builtinVideo.updatedAt = new Date().toISOString()
    }
  }

  if (changed) {
    saveStore(store)
  }
  return store.mcpServices
}

export function getMcpService(id: string): McpService | undefined {
  return loadStore().mcpServices.find((s) => s.id === id)
}

export function createMcpService(
  input: Omit<McpService, 'id' | 'createdAt' | 'updatedAt' | 'enabled' | 'running'>
): McpService {
  const store = loadStore()
  const now = new Date().toISOString()
  const service: McpService = {
    id: randomUUID(),
    name: input.name,
    type: input.type,
    provider: input.provider,
    baseUrl: input.baseUrl,
    modelId: input.modelId,
    apiKey: input.apiKey,
    enabled: false,
    running: false,
    createdAt: now,
    updatedAt: now
  }
  store.mcpServices.push(service)
  saveStore(store)
  return service
}

export function updateMcpService(
  id: string,
  patch: Partial<Omit<McpService, 'id' | 'createdAt'>>
): McpService {
  const store = loadStore()
  const idx = store.mcpServices.findIndex((s) => s.id === id)
  if (idx < 0) throw new Error('MCP Service not found')
  store.mcpServices[idx] = {
    ...store.mcpServices[idx],
    ...patch,
    id,
    updatedAt: new Date().toISOString()
  }
  saveStore(store)
  return store.mcpServices[idx]
}

export function deleteMcpService(id: string): void {
  const store = loadStore()
  const target = store.mcpServices.find((s) => s.id === id)
  if (!target) throw new Error('MCP Service not found')
  if (target.builtin) {
    throw new Error('内置 MCP 服务不可删除')
  }
  if (target.running) {
    throw new Error('不能删除正在运行的 MCP 服务，请先停止')
  }
  store.mcpServices = store.mcpServices.filter((s) => s.id !== id)
  saveStore(store)
}

export function markMcpServiceEnabled(id: string, enabled: boolean): McpService {
  const store = loadStore()
  const idx = store.mcpServices.findIndex((s) => s.id === id)
  if (idx < 0) throw new Error('MCP Service not found')
  store.mcpServices[idx] = {
    ...store.mcpServices[idx],
    enabled,
    updatedAt: new Date().toISOString()
  }
  saveStore(store)
  return store.mcpServices[idx]
}

export function markMcpServiceRunning(id: string, running: boolean, port?: number): McpService {
  const store = loadStore()
  const idx = store.mcpServices.findIndex((s) => s.id === id)
  if (idx < 0) throw new Error('MCP Service not found')
  store.mcpServices[idx] = {
    ...store.mcpServices[idx],
    running,
    port: running ? port : undefined,
    updatedAt: new Date().toISOString()
  }
  saveStore(store)
  return store.mcpServices[idx]
}

/** 生成 MCP 服务连接信息（用于「复制配置信息」）。 */
export function getMcpConnectionInfo(id: string): { text: string; json: Record<string, unknown> } {
  const service = getMcpService(id)
  if (!service) throw new Error('MCP Service not found')
  // store 中的 running/port 每次 load 都会被清空（会话级状态），必须以运行时为准
  const runtime = getMcpRuntime(id)
  if (!runtime.running || !runtime.port) {
    throw new Error('MCP 服务未运行，请先启动该服务后再复制配置')
  }

  // 导出本地 MCP 代理地址：客户端接入 127.0.0.1:<port>，由本应用转发上游并注入 API Key，
  // 因此不导出上游 baseUrl / apiKey / 远端 endpoint。
  const localUrl = `http://127.0.0.1:${runtime.port}`
  // 标准 MCP 客户端（WorkBuddy / Cursor / Cline 等）只识别传输类型 type 与连接地址 url；
  // key 用 ASCII 别名，避免中文 server 名进入工具名（mcp__<server>__<tool>）导致客户端解析失败；
  // 中文显示名放在 value.name 字段。内部字段（baseUrl / provider / image-generation 等）不得外泄。
  let key: string
  if (service.builtin) {
    key = service.id === BUILTIN_MCP_IMAGE_ID ? 'dst-image-mcp' : 'dst-video-mcp'
  } else {
    key = service.id
  }
  const json = {
    type: 'http',
    url: localUrl,
    name: service.name
  }
  return {
    json,
    text: JSON.stringify({ mcpServers: { [key]: json } }, null, 2)
  }
}

// ── Models ──

export function listModels(app?: AppId): Model[] {
  const store = loadStore()
  const list = store.models
  return app ? list.filter((m) => m.app === app) : list
}

export function getModel(id: string): Model | undefined {
  return loadStore().models.find((m) => m.id === id)
}

export function getModelByModelId(modelId: string, app: AppId): Model | undefined {
  return loadStore().models.find((m) => m.modelId === modelId && m.app === app)
}

export function saveModelsFromApi(
  providerId: string,
  app: AppId,
  models: ModelInfo[]
): Model[] {
  const store = loadStore()
  const now = new Date().toISOString()
  
  // 保留用户已配置的模型设置
  const existingModels = new Map<string, Model>()
  for (const m of store.models) {
    if (m.app === app && m.providerId === providerId) {
      existingModels.set(m.modelId, m)
    }
  }
  
  // 移除旧的模型
  store.models = store.models.filter((m) => !(m.app === app && m.providerId === providerId))
  
  // 添加新模型，保留已有配置
  for (const info of models) {
    const existing = existingModels.get(info.id)
    const model: Model = {
      id: existing?.id || randomUUID(),
      providerId,
      app,
      modelId: info.id,
      name: info.name || info.id,
      contextWindow: info.contextWindow,
      supportsVision: info.supportsVision,
      supportsFunctionCalling: info.supportsFunctionCalling,
      config: existing?.config || {
        contextWindow: info.contextWindow,
        supportsToolCall: info.supportsFunctionCalling,
        supportsImages: info.supportsVision
      },
      enabled: existing?.enabled || false,
      createdAt: existing?.createdAt || now,
      updatedAt: now
    }
    store.models.push(model)
  }
  
  store.lastSyncAt = now
  saveStore(store)
  return store.models.filter((m) => m.app === app)
}

export function updateModel(
  id: string,
  patch: Partial<Omit<Model, 'id' | 'createdAt'>>
): Model {
  const store = loadStore()
  const idx = store.models.findIndex((m) => m.id === id)
  if (idx < 0) throw new Error('Model not found')
  store.models[idx] = {
    ...store.models[idx],
    ...patch,
    id,
    updatedAt: new Date().toISOString()
  }
  saveStore(store)
  return store.models[idx]
}

export function enableModel(id: string, app: AppId): Model {
  const store = loadStore()
  const now = new Date().toISOString()
  
  // 先禁用同应用的所有模型
  for (const m of store.models) {
    if (m.app === app) {
      m.enabled = m.id === id
      m.updatedAt = now
    }
  }
  
  saveStore(store)
  return store.models.find((m) => m.id === id)!
}

export function disableModel(id: string): Model {
  const store = loadStore()
  const idx = store.models.findIndex((m) => m.id === id)
  if (idx < 0) throw new Error('Model not found')
  store.models[idx] = {
    ...store.models[idx],
    enabled: false,
    updatedAt: new Date().toISOString()
  }
  saveStore(store)
  return store.models[idx]
}

export function getEnabledModel(app: AppId): Model | undefined {
  return loadStore().models.find((m) => m.app === app && m.enabled)
}

export function getLastSyncAt(): string | undefined {
  return loadStore().lastSyncAt
}
