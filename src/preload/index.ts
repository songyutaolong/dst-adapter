import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppId,
  AppInfo,
  AppSettings,
  ApplyResult,
  Provider,
  SpeedTestResult
} from '../shared/types'

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
  launchApp: (app: AppId): Promise<boolean> =>
    ipcRenderer.invoke('adapters:launch', app),
  onDeepLinkImported: (cb: (provider: Provider) => void) => {
    const listener = (_: Electron.IpcRendererEvent, provider: Provider) =>
      cb(provider)
    ipcRenderer.on('deeplink:imported', listener)
    return () => ipcRenderer.removeListener('deeplink:imported', listener)
  }
}

contextBridge.exposeInMainWorld('dst', api)

export type DstApi = typeof api
