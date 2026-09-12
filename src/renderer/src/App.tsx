import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
  UpdateState,
  GithubAccelerationResult
} from '../../shared/types'
import {
  BUILTIN_MCP_IMAGE_DEFAULTS,
  BUILTIN_MCP_VIDEO_DEFAULTS
} from '../../shared/types'

type TabId = 'provide' | 'mcp' | 'skill'

function TabIcon({ id }: { id: TabId }) {
  if (id === 'provide') {
    return (
      <svg className="tab-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M3 3h8v8H3V3zm10 0h8v8h-8V3zM3 13h8v8H3v-8zm10 0h8v8h-8v-8z" />
      </svg>
    )
  }
  if (id === 'mcp') {
    return (
      <svg className="tab-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M22.7 19.3 15.8 12.4c.6-1.5.3-3.3-.9-4.5-1.4-1.4-3.6-1.6-5.2-.6l2.8 2.8-2.8 2.8-2.8-2.8c-1 1.6-.8 3.8.6 5.2 1.2 1.2 3 1.5 4.5.9l6.9 6.9c.4.4 1 .4 1.4 0l2.4-2.4c.4-.4.4-1 0-1.4z" />
      </svg>
    )
  }
  return (
    <svg className="tab-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M20.5 11H19V7c0-1.1-.9-2-2-2h-4V3.5C13 2.12 11.88 1 10.5 1S8 2.12 8 3.5V5H4c-1.1 0-2 .9-2 2v3.8h1.5c1.49 0 2.7 1.21 2.7 2.7s-1.21 2.7-2.7 2.7H2V20c0 1.1.9 2 2 2h3.8v-1.5c0-1.49 1.21-2.7 2.7-2.7s2.7 1.21 2.7 2.7V22H17c1.1 0 2-.9 2-2v-4h1.5c1.38 0 2.5-1.12 2.5-2.5S21.88 11 20.5 11z" />
    </svg>
  )
}

const TABS: { id: TabId; label: string }[] = [
  { id: 'provide', label: '模型管理' },
  { id: 'mcp', label: '工具管理' },
  { id: 'skill', label: '技能管理' }
]

type FormState = {
  name: string
  endpoint: string
  apiKey: string
  rawApiKey?: string
  wireApi: 'responses' | 'chat_completions'
  vendor: string
}

/** API Key 脱敏：保留前3位+后4位，中间掩码。如 sk-proj-abc1234 → sk-****1234 */
function maskApiKey(key: string): string {
  if (!key) return ''
  const trimmed = key.trim()
  if (trimmed.length <= 8) return '******'
  return `${trimmed.slice(0, 3)}****${trimmed.slice(-4)}`
}

const emptyForm = (): FormState => ({
  name: 'dst',
  endpoint: 'https://dst-ai.com',
  apiKey: '',
  rawApiKey: undefined,
  wireApi: 'chat_completions',
  vendor: 'dst'
})

function isMcpEnabledForApp(service: McpService, app: AppId): boolean {
  return Boolean(service.enabledApps?.includes(app))
}

export default function App() {
  const [activeTab, setActiveTab] = useState<TabId>('provide')
  const [apps, setApps] = useState<AppInfo[]>([])
  const [currentApp, setCurrentApp] = useState<AppId>('workbuddy')
  const [providers, setProviders] = useState<Provider[]>([])
  const [dataDir, setDataDir] = useState('')
  const [version, setVersion] = useState('')
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [githubBusy, setGithubBusy] = useState(false)
  const [form, setForm] = useState<FormState>(emptyForm())
  const [busy, setBusy] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [toast, setToast] = useState<{
    text: string
    error?: boolean
  } | null>(null)

  // Auto Update
  const [update, setUpdate] = useState<UpdateState | null>(null)
  const [updateBusy, setUpdateBusy] = useState(false)

  // Models
  const [models, setModels] = useState<Model[]>([])
  const [lastSyncAt, setLastSyncAt] = useState<string | undefined>()
  const [modelSearch, setModelSearch] = useState('')
  const [modelPage, setModelPage] = useState(1)
  const [showModelSettings, setShowModelSettings] = useState(false)
  const [editingModel, setEditingModel] = useState<Model | null>(null)
  const [modelConfig, setModelConfig] = useState<ModelConfig>({})
  const MODELS_PER_PAGE = 12

  // MCP Services
  const [mcpServices, setMcpServices] = useState<McpService[]>([])
  const didFullRefreshRef = useRef(false)

  const currentMeta = useMemo(
    () => apps.find((a) => a.id === currentApp),
    [apps, currentApp]
  )

  const appProviders = useMemo(
    () => providers.filter((provider) => provider.app === currentApp),
    [providers, currentApp]
  )

  const showToast = useCallback((text: string, error = false) => {
    setToast({ text, error })
    window.setTimeout(() => setToast(null), 3200)
  }, [])

  const refresh = useCallback(async () => {
    const [appList, providerList, dir, ver, appSettings, mcpList, modelList, syncTime] = await Promise.all([
      window.dst.listApps(),
      window.dst.listProviders(),
      window.dst.getDataDir(),
      window.dst.getVersion(),
      window.dst.getSettings(),
      window.dst.listMcpServices(),
      window.dst.listModels(currentApp),
      window.dst.getLastSyncAt()
    ])
    setApps(appList)
    setProviders(providerList)
    setDataDir(dir)
    setVersion(ver)
    setSettings(appSettings)
    setMcpServices(mcpList)
    setModels(modelList)
    setLastSyncAt(syncTime)
  }, [currentApp])

  useEffect(() => {
    if (didFullRefreshRef.current) return
    didFullRefreshRef.current = true
    refresh().catch((err) =>
      showToast(err instanceof Error ? err.message : String(err), true)
    )
  }, [refresh, showToast])

  // 切换应用只刷新轻量数据，避免重新探测所有应用。
  useEffect(() => {
    if (apps.length === 0) return
    Promise.all([
      window.dst.listProviders(),
      window.dst.listModels(currentApp),
      window.dst.getLastSyncAt()
    ])
      .then(([providerList, modelList, syncTime]) => {
        setProviders(providerList)
        setModels(modelList)
        setLastSyncAt(syncTime)
      })
      .catch((err) =>
        showToast(err instanceof Error ? err.message : String(err), true)
      )
  }, [currentApp, apps.length, showToast])

  useEffect(() => {
    return window.dst.onDeepLinkImported(() => {
      refresh()
      showToast('已通过 Deep Link 导入 Provider')
    })
  }, [refresh, showToast])

  // Auto Update：初始化状态 + 订阅主进程推送
  useEffect(() => {
    window.dst
      .getUpdateState()
      .then(setUpdate)
      .catch(() => {})
    return window.dst.onUpdateEvent(setUpdate)
  }, [])

  const onCheckUpdate = async () => {
    setUpdateBusy(true)
    try {
      let s = await window.dst.checkForUpdate(true)
      setUpdate(s)
      if (s.status === 'available') {
        showToast(`发现新版本 v${s.version}，开始下载`)
        s = await window.dst.downloadUpdate()
        setUpdate(s)
        if (s.status === 'downloaded') {
          showToast('下载完成，可点击「重启安装」')
        }
      } else if (s.status === 'up-to-date') {
        showToast('已是最新版本')
      } else if (s.status === 'error' || s.status === 'unsupported') {
        showToast(s.error || '检查更新失败', true)
      } else if (s.status === 'downloaded') {
        showToast('更新已就绪，请重启安装')
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), true)
    } finally {
      setUpdateBusy(false)
    }
  }

  const onDownloadUpdate = async () => {
    setUpdateBusy(true)
    try {
      const s = await window.dst.downloadUpdate()
      setUpdate(s)
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), true)
    } finally {
      setUpdateBusy(false)
    }
  }

  const onInstallUpdate = () => {
    void window.dst.installUpdate()
  }

  const loadSettingsForm = useCallback((appSettings: AppSettings | null, providerList: Provider[]) => {
    const existing = providerList[0]
    const apiKey = appSettings?.providerApiKey || existing?.apiKey || ''
    setForm({
      name: appSettings?.providerName || existing?.name || 'dst',
      endpoint: appSettings?.providerEndpoint || existing?.endpoint || 'https://dst-ai.com',
      apiKey: apiKey ? maskApiKey(apiKey) : '',
      rawApiKey: apiKey || undefined,
      wireApi: appSettings?.providerWireApi || existing?.wireApi || 'chat_completions',
      vendor: appSettings?.providerVendor || existing?.vendor || 'dst'
    })
  }, [])

  useEffect(() => {
    if (showSettings) {
      loadSettingsForm(settings, providers)
    }
  }, [showSettings, settings, providers, loadSettingsForm])

  const saveSettingsProvider = async () => {
    const finalApiKey = form.apiKey.includes('****')
      ? form.rawApiKey || ''
      : form.apiKey.trim()
    if (!finalApiKey) {
      showToast('请填写 API Key', true)
      return
    }
    setBusy(true)
    try {
      const next = await window.dst.updateSettings({
        providerName: form.name.trim() || 'dst',
        providerEndpoint: form.endpoint.trim() || 'https://dst-ai.com',
        providerApiKey: finalApiKey,
        providerWireApi: form.wireApi,
        providerVendor: form.vendor.trim() || 'dst'
      })
      setSettings(next)
      showToast('Provider 配置已保存')
      await refresh()
      const list = await window.dst.listMcpServices()
      for (const s of list.filter((item) => item.builtin && !item.running)) {
        try {
          await window.dst.startMcpService(s.id, currentApp)
        } catch {
          /* 无 Key 或已占用时忽略 */
        }
      }
      await refresh()
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), true)
    } finally {
      setBusy(false)
    }
  }

  const toggleLaunchAtLogin = async () => {
    if (!settings) return
    try {
      const next = await window.dst.updateSettings({
        launchAtLogin: !settings.launchAtLogin
      })
      setSettings(next)
      showToast(next.launchAtLogin ? '已开启开机启动' : '已关闭开机启动')
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), true)
    }
  }

  // 刷新模型列表
  const onSyncModels = async () => {
    const endpoint = settings?.providerEndpoint || appProviders[0]?.endpoint || providers[0]?.endpoint
    const apiKey = settings?.providerApiKey || appProviders[0]?.apiKey || providers[0]?.apiKey
    if (!endpoint || !apiKey?.trim()) {
      showToast('请先在设置中配置 Provider', true)
      setShowSettings(true)
      return
    }

    setSyncing(true)
    try {
      let providerId: string
      const existing = appProviders[0]
      const patch = {
        name: settings?.providerName || 'dst',
        endpoint,
        apiKey,
        wireApi: settings?.providerWireApi || 'chat_completions',
        vendor: settings?.providerVendor || 'dst'
      }
      if (existing) {
        await window.dst.updateProvider(existing.id, patch)
        providerId = existing.id
      } else {
        const created = await window.dst.createProvider({
          ...patch,
          app: currentApp
        })
        providerId = created.id
      }

      const result = await window.dst.syncModels(
        providerId,
        currentApp,
        endpoint,
        apiKey
      )

      if (result.ok) {
        showToast(`已同步 ${result.count} 个模型`)
      } else {
        showToast(result.message, true)
      }
      await refresh()
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), true)
    } finally {
      setSyncing(false)
    }
  }

  const toggleGithubAcceleration = async () => {
    if (!settings) return
    setGithubBusy(true)
    try {
      const result: GithubAccelerationResult = await window.dst.toggleGithubAcceleration(
        !settings.githubAccelerationEnabled
      )
      setSettings(await window.dst.getSettings())
      showToast(result.message, !result.ok)
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), true)
    } finally {
      setGithubBusy(false)
    }
  }

  // 启用模型
  const onEnableModel = async (id: string) => {
    setBusy(true)
    try {
      const result: ApplyResult = await window.dst.enableModel(id, currentApp)
      showToast(result.message, !result.ok)
      await refresh()
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), true)
    } finally {
      setBusy(false)
    }
  }

  // 停用模型
  const onDisableModel = async (id: string) => {
    setBusy(true)
    try {
      await window.dst.disableModel(id)
      showToast('模型已停用')
      await refresh()
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), true)
    } finally {
      setBusy(false)
    }
  }

  // 打开模型设置
  const openModelSettings = (model: Model) => {
    setEditingModel(model)
    setModelConfig({ ...model.config })
    setShowModelSettings(true)
  }

  // 保存模型设置
  const saveModelSettings = async () => {
    if (!editingModel) return
    setBusy(true)
    try {
      await window.dst.updateModelConfig(editingModel.id, modelConfig)
      showToast('设置已保存')
      setShowModelSettings(false)
      await refresh()
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), true)
    } finally {
      setBusy(false)
    }
  }

  // 过滤和分页
  const filteredModels = useMemo(() => {
    const q = modelSearch.trim().toLowerCase()
    if (!q) return models
    return models.filter((m) => 
      m.modelId.toLowerCase().includes(q) || 
      (m.name && m.name.toLowerCase().includes(q))
    )
  }, [models, modelSearch])

  const paginatedModels = useMemo(() => {
    const start = (modelPage - 1) * MODELS_PER_PAGE
    return filteredModels.slice(start, start + MODELS_PER_PAGE)
  }, [filteredModels, modelPage])

  const totalPages = useMemo(() => {
    return Math.ceil(filteredModels.length / MODELS_PER_PAGE)
  }, [filteredModels])

  const onLaunch = async () => {
    setBusy(true)
    try {
      const result = await window.dst.launchApp(currentApp)
      const message = result?.message || '已尝试启动应用'
      showToast(message)
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), true)
    } finally {
      setBusy(false)
    }
  }

  const onDownload = async (app: AppInfo) => {
    try {
      await window.dst.downloadApp(app.id)
      showToast(`已打开 ${app.name} 官方下载页面`)
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), true)
    }
  }

  // ── MCP Service Operations ──

  // 每次操作前重新拉取最新状态，避免陈旧 UI 状态导致误操作
  const getFreshMcpService = async (id: string): Promise<McpService | undefined> => {
    const list = await window.dst.listMcpServices()
    return list.find((s) => s.id === id)
  }

  const onMcpStart = async (s: McpService) => {
    setBusy(true)
    try {
      const fresh = (await getFreshMcpService(s.id)) ?? s
      // 状态验证：已运行则拒绝重复启动
      if (fresh.running) {
        showToast(`${fresh.name} 已在运行中（端口 :${fresh.port}）`, true)
        return
      }
      const apiKey = settings?.providerApiKey || appProviders[0]?.apiKey || providers[0]?.apiKey
      if (!apiKey?.trim()) {
        showToast('请先在设置中配置 Provider 并填写 API Key', true)
        setShowSettings(true)
        return
      }
      await window.dst.startMcpService(s.id, currentApp)
      showToast(`已启动 ${s.name}`)
      await refresh()
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), true)
    } finally {
      setBusy(false)
    }
  }

  const onMcpEnable = async (s: McpService, enabled: boolean) => {
    setBusy(true)
    try {
      const result = await window.dst.enableMcpService(s.id, enabled, currentApp)
      showToast(result.message, !result.ok)
      await refresh()
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), true)
    } finally {
      setBusy(false)
    }
  }

  const builtinMcpServices = useMemo(
    () => mcpServices.filter((s) => s.builtin),
    [mcpServices]
  )

  const currentAppMcpServices = useMemo(
    () =>
      builtinMcpServices.map((service) => ({
        ...service,
        enabledForCurrentApp: isMcpEnabledForApp(service, currentApp)
      })),
    [builtinMcpServices, currentApp]
  )

  const onMcpStop = async (s: McpService) => {
    setBusy(true)
    try {
      const fresh = (await getFreshMcpService(s.id)) ?? s
      // 状态验证：未运行则拒绝停止
      if (!fresh.running) {
        showToast(`${fresh.name} 未在运行`, true)
        return
      }
      await window.dst.stopMcpService(s.id)
      showToast(`已停止 ${s.name}`)
      await refresh()
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="app">
      <div className={`layout ${showSettings ? 'settings-layout' : ''}`}>
        {/* ── Left Sidebar: App List ── */}
        {!showSettings && (
          <aside className="sidebar">
            <h3>应用</h3>
            <div className="sidebar-apps">
              {apps.map((app) => (
                <div
                  key={app.id}
                  className={`app-item-row ${currentApp === app.id ? 'active' : ''} ${!app.implemented ? 'disabled' : ''}`}
                >
                  <button
                    className="app-item"
                    onClick={() => setCurrentApp(app.id)}
                    disabled={!app.implemented}
                  >
                    <div>{app.name}</div>
                    <div className="meta">
                      {app.implemented ? (
                        <span className={`badge ${app.installed ? 'ok' : 'warn'}`}>
                          {app.installed ? '已安装' : '未检测到'}
                        </span>
                      ) : (
                        <span className="badge">集成中</span>
                      )}
                    </div>
                  </button>
                  {app.downloadUrl && (
                    <button
                      className="app-download"
                      title={`下载 ${app.name}`}
                      aria-label={`下载 ${app.name}`}
                      onClick={() => onDownload(app)}
                    >
                      ↓
                    </button>
                  )}
                </div>
              ))}
            </div>
            <div className="sidebar-footer">
              <span>v{version || '…'}</span>
              <button
                className={`settings-entry ${showSettings ? 'active' : ''}`}
                onClick={() => setShowSettings(true)}
                title="设置"
                aria-label="设置"
              >
                设置
              </button>
            </div>
          </aside>
        )}

        {/* ─ Right Panel: Tab Content ── */}
        <main className={`panel ${showSettings ? 'settings-panel' : ''}`}>
          {showSettings ? (
            <>
              <div className="panel-head">
                <div>
                  <h2>设置</h2>
                  <div className="sub" style={{ color: 'var(--muted)', fontSize: 13 }}>
                    Provider、MCP 服务、版本更新与窗口行为
                  </div>
                </div>
                <div className="actions">
                  <button className="btn primary settings-btn" onClick={() => setShowSettings(false)}>
                    ← 返回主页
                  </button>
                </div>
              </div>
              <div className="panel-body settings-page">
                <section className="settings-section">
                  <h3>版本更新</h3>
                  <p className="settings-desc">当前版本：v{version || '…'} · 检查并安装最新版本。</p>
                  <div className="actions settings-actions">
                    <button
                      className="btn primary settings-btn"
                      onClick={onCheckUpdate}
                      disabled={updateBusy}
                    >
                      {updateBusy && update?.status === 'checking' ? '检查中…' : '获取最新版本并更新'}
                    </button>
                    {update?.status === 'available' && (
                      <button
                        className="btn primary settings-btn"
                        onClick={onDownloadUpdate}
                        disabled={updateBusy}
                      >
                        下载 v{update.version}
                      </button>
                    )}
                    {update?.status === 'downloaded' && (
                      <button className="btn primary settings-btn" onClick={onInstallUpdate}>
                        重启安装
                      </button>
                    )}
                  </div>
                  {update && update.status !== 'idle' && (
                    <div
                      className={`update-banner ${
                        update.status === 'error' || update.status === 'unsupported'
                          ? 'error'
                          : ''
                      }`}
                      style={{ marginTop: 12 }}
                    >
                      <div className="update-info">
                        {update.status === 'checking' && <span>正在检查更新…</span>}
                        {update.status === 'available' && (
                          <span>
                            发现新版本 <b>v{update.version}</b>（当前 v{version}）
                          </span>
                        )}
                        {update.status === 'downloading' && (
                          <span>正在下载 v{update.version}… {update.percent ?? 0}%</span>
                        )}
                        {update.status === 'downloaded' && (
                          <span>v{update.version} 已下载完成，点击「重启安装」</span>
                        )}
                        {update.status === 'up-to-date' && (
                          <span>已是最新版本 v{version}</span>
                        )}
                        {update.status === 'error' && (
                          <span>检查更新失败：{update.error}</span>
                        )}
                        {update.status === 'unsupported' && (
                          <span>{update.error}</span>
                        )}
                      </div>
                      {update.status === 'downloading' && (
                        <div className="update-progress">
                          <div
                            className="update-progress-bar"
                            style={{ width: `${update.percent ?? 0}%` }}
                          />
                        </div>
                      )}
                    </div>
                  )}
                </section>

                <section className="settings-section">
                  <h3>Provider 配置</h3>
                  <p className="settings-desc">所有应用共用这份大算头连接信息；保存后自动同步，无需按应用单独配置。</p>
                  <div className="form">
                    <div className="field">
                      <label>名称</label>
                      <input value={form.name} readOnly disabled />
                    </div>
                    <div className="field">
                      <label>Base URL</label>
                      <input value={form.endpoint} readOnly disabled />
                    </div>
                    <div className="field">
                      <label>API Key</label>
                      <input
                        type="password"
                        value={form.apiKey}
                        onChange={(e) =>
                          setForm((s) => ({
                            ...s,
                            apiKey: e.target.value,
                            rawApiKey: e.target.value === s.apiKey ? s.rawApiKey : undefined
                          }))
                        }
                        placeholder="sk-..."
                      />
                    </div>
                    <div className="actions settings-actions">
                      <button
                        className="btn settings-btn"
                        disabled={busy || !form.apiKey.trim()}
                        onClick={async () => {
                          setBusy(true)
                          try {
                            const testKey = form.apiKey.includes('****')
                              ? form.rawApiKey || ''
                              : form.apiKey.trim()
                            if (!testKey) {
                              showToast('请填写 API Key', true)
                              return
                            }
                            const result: SpeedTestResult = await window.dst.speedTest(
                              form.endpoint,
                              testKey
                            )
                            if (result.ok) {
                              showToast(`连接成功 ${result.latencyMs}ms`)
                            } else {
                              showToast(`连接失败：${result.error || result.status}`, true)
                            }
                          } catch (err) {
                            showToast(err instanceof Error ? err.message : String(err), true)
                          } finally {
                            setBusy(false)
                          }
                        }}
                      >
                        测试连接
                      </button>
                      <button
                        className="btn primary settings-btn"
                        disabled={busy}
                        onClick={saveSettingsProvider}
                      >
                        保存配置
                      </button>
                    </div>
                  </div>
                </section>

                <section className="settings-section">
                  <h3>GitHub 加速</h3>
                  <p className="settings-desc">解析 GitHub 相关 IP，并写入本机 hosts 托管配置块。</p>
                  <div className="settings-switch-row">
                    <span>GitHub 加速</span>
                    <button
                      type="button"
                      className={`switch ${settings?.githubAccelerationEnabled ? 'on' : ''}`}
                      role="switch"
                      aria-checked={Boolean(settings?.githubAccelerationEnabled)}
                      aria-label="GitHub 加速"
                      onClick={toggleGithubAcceleration}
                      disabled={githubBusy}
                    >
                      <span className="switch-knob" />
                    </button>
                  </div>
                </section>

                <section className="settings-section">
                  <h3>MCP 设置</h3>
                  <p className="settings-desc">启动或停止本机 MCP HTTP 服务。打开软件后会自动启动，无需手动点击。</p>
                  {builtinMcpServices.length === 0 ? (
                    <div className="empty">暂无内置 MCP 服务</div>
                  ) : (
                    <div className="list">
                      {builtinMcpServices.map((s) => (
                        <div
                          key={s.id}
                          className={`card builtin-card ${s.running ? 'enabled' : ''}`}
                        >
                          <div>
                            <h4>
                              {s.name}
                              <span className="badge builtin">内置</span>
                              {s.running ? (
                                <span className="badge ok">运行中 :{s.port}</span>
                              ) : (
                                <span className="badge">未运行</span>
                              )}
                            </h4>
                            <div className="row settings-actions">
                              <button
                                className="btn primary settings-btn"
                                disabled={busy}
                                onClick={() => onMcpStart(s)}
                              >
                                启动服务
                              </button>
                              <button
                                className="btn danger settings-btn"
                                disabled={busy}
                                onClick={() => onMcpStop(s)}
                              >
                                停止服务
                              </button>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </section>

                <section className="settings-section">
                  <h3>窗口行为</h3>
                  <p className="settings-desc">设置是否在系统登录后自动启动本应用。</p>
                  <div className="settings-switch-row">
                    <span>开机启动</span>
                    <button
                      type="button"
                      className={`switch ${settings?.launchAtLogin ? 'on' : ''}`}
                      role="switch"
                      aria-checked={Boolean(settings?.launchAtLogin)}
                      aria-label="开机启动"
                      onClick={toggleLaunchAtLogin}
                    >
                      <span className="switch-knob" />
                    </button>
                  </div>
                </section>
              </div>
            </>
          ) : (
            <>
          {/* ── Tab Bar ── */}
          <div className="tab-bar">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                className={`tab-item ${activeTab === tab.id ? 'active' : ''}`}
                onClick={() => setActiveTab(tab.id)}
              >
                <span className="tab-icon-wrap">
                  <TabIcon id={tab.id} />
                </span>
                {tab.label}
              </button>
            ))}
          </div>

          {/* ── Provide Tab ── */}
          {activeTab === 'provide' && (
            <>
              <div className="panel-head">
                <div>
                  <h2>{currentMeta?.name || currentApp}</h2>
                  <div className="sub" style={{ color: 'var(--muted)', fontSize: 12 }}>
                    {currentMeta?.implemented
                      ? currentMeta.configPath || currentMeta.message
                      : '适配器框架已预留，写入逻辑尚未实现'}
                  </div>
                </div>
                <div className="actions">
                  {currentMeta?.downloadUrl && !currentMeta.installed && (
                    <button
                      className="btn"
                      onClick={() => onDownload(currentMeta)}
                      disabled={busy}
                    >
                      ↓ 下载应用
                    </button>
                  )}
                  {currentMeta?.implemented && (
                    <>
                    <button
                      className="btn primary"
                      onClick={onSyncModels}
                      disabled={busy || syncing}
                    >
                      <svg
                        className="btn-icon"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        aria-hidden="true"
                      >
                        <path d="M12 5v14M5 12h14" />
                      </svg>
                      {syncing ? '同步中...' : '获取模型列表'}
                    </button>
                    <button className="btn" onClick={onLaunch} disabled={busy}>
                      <svg
                        className="btn-icon"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <path d="M14 3h7v7" />
                        <path d="M10 14 21 3" />
                        <path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" />
                      </svg>
                      打开应用
                    </button>
                    </>
                  )}
                </div>
              </div>

              {currentApp === 'codex' && (
                <div className="feature-banner">
                  <div>
                    <strong>纯 API 模式</strong>
                    <span>无需 OpenAI 账号；启用后由大算头 Provider 提供模型。</span>
                  </div>
                </div>
              )}

              <div className="panel-body">
                {!currentMeta?.implemented ? (
                  <div className="empty">
                    {currentMeta?.name} 仅搭建框架，启用写入将在后续版本实现。
                  </div>
                ) : models.length === 0 ? (
                  <div className="empty">
                    <div className="empty-icon">📦</div>
                    <div>
                      {settings?.providerApiKey || appProviders.length > 0
                        ? '暂无模型。点击「获取模型列表」同步可用模型。'
                        : '还没有配置 Provider。请先到设置中配置，再点击「获取模型列表」。'}
                    </div>
                  </div>
                ) : (
                  <>
                    {/* 搜索和刷新按钮 */}
                    <div className="model-toolbar">
                      <input
                        type="text"
                        className="search-input"
                        placeholder="搜索模型..."
                        value={modelSearch}
                        onChange={(e) => {
                          setModelSearch(e.target.value)
                          setModelPage(1)
                        }}
                      />
                      <button
                        className="btn"
                        onClick={onSyncModels}
                        disabled={syncing}
                      >
                        {syncing ? '同步中...' : '🔄 刷新模型清单'}
                      </button>
                    </div>
                    
                    {/* 最后更新时间 + 模型统计 */}
                    <div className="sync-info">
                      <span>
                        最后更新：{lastSyncAt ? new Date(lastSyncAt).toLocaleString('zh-CN') : '—'}
                      </span>
                      <span className="sync-stats">
                        模型总数：{models.length}　已启用：{models.filter((m) => m.enabled).length}
                      </span>
                    </div>

                    {/* 模型列表 */}
                    <div className="model-grid">
                      {paginatedModels.map((model) => (
                        <div
                          key={model.id}
                          className={`model-card ${model.enabled ? 'enabled' : ''}`}
                        >
                          <div className="model-card-header">
                            <h4>{model.name || model.modelId}</h4>
                            {model.enabled && <span className="badge ok">已启用</span>}
                          </div>
                          <div className="model-card-body">
                            <div className="model-id">{model.modelId}</div>
                            {model.contextWindow && (
                              <div className="model-meta">
                                上下文：{(model.contextWindow / 1000).toFixed(0)}K
                              </div>
                            )}
                            <div className="model-features">
                              {model.supportsVision && <span className="feature-tag">👁 视觉</span>}
                              {model.supportsFunctionCalling && <span className="feature-tag">🔧 工具调用</span>}
                            </div>
                          </div>
                          <div className="model-card-actions">
                            {model.enabled ? (
                              <button
                                className="btn danger"
                                disabled={busy}
                                onClick={() => onDisableModel(model.id)}
                              >
                                停用
                              </button>
                            ) : (
                              <button
                                className="btn primary"
                                disabled={busy}
                                onClick={() => onEnableModel(model.id)}
                              >
                                启用
                              </button>
                            )}
                            <button
                              className="btn"
                              disabled={busy}
                              onClick={() => openModelSettings(model)}
                            >
                              设置
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>

                    {/* 分页 */}
                    {totalPages > 1 && (
                      <div className="pagination">
                        <button
                          className="btn"
                          disabled={modelPage === 1}
                          onClick={() => setModelPage(modelPage - 1)}
                        >
                          上一页
                        </button>
                        <span className="page-info">
                          {modelPage} / {totalPages}
                        </span>
                        <button
                          className="btn"
                          disabled={modelPage === totalPages}
                          onClick={() => setModelPage(modelPage + 1)}
                        >
                          下一页
                        </button>
                      </div>
                    )}
                  </>
                )}
              </div>
            </>
          )}

          {/* ── MCP Tab ── */}
          {activeTab === 'mcp' && (
            <>
              <div className="panel-head">
                <div>
                  <h2>工具管理</h2>
                  <div className="sub" style={{ color: 'var(--muted)', fontSize: 12 }}>
                    按应用独立启用；当前写入 {currentMeta?.name || currentApp}
                  </div>
                </div>
              </div>
              <div className="panel-body">
                {builtinMcpServices.length === 0 ? (
                  <div className="empty">
                    <div className="empty-icon">🔌</div>
                    <div>暂无内置 MCP 服务。</div>
                  </div>
                ) : (
                  <div className="list">
                    {currentAppMcpServices.map((s) => (
                      <div
                        key={s.id}
                        className={`card builtin-card ${s.enabledForCurrentApp ? 'enabled' : ''}`}
                      >
                        <div>
                          <h4>
                            {s.name}
                            <span className="badge builtin">内置</span>
                            {s.enabledForCurrentApp ? (
                              <span className="badge ok">当前应用已启用</span>
                            ) : (
                              <span className="badge">当前应用未启用</span>
                            )}
                          </h4>
                          <div className="sub">
                            服务商：
                            {s.provider === 'dst'
                              ? '大算头'
                              : s.provider === 'gemini-3-pro-image'
                                ? 'Gemini 3 Pro Image'
                                : s.provider === 'gpt-image-2'
                                  ? 'GPT Image 2'
                                  : s.provider === 'doubao-seedance-2.0'
                                    ? '豆包 Seedance 2.0'
                                    : '自定义'}
                          </div>
                          <div className="sub">
                            {s.type === 'file-upload'
                              ? '支持输入：'
                              : s.type === '3d-generation'
                                ? '支持任务：'
                                : '支持模型：'}
                            {s.type === 'video-generation'
                              ? BUILTIN_MCP_VIDEO_DEFAULTS.models.join(' / ')
                              : s.type === 'file-upload'
                                ? '腾讯 COS / 阿里 OSS；本地路径 / Base64 文件'
                                : s.type === '3d-generation'
                                  ? '文生 / 图生 / 多视图 / 任务查询'
                                  : BUILTIN_MCP_IMAGE_DEFAULTS.models.join(' / ')}
                            {s.type === 'file-upload'
                              ? '（file_path / content 二选一）'
                              : s.type === '3d-generation'
                                ? '（统一模型）'
                                : '（请求时按参数选择）'}
                          </div>
                          <div className="row mcp-actions">
                            <button
                              className="btn primary"
                              disabled={busy}
                              onClick={() => onMcpEnable(s, true)}
                            >
                              启用
                            </button>
                            <button
                              className="btn danger"
                              disabled={busy}
                              onClick={() => onMcpEnable(s, false)}
                            >
                              停用
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}

          {/* ── Skill Tab ── */}
          {activeTab === 'skill' && (
            <>
              <div className="panel-head">
                <div>
                  <h2>技能管理</h2>
                  <div className="sub" style={{ color: 'var(--muted)', fontSize: 12 }}>
                    管理 {currentMeta?.name || currentApp} 的可复用 AI 技能模板
                  </div>
                </div>
              </div>
              <div className="panel-body">
                <div className="empty">
                  <div className="empty-icon">🧩</div>
                  <div>Skill 技能管理框架已搭建，具体实现将在后续版本完成。</div>
                  <div className="sub" style={{ marginTop: 8 }}>
                    支持自定义 Prompt 模板、工具链编排等技能。
                  </div>
                </div>
              </div>
            </>
          )}
            </>
          )}

          <p className="footer-note">
            大算头适配器 v{version || '…'} · 本地数据目录：{dataDir || '...'}
            （备份在 backups/ 下）
          </p>
        </main>
      </div>


      {/* 模型设置弹窗 */}
      {showModelSettings && editingModel && (
        <div className="modal-backdrop" onClick={() => setShowModelSettings(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>模型设置 - {editingModel.name || editingModel.modelId}</h3>
            <div className="form">
              <div className="field">
                <label>上下文窗口 (tokens)</label>
                <input
                  type="number"
                  value={modelConfig.contextWindow || editingModel.contextWindow || ''}
                  onChange={(e) =>
                    setModelConfig((s) => ({ ...s, contextWindow: Number(e.target.value) || undefined }))
                  }
                  placeholder="例如：128000"
                />
              </div>
              <div className="field">
                <label>最大输出 tokens</label>
                <input
                  type="number"
                  value={modelConfig.maxTokens || ''}
                  onChange={(e) =>
                    setModelConfig((s) => ({ ...s, maxTokens: Number(e.target.value) || undefined }))
                  }
                  placeholder="例如：4096"
                />
              </div>
              <div className="field">
                <label>Temperature</label>
                <input
                  type="number"
                  step="0.1"
                  min="0"
                  max="2"
                  value={modelConfig.temperature ?? ''}
                  onChange={(e) =>
                    setModelConfig((s) => ({ ...s, temperature: Number(e.target.value) || undefined }))
                  }
                  placeholder="0-2"
                />
              </div>
              <div className="field">
                <label>Top P</label>
                <input
                  type="number"
                  step="0.1"
                  min="0"
                  max="1"
                  value={modelConfig.topP ?? ''}
                  onChange={(e) =>
                    setModelConfig((s) => ({ ...s, topP: Number(e.target.value) || undefined }))
                  }
                  placeholder="0-1"
                />
              </div>
              <div className="checks">
                <label>
                  <input
                    type="checkbox"
                    checked={modelConfig.supportsToolCall ?? editingModel.supportsFunctionCalling ?? false}
                    onChange={(e) =>
                      setModelConfig((s) => ({ ...s, supportsToolCall: e.target.checked }))
                    }
                  />
                  支持工具调用
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={modelConfig.supportsImages ?? editingModel.supportsVision ?? false}
                    onChange={(e) =>
                      setModelConfig((s) => ({ ...s, supportsImages: e.target.checked }))
                    }
                  />
                  支持图像输入
                </label>
              </div>
              <div className="actions">
                <button className="btn" onClick={() => setShowModelSettings(false)}>
                  取消
                </button>
                <button
                  className="btn primary"
                  disabled={busy}
                  onClick={saveModelSettings}
                >
                  保存
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div className={`toast ${toast.error ? 'error' : ''}`}>{toast.text}</div>
      )}

    </div>
  )
}
