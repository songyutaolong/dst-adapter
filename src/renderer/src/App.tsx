import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  AppId,
  AppInfo,
  AppSettings,
  ApplyResult,
  Provider,
  SpeedTestResult,
  McpService,
  McpServiceType,
  McpProvider,
  Model,
  ModelConfig,
  UpdateState
} from '../../shared/types'
import { BUILTIN_MCP_IMAGE_DEFAULTS, BUILTIN_MCP_VIDEO_DEFAULTS } from '../../shared/types'

type TabId = 'provide' | 'mcp' | 'skill'

const TABS: { id: TabId; label: string; icon: string }[] = [
  { id: 'provide', label: 'Provider', icon: '⚡' },
  { id: 'mcp', label: 'MCP', icon: '🔌' },
  { id: 'skill', label: 'Skill', icon: '🧩' }
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

export default function App() {
  const [activeTab, setActiveTab] = useState<TabId>('provide')
  const [apps, setApps] = useState<AppInfo[]>([])
  const [currentApp, setCurrentApp] = useState<AppId>('workbuddy')
  const [providers, setProviders] = useState<Provider[]>([])
  const [dataDir, setDataDir] = useState('')
  const [version, setVersion] = useState('')
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<Provider | null>(null)
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
  const [showMcpForm, setShowMcpForm] = useState(false)
  const [editingMcp, setEditingMcp] = useState<McpService | null>(null)
  const [mcpForm, setMcpForm] = useState({
    name: '',
    type: 'image-generation' as McpServiceType,
    provider: 'gemini-3-pro-image' as McpProvider,
    baseUrl: '',
    modelId: '',
    apiKey: ''
  })

  // 连接信息弹窗（MCP 连接信息复用 Provider 的配置）
  const [showConnInfo, setShowConnInfo] = useState(false)
  const [connInfo, setConnInfo] = useState<{ text: string; json: Record<string, unknown> } | null>(null)
  const [copied, setCopied] = useState(false)

  const currentMeta = useMemo(
    () => apps.find((a) => a.id === currentApp),
    [apps, currentApp]
  )

  const showToast = useCallback((text: string, error = false) => {
    setToast({ text, error })
    window.setTimeout(() => setToast(null), 3200)
  }, [])

  const refresh = useCallback(async () => {
    const [appList, providerList, dir, ver, appSettings, mcpList, modelList, syncTime] = await Promise.all([
      window.dst.listApps(),
      window.dst.listProviders(currentApp),
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
    refresh().catch((err) =>
      showToast(err instanceof Error ? err.message : String(err), true)
    )
  }, [refresh, showToast])

  // 切换应用时刷新 providers 和 models
  useEffect(() => {
    if (apps.length === 0) return
    Promise.all([
      window.dst.listProviders(currentApp),
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
      const s = await window.dst.checkForUpdate(true)
      setUpdate(s)
      if (s.status === 'available') {
        showToast(`发现新版本 v${s.version}，点击「下载更新」`)
      } else if (s.status === 'up-to-date') {
        showToast('已是最新版本')
      } else if (s.status === 'error' || s.status === 'unsupported') {
        showToast(s.error || '检查更新失败', true)
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

  const openCreate = () => {
    // 已配置过则反写连接信息；API Key 脱敏显示
    const existing = providers.find((p) => p.app === currentApp)
    setEditing(null)
    setForm({
      name: existing?.name || 'dst',
      endpoint: existing?.endpoint || 'https://dst-ai.com',
      apiKey: existing?.apiKey ? maskApiKey(existing.apiKey) : '',
      rawApiKey: existing?.apiKey || undefined,
      wireApi: existing?.wireApi || 'chat_completions',
      vendor: existing?.vendor || 'dst'
    })
    setShowForm(true)
  }

  const openEdit = (p: Provider) => {
    setEditing(p)
    setForm({
      name: p.name,
      endpoint: p.endpoint,
      apiKey: p.apiKey ? maskApiKey(p.apiKey) : '',
      rawApiKey: p.apiKey || undefined,
      wireApi: p.wireApi || 'chat_completions',
      vendor: p.vendor || 'dst'
    })
    setShowForm(true)
  }

  const saveForm = async () => {
    // 若输入框仍是脱敏态（含掩码），说明未修改，使用原始 Key
    const finalApiKey = form.apiKey.includes('****')
      ? form.rawApiKey || ''
      : form.apiKey.trim()
    if (!finalApiKey) {
      showToast('请填写 API Key', true)
      return
    }
    setBusy(true)
    try {
      let providerId: string
      
      if (editing) {
        await window.dst.updateProvider(editing.id, {
          name: form.name.trim(),
          endpoint: form.endpoint.trim(),
          apiKey: finalApiKey,
          wireApi: form.wireApi,
          vendor: form.vendor.trim() || 'dst'
        })
        providerId = editing.id
        showToast('配置已更新，正在同步模型...')
      } else {
        // 检查是否已存在 provider，如果存在则更新，否则创建
        const existing = providers.find(p => p.app === currentApp)
        if (existing) {
          await window.dst.updateProvider(existing.id, {
            name: form.name.trim(),
            endpoint: form.endpoint.trim(),
            apiKey: finalApiKey,
            wireApi: form.wireApi,
            vendor: form.vendor.trim() || 'dst'
          })
          providerId = existing.id
        } else {
          const newProvider = await window.dst.createProvider({
            name: form.name.trim(),
            app: currentApp,
            endpoint: form.endpoint.trim(),
            apiKey: finalApiKey,
            wireApi: form.wireApi,
            vendor: form.vendor.trim() || 'dst'
          })
          providerId = newProvider.id
        }
        showToast('配置成功，正在同步模型...')
      }
      
      // 同步模型
      setSyncing(true)
      const syncResult = await window.dst.syncModels(
        providerId,
        currentApp,
        form.endpoint.trim(),
        finalApiKey
      )
      
      if (syncResult.ok) {
        showToast(`已同步 ${syncResult.count} 个模型`)
      } else {
        showToast(syncResult.message, true)
      }
      
      setShowForm(false)
      await refresh()
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), true)
    } finally {
      setBusy(false)
      setSyncing(false)
    }
  }

  // 刷新模型列表
  const onSyncModels = async () => {
    const provider = providers.find(p => p.app === currentApp)
    if (!provider) {
      showToast('请先配置 Provider', true)
      return
    }
    
    setSyncing(true)
    try {
      const result = await window.dst.syncModels(
        provider.id,
        currentApp,
        provider.endpoint,
        provider.apiKey
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
      const warn =
        currentApp === 'codex' &&
        result &&
        'injected' in result &&
        result.injected === false &&
        Boolean(settings?.codexEnhancements)
      showToast(message, warn)
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

  const openMcpCreate = () => {
    setEditingMcp(null)
    setMcpForm({
      name: '',
      type: 'image-generation',
      provider: 'gemini-3-pro-image',
      baseUrl: '',
      modelId: '',
      apiKey: ''
    })
    setShowMcpForm(true)
  }

  const openMcpEdit = (s: McpService) => {
    setEditingMcp(s)
    setMcpForm({
      name: s.name,
      type: s.type,
      provider: s.provider,
      baseUrl: s.baseUrl,
      modelId: s.modelId,
      apiKey: s.apiKey
    })
    setShowMcpForm(true)
  }

  const saveMcpForm = async () => {
    if (!mcpForm.name.trim() || !mcpForm.baseUrl.trim() || !mcpForm.apiKey.trim()) {
      showToast('请填写名称、Base URL 和 API Key', true)
      return
    }
    if (!mcpForm.modelId.trim()) {
      showToast('请填写模型 ID', true)
      return
    }
    setBusy(true)
    try {
      if (editingMcp) {
        await window.dst.updateMcpService(editingMcp.id, mcpForm)
        showToast('已更新 MCP 服务')
      } else {
        await window.dst.createMcpService(mcpForm)
        showToast('已添加 MCP 服务')
      }
      setShowMcpForm(false)
      await refresh()
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), true)
    } finally {
      setBusy(false)
    }
  }

  const onMcpDelete = async (id: string) => {
    setBusy(true)
    try {
      await window.dst.deleteMcpService(id)
      showToast('已删除 MCP 服务')
      await refresh()
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), true)
    } finally {
      setBusy(false)
    }
  }

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
      // 连接信息来自当前应用的 Provider 配置
      const provider = providers.find((p) => p.app === currentApp)
      if (!provider) {
        showToast('请先在「配置 Provider」中配置连接信息', true)
        return
      }
      if (!provider.apiKey.trim()) {
        showToast('请在「配置 Provider」中填写 API Key', true)
        return
      }
      await window.dst.startMcpService(s.id, currentApp)
      showToast(`已启动 ${s.name}（使用 ${provider.name} 连接）`)
      await refresh()
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), true)
    } finally {
      setBusy(false)
    }
  }

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

  const openConnInfo = async (id: string) => {
    try {
      const info = await window.dst.getMcpConnectionInfo(id)
      setConnInfo(info)
      setCopied(false)
      setShowConnInfo(true)
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), true)
    }
  }

  const copyConnInfo = async () => {
    if (!connInfo) return
    try {
      await window.dst.writeClipboard(connInfo.text)
      setCopied(true)
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), true)
    }
  }

  const toggleCodexEnhancements = async () => {
    if (!settings) return
    try {
      const next = await window.dst.updateSettings({
        codexEnhancements: !settings.codexEnhancements
      })
      setSettings(next)
      showToast(`Codex 界面增强已${next.codexEnhancements ? '开启' : '关闭'}`)
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), true)
    }
  }

  return (
    <div className="app">
      <div className="layout">
        {/* ── Left Sidebar: App List ── */}
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
              className="update-link"
              onClick={onCheckUpdate}
              disabled={updateBusy}
              title="检查更新"
              aria-label="检查更新"
            >
              {updateBusy ? '⟳' : '↻'}
            </button>
          </div>
        </aside>

        {/* ─ Right Panel: Tab Content ── */}
        <main className="panel">
          {/* ── Tab Bar ── */}
          <div className="tab-bar">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                className={`tab-item ${activeTab === tab.id ? 'active' : ''}`}
                onClick={() => setActiveTab(tab.id)}
              >
                <span className="tab-icon">{tab.icon}</span>
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
                      onClick={openCreate}
                      disabled={busy}
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
                      配置 Provider
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

              {currentApp === 'codex' && settings && (
                <div className="feature-banner">
                  <div>
                    <strong>纯 API 模式</strong>
                    <span>无需 OpenAI 账号；启用后由大算头 Provider 提供模型。</span>
                  </div>
                  <label>
                    <input
                      type="checkbox"
                      checked={settings.codexEnhancements}
                      onChange={toggleCodexEnhancements}
                    />
                    插件解锁与基础 UI 增强
                  </label>
                </div>
              )}

              <div className="panel-body">
                {!currentMeta?.implemented ? (
                  <div className="empty">
                    {currentMeta?.name} 仅搭建框架，启用写入将在后续版本实现。
                  </div>
                ) : providers.length === 0 ? (
                  <div className="empty">
                    <div className="empty-icon">⚡</div>
                    <div>还没有配置 Provider。点击「配置 Provider」开始使用。</div>
                  </div>
                ) : models.length === 0 ? (
                  <div className="empty">
                    <div className="empty-icon">📦</div>
                    <div>暂无模型。点击「刷新模型清单」同步可用模型。</div>
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
                  <h2>MCP 服务</h2>
                  <div className="sub" style={{ color: 'var(--muted)', fontSize: 12 }}>
                    管理 {currentMeta?.name || currentApp} 的 Model Context Protocol 服务
                  </div>
                </div>
              </div>
              <div className="panel-body">
                {mcpServices.length === 0 ? (
                  <div className="empty">
                    <div className="empty-icon">🔌</div>
                    <div>还没有 MCP 服务。添加图片生成等服务，然后启动。</div>
                    <div className="sub" style={{ marginTop: 8 }}>
                      支持 Gemini 3 Pro Image / GPT Image 2 等图片生成服务。
                    </div>
                  </div>
                ) : (
                  <div className="list">
                    {mcpServices.map((s) =>
                      s.builtin ? (
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
                            <div className="sub">服务商：{s.provider === 'dst' ? '大算头' : s.provider === 'gemini-3-pro-image' ? 'Gemini 3 Pro Image' : s.provider === 'gpt-image-2' ? 'GPT Image 2' : s.provider === 'doubao-seedance-2.0' ? '豆包 Seedance 2.0' : '自定义'}</div>
                            <div className="sub">支持模型：{s.type === 'video-generation' ? BUILTIN_MCP_VIDEO_DEFAULTS.models.join(' / ') : BUILTIN_MCP_IMAGE_DEFAULTS.models.join(' / ')}（请求时按参数选择）</div>
                            <div className="row">
                              <button
                                className="btn primary"
                                disabled={busy}
                                onClick={() => onMcpStart(s)}
                              >
                                启动
                              </button>
                              <button
                                className="btn danger"
                                disabled={busy}
                                onClick={() => onMcpStop(s)}
                              >
                                停止
                              </button>
                              <button
                                className="btn"
                                disabled={busy}
                                onClick={() => openConnInfo(s.id)}
                              >
                                复制配置信息
                              </button>
                            </div>
                          </div>
                        </div>
                      ) : (
                        <div
                          key={s.id}
                          className={`card ${s.running ? 'enabled' : ''}`}
                        >
                          <div>
                            <h4>
                              {s.name}
                              {s.running ? (
                                <span className="badge ok">运行中 :{s.port}</span>
                              ) : (
                                <span className="badge">未运行</span>
                              )}
                            </h4>
                            <div className="sub">类型：{s.type === 'image-generation' ? '图片生成' : s.type === 'video-generation' ? '视频生成' : s.type}</div>
                            <div className="sub">服务商：{s.provider === 'gemini-3-pro-image' ? 'Gemini 3 Pro Image' : s.provider === 'gpt-image-2' ? 'GPT Image 2' : s.provider === 'doubao-seedance-2.0' ? '豆包 Seedance 2.0' : s.provider === 'dst' ? '大算头' : '自定义'}</div>
                            <div className="sub">模型：{s.modelId}</div>
                            <div className="sub">Endpoint：{s.baseUrl}</div>
                            <div className="row">
                              <button
                                className="btn primary"
                                disabled={busy}
                                onClick={() => onMcpStart(s)}
                              >
                                启动
                              </button>
                              <button
                                className="btn danger"
                                disabled={busy}
                                onClick={() => onMcpStop(s)}
                              >
                                停止
                              </button>
                              <button
                                className="btn"
                                disabled={busy}
                                onClick={() => openMcpEdit(s)}
                              >
                                编辑
                              </button>
                              <button
                                className="btn danger"
                                disabled={busy || s.running}
                                onClick={() => onMcpDelete(s.id)}
                              >
                                删除
                              </button>
                            </div>
                          </div>
                        </div>
                      )
                    )}
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
                  <h2>Skill 技能</h2>
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

          {/* ── Auto Update Banner ── */}
          {update && update.status !== 'idle' && (
            <div
              className={`update-banner ${
                update.status === 'error' || update.status === 'unsupported'
                  ? 'error'
                  : ''
              }`}
            >
              <div className="update-info">
                {update.status === 'checking' && <span>正在检查更新…</span>}
                {update.status === 'available' && (
                  <span>
                    发现新版本 <b>v{update.version}</b>（当前 v{version}）
                  </span>
                )}
                {update.status === 'downloading' && (
                  <span>正在下载 v{update.version}…</span>
                )}
                {update.status === 'downloaded' && (
                  <span>
                    v{update.version} 已下载完成
                  </span>
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
              <div className="update-actions">
                {update.status === 'available' && (
                  <button
                    className="btn primary small"
                    onClick={onDownloadUpdate}
                    disabled={updateBusy}
                  >
                    下载更新
                  </button>
                )}
                {update.status === 'downloading' && (
                  <span className="update-percent">
                    {update.percent ?? 0}%
                  </span>
                )}
                {update.status === 'downloaded' && (
                  <>
                    <span className="update-percent">100%</span>
                    <button
                      className="btn primary small"
                      onClick={onInstallUpdate}
                    >
                      重启安装
                    </button>
                  </>
                )}
                {update.status === 'error' && (
                  <button
                    className="btn small"
                    onClick={onCheckUpdate}
                    disabled={updateBusy}
                  >
                    重试
                  </button>
                )}
                {(update.status === 'up-to-date' ||
                  update.status === 'unsupported') && (
                  <button
                    className="btn small"
                    onClick={() => setUpdate((u) => (u ? { ...u, status: 'idle' } : u))}
                  >
                    知道了
                  </button>
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

          <p className="footer-note">
            大算头适配器 v{version || '…'} · 本地数据目录：{dataDir || '...'}
            （备份在 backups/ 下）
          </p>
        </main>
      </div>

      {showForm && (
        <div className="modal-backdrop" onClick={() => setShowForm(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>配置 Provider</h3>
            {syncing && (
              <div className="sync-progress">
                <div className="sync-spinner"></div>
                <span>授权模型同步中...</span>
              </div>
            )}
            <div className="form">
              <div className="field">
                <label>名称</label>
                <input
                  value={form.name}
                  readOnly
                  disabled
                />
              </div>
              <div className="field">
                <label>Base URL</label>
                <input
                  value={form.endpoint}
                  readOnly
                  disabled
                />
              </div>
              {currentApp === 'codex' && (
                <div className="field">
                  <label>上游协议</label>
                  <select
                    value={form.wireApi}
                    onChange={(e) =>
                      setForm((s) => ({
                        ...s,
                        wireApi: e.target.value as FormState['wireApi']
                      }))
                    }
                  >
                    <option value="chat_completions">
                      Chat Completions（推荐，自动转 Responses）
                    </option>
                    <option value="responses">Responses 直连</option>
                  </select>
                </div>
              )}
              <div className="field">
                <label>API Key</label>
                <input
                  type="password"
                  value={form.apiKey}
                  onChange={(e) =>
                    setForm((s) => ({
                      ...s,
                      apiKey: e.target.value,
                      // 用户手动修改 Key 时清除原始 Key，保存以新输入为准
                      rawApiKey: e.target.value === s.apiKey ? s.rawApiKey : undefined
                    }))
                  }
                  placeholder="sk-..."
                />
              </div>
              <div className="actions">
                <button className="btn" onClick={() => setShowForm(false)} disabled={syncing}>
                  取消
                </button>
                <button
                  className="btn"
                  disabled={busy || syncing || !form.apiKey.trim()}
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
                  className="btn primary"
                  disabled={busy || syncing}
                  onClick={saveForm}
                >
                  保存
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

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

      {showMcpForm && (
        <div className="modal-backdrop" onClick={() => setShowMcpForm(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>{editingMcp ? '编辑 MCP 服务' : '添加 MCP 服务'}</h3>
            <div className="form">
              <div className="field">
                <label>名称</label>
                <input
                  value={mcpForm.name}
                  onChange={(e) =>
                    setMcpForm((s) => ({ ...s, name: e.target.value }))
                  }
                  placeholder="例如：Gemini 图片生成"
                />
              </div>
              <div className="field">
                <label>服务类型</label>
                <select
                  value={mcpForm.type}
                  onChange={(e) =>
                    setMcpForm((s) => ({ ...s, type: e.target.value as McpServiceType }))
                  }
                >
                  <option value="image-generation">图片生成</option>
                  <option value="text-generation">文本生成</option>
                  <option value="custom">自定义</option>
                </select>
              </div>
              <div className="field">
                <label>服务商</label>
                <select
                  value={mcpForm.provider}
                  onChange={(e) =>
                    setMcpForm((s) => ({ ...s, provider: e.target.value as McpProvider }))
                  }
                >
                  <option value="gemini-3-pro-image">Gemini 3 Pro Image</option>
                  <option value="gpt-image-2">GPT Image 2</option>
                  <option value="custom">自定义</option>
                </select>
              </div>
              <div className="field">
                <label>Base URL</label>
                <input
                  value={mcpForm.baseUrl}
                  onChange={(e) =>
                    setMcpForm((s) => ({ ...s, baseUrl: e.target.value }))
                  }
                  placeholder="https://api.example.com"
                />
              </div>
              <div className="field">
                <label>模型 ID</label>
                <input
                  value={mcpForm.modelId}
                  onChange={(e) =>
                    setMcpForm((s) => ({ ...s, modelId: e.target.value }))
                  }
                  placeholder="gemini-3-pro-image 或 gpt-image-2"
                />
              </div>
              <div className="field">
                <label>API Key</label>
                <input
                  type="password"
                  value={mcpForm.apiKey}
                  onChange={(e) =>
                    setMcpForm((s) => ({ ...s, apiKey: e.target.value }))
                  }
                  placeholder="sk-..."
                />
              </div>
              <div className="actions">
                <button className="btn" onClick={() => setShowMcpForm(false)}>
                  取消
                </button>
                <button
                  className="btn primary"
                  disabled={busy}
                  onClick={saveMcpForm}
                >
                  保存
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Built-in Image Generation: Connection Info ── */}
      {showConnInfo && connInfo && (
        <div className="modal-backdrop" onClick={() => setShowConnInfo(false)}>
          <div className="modal conn-modal" onClick={(e) => e.stopPropagation()}>
            <h3>MCP 连接信息</h3>
            <p className="conn-hint">
              将以下 JSON 配置给任意支持 MCP 的客户端（如 Claude Desktop、Cherry Studio、Codex 等）。
            </p>
            <pre className="conn-pre">{connInfo.text}</pre>
            <div className="actions">
              <button className="btn" onClick={() => setShowConnInfo(false)}>
                关闭
              </button>
              <button className="btn primary" onClick={copyConnInfo}>
                {copied ? '✓ 已复制' : '一键复制'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
