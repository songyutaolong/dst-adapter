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
  RemoteSkillPackage,
  SkillCatalogResult,
  UpdateState
} from '../../shared/types'
import {
  BUILTIN_MCP_IMAGE_DEFAULTS,
  BUILTIN_MCP_UEMCP_DEFAULTS,
  BUILTIN_MCP_VIDEO_DEFAULTS,
  DEFAULT_PROVIDER_ENDPOINT
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

function EyeIcon({ hidden }: { hidden: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {hidden ? (
        <>
          <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
          <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
          <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
          <line x1="1" y1="1" x2="23" y2="23" />
        </>
      ) : (
        <>
          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
          <circle cx="12" cy="12" r="3" />
        </>
      )}
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
  endpoint: DEFAULT_PROVIDER_ENDPOINT,
  apiKey: '',
  rawApiKey: undefined,
  wireApi: 'chat_completions',
  vendor: 'dst'
})

function isMcpEnabledForApp(service: McpService, app: AppId): boolean {
  return Boolean(service.enabledApps?.includes(app))
}

function mcpProviderLabel(service: McpService): string {
  if (service.type === 'ue-mcp') return '大算头'
  if (service.provider === 'dst') return '大算头'
  if (service.provider === 'gemini-3-pro-image') return 'Gemini 3 Pro Image'
  if (service.provider === 'gpt-image-2') return 'GPT Image 2'
  if (service.provider === 'doubao-seedance-2.0') return '豆包 Seedance 2.0'
  return '自定义'
}

function mcpCapability(service: McpService): string {
  if (service.type === 'ue-mcp') {
    return `启动命令：${BUILTIN_MCP_UEMCP_DEFAULTS.command} ${BUILTIN_MCP_UEMCP_DEFAULTS.args.join(' ')}（由 WorkBuddy 自动拉起）`
  }
  if (service.type === 'file-upload') {
    return '支持输入：腾讯 COS / 阿里 OSS；本地路径 / Base64 文件（file_path / content 二选一）'
  }
  if (service.type === '3d-generation') {
    return '支持任务：文生 / 图生 / 多视图 / 任务查询（统一模型）'
  }
  if (service.type === 'video-generation') {
    return `支持模型：${BUILTIN_MCP_VIDEO_DEFAULTS.models.join(' / ')}（请求时按参数选择）`
  }
  return `支持模型：${BUILTIN_MCP_IMAGE_DEFAULTS.models.join(' / ')}（请求时按参数选择）`
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
  const [form, setForm] = useState<FormState>(emptyForm())
  const [showPlainApiKey, setShowPlainApiKey] = useState(false)
  const [workBuddyPath, setWorkBuddyPath] = useState('')
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
  const [skillCatalog, setSkillCatalog] = useState<SkillCatalogResult | null>(null)
  const [skillLoading, setSkillLoading] = useState(false)
  const [skillError, setSkillError] = useState('')
  const [skillReloadToken, setSkillReloadToken] = useState(0)
  const [skillAction, setSkillAction] = useState('')
  const [skillCloseRequired, setSkillCloseRequired] = useState(false)

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

  useEffect(() => {
    if (activeTab !== 'skill') return

    let cancelled = false
    setSkillLoading(true)
    setSkillError('')
    setSkillCloseRequired(false)

    window.dst
      .listSkillCatalog(currentApp)
      .then((result) => {
        if (cancelled) return
        setSkillCatalog(result)
        setSkillError(result.ok ? '' : result.message)
      })
      .catch((err) => {
        if (cancelled) return
        setSkillCatalog(null)
        setSkillError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setSkillLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [activeTab, currentApp, skillReloadToken])

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
    setWorkBuddyPath(appSettings?.workBuddyPath || '')
    setForm({
      name: appSettings?.providerName || existing?.name || 'dst',
      endpoint: appSettings?.providerEndpoint || existing?.endpoint || DEFAULT_PROVIDER_ENDPOINT,
      apiKey: apiKey ? maskApiKey(apiKey) : '',
      rawApiKey: apiKey || undefined,
      wireApi: appSettings?.providerWireApi || existing?.wireApi || 'chat_completions',
      vendor: appSettings?.providerVendor || existing?.vendor || 'dst'
    })
    setShowPlainApiKey(false)
  }, [])

  const toggleApiKeyVisibility = () => {
    const nextVisible = !showPlainApiKey
    setShowPlainApiKey(nextVisible)
    setForm((s) => {
      const plainKey = s.apiKey.includes('****')
        ? s.rawApiKey || ''
        : s.apiKey

      return {
        ...s,
        apiKey: nextVisible ? plainKey : plainKey ? maskApiKey(plainKey) : '',
        rawApiKey: plainKey || undefined
      }
    })
  }

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
        providerEndpoint: form.endpoint.trim() || DEFAULT_PROVIDER_ENDPOINT,
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

  const saveWorkBuddyPath = async () => {
    setBusy(true)
    try {
      const next = await window.dst.updateSettings({
        workBuddyPath: workBuddyPath.trim()
      })
      setSettings(next)
      showToast(next.workBuddyPath ? 'WorkBuddy 路径已保存' : '已恢复默认 WorkBuddy 路径')
      await refresh()
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), true)
    } finally {
      setBusy(false)
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

  const formatSkillSize = (size: number) => {
    if (size < 1024) return `${size} B`
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
    return `${(size / (1024 * 1024)).toFixed(1)} MB`
  }

  const onRefreshSkills = () => {
    setSkillReloadToken((token) => token + 1)
  }

  const onSetSkillEnabled = async (id: string, enabled: boolean) => {
    setSkillAction(id)
    try {
      const result = await window.dst.setSkillEnabled(id, enabled, currentApp)
      showToast(result.message)
      setSkillCatalog((current) =>
        current
          ? {
              ...current,
              skills: current.skills.map((skill) =>
                skill.id === id ? { ...skill, enabled } : skill
              )
            }
          : current
      )
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), true)
    } finally {
      setSkillAction('')
    }
  }

  const onUpdateSkill = async (skill: RemoteSkillPackage) => {
    setSkillAction(skill.id)
    try {
      const workBuddyRunning = currentApp === 'workbuddy' &&
        await window.dst.isAppRunning(currentApp)
      if (workBuddyRunning) {
        setSkillCloseRequired(true)
        showToast('WorkBuddy 正在运行；请先手动关闭后，再点击安装/更新', true)
        return
      }
      setSkillCloseRequired(false)
      const result = await window.dst.updateSkill(skill.id, currentApp)
      showToast(result.message, !result.ok)
      setSkillReloadToken((token) => token + 1)
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), true)
    } finally {
      setSkillAction('')
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

  const onUemcpEnable = async (s: McpService) => {
    setBusy(true)
    try {
      const result = await window.dst.enableMcpService(s.id, true, 'workbuddy')
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
      builtinMcpServices
        .filter((service) => service.type !== 'ue-mcp' || currentApp === 'workbuddy')
        .map((service) => ({
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
                  <h3>WorkBuddy 路径</h3>
                  <p className="settings-desc">
                    留空时会自动检测默认目录和系统安装记录；自动检测失败时，再填写安装目录或 WorkBuddy.exe 完整路径。
                  </p>
                  <div className="form">
                    <div className="field">
                      <label>安装目录 / 可执行文件</label>
                      <input
                        type="text"
                        value={workBuddyPath}
                        spellCheck={false}
                        placeholder="例如 D:\Apps\WorkBuddy 或 D:\Apps\WorkBuddy\WorkBuddy.exe"
                        onChange={(e) => setWorkBuddyPath(e.target.value)}
                      />
                    </div>
                    <div className="actions settings-actions">
                      <button
                        className="btn primary settings-btn"
                        disabled={busy}
                        onClick={saveWorkBuddyPath}
                      >
                        保存路径
                      </button>
                    </div>
                  </div>
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
                      <div className="api-key-control">
                        <input
                          type={showPlainApiKey ? 'text' : 'password'}
                          value={form.apiKey}
                          spellCheck={false}
                          autoComplete="off"
                          onChange={(e) =>
                            setForm((s) => ({
                              ...s,
                              apiKey: e.target.value,
                              rawApiKey: e.target.value === s.apiKey ? s.rawApiKey : undefined
                            }))
                          }
                          placeholder="sk-..."
                        />
                        <button
                          type="button"
                          className="api-key-toggle"
                          disabled={!form.apiKey.trim()}
                          aria-pressed={showPlainApiKey}
                          aria-label={showPlainApiKey ? '隐藏 API Key' : '显示 API Key'}
                          title={showPlainApiKey ? '隐藏 API Key' : '显示 API Key'}
                          onClick={toggleApiKeyVisibility}
                        >
                          <EyeIcon hidden={!showPlainApiKey} />
                        </button>
                      </div>
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
                              {s.type === 'ue-mcp' ? (
                                <span className="badge builtin">外部进程</span>
                              ) : (
                                <>
                                  <span className="badge builtin">内置</span>
                                  {s.running ? (
                                    <span className="badge ok">运行中 :{s.port}</span>
                                  ) : (
                                    <span className="badge">未运行</span>
                                  )}
                                </>
                              )}
                            </h4>
                            {s.type === 'ue-mcp' ? (
                              <div className="row settings-actions">
                                <button
                                  className="btn primary settings-btn"
                                  disabled={busy}
                                  onClick={() => onUemcpEnable(s)}
                                >
                                  启用配置
                                </button>
                              </div>
                            ) : (
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
                            )}
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
                            服务商：{mcpProviderLabel(s)}
                          </div>
                          <div className="sub">
                            {mcpCapability(s)}
                          </div>
                          <div className="row mcp-actions">
                            <button
                              className="btn primary"
                              disabled={busy}
                              onClick={() =>
                                onUemcpEnable(s)
                              }
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
                    管理 {currentMeta?.name || currentApp} 的远端 Skill 目录
                  </div>
                </div>
                <button className="btn secondary" disabled={skillLoading} onClick={onRefreshSkills}>
                  ↻ 刷新
                </button>
              </div>
              {skillCloseRequired && (
                <div className="feature-banner">
                  <div>
                    <strong>WorkBuddy 正在运行</strong>
                    <span>请先手动关闭 WorkBuddy；完全退出后，再点击安装/更新。</span>
                  </div>
                </div>
              )}
              <div className="panel-body">
                {skillLoading ? (
                  <div className="empty">
                    <div className="empty-icon">🧩</div>
                    <div>正在获取 Skill 目录…</div>
                  </div>
                ) : skillError && !skillCatalog?.skills.length ? (
                  <div className="empty">
                    <div className="empty-icon">⚠️</div>
                    <div>{skillError}</div>
                    <div className="sub" style={{ marginTop: 8 }}>
                      请确认当前应用支持 Skill 仓储，并且 Provider 已返回 OSS 配置。
                    </div>
                  </div>
                ) : !skillCatalog?.skills.length ? (
                  <div className="empty">
                    <div className="empty-icon">🧩</div>
                    <div>Skill 仓储暂无可用技能。</div>
                  </div>
                ) : (
                  <div className="list">
                    {skillCatalog.skills.map((skill: RemoteSkillPackage) => (
                      <div key={`${skill.id}-${skill.version}`} className="card">
                        <div>
                          <h4>
                            {skill.name}
                            <span className="badge">v{skill.version}</span>
                          </h4>
                          {skill.description && <div className="sub">{skill.description}</div>}
                          <div className="sub">
                            {[
                              skill.vendor && `厂商：${skill.vendor}`,
                              skill.localVersion && `本地版本：v${skill.localVersion}`,
                              `大小：${formatSkillSize(skill.size)}`,
                              skill.minWorkBuddyVersion &&
                                `最低版本：v${skill.minWorkBuddyVersion}`,
                              `对象：${skill.objectKey}`
                            ]
                              .filter(Boolean)
                              .join(' · ')}
                          </div>
                          <div className="row mcp-actions">
                            <button
                              className="btn primary"
                              disabled={!skill.installed || skill.enabled || skillAction === skill.id}
                              onClick={() => onSetSkillEnabled(skill.id, true)}
                            >
                              启用
                            </button>
                            <button
                              className="btn danger"
                              disabled={!skill.installed || !skill.enabled || skillAction === skill.id}
                              onClick={() => onSetSkillEnabled(skill.id, false)}
                            >
                              停用
                            </button>
                            {!skill.installed && (
                              <button
                                className="btn primary"
                                disabled={skillAction === skill.id}
                                onClick={() => onUpdateSkill(skill)}
                              >
                                {skillAction === skill.id ? '安装中...' : '安装'}
                              </button>
                            )}
                            {skill.installed && skill.updateAvailable && (
                              <button
                                className="btn primary"
                                disabled={skillAction === skill.id}
                                onClick={() => onUpdateSkill(skill)}
                              >
                                {skillAction === skill.id ? '更新中...' : '更新'}
                              </button>
                            )}
                            {!skill.installed && <span className="badge">未安装</span>}
                            {skill.installed && (
                              <span className="badge">{skill.enabled ? '已启用' : '已停用'}</span>
                            )}
                            {skill.localVersion && (
                              <span className="badge">本地 v{skill.localVersion}</span>
                            )}
                            {skill.updateAvailable && <span className="badge warn">可更新</span>}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {skillError && skillCatalog?.skills.length ? (
                  <div className="sub" style={{ marginTop: 10, color: 'var(--danger)' }}>
                    {skillError}
                  </div>
                ) : null}
              </div>
            </>
          )}
            </>
          )}

          <p className="footer-note">
            dst adapter v{version || '…'} · 本地数据目录：{dataDir || '...'}
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
