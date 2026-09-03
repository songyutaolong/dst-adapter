import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppId,
  AppInfo,
  AppSettings,
  ApplyResult,
  Provider,
  SpeedTestResult,
  McpService,
  Model,
  ModelConfig,
  SyncModelsResult,
  UpdateState
} from '../shared/types'

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
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke('settings:get'),
  updateSettings: (patch: Partial<AppSettings>): Promise<AppSettings> =>
    ipcRenderer.invoke('settings:update', patch),
  getDataDir: (): Promise<string> => ipcRenderer.invoke('system:dataDir'),
  getVersion: (): Promise<string> => ipcRenderer.invoke('system:version'),
  launchApp: (
    app: AppId
  ): Promise<{ ok?: boolean; injected?: boolean; message?: string }> =>
    ipcRenderer.invoke('adapters:launch', app),
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
  enableMcpService: (id: string, enabled: boolean): Promise<McpService> =>
    ipcRenderer.invoke('mcp:enable', id, enabled),
  startMcpService: (id: string, app?: AppId): Promise<McpService> =>
    ipcRenderer.invoke('mcp:start', id, app),
  stopMcpService: (id: string): Promise<McpService> =>
    ipcRenderer.invoke('mcp:stop', id),
  getMcpConnectionInfo: (id: string): Promise<McpConnectionInfo> =>
    ipcRenderer.invoke('mcp:info', id),
  writeClipboard: (text: string): Promise<boolean> =>
    ipcRenderer.invoke('clipboard:write', text),
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
  disableModel: (id: string): Promise<Model> =>
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
