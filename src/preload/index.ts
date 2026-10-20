import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppId,
  AppInfo,
  AppSettings,
  ApplyResult,
  AssetRecord,
  GatewayMeResult,
  Provider,
  SpeedTestResult,
  McpService,
  Model,
  ModelConfig,
  Prompt,
  SessionMeta,
  SessionArchiveState,
  SessionMessagesOptions,
  SessionMessagesPage,
  SettingsRewriteEvent,
  SkillCatalogResult,
  SyncModelsResult,
  UpdateState
} from '../shared/types'
import type { PromptTemplate } from '../shared/prompts'

export interface McpConnectionInfo {
  text: string
  json: Record<string, unknown>
}

const api = {
  listApps: (): Promise<AppInfo[]> => ipcRenderer.invoke('apps:list'),
  listProviders: (app?: AppId): Promise<Provider[]> =>
    ipcRenderer.invoke('providers:list', app),
  createProvider: (
    input: Omit<Provider, 'id' | 'createdAt' | 'updatedAt' | 'enabled'>
  ): Promise<Provider> => ipcRenderer.invoke('providers:create', input),
  updateProvider: (
    id: string,
    patch: Partial<Provider>
  ): Promise<Provider> => ipcRenderer.invoke('providers:update', id, patch),
  deleteProvider: (id: string): Promise<boolean> =>
    ipcRenderer.invoke('providers:delete', id),
  enableProvider: (id: string): Promise<ApplyResult> =>
    ipcRenderer.invoke('providers:enable', id),
  speedTest: (endpoint: string, apiKey: string): Promise<SpeedTestResult> =>
    ipcRenderer.invoke('providers:speedTest', endpoint, apiKey),
  fetchModels: (
    endpoint: string,
    apiKey: string
  ): Promise<{ ok: boolean; models: string[]; error?: string }> =>
    ipcRenderer.invoke('providers:fetchModels', endpoint, apiKey),
  fetchMe: (): Promise<GatewayMeResult> => ipcRenderer.invoke('providers:me'),
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke('settings:get'),
  updateSettings: (patch: Partial<AppSettings>): Promise<AppSettings> =>
    ipcRenderer.invoke('settings:update', patch),
  getDataDir: (): Promise<string> => ipcRenderer.invoke('system:dataDir'),
  getVersion: (): Promise<string> => ipcRenderer.invoke('system:version'),
  launchApp: (
    app: AppId
  ): Promise<{ ok?: boolean; message?: string }> =>
    ipcRenderer.invoke('adapters:launch', app),
  isAppRunning: (app: AppId): Promise<boolean> =>
    ipcRenderer.invoke('adapters:is-running', app),
  downloadApp: (app: AppId): Promise<boolean> =>
    ipcRenderer.invoke('apps:download', app),
  onDeepLinkImported: (cb: (provider: Provider) => void) => {
    const listener = (_: Electron.IpcRendererEvent, provider: Provider) =>
      cb(provider)
    ipcRenderer.on('deeplink:imported', listener)
    return () => {
      ipcRenderer.removeListener('deeplink:imported', listener)
    }
  },
  onSettingsRewrite: (cb: (result: SettingsRewriteEvent) => void) => {
    const listener = (_: Electron.IpcRendererEvent, result: SettingsRewriteEvent) =>
      cb(result)
    ipcRenderer.on('settings:rewrite', listener)
    return () => {
      ipcRenderer.removeListener('settings:rewrite', listener)
    }
  },
  // MCP Services
  listMcpServices: (): Promise<McpService[]> => ipcRenderer.invoke('mcp:list'),
  createMcpService: (
    input: Omit<McpService, 'id' | 'createdAt' | 'updatedAt' | 'enabled' | 'running'>
  ): Promise<McpService> => ipcRenderer.invoke('mcp:create', input),
  updateMcpService: (
    id: string,
    patch: Partial<Omit<McpService, 'id' | 'createdAt'>>
  ): Promise<McpService> => ipcRenderer.invoke('mcp:update', id, patch),
  deleteMcpService: (id: string): Promise<boolean> =>
    ipcRenderer.invoke('mcp:delete', id),
  enableMcpService: (id: string, enabled: boolean, app: AppId): Promise<ApplyResult> =>
    ipcRenderer.invoke('mcp:enable', id, enabled, app),
  startMcpService: (id: string, app?: AppId): Promise<McpService> =>
    ipcRenderer.invoke('mcp:start', id, app),
  stopMcpService: (id: string): Promise<McpService> =>
    ipcRenderer.invoke('mcp:stop', id),
  getMcpConnectionInfo: (id: string): Promise<McpConnectionInfo> =>
    ipcRenderer.invoke('mcp:info', id),
  writeClipboard: (text: string): Promise<boolean> =>
    ipcRenderer.invoke('clipboard:write', text),
  // Skills
  listSkillCatalog: (app: AppId = 'workbuddy', force = false): Promise<SkillCatalogResult> =>
    ipcRenderer.invoke('skills:catalog:list', app, force),
  setSkillEnabled: (id: string, enabled: boolean, app: AppId = 'workbuddy'): Promise<ApplyResult> =>
    ipcRenderer.invoke('skills:set-enabled', app, id, enabled),
  updateSkill: (
    id: string,
    app: AppId = 'workbuddy'
  ): Promise<ApplyResult> =>
    ipcRenderer.invoke('skills:update', app, id),
  // Models
  listModels: (app?: AppId): Promise<Model[]> =>
    ipcRenderer.invoke('models:list', app),
  getModel: (id: string): Promise<Model | undefined> =>
    ipcRenderer.invoke('models:get', id),
  getEnabledModel: (app: AppId): Promise<Model | undefined> =>
    ipcRenderer.invoke('models:getEnabled', app),
  updateModelConfig: (id: string, config: Partial<ModelConfig>): Promise<Model> =>
    ipcRenderer.invoke('models:update', id, config),
  enableModel: (id: string, app: AppId): Promise<ApplyResult> =>
    ipcRenderer.invoke('models:enable', id, app),
  disableModel: (id: string): Promise<ApplyResult> =>
    ipcRenderer.invoke('models:disable', id),
  getLastSyncAt: (): Promise<string | undefined> =>
    ipcRenderer.invoke('models:lastSyncAt'),
  syncModels: (
    providerId: string,
    app: AppId,
    endpoint: string,
    apiKey: string
  ): Promise<SyncModelsResult> =>
    ipcRenderer.invoke('models:sync', providerId, app, endpoint, apiKey),
  // Sessions
  listSessions: (app: AppId): Promise<SessionMeta[]> =>
    ipcRenderer.invoke('sessions:list', app),
  getSessionMessages: (
    app: AppId,
    sessionId: string,
    opts?: SessionMessagesOptions
  ): Promise<SessionMessagesPage> =>
    ipcRenderer.invoke('sessions:messages', app, sessionId, opts),
  deleteSession: (app: AppId, sessionId: string): Promise<ApplyResult> =>
    ipcRenderer.invoke('sessions:delete', app, sessionId),
  // Session Archive（会话归档 → AI 能力平台）
  getSessionArchiveState: (): Promise<SessionArchiveState> =>
    ipcRenderer.invoke('sessions:archiveState'),
  runSessionArchiveNow: (): Promise<SessionArchiveState> =>
    ipcRenderer.invoke('sessions:archiveNow'),
  onSessionArchiveUpdated: (cb: (state: SessionArchiveState) => void) => {
    const listener = (_: Electron.IpcRendererEvent, s: SessionArchiveState) => cb(s)
    ipcRenderer.on('sessions:archive-updated', listener)
    return () => {
      ipcRenderer.removeListener('sessions:archive-updated', listener)
    }
  },
  // Prompts（提示词管理：个人提示词 + 公司模板，均走 AI 能力平台）
  listPrompts: (): Promise<Prompt[]> => ipcRenderer.invoke('prompts:list'),
  listPromptTemplates: (): Promise<PromptTemplate[]> =>
    ipcRenderer.invoke('prompts:listTemplates'),
  createPrompt: (input: Omit<Prompt, 'id' | 'createdAt' | 'updatedAt'>): Promise<Prompt> =>
    ipcRenderer.invoke('prompts:create', input),
  updatePrompt: (id: string, patch: Partial<Omit<Prompt, 'id' | 'createdAt'>>): Promise<Prompt> =>
    ipcRenderer.invoke('prompts:update', id, patch),
  deletePrompt: (id: string): Promise<boolean> => ipcRenderer.invoke('prompts:delete', id),
  // Assets（生成记录）
  listAssetRecords: (): Promise<AssetRecord[]> => ipcRenderer.invoke('assets:list'),
  retryAssetRecord: (id: string): Promise<AssetRecord> => ipcRenderer.invoke('assets:retry', id),
  deleteAssetRecord: (id: string): Promise<boolean> => ipcRenderer.invoke('assets:delete', id),
  signAssetRecordUrl: (
    id: string
  ): Promise<{ url: string; expiresAt: string }> => ipcRenderer.invoke('assets:signUrl', id),
  onAssetsChanged: (cb: () => void) => {
    const listener = () => cb()
    ipcRenderer.on('assets:changed', listener)
    return () => {
      ipcRenderer.removeListener('assets:changed', listener)
    }
  },
  // Auto Update
  getUpdateState: (): Promise<UpdateState> => ipcRenderer.invoke('update:getState'),
  checkForUpdate: (userInitiated = false): Promise<UpdateState> =>
    ipcRenderer.invoke('update:check', userInitiated),
  downloadUpdate: (): Promise<UpdateState> => ipcRenderer.invoke('update:download'),
  installUpdate: (): Promise<boolean> => ipcRenderer.invoke('update:install'),
  onUpdateEvent: (cb: (state: UpdateState) => void) => {
    const listener = (_: Electron.IpcRendererEvent, s: UpdateState) => cb(s)
    ipcRenderer.on('update:event', listener)
    return () => {
      ipcRenderer.removeListener('update:event', listener)
    }
  }
}

contextBridge.exposeInMainWorld('dst', api)

export type DstApi = typeof api
