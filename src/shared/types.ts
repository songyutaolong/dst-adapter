export type AppId =
  | 'workbuddy'
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
  model: string
  vendor?: string
  supportsToolCall?: boolean
  supportsImages?: boolean
  supportsReasoning?: boolean
  enabled: boolean
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

export interface AppSettings {
  launchAtLogin: boolean
  backupKeep: number
  locale: 'zh-CN'
}

export const DEFAULT_SETTINGS: AppSettings = {
  launchAtLogin: false,
  backupKeep: 10,
  locale: 'zh-CN'
}

export const APP_META: Record<
  AppId,
  { name: string; implemented: boolean }
> = {
  workbuddy: { name: 'WorkBuddy', implemented: true },
  cursor: { name: 'Cursor', implemented: false },
  continue: { name: 'Continue', implemented: false },
  cline: { name: 'Cline', implemented: false },
  'cherry-studio': { name: 'Cherry Studio', implemented: false },
  'claude-code': { name: 'Claude Code', implemented: false },
  'claude-desktop': { name: 'Claude Desktop', implemented: false },
  vscode: { name: 'VS Code', implemented: false }
}
