import { ipcMain, BrowserWindow } from 'electron'
import type { AppId, Provider } from '../shared/types'
import { APP_META } from '../shared/types'
import { listAdapters, getAdapter } from './adapters'
import {
  createProvider,
  deleteProvider,
  getDataDir,
  getSettings,
  listProviders,
  updateProvider,
  updateSettings
} from './store'
import { enableProvider } from './switcher'
import { fetchModels, speedTest } from './speedtest'
import { rebuildTrayMenu } from './tray'
import { parseDeepLink } from '../shared/url'

export function registerIpc(getMainWindow: () => BrowserWindow | null): void {
  ipcMain.handle('apps:list', async () => {
    const adapters = listAdapters()
    const infos = await Promise.all(
      adapters.map(async (a) => {
        const detect = await a.detect()
        return {
          id: a.id as AppId,
          name: a.name,
          implemented: a.implemented,
          installed: detect.installed,
          configPath: detect.configPath,
          message: detect.detail
        }
      })
    )
    return infos
  })

  ipcMain.handle('providers:list', (_e, app?: AppId) => listProviders(app))

  ipcMain.handle(
    'providers:create',
    (_e, input: Omit<Provider, 'id' | 'createdAt' | 'updatedAt' | 'enabled'>) => {
      const p = createProvider(input)
      rebuildTrayMenu(getMainWindow)
      return p
    }
  )

  ipcMain.handle(
    'providers:update',
    (_e, id: string, patch: Partial<Provider>) => {
      const p = updateProvider(id, patch)
      rebuildTrayMenu(getMainWindow)
      return p
    }
  )

  ipcMain.handle('providers:delete', (_e, id: string) => {
    deleteProvider(id)
    rebuildTrayMenu(getMainWindow)
    return true
  })

  ipcMain.handle('providers:enable', async (_e, id: string) => {
    const result = await enableProvider(id)
    rebuildTrayMenu(getMainWindow)
    return result
  })

  ipcMain.handle(
    'providers:speedTest',
    (_e, endpoint: string, apiKey: string) => speedTest(endpoint, apiKey)
  )

  ipcMain.handle(
    'providers:fetchModels',
    (_e, endpoint: string, apiKey: string) => fetchModels(endpoint, apiKey)
  )

  ipcMain.handle('settings:get', () => getSettings())
  ipcMain.handle('settings:update', (_e, patch) => updateSettings(patch))
  ipcMain.handle('system:dataDir', () => getDataDir())
  ipcMain.handle('system:appMeta', () => APP_META)

  ipcMain.handle('adapters:launch', async (_e, app: AppId) => {
    const adapter = getAdapter(app)
    if (!adapter.launch) throw new Error('该应用不支持启动')
    await adapter.launch()
    return true
  })

  ipcMain.handle('deeplink:parse', (_e, url: string) => parseDeepLink(url))
}
