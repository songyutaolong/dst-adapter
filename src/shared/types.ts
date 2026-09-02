export type AppId =
  | 'workbuddy'
  | 'codex'
  | 'cursor'
  | 'continue'
  | 'cline'
  | 'cherry-studio'
  | 'claude-code'
  | 'claude-desktop'
  | 'vscode'

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

export type McpServiceType = 'image-generation' | 'video-generation' | 'text-generation' | 'custom'
export type McpProvider = 'gemini-3-pro-image' | 'gpt-image-2' | 'doubao-seedance-2.0' | 'dst' | 'custom'

export interface McpService {
  id: string
  name: string
  type: McpServiceType
  provider: McpProvider
  baseUrl: string
  modelId: string
  apiKey: string
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

export interface ApplyResult {
  ok: boolean
  message: string
  backupPath?: string
}

export interface SyncModelsResult {
  ok: boolean
  message: string
  models?: ModelInfo[]
  count?: number
  lastSyncAt?: string
}

/** MCP 服务默认端口（用于非内置服务） */
export const MCP_DEFAULT_PORT = 17890

/** 内置图片生成 MCP 服务（不可删除）。 */
export const BUILTIN_MCP_IMAGE_ID = 'builtin-mcp-image-generation'
export const BUILTIN_MCP_IMAGE_PORT = 17888

export const BUILTIN_MCP_IMAGE_DEFAULTS = {
  name: '图片生成工具',
  type: 'image-generation' as McpServiceType,
  provider: 'dst' as McpProvider,
  baseUrl: 'https://dst-ai.com',
  models: ['gemini-3-pro-image', 'gpt-image-2']
}

/** 内置视频生成 MCP 服务（不可删除）。 */
export const BUILTIN_MCP_VIDEO_ID = 'builtin-mcp-video-generation'
export const BUILTIN_MCP_VIDEO_PORT = 17889

export const BUILTIN_MCP_VIDEO_DEFAULTS = {
  name: '视频生成工具',
  type: 'video-generation' as McpServiceType,
  provider: 'dst' as McpProvider,
  baseUrl: 'https://dst-ai.com',
  models: ['doubao-seedance-2.0'],
  resolutions: ['480p', '720p', '1080p', '4K'],
  ratios: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16', 'adaptive'],
  fps: [24, 60],
  durations: [5, 10]
}

export interface AppSettings {
  launchAtLogin: boolean
  backupKeep: number
  locale: 'zh-CN'
  codexEnhancements: boolean
}

export const DEFAULT_SETTINGS: AppSettings = {
  launchAtLogin: false,
  backupKeep: 10,
  locale: 'zh-CN',
  codexEnhancements: true
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
  cursor: {
    name: 'Cursor',
    implemented: false,
    downloadUrl: 'https://www.cursor.com/downloads'
  },
  continue: {
    name: 'Continue',
    implemented: false,
    downloadUrl: 'https://www.continue.dev/'
  },
  cline: {
    name: 'Cline',
    implemented: false,
    downloadUrl: 'https://cline.bot/'
  },
  'cherry-studio': {
    name: 'Cherry Studio',
    implemented: false,
    downloadUrl: 'https://www.cherry-ai.com/'
  },
  'claude-code': {
    name: 'Claude Code',
    implemented: false,
    downloadUrl: 'https://www.anthropic.com/claude-code'
  },
  'claude-desktop': {
    name: 'Claude Desktop',
    implemented: false,
    downloadUrl: 'https://claude.ai/download'
  },
  vscode: {
    name: 'VS Code',
    implemented: false,
    downloadUrl: 'https://code.visualstudio.com/download'
  }
}
