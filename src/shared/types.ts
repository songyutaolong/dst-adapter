export type AppId = 'workbuddy' | 'codex' | 'claude-code'

export interface Provider {
  id: string
  name: string
  app: AppId
  endpoint: string
  apiKey: string
  model?: string
  wireApi?: 'responses' | 'chat_completions'
  vendor?: string
  supportsToolCall?: boolean
  supportsImages?: boolean
  supportsReasoning?: boolean
  enabled: boolean
  createdAt: string
  updatedAt: string
}

/** 模型配置 */
export interface ModelConfig {
  contextWindow?: number
  maxTokens?: number
  supportsToolCall?: boolean
  supportsImages?: boolean
  supportsReasoning?: boolean
  temperature?: number
  topP?: number
}

/** 从 API 获取的模型信息 */
export interface ModelInfo {
  id: string
  name?: string
  contextWindow?: number
  supportsVision?: boolean
  supportsFunctionCalling?: boolean
}

/** 本地存储的模型（包含用户配置） */
export interface Model {
  id: string
  providerId: string
  app: AppId
  modelId: string
  name?: string
  contextWindow?: number
  supportsVision?: boolean
  supportsFunctionCalling?: boolean
  config: ModelConfig
  enabled: boolean
  createdAt: string
  updatedAt: string
}

/** 应用模型配置状态 */
export interface AppModelConfig {
  app: AppId
  providerId: string
  enabledModelId?: string
  lastSyncAt?: string
}

export type McpServiceType =
  | 'image-generation'
  | 'video-generation'
  | 'file-upload'
  | '3d-generation'
  | 'ue-mcp'
  | 'text-generation'
  | 'custom'
export type McpProvider = 'gemini-3-pro-image' | 'gpt-image-2' | 'doubao-seedance-2.0' | 'dst' | 'custom'

export interface McpService {
  id: string
  name: string
  type: McpServiceType
  provider: McpProvider
  baseUrl: string
  modelId: string
  apiKey: string
  /** 服务启用是应用级配置；running/port 是本机进程级状态。 */
  enabledApps?: AppId[]
  enabled: boolean
  running: boolean
  port?: number
  builtin?: boolean
  createdAt: string
  updatedAt: string
}

export interface AppInfo {
  id: AppId
  name: string
  implemented: boolean
  installed: boolean
  configPath?: string
  message?: string
  downloadUrl?: string
}

export interface DetectResult {
  installed: boolean
  configPath?: string
  running?: boolean
  detail?: string
}

export interface SpeedTestResult {
  ok: boolean
  latencyMs?: number
  status?: number
  error?: string
  modelsSample?: string[]
}

/** GET /v1/me：网关 API Key 对应的最小用户/组织身份 */
export interface GatewayMeInfo {
  user: {
    id: number
    username: string
    display_name: string
  }
  organization: {
    id: number
    name: string
  } | null
}

export interface GatewayMeResult {
  ok: boolean
  status?: number
  info?: GatewayMeInfo
  error?: string
}

export interface ApplyResult {
  ok: boolean
  message: string
  backupPath?: string
}

/** 会话管理：单个历史会话的元信息（只读扫描自应用本地落盘文件） */
export interface SessionMeta {
  app: AppId
  sessionId: string
  title: string
  summary: string
  projectDir: string
  createdAt: string
  lastActiveAt: string
  sourcePath: string
}

export type SessionMessageRole = 'user' | 'assistant' | 'tool'

/** 工具调用结构化记录（消息的附加信息，平台 tool_calls 字段）。 */
export interface SessionToolCall {
  name: string
  args?: string
  result?: string
  status?: string
}

export interface SessionMessage {
  role: SessionMessageRole
  text: string
  timestamp?: string
  /** 结构化工具调用（展示仍用 text；平台上报时随消息携带） */
  toolCalls?: SessionToolCall[]
}

/** 会话消息读取选项：不传 cursor 时返回最新的一页 */
export interface SessionMessagesOptions {
  /** 上一页返回的游标（文件字节偏移），向更早方向翻页 */
  cursor?: number
  limit?: number
}

/** 会话消息分页结果：大文件只读尾部窗口，更早的消息按需加载 */
export interface SessionMessagesPage {
  messages: SessionMessage[]
  /** 是否还有更早的消息 */
  hasMore: boolean
  /** 加载下一页（更早）时回传的游标 */
  cursor?: number
  /** 小文件全量解析时的消息总数 */
  total?: number
}

/** 会话归档最近一次运行结果（界面展示用） */
export interface SessionArchiveRun {
  at: string
  ok: boolean
  message: string
  uploaded: number
  failed: number
}

/** 会话归档状态：定期把本地会话上报公司 AI 能力平台（增量，同一会话整体覆盖） */
export interface SessionArchiveState {
  enabled: boolean
  /** 是否已配置 AI 能力平台（Base URL/Key/Secret 齐备） */
  platformConfigured: boolean
  lastRun: SessionArchiveRun | null
}

export interface SyncModelsResult {
  ok: boolean
  message: string
  models?: ModelInfo[]
  count?: number
  lastSyncAt?: string
}

/** 提示词管理：个人提示词（存于 AI 能力平台，"使用"即复制到系统剪贴板） */
export interface Prompt {
  id: string
  name: string
  /** 提示词正文（多行） */
  content: string
  /** 标签（平台侧随提示词维护） */
  tags?: string[]
  createdAt: string
  updatedAt: string
}

/** 生成记录：内置 MCP 工具产出的图片/视频/3D 资产自动归档（下载→上传云存储→记录元数据） */
export type AssetKind = 'image' | 'video' | 'model3d'

export type AssetRecordStatus =
  | 'pending' // 视频/3D 任务已提交，等待结果
  | 'uploading' // 已拿到资产（内存/本地缓存），上传中
  | 'completed' // 已归档到云存储
  | 'upload_failed' // 下载或上传失败，可手动重试
  | 'failed' // 上游生成任务失败，不可重试
  | 'expired' // 轮询超时放弃

export interface AssetRecordIdentity {
  userId: number
  username: string
  displayName: string
  orgId: number
  orgName: string
}

export interface AssetRecordCloud {
  provider: 'cos' | 'oss'
  bucket: string
  key: string
  region?: string
  uploadedAt: string
  size: number
  contentType: string
  /** 逻辑键：对象 key 去掉组织 path_prefix 后的业务路径，供 AI 能力平台 files/import 定位对象 */
  logicalKey?: string
}

/** AI 能力平台数据归档结果（files/import 返回的文件 id 与后台状态） */
export interface AssetRecordArchive {
  /** files/import 返回的平台文件 id */
  fileId: string
  /** 平台侧后台状态：pending（复制中）→ ready */
  status: string
  /** 发起导入的时间 */
  importedAt: string
  error?: string
}

export interface AssetRecord {
  id: string
  /** 同一次工具调用产出多张图时共享的调用 ID */
  callId: string
  kind: AssetKind
  toolName: string
  /** 调用方（WorkBuddy / Codex / UA 片段），识别失败为 unknown */
  sourceApp: string
  /** 提交时捕获的提示词；3D 后处理工具为合成的操作描述 */
  prompt: string
  /** 生成来源会话（工具入参携带的 session_id，格式如 workbuddy:<uuid>）；平台数据归档时带上 */
  sessionId?: string
  /** 清洗后的入参（超长/base64 字段已替换为占位符） */
  params: Record<string, unknown>
  model?: string
  identity: AssetRecordIdentity | null
  status: AssetRecordStatus
  taskId?: string
  /** 上游任务状态原文 */
  taskStatus?: string
  failReason?: string
  /** 上游结果 URL（下载源） */
  resultUrl?: string
  fileName: string
  mimeType?: string
  size?: number
  /** 失败重试用的本地缓存文件（上传成功后删除） */
  localBufferPath?: string
  cloud?: AssetRecordCloud
  /** AI 能力平台数据归档结果（云盘上传完成后调用 files/import 登记，失败时 status=failed） */
  archive?: AssetRecordArchive
  error?: string
  attempts: number
  createdAt: string
  updatedAt: string
  completedAt?: string
}

/** OSS Skill 仓储中的可安装包；凭据和签名 URL 不进入渲染进程。 */
export interface RemoteSkillPackage {
  id: string
  name: string
  version: string
  objectKey: string
  size: number
  description?: string
  vendor?: string
  minWorkBuddyVersion?: string
  sha256?: string
  etag?: string
  lastModified?: string
  installed?: boolean
  enabled?: boolean
  localVersion?: string
  updateAvailable?: boolean
}

export interface SkillRepositoryInfo {
  provider: 'oss' | 'cos'
  bucket: string
  prefix?: string
}

export interface SkillCatalogResult {
  ok: boolean
  message: string
  skills: RemoteSkillPackage[]
  repository?: SkillRepositoryInfo
  generatedAt?: string
  fromCache?: boolean
}

/** MCP 服务默认端口（用于非内置服务） */
export const MCP_DEFAULT_PORT = 17890

/** OpenAI-compatible canonical Base URL used by the bundled DST services. */
export const DEFAULT_PROVIDER_ENDPOINT = 'https://dst-ai.com/v1'

/** 内置图片生成 MCP 服务（不可删除）。 */
export const BUILTIN_MCP_IMAGE_ID = 'builtin-mcp-image-generation'
export const BUILTIN_MCP_IMAGE_PORT = 17888

export const BUILTIN_MCP_IMAGE_DEFAULTS = {
  name: '图片生成工具',
  type: 'image-generation' as McpServiceType,
  provider: 'dst' as McpProvider,
  baseUrl: DEFAULT_PROVIDER_ENDPOINT,
  models: ['gemini-3-pro-image', 'gpt-image-2', 'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst']
}

/** 内置视频生成 MCP 服务（不可删除）。 */
export const BUILTIN_MCP_VIDEO_ID = 'builtin-mcp-video-generation'
export const BUILTIN_MCP_VIDEO_PORT = 17889

export const BUILTIN_MCP_VIDEO_DEFAULTS = {
  name: '视频生成工具',
  type: 'video-generation' as McpServiceType,
  provider: 'dst' as McpProvider,
  baseUrl: DEFAULT_PROVIDER_ENDPOINT,
  models: ['doubao-seedance-2.0', 'wan3.0-video'],
  resolutions: ['480p', '720p', '1080p', '4K'],
  ratios: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16', 'adaptive'],
  fps: [24, 60],
  durations: [5, 10]
}

/** 内置文件上传 MCP 服务（不可删除）。 */
export const BUILTIN_MCP_FILE_UPLOAD_ID = 'builtin-mcp-file-upload'
export const BUILTIN_MCP_FILE_UPLOAD_PORT = 17891

export const BUILTIN_MCP_FILE_UPLOAD_DEFAULTS = {
  name: '文件上传工具',
  type: 'file-upload' as McpServiceType,
  provider: 'dst' as McpProvider,
  baseUrl: DEFAULT_PROVIDER_ENDPOINT
}

/** 内置 3D 生成 MCP 服务（不可删除）。 */
export const BUILTIN_MCP_3D_ID = 'builtin-mcp-3d-generation'
export const BUILTIN_MCP_3D_PORT = 17892

export const BUILTIN_MCP_3D_DEFAULTS = {
  name: '3D 生成工具',
  type: '3d-generation' as McpServiceType,
  provider: 'dst' as McpProvider,
  baseUrl: DEFAULT_PROVIDER_ENDPOINT
}

/** 内置 UEMCP 服务；由 WorkBuddy/Codex 根据各自配置直接拉起 command 进程。 */
export const BUILTIN_MCP_UEMCP_ID = 'builtin-mcp-ue-mcp'

export const BUILTIN_MCP_UEMCP_DEFAULTS = {
  name: 'UE连接工具',
  type: 'ue-mcp' as McpServiceType,
  provider: 'custom' as McpProvider,
  command: 'npx',
  args: ['-y', 'ue-mcp']
}

export interface AppSettings {
  launchAtLogin: boolean
  backupKeep: number
  locale: 'zh-CN'
  /** Custom WorkBuddy install directory or executable path. */
  workBuddyPath: string
  /** Custom Codex install directory or executable path. */
  codexPath: string
  providerName: string
  providerEndpoint: string
  providerApiKey: string
  providerWireApi: 'responses' | 'chat_completions'
  providerVendor: string
  /** AI能力平台配置（先实现配置保存，具体使用后续实现） */
  assetBaseUrl: string
  assetKey: string
  assetSecret: string
  /** 每应用路由开关：是否经由 dstAdapter 本地代理做协议转换（浅合并，须整体替换）。 */
  routing: Partial<Record<AppId, boolean>>
}

export const DEFAULT_SETTINGS: AppSettings = {
  launchAtLogin: true,
  backupKeep: 10,
  locale: 'zh-CN',
  workBuddyPath: '',
  codexPath: '',
  providerName: 'dst',
  providerEndpoint: DEFAULT_PROVIDER_ENDPOINT,
  providerApiKey: '',
  providerWireApi: 'chat_completions',
  providerVendor: 'dst',
  assetBaseUrl: '',
  assetKey: '',
  assetSecret: '',
  routing: { codex: true }
}

/** 路由协议转换支持表：按应用声明转换方向与是否已可用。 */
export interface RoutingConversionSupport {
  direction: 'responses→chat' | 'chat→responses'
  available: boolean
}

export const ROUTING_CONVERSION_SUPPORT: Partial<Record<AppId, RoutingConversionSupport>> = {
  codex: { direction: 'responses→chat', available: true },
  workbuddy: { direction: 'chat→responses', available: false }
}

/** 已支持协议转换路由的应用（协议/路由变更后需要重写配置的范围）。 */
export const ROUTING_SUPPORTED_APPS: AppId[] = (
  Object.keys(ROUTING_CONVERSION_SUPPORT) as AppId[]
).filter((app) => Boolean(ROUTING_CONVERSION_SUPPORT[app]?.available))

/** 路由/协议变更后重写应用配置的结果事件（经 IPC 推送到渲染层）。 */
export interface SettingsRewriteEvent {
  app: AppId
  ok: boolean
  message: string
}

/** 应用自动更新状态（electron-updater 状态机的精简映射） */
export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'up-to-date'
  | 'error'
  | 'unsupported'

export interface UpdateState {
  status: UpdateStatus
  /** 远端可用版本（available / downloading / downloaded 时存在） */
  version?: string
  currentVersion: string
  /** 下载进度 0-100 */
  percent?: number
  error?: string
  isPackaged: boolean
  /** 是否支持自动更新（Windows 仅 NSIS 安装版；macOS 需 zip + 签名） */
  canUpdate: boolean
}

export const APP_META: Record<
  AppId,
  { name: string; implemented: boolean; downloadUrl?: string }
> = {
  workbuddy: {
    name: 'WorkBuddy',
    implemented: true,
    downloadUrl: 'https://www.workbuddy.ai/'
  },
  codex: {
    name: 'Codex',
    implemented: true,
    downloadUrl: 'https://openai.com/zh-Hans-CN/codex/'
  },
  'claude-code': {
    name: 'Claude Code',
    implemented: false,
    downloadUrl: 'https://www.anthropic.com/claude-code'
  }
}
