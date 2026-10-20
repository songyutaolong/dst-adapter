import { app, ipcMain, BrowserWindow, shell, clipboard } from 'electron'
import type {
  AppId,
  Provider,
  McpService,
  ModelConfig,
  ModelInfo,
  Prompt,
  SessionMessagesOptions,
  SyncModelsResult
} from '../shared/types'
import {
  APP_META,
  BUILTIN_MCP_UEMCP_ID,
  DEFAULT_PROVIDER_ENDPOINT,
  ROUTING_SUPPORTED_APPS
} from '../shared/types'
import { listAdapters, getAdapter } from './adapters'
import {
  createProvider,
  deleteProvider,
  getDataDir,
  getSettings,
  getDstConnection,
  listProviders,
  updateProvider,
  updateSettings,
  listMcpServices,
  getMcpService,
  createMcpService,
  updateMcpService,
  deleteMcpService,
  markMcpServiceRunning,
  getMcpConnectionInfo,
  listModels,
  getModel,
  updateModel,
  getEnabledModel,
  saveModelsFromApi,
  getLastSyncAt
} from './store'
import {
  listPlatformMyPrompts,
  createPlatformMyPrompt,
  updatePlatformMyPrompt,
  deletePlatformMyPrompt,
  listPlatformPromptTemplates
} from './prompts'
import {
  enableProvider,
  enableModel as enableModelForApp,
  disableModel as disableModelForApp,
  applyMcpToApp,
  ensureMcpToApp,
  rewriteEnabledProviders
} from './switcher'
import { fetchMe, fetchModels, speedTest } from './speedtest'
import { rebuildTrayMenu } from './tray'
import { parseDeepLink } from '../shared/url'
import { launchMcpService, stopMcpService as stopMcpProcess, getMcpRuntime } from './mcp/launcher'
import {
  listAssetRecords,
  retryAssetRecord,
  signAssetRecordUrl,
  deleteAssetRecord
} from './assets/archive'
import {
  getSessionArchiveState,
  runSessionArchiveNow
} from './sessionArchive'
import {
  checkForUpdates,
  downloadUpdate,
  getUpdateState,
  quitAndInstall
} from './update'
import { applyLaunchAtLogin } from './login'
import { stopCodexProxy } from './codex/proxy'

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

  // 网关身份：主进程用已保存的连接信息请求 /v1/me，渲染进程无需传 Key
  ipcMain.handle('providers:me', () => {
    const conn = getDstConnection()
    return fetchMe(conn.endpoint || DEFAULT_PROVIDER_ENDPOINT, conn.apiKey)
  })

  ipcMain.handle('settings:get', () => getSettings())
  ipcMain.handle('settings:update', async (_e, patch) => {
    const prev = getSettings()
    // 在 updateSettings 内部的 syncSharedProviders 强制启用共享 Provider 之前，
    // 快照"本来就已启用"的应用：自动重写只覆盖这些，避免改写刻意停用的应用配置
    const rewriteTargets = ROUTING_SUPPORTED_APPS.filter((app) =>
      listProviders(app).some((p) => p.enabled)
    )
    const next = updateSettings(patch)
    if (typeof patch?.launchAtLogin === 'boolean') {
      applyLaunchAtLogin(patch.launchAtLogin)
    }
    // 路由开关或上游协议变化：自动重写受影响应用的配置，保持 base_url/wire_api 同步
    const routingChanged =
      patch &&
      typeof patch.routing === 'object' &&
      JSON.stringify(prev.routing) !== JSON.stringify(next.routing)
    const wireApiChanged =
      patch?.providerWireApi && patch.providerWireApi !== prev.providerWireApi
    if (routingChanged || wireApiChanged) {
      const results = await rewriteEnabledProviders(rewriteTargets)
      const win = getMainWindow()
      for (const r of results) {
        if (!r.ok && win && !win.isDestroyed()) {
          win.webContents.send('settings:rewrite', r)
        }
      }
      // 兜底：路由不再需要代理时确保停掉（覆盖无启用 Provider 的残余场景）
      if (!(next.routing?.codex ?? true) || next.providerWireApi === 'responses') {
        void stopCodexProxy()
      }
    }
    return next
  })
  ipcMain.handle('system:dataDir', () => getDataDir())
  ipcMain.handle('system:appMeta', () => APP_META)
  ipcMain.handle('system:version', () => app.getVersion())

  ipcMain.handle('adapters:launch', async (_e, app: AppId) => {
    const adapter = getAdapter(app)
    if (!adapter.launch) throw new Error('该应用不支持启动')
    if (app === 'workbuddy' || app === 'codex') {
      const service = getMcpService(BUILTIN_MCP_UEMCP_ID)
      if (service?.enabledApps?.includes(app)) {
        const result = await ensureMcpToApp(app, service.id)
        if (!result.ok) throw new Error(result.message)
      }
    }
    const result = await adapter.launch()
    if (result && typeof result === 'object') return result
    return { ok: true, message: '已尝试启动应用' }
  })

  ipcMain.handle('adapters:is-running', async (_e, app: AppId) => {
    const adapter = getAdapter(app)
    if (!adapter.isRunning) throw new Error(`${adapter.name} 尚不支持运行状态检测`)
    return adapter.isRunning()
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

  ipcMain.handle('mcp:enable', async (_e, id: string, enabled: boolean, app: AppId) => {
    return enabled ? ensureMcpToApp(app, id) : applyMcpToApp(app, id, false)
  })

  ipcMain.handle('mcp:start', async (_e, id: string, app?: AppId) => {
    const service = getMcpService(id)
    if (!service) throw new Error('MCP Service not found')
    if (service.type === 'ue-mcp') {
      throw new Error('UE 连接工具由目标应用启动；请先启用配置，再启动 WorkBuddy 或 Codex')
    }
    const conn = getDstConnection()
    const provider = app ? listProviders(app)[0] : undefined
    const endpoint = conn.apiKey ? conn.endpoint : provider?.endpoint
    const apiKey = conn.apiKey || provider?.apiKey || ''
    if (!apiKey.trim()) {
      throw new Error('请先在设置中配置 Provider 并填写 API Key')
    }
    const serviceWithConn: McpService = {
      ...service,
      baseUrl: endpoint || DEFAULT_PROVIDER_ENDPOINT,
      apiKey
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

  // ── Skills ──

  ipcMain.handle(
    'skills:catalog:list',
    async (_e, app?: AppId, force?: boolean) => {
      const adapter = getAdapter(app || 'workbuddy')
      if (!adapter.listSkills) {
        throw new Error(`${adapter.name} 尚不支持 Skill 仓储`)
      }
      return adapter.listSkills(Boolean(force))
    }
  )

  ipcMain.handle(
    'skills:set-enabled',
    async (_e, app?: AppId, id?: string, enabled?: boolean) => {
      if (!id || typeof enabled !== 'boolean') {
        throw new Error('Skill 开关参数无效')
      }
      const adapter = getAdapter(app || 'workbuddy')
      if (!adapter.setSkillEnabled) {
        throw new Error(`${adapter.name} 尚不支持 Skill 开关`)
      }
      return adapter.setSkillEnabled(id, enabled)
    }
  )

  ipcMain.handle(
    'skills:update',
    async (_e, app?: AppId, id?: string) => {
      if (!id) throw new Error('Skill 更新参数无效')
      const adapter = getAdapter(app || 'workbuddy')
      if (!adapter.updateSkill) {
        throw new Error(`${adapter.name} 尚不支持 Skill 在线更新`)
      }
      return adapter.updateSkill(id)
    }
  )

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

  ipcMain.handle('models:disable', async (_e, id: string) => {
    const result = await disableModelForApp(id)
    rebuildTrayMenu(getMainWindow)
    return result
  })

  ipcMain.handle('models:lastSyncAt', () => getLastSyncAt())

  // ── Sessions ──

  ipcMain.handle('sessions:list', async (_e, app: AppId) => {
    const adapter = getAdapter(app)
    if (!adapter.listSessions) {
      throw new Error(`${adapter.name} 尚不支持会话管理`)
    }
    return adapter.listSessions()
  })

  ipcMain.handle(
    'sessions:messages',
    async (_e, app: AppId, sessionId: string, opts?: SessionMessagesOptions) => {
      const adapter = getAdapter(app)
      if (!adapter.readSessionMessages) {
        throw new Error(`${adapter.name} 尚不支持会话消息读取`)
      }
      return adapter.readSessionMessages(sessionId, opts)
    }
  )

  ipcMain.handle('sessions:delete', async (_e, app: AppId, sessionId: string) => {
    const adapter = getAdapter(app)
    if (!adapter.deleteSession) {
      throw new Error(`${adapter.name} 尚不支持会话删除`)
    }
    const result = await adapter.deleteSession(sessionId)
    if (result.ok) rebuildTrayMenu(getMainWindow)
    return result
  })

  // ── Session Archive（会话归档 → AI 能力平台）──
  ipcMain.handle('sessions:archiveState', () => getSessionArchiveState())

  ipcMain.handle('sessions:archiveNow', async () => runSessionArchiveNow())

  // ── Prompts（提示词管理：个人提示词 + 公司模板，均走 AI 能力平台） ──

  ipcMain.handle('prompts:list', () => listPlatformMyPrompts())

  ipcMain.handle('prompts:listTemplates', () => listPlatformPromptTemplates())

  ipcMain.handle(
    'prompts:create',
    (_e, input: Omit<Prompt, 'id' | 'createdAt' | 'updatedAt'>) => createPlatformMyPrompt(input)
  )

  ipcMain.handle(
    'prompts:update',
    (_e, id: string, patch: Partial<Omit<Prompt, 'id' | 'createdAt'>>) =>
      updatePlatformMyPrompt(id, patch)
  )

  ipcMain.handle('prompts:delete', (_e, id: string) => deletePlatformMyPrompt(id))

  // ── Assets（生成记录）──
  ipcMain.handle('assets:list', () => listAssetRecords())

  ipcMain.handle('assets:retry', (_e, id: string) => retryAssetRecord(id))

  ipcMain.handle('assets:delete', (_e, id: string) => {
    deleteAssetRecord(id)
    return true
  })

  ipcMain.handle('assets:signUrl', (_e, id: string) => signAssetRecordUrl(id))

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
