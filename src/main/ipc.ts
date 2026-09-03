import { app, ipcMain, BrowserWindow, shell, clipboard } from 'electron'
import type { AppId, Provider, McpService, ModelConfig, ModelInfo, SyncModelsResult } from '../shared/types'
import { APP_META } from '../shared/types'
import { listAdapters, getAdapter } from './adapters'
import {
  createProvider,
  deleteProvider,
  getDataDir,
  getSettings,
  listProviders,
  updateProvider,
  updateSettings,
  listMcpServices,
  getMcpService,
  createMcpService,
  updateMcpService,
  deleteMcpService,
  markMcpServiceEnabled,
  markMcpServiceRunning,
  getMcpConnectionInfo,
  listModels,
  getModel,
  updateModel,
  disableModel,
  getEnabledModel,
  saveModelsFromApi,
  getLastSyncAt
} from './store'
import { enableProvider, enableModel as enableModelForApp } from './switcher'
import { fetchModels, speedTest } from './speedtest'
import { rebuildTrayMenu } from './tray'
import { parseDeepLink } from '../shared/url'
import { launchMcpService, stopMcpService as stopMcpProcess, getMcpRuntime } from './mcp/launcher'
import {
  checkForUpdates,
  downloadUpdate,
  getUpdateState,
  quitAndInstall
} from './update'

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
          message: detect.detail,
          downloadUrl: APP_META[a.id as AppId].downloadUrl
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
  ipcMain.handle('system:version', () => app.getVersion())

  ipcMain.handle('adapters:launch', async (_e, app: AppId) => {
    const adapter = getAdapter(app)
    if (!adapter.launch) throw new Error('该应用不支持启动')
    const result = await adapter.launch()
    if (result && typeof result === 'object') return result
    return { ok: true, message: '已尝试启动应用' }
  })

  ipcMain.handle('apps:download', async (_e, appId: AppId) => {
    const url = APP_META[appId].downloadUrl
    if (!url) throw new Error('该应用暂无下载地址')
    await shell.openExternal(url)
    return true
  })

  ipcMain.handle('deeplink:parse', (_e, url: string) => parseDeepLink(url))

  // ── MCP Services ──

  ipcMain.handle('mcp:list', () => {
    // 以真实进程状态为准，无条件校准持久化的 running/port，
    // 避免应用重启后 db 残留旧状态导致 UI 显示与事实不符
    const services = listMcpServices()
    for (const s of services) {
      // 运行时状态（内存 Map）为准，一次拿全 running + port，
      // 避免用被 loadStore 清空的 s.port 回写导致 port 永久丢失
      const runtime = getMcpRuntime(s.id)
      const updated = markMcpServiceRunning(
        s.id,
        runtime.running,
        runtime.running ? runtime.port : undefined
      )
      s.running = updated.running
      s.port = updated.port
    }
    return services
  })

  ipcMain.handle(
    'mcp:create',
    (_e, input: Omit<McpService, 'id' | 'createdAt' | 'updatedAt' | 'enabled' | 'running'>) => {
      return createMcpService(input)
    }
  )

  ipcMain.handle(
    'mcp:update',
    (_e, id: string, patch: Partial<Omit<McpService, 'id' | 'createdAt'>>) => {
      return updateMcpService(id, patch)
    }
  )

  ipcMain.handle('mcp:delete', (_e, id: string) => {
    deleteMcpService(id)
    return true
  })

  ipcMain.handle('mcp:enable', (_e, id: string, enabled: boolean) => {
    return markMcpServiceEnabled(id, enabled)
  })

  ipcMain.handle('mcp:start', async (_e, id: string, app?: AppId) => {
    const service = getMcpService(id)
    if (!service) throw new Error('MCP Service not found')
    // 复用当前应用 Provider 的连接信息（endpoint / apiKey）
    const provider = app ? listProviders(app)[0] : listProviders()[0]
    if (!provider) {
      throw new Error('请先在「配置 Provider」中配置连接信息')
    }
    if (!provider.apiKey.trim()) {
      throw new Error('请在「配置 Provider」中填写 API Key')
    }
    const serviceWithConn: McpService = {
      ...service,
      baseUrl: provider.endpoint,
      apiKey: provider.apiKey
    }
    const result = await launchMcpService(serviceWithConn)
    if (!result.ok) throw new Error(result.error || '启动失败')
    return markMcpServiceRunning(id, true, result.port)
  })

  ipcMain.handle('mcp:stop', async (_e, id: string) => {
    const result = await stopMcpProcess(id)
    if (!result.ok) throw new Error(result.error || '停止失败')
    return markMcpServiceRunning(id, false)
  })

  ipcMain.handle('mcp:info', (_e, id: string) => getMcpConnectionInfo(id))

  ipcMain.handle('clipboard:write', (_e, text: string) => {
    clipboard.writeText(text)
    return true
  })

  // ── Models ──

  ipcMain.handle('models:list', (_e, app?: AppId) => listModels(app))

  ipcMain.handle('models:get', (_e, id: string) => getModel(id))

  ipcMain.handle('models:getEnabled', (_e, app: AppId) => getEnabledModel(app))

  ipcMain.handle(
    'models:update',
    (_e, id: string, patch: Partial<ModelConfig>) => {
      return updateModel(id, { config: patch })
    }
  )

  ipcMain.handle('models:enable', async (_e, id: string, app: AppId) => {
    const result = await enableModelForApp(app, id)
    rebuildTrayMenu(getMainWindow)
    return result
  })

  ipcMain.handle('models:disable', (_e, id: string) => {
    const model = disableModel(id)
    rebuildTrayMenu(getMainWindow)
    return model
  })

  ipcMain.handle('models:lastSyncAt', () => getLastSyncAt())

  ipcMain.handle(
    'models:sync',
    async (_e, providerId: string, app: AppId, endpoint: string, apiKey: string): Promise<SyncModelsResult> => {
      // 先验证连通性
      const test = await speedTest(endpoint, apiKey)
      if (!test.ok) {
        return {
          ok: false,
          message: `连接失败：${test.error || test.status || '无法连接到服务器'}`
        }
      }
      
      // 获取模型列表
      const modelsResult = await fetchModels(endpoint, apiKey)
      if (!modelsResult.ok) {
        return {
          ok: false,
          message: `获取模型失败：${modelsResult.error || '未知错误'}`
        }
      }
      
      // 转换为 ModelInfo 格式
      const modelInfos: ModelInfo[] = modelsResult.models.map((id) => ({
        id,
        name: id,
        supportsFunctionCalling: true,
        supportsVision: false
      }))
      
      // 保存到本地
      saveModelsFromApi(providerId, app, modelInfos)
      
      return {
        ok: true,
        message: `已同步 ${modelInfos.length} 个模型`,
        models: modelInfos,
        count: modelInfos.length,
        lastSyncAt: new Date().toISOString()
      }
    }
  )

  // ── Auto Update ──

  ipcMain.handle('update:getState', () => getUpdateState())

  ipcMain.handle('update:check', (_e, userInitiated: boolean) =>
    checkForUpdates(Boolean(userInitiated))
  )

  ipcMain.handle('update:download', () => downloadUpdate())

  ipcMain.handle('update:install', () => {
    quitAndInstall()
    return true
  })
}
