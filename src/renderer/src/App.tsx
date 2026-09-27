import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AppId,
  AppInfo,
  AppSettings,
  ApplyResult,
  GatewayMeResult,
  Provider,
  SpeedTestResult,
  McpService,
  Model,
  ModelConfig,
  Prompt,
  RemoteSkillPackage,
  SessionMeta,
  SessionMessage,
  SkillCatalogResult,
  UpdateState
} from '../../shared/types'
import {
  BUILTIN_MCP_IMAGE_DEFAULTS,
  BUILTIN_MCP_UEMCP_DEFAULTS,
  BUILTIN_MCP_VIDEO_DEFAULTS,
  DEFAULT_PROVIDER_ENDPOINT
} from '../../shared/types'
import { COMPANY_PROMPT_TEMPLATES } from '../../shared/prompts'
import type { PromptTemplate } from '../../shared/prompts'

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

// 会话管理当前支持的应用
const SESSION_APPS: { id: AppId; label: string }[] = [
  { id: 'workbuddy', label: 'WorkBuddy' },
  { id: 'codex', label: 'Codex' }
]

function SessionIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zM6 9h12v2H6V9zm8 5H6v-2h8v2zm4-6H6V6h12v2z" />
    </svg>
  )
}

function PromptIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z" />
    </svg>
  )
}

function SettingsIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.48.48 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.49.49 0 0 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.21.07-.47-.12-.61l-2.01-1.58zM12 15.6a3.6 3.6 0 1 1 0-7.2 3.6 3.6 0 0 1 0 7.2z" />
    </svg>
  )
}

function formatSessionTime(iso: string): string {
  const time = new Date(iso).getTime()
  if (!Number.isFinite(time)) return '—'
  const diff = Date.now() - time
  if (diff < 60 * 60 * 1000) return `${Math.max(1, Math.round(diff / 60000))} 分钟前`
  if (diff < 24 * 60 * 60 * 1000) return `${Math.round(diff / 3600000)} 小时前`
  if (diff < 7 * 24 * 60 * 60 * 1000) return `${Math.round(diff / 86400000)} 天前`
  return new Date(iso).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

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

function mcpProviderLabel(_service: McpService): string {
  // 服务商统一展示为 up
  return 'up'
}

function mcpCapability(service: McpService, app: AppId): string {
  if (service.type === 'ue-mcp') {
    return `启动命令：${BUILTIN_MCP_UEMCP_DEFAULTS.command} ${BUILTIN_MCP_UEMCP_DEFAULTS.args.join(' ')}（由 ${app === 'codex' ? 'Codex' : 'WorkBuddy'} 自动拉起）`
  }
  if (service.type === 'file-upload') {
    return '支持输入：腾讯 COS / 阿里 OSS；本地路径 / Base64 文件（file_path / content 二选一）'
  }
  if (service.type === '3d-generation') {
    return '支持任务：文生 / 图生 / 多视图 / 贴图 / 减面 / 分割 / 绑骨检测 / 绑骨 / 任务查询'
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
  const [view, setView] = useState<'home' | 'settings' | 'sessions' | 'prompts'>('home')
  const showSettings = view === 'settings'
  const [form, setForm] = useState<FormState>(emptyForm())
  const [showPlainApiKey, setShowPlainApiKey] = useState(false)
  const [workBuddyPath, setWorkBuddyPath] = useState('')
  const [codexPath, setCodexPath] = useState('')
  const [busy, setBusy] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [toast, setToast] = useState<{
    text: string
    error?: boolean
  } | null>(null)

  // Auto Update
  const [update, setUpdate] = useState<UpdateState | null>(null)
  const [updateBusy, setUpdateBusy] = useState(false)

  // 网关账户身份（/v1/me）
  const [meInfo, setMeInfo] = useState<GatewayMeResult | null>(null)
  const [meLoading, setMeLoading] = useState(false)

  // Models
  const [models, setModels] = useState<Model[]>([])
  const [lastSyncAt, setLastSyncAt] = useState<string | undefined>()
  const [modelSearch, setModelSearch] = useState('')
  const [mcpSearch, setMcpSearch] = useState('')
  const [skillSearch, setSkillSearch] = useState('')
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

  // Sessions（会话管理）
  const [sessionApp, setSessionApp] = useState<AppId>('workbuddy')
  const [sessions, setSessions] = useState<SessionMeta[]>([])
  const [sessionsLoading, setSessionsLoading] = useState(false)
  const [sessionSearch, setSessionSearch] = useState('')
  const [openSession, setOpenSession] = useState<SessionMeta | null>(null)
  const [sessionPage, setSessionPage] = useState<{
    list: SessionMessage[]
    cursor?: number
    hasMore: boolean
    total?: number
  } | null>(null)
  const [messagesLoading, setMessagesLoading] = useState(false)
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const [listVisible, setListVisible] = useState(60)
  const [sessionBusy, setSessionBusy] = useState(false)
  const [skillError, setSkillError] = useState('')
  const [skillReloadToken, setSkillReloadToken] = useState(0)
  const [skillAction, setSkillAction] = useState('')
  const [skillCloseRequired, setSkillCloseRequired] = useState(false)

  // Prompts（提示词管理）
  const [promptTab, setPromptTab] = useState<'personal' | 'company'>('personal')
  const [prompts, setPrompts] = useState<Prompt[]>([])
  const [promptsLoading, setPromptsLoading] = useState(false)
  const [promptSearch, setPromptSearch] = useState('')
  const [promptBusy, setPromptBusy] = useState(false)
  const [showPromptEditor, setShowPromptEditor] = useState(false)
  const [editingPrompt, setEditingPrompt] = useState<Prompt | null>(null)
  const [promptForm, setPromptForm] = useState<{ name: string; content: string }>({
    name: '',
    content: ''
  })
  const [viewingPrompt, setViewingPrompt] = useState<{
    name: string
    description?: string
    content: string
    source: 'personal' | 'company'
    prompt?: Prompt
    template?: PromptTemplate
  } | null>(null)

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

  // 网关身份：Key 配置就绪或变化时自动拉取（含保存配置后的刷新）
  const activeKey = settings?.providerApiKey?.trim() || providers[0]?.apiKey?.trim() || ''
  useEffect(() => {
    if (!activeKey) {
      setMeInfo(null)
      setMeLoading(false)
      return
    }
    // HMR 场景下 preload 可能还是旧版本（无 fetchMe），缺方法时静默跳过，避免整页崩溃
    if (typeof window.dst.fetchMe !== 'function') return
    let cancelled = false
    setMeLoading(true)
    try {
      window.dst
        .fetchMe()
        .then((result) => {
          if (!cancelled) setMeInfo(result)
        })
        .catch((err) => {
          if (!cancelled) {
            setMeInfo({ ok: false, error: err instanceof Error ? err.message : String(err) })
          }
        })
        .finally(() => {
          if (!cancelled) setMeLoading(false)
        })
    } catch (err) {
      setMeLoading(false)
      setMeInfo({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
    return () => {
      cancelled = true
    }
  }, [activeKey])

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
    setCodexPath(appSettings?.codexPath || '')
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

  // ── 会话管理 ──

  const loadSessions = async (app: AppId) => {
    setSessionsLoading(true)
    try {
      const list = await window.dst.listSessions(app)
      setSessions(list)
    } catch (err) {
      setSessions([])
      showToast(err instanceof Error ? err.message : '会话列表读取失败', true)
    } finally {
      setSessionsLoading(false)
    }
  }

  useEffect(() => {
    if (view === 'sessions' && !openSession) {
      void loadSessions(sessionApp)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, sessionApp, openSession])

  // 会话关键字检索：匹配标题、摘要、项目目录
  const sessionList = useMemo(() => {
    const q = sessionSearch.trim().toLowerCase()
    if (!q) return sessions
    return sessions.filter(
      (s) =>
        s.title.toLowerCase().includes(q) ||
        s.summary.toLowerCase().includes(q) ||
        s.projectDir.toLowerCase().includes(q)
    )
  }, [sessions, sessionSearch])

  // 切换应用或搜索词后回到首批渲染量，避免一次性挂载上千卡片
  useEffect(() => {
    setListVisible(60)
  }, [sessionApp, sessionSearch])

  const openSessionDetail = async (meta: SessionMeta) => {
    setOpenSession(meta)
    setSessionPage(null)
    setMessagesLoading(true)
    try {
      const page = await window.dst.getSessionMessages(meta.app, meta.sessionId)
      setSessionPage({
        list: page.messages,
        cursor: page.cursor,
        hasMore: page.hasMore,
        total: page.total
      })
    } catch (err) {
      showToast(err instanceof Error ? err.message : '会话消息读取失败', true)
      setOpenSession(null)
    } finally {
      setMessagesLoading(false)
    }
  }

  // 大会话：向更早方向按游标翻页，旧消息前插
  const loadEarlierMessages = async () => {
    if (
      !openSession ||
      !sessionPage?.hasMore ||
      sessionPage.cursor === undefined ||
      loadingEarlier
    ) {
      return
    }
    setLoadingEarlier(true)
    try {
      const page = await window.dst.getSessionMessages(openSession.app, openSession.sessionId, {
        cursor: sessionPage.cursor
      })
      setSessionPage((prev) =>
        prev
          ? {
              list: [...page.messages, ...prev.list],
              cursor: page.cursor,
              hasMore: page.hasMore,
              total: prev.total
            }
          : prev
      )
    } catch (err) {
      showToast(err instanceof Error ? err.message : '更早消息加载失败', true)
    } finally {
      setLoadingEarlier(false)
    }
  }

  const closeSessionDetail = () => {
    setOpenSession(null)
    setSessionPage(null)
  }

  // 会话列表滚动触底时自动追加一批卡片
  const onSessionListScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 120) {
      setListVisible((v) => (v < sessionList.length ? v + 60 : v))
    }
  }

  const onDeleteSession = async (meta: SessionMeta) => {
    if (!window.confirm(`确定删除会话「${meta.title}」？删除后不可恢复。`)) return
    setSessionBusy(true)
    try {
      const result = await window.dst.deleteSession(meta.app, meta.sessionId)
      showToast(result.message, !result.ok)
      if (result.ok) {
        if (openSession?.sessionId === meta.sessionId) closeSessionDetail()
        await loadSessions(meta.app)
      }
    } finally {
      setSessionBusy(false)
    }
  }

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
      setView('settings')
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

  const saveCodexPath = async () => {
    setBusy(true)
    try {
      const next = await window.dst.updateSettings({
        codexPath: codexPath.trim()
      })
      setSettings(next)
      showToast(next.codexPath ? 'Codex 路径已保存' : '已恢复默认 Codex 路径')
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
      const result: ApplyResult = await window.dst.disableModel(id)
      showToast(result.message, !result.ok)
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
      const appRunning =
        currentApp === 'workbuddy' || currentApp === 'codex'
          ? await window.dst.isAppRunning(currentApp)
          : false
      if (appRunning) {
        setSkillCloseRequired(true)
        showToast(`${currentMeta?.name || currentApp} 正在运行；请先完全退出后，再点击安装/更新`, true)
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
        setView('settings')
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

  const onUemcpEnable = async (s: McpService, app: AppId = 'workbuddy') => {
    setBusy(true)
    try {
      const result = await window.dst.enableMcpService(s.id, true, app)
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
        .filter(
          (service) =>
            service.type !== 'ue-mcp' ||
            currentApp === 'workbuddy' ||
            currentApp === 'codex'
        )
        .map((service) => ({
          ...service,
          enabledForCurrentApp: isMcpEnabledForApp(service, currentApp)
        })),
    [builtinMcpServices, currentApp]
  )

  // 工具关键字检索：匹配名称、服务商、能力描述
  const filteredMcpServices = useMemo(() => {
    const q = mcpSearch.trim().toLowerCase()
    if (!q) return currentAppMcpServices
    return currentAppMcpServices.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        mcpProviderLabel(s).toLowerCase().includes(q) ||
        mcpCapability(s, currentApp).toLowerCase().includes(q)
    )
  }, [currentAppMcpServices, mcpSearch, currentApp])

  // 技能关键字检索：匹配名称、描述、厂商
  const filteredSkills = useMemo(() => {
    const skills = skillCatalog?.skills ?? []
    const q = skillSearch.trim().toLowerCase()
    if (!q) return skills
    return skills.filter(
      (skill) =>
        skill.name.toLowerCase().includes(q) ||
        (skill.description || '').toLowerCase().includes(q) ||
        (skill.vendor || '').toLowerCase().includes(q)
    )
  }, [skillCatalog, skillSearch])

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

  // ── 提示词管理 ──

  const loadPrompts = async () => {
    setPromptsLoading(true)
    try {
      const list = await window.dst.listPrompts()
      setPrompts(list)
    } catch (err) {
      setPrompts([])
      showToast(err instanceof Error ? err.message : '提示词列表读取失败', true)
    } finally {
      setPromptsLoading(false)
    }
  }

  useEffect(() => {
    if (view === 'prompts') {
      void loadPrompts()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view])

  // 个人提示词关键字检索：匹配名称、内容；按更新时间倒序
  const filteredPrompts = useMemo(() => {
    const q = promptSearch.trim().toLowerCase()
    const list = [...prompts].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    if (!q) return list
    return list.filter(
      (p) => p.name.toLowerCase().includes(q) || p.content.toLowerCase().includes(q)
    )
  }, [prompts, promptSearch])

  // 公司模板关键字检索：匹配名称、描述
  const filteredTemplates = useMemo(() => {
    const q = promptSearch.trim().toLowerCase()
    if (!q) return COMPANY_PROMPT_TEMPLATES
    return COMPANY_PROMPT_TEMPLATES.filter(
      (t) => t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q)
    )
  }, [promptSearch])

  const onCopyPrompt = async (text: string) => {
    try {
      await window.dst.writeClipboard(text)
      showToast('已复制到剪贴板，可直接粘贴使用')
    } catch (err) {
      showToast(err instanceof Error ? err.message : '复制失败', true)
    }
  }

  const openPromptCreate = () => {
    setEditingPrompt(null)
    setPromptForm({ name: '', content: '' })
    setShowPromptEditor(true)
  }

  const openPromptEdit = (p: Prompt) => {
    setEditingPrompt(p)
    setPromptForm({ name: p.name, content: p.content })
    setShowPromptEditor(true)
  }

  const savePrompt = async () => {
    const name = promptForm.name.trim()
    const content = promptForm.content.trim()
    if (!name) {
      showToast('请填写提示词名称', true)
      return
    }
    if (!content) {
      showToast('请填写提示词内容', true)
      return
    }
    setPromptBusy(true)
    try {
      if (editingPrompt) {
        await window.dst.updatePrompt(editingPrompt.id, { name, content })
        showToast('提示词已保存')
      } else {
        await window.dst.createPrompt({ name, content })
        showToast('提示词已创建')
      }
      setShowPromptEditor(false)
      await loadPrompts()
    } catch (err) {
      showToast(err instanceof Error ? err.message : '保存失败', true)
    } finally {
      setPromptBusy(false)
    }
  }

  const onDeletePrompt = async (p: Prompt) => {
    if (!window.confirm(`确定删除提示词「${p.name}」？删除后不可恢复。`)) return
    setPromptBusy(true)
    try {
      await window.dst.deletePrompt(p.id)
      showToast('提示词已删除')
      if (viewingPrompt?.prompt?.id === p.id) setViewingPrompt(null)
      await loadPrompts()
    } catch (err) {
      showToast(err instanceof Error ? err.message : '删除失败', true)
    } finally {
      setPromptBusy(false)
    }
  }

  const onSaveTemplateAsPersonal = async (t: PromptTemplate) => {
    setPromptBusy(true)
    try {
      await window.dst.createPrompt({ name: t.name, content: t.content })
      showToast(`已另存为个人提示词「${t.name}」`)
      setPromptTab('personal')
      await loadPrompts()
    } catch (err) {
      showToast(err instanceof Error ? err.message : '另存失败', true)
    } finally {
      setPromptBusy(false)
    }
  }

  return (
    <div className="app">
      {/* ── 顶栏：当前 API Key 身份（点击跳设置） ── */}
      <header className="topbar">
        <button
          type="button"
          className={`account-card${meInfo?.ok ? ' ok' : ''}${meInfo && !meInfo.ok ? ' error' : ''}`}
          onClick={() => setView('settings')}
          title={
            meInfo?.ok && meInfo.info
              ? `${meInfo.info.user.display_name}（${meInfo.info.user.username}）· 令牌有效，点击查看 Provider 配置`
              : meInfo?.error || '点击前往设置配置 API Key'
          }
        >
          {!activeKey && !meLoading ? (
            <>
              <span className="account-avatar muted">?</span>
              <span className="account-name">未配置 API Key</span>
              <span className="account-sub">点击前往设置</span>
            </>
          ) : meLoading ? (
            <>
              <span className="account-avatar muted">…</span>
              <span className="account-name">获取用户信息…</span>
              <span className="account-sub">正在验证 API Key</span>
            </>
          ) : meInfo?.ok && meInfo.info ? (
            <>
              <span className="account-avatar">
                {meInfo.info.user.display_name.slice(0, 1).toUpperCase()}
              </span>
              <span className="account-name">{meInfo.info.user.display_name}</span>
              <span className="account-sub">
                {meInfo.info.user.username}
                {meInfo.info.organization?.name
                  ? ` · ${meInfo.info.organization.name}`
                  : ' · 个人'}
              </span>
              <span className="account-flex" />
              <span className="account-status ok">✓ 令牌有效</span>
            </>
          ) : (
            <>
              <span className="account-avatar warn">!</span>
              <span className="account-name">令牌验证失败</span>
              <span className="account-sub">{meInfo?.error || '请检查 API Key'}</span>
              <span className="account-flex" />
              <span className="account-status warn">⚠</span>
            </>
          )}
        </button>
      </header>
      <div className={`layout ${view !== 'home' ? 'settings-layout' : ''}`}>
        {/* ── Left Sidebar: App List ── */}
        {view === 'home' && (
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
              <div className="footer-actions">
                <button
                  className="icon-entry"
                  onClick={() => setView('sessions')}
                  title="会话管理"
                  aria-label="会话管理"
                >
                  <SessionIcon />
                </button>
                <button
                  className="icon-entry"
                  onClick={() => setView('prompts')}
                  title="提示词管理"
                  aria-label="提示词管理"
                >
                  <PromptIcon />
                </button>
                <button
                  className={`icon-entry ${showSettings ? 'active' : ''}`}
                  onClick={() => setView('settings')}
                  title="设置"
                  aria-label="设置"
                >
                  <SettingsIcon />
                </button>
              </div>
            </div>
          </aside>
        )}

        {/* ─ Right Panel: Tab Content ── */}
        <main className={`panel ${view !== 'home' ? 'settings-panel' : ''}`}>
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
                  <button className="btn primary settings-btn" onClick={() => setView('home')}>
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
                  <h3>Codex 路径</h3>
                  <p className="settings-desc">
                    留空时会自动检测默认安装目录和 Microsoft Store 安装记录；自动检测失败时，再填写安装目录或 Codex.exe 完整路径。
                  </p>
                  <div className="form">
                    <div className="field">
                      <label>安装目录 / 可执行文件</label>
                      <input
                        type="text"
                        value={codexPath}
                        spellCheck={false}
                        placeholder="例如 D:\Apps\Codex 或 D:\Apps\Codex\Codex.exe"
                        onChange={(e) => setCodexPath(e.target.value)}
                      />
                    </div>
                    <div className="actions settings-actions">
                      <button
                        className="btn primary settings-btn"
                        disabled={busy}
                        onClick={saveCodexPath}
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
                      <label>接口协议</label>
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
                          Chat Completions（经 dstAdapter 代理）
                        </option>
                        <option value="responses">Responses（直连）</option>
                      </select>
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
                                  onClick={() =>
                                    onUemcpEnable(
                                      s,
                                      currentApp === 'codex' ? 'codex' : 'workbuddy'
                                    )
                                  }
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
          ) : view === 'sessions' ? (
            openSession ? (
              <>
                <div className="panel-head">
                  <div className="session-detail-head">
                    <h2>{openSession.title}</h2>
                    <div className="sub" style={{ color: 'var(--muted)', fontSize: 13 }}>
                      {SESSION_APPS.find((a) => a.id === openSession.app)?.label || openSession.app}
                      　·　{formatSessionTime(openSession.lastActiveAt)}　·　{openSession.projectDir}
                    </div>
                  </div>
                  <div className="actions">
                    <button className="btn" onClick={closeSessionDetail}>
                      ← 返回列表
                    </button>
                    <button
                      className="btn danger"
                      onClick={() => onDeleteSession(openSession)}
                      disabled={sessionBusy}
                    >
                      删除会话
                    </button>
                  </div>
                </div>
                <div className="panel-body session-page">
                  {messagesLoading ? (
                    <div className="empty">正在加载会话消息…</div>
                  ) : !sessionPage || sessionPage.list.length === 0 ? (
                    <div className="empty">该会话没有可展示的消息。</div>
                  ) : (
                    <div className="session-messages">
                      {sessionPage.hasMore && (
                        <button
                          className="btn load-earlier"
                          onClick={loadEarlierMessages}
                          disabled={loadingEarlier}
                        >
                          {loadingEarlier ? '加载中…' : '↑ 加载更早的消息'}
                        </button>
                      )}
                      {sessionPage.total !== undefined && (
                        <div className="session-page-info">共 {sessionPage.total} 条消息</div>
                      )}
                      {sessionPage.list.map((m, idx) => (
                        <div key={idx} className={`msg ${m.role}`}>
                          <span className="msg-role">
                            {m.role === 'user' ? '用户' : m.role === 'assistant' ? '助手' : '工具'}
                            {m.timestamp ? ` · ${formatSessionTime(m.timestamp)}` : ''}
                          </span>
                          <pre className="msg-text">{m.text}</pre>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </>
            ) : (
              <>
                <div className="panel-head">
                  <div>
                    <h2>会话管理</h2>
                    <div className="sub" style={{ color: 'var(--muted)', fontSize: 13 }}>
                      浏览并管理 WorkBuddy / Codex 的本地历史会话
                    </div>
                  </div>
                  <div className="actions">
                    <button
                      className="btn"
                      onClick={() => loadSessions(sessionApp)}
                      disabled={sessionsLoading}
                    >
                      {sessionsLoading ? '扫描中…' : '刷新'}
                    </button>
                    <button className="btn primary settings-btn" onClick={() => setView('home')}>
                      ← 返回主页
                    </button>
                  </div>
                </div>
                <div className="panel-body session-page" onScroll={onSessionListScroll}>
                  <div className="session-toolbar">
                    <div className="chip-row">
                      {SESSION_APPS.map((a) => (
                        <button
                          key={a.id}
                          className={`chip ${sessionApp === a.id ? 'active' : ''}`}
                          onClick={() => setSessionApp(a.id)}
                        >
                          {a.label}
                        </button>
                      ))}
                    </div>
                    <input
                      type="text"
                      className="search-input"
                      placeholder="搜索会话（标题 / 摘要 / 项目）..."
                      value={sessionSearch}
                      onChange={(e) => setSessionSearch(e.target.value)}
                    />
                  </div>
                  {sessionsLoading ? (
                    <div className="empty">正在扫描本地会话…</div>
                  ) : sessionList.length === 0 ? (
                    <div className="empty">
                      <div className="empty-icon">💬</div>
                      <div>
                        {sessionSearch
                          ? `没有匹配「${sessionSearch.trim()}」的会话。`
                          : '暂无历史会话。'}
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="sync-info">
                        <span>
                          最近活跃：{formatSessionTime(sessionList[0].lastActiveAt)}
                        </span>
                        <span className="sync-stats">
                          会话总数：{sessions.length}　匹配：{sessionList.length}
                        </span>
                      </div>
                      <div className="session-list">
                        {sessionList.slice(0, listVisible).map((s) => (
                          <div
                            key={`${s.app}-${s.sessionId}`}
                            className="session-card"
                            onClick={() => openSessionDetail(s)}
                          >
                            <div className="session-card-main">
                              <div className="session-title">{s.title}</div>
                              <div className="session-summary">{s.summary || '（无摘要）'}</div>
                              <div className="session-meta">
                                <span className="session-project" title={s.projectDir}>
                                  {s.projectDir}
                                </span>
                                <span>·</span>
                                <span>{formatSessionTime(s.lastActiveAt)}</span>
                              </div>
                            </div>
                            <button
                              className="btn danger session-delete"
                              onClick={(e) => {
                                e.stopPropagation()
                                onDeleteSession(s)
                              }}
                              disabled={sessionBusy}
                            >
                              删除
                            </button>
                          </div>
                        ))}
                        {listVisible < sessionList.length && (
                          <button
                            className="btn load-earlier"
                            onClick={() => setListVisible((v) => v + 60)}
                          >
                            ↓ 加载更多（还有 {sessionList.length - listVisible} 个会话）
                          </button>
                        )}
                      </div>
                    </>
                  )}
                </div>
              </>
            )
          ) : view === 'prompts' ? (
            <>
              <div className="panel-head">
                <div>
                  <h2>提示词管理</h2>
                  <div className="sub" style={{ color: 'var(--muted)', fontSize: 13 }}>
                    维护个人常用提示词，使用公司统一模板
                  </div>
                </div>
                <div className="actions">
                  {promptTab === 'personal' && (
                    <button className="btn primary settings-btn" onClick={openPromptCreate}>
                      + 新建提示词
                    </button>
                  )}
                  <button className="btn settings-btn" onClick={() => setView('home')}>
                    ← 返回主页
                  </button>
                </div>
              </div>
              <div className="panel-body session-page">
                <div className="session-toolbar">
                  <div className="chip-row">
                    <button
                      className={`chip ${promptTab === 'personal' ? 'active' : ''}`}
                      onClick={() => setPromptTab('personal')}
                    >
                      个人提示词
                    </button>
                    <button
                      className={`chip ${promptTab === 'company' ? 'active' : ''}`}
                      onClick={() => setPromptTab('company')}
                    >
                      公司模板
                    </button>
                  </div>
                  <input
                    type="text"
                    className="search-input"
                    placeholder={
                      promptTab === 'personal'
                        ? '搜索我的提示词（名称 / 内容）...'
                        : '搜索公司模板（名称 / 描述）...'
                    }
                    value={promptSearch}
                    onChange={(e) => setPromptSearch(e.target.value)}
                  />
                </div>
                {promptTab === 'personal' ? (
                  promptsLoading ? (
                    <div className="empty">正在读取提示词…</div>
                  ) : filteredPrompts.length === 0 ? (
                    <div className="empty">
                      {promptSearch.trim() ? (
                        <>没有匹配 “{promptSearch.trim()}” 的提示词</>
                      ) : (
                        <>
                          <div className="empty-icon">📝</div>
                          还没有个人提示词，点右上角「新建提示词」开始
                        </>
                      )}
                    </div>
                  ) : (
                    <div className="list">
                      {filteredPrompts.map((p) => (
                        <div
                          key={p.id}
                          className="card prompt-card"
                          onClick={() =>
                            setViewingPrompt({
                              name: p.name,
                              content: p.content,
                              source: 'personal',
                              prompt: p
                            })
                          }
                        >
                          <div>
                            <h4>{p.name}</h4>
                            <div className="prompt-content-preview">{p.content}</div>
                            <div className="sub">更新于 {formatSessionTime(p.updatedAt)}</div>
                            <div className="row mcp-actions" onClick={(e) => e.stopPropagation()}>
                              <button
                                className="btn primary"
                                onClick={() => onCopyPrompt(p.content)}
                              >
                                使用
                              </button>
                              <button className="btn" onClick={() => openPromptEdit(p)}>
                                编辑
                              </button>
                              <button
                                className="btn danger"
                                disabled={promptBusy}
                                onClick={() => onDeletePrompt(p)}
                              >
                                删除
                              </button>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )
                ) : filteredTemplates.length === 0 ? (
                  <div className="empty">没有匹配 “{promptSearch.trim()}” 的公司模板</div>
                ) : (
                  <div className="list">
                    {filteredTemplates.map((t) => (
                      <div
                        key={t.id}
                        className="card prompt-card"
                        onClick={() =>
                          setViewingPrompt({
                            name: t.name,
                            description: t.description,
                            content: t.content,
                            source: 'company',
                            template: t
                          })
                        }
                      >
                        <div>
                          <h4>
                            {t.name}
                            <span className="badge builtin">公司模板</span>
                          </h4>
                          <div className="sub">{t.description}</div>
                          <div className="prompt-content-preview">{t.content}</div>
                          <div className="row mcp-actions" onClick={(e) => e.stopPropagation()}>
                            <button
                              className="btn primary"
                              onClick={() => onCopyPrompt(t.content)}
                            >
                              使用
                            </button>
                            <button
                              className="btn"
                              disabled={promptBusy}
                              onClick={() => onSaveTemplateAsPersonal(t)}
                            >
                              另存为个人提示词
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
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
                  <h2>模型管理</h2>
                  <div className="sub" style={{ color: 'var(--muted)', fontSize: 12 }}>
                    {currentMeta?.implemented
                      ? `${currentMeta.name} · ${currentMeta.configPath || currentMeta.message}`
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
                ) : (
                  <>
                    {/* 搜索和刷新按钮（空列表时也可同步） */}
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
                        disabled={busy || syncing}
                      >
                        {syncing ? '同步中...' : '🔄 刷新模型清单'}
                      </button>
                    </div>
                    {models.length === 0 ? (
                      <div className="empty">
                        <div className="empty-icon">📦</div>
                        <div>
                          {settings?.providerApiKey || appProviders.length > 0
                            ? '暂无模型。点击「刷新模型清单」同步可用模型。'
                            : '还没有配置 Provider。请先到设置中配置，再点击「刷新模型清单」。'}
                        </div>
                      </div>
                    ) : (
                    <>
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
                  <>
                    {/* 工具搜索 */}
                    <div className="model-toolbar">
                      <input
                        type="text"
                        className="search-input"
                        placeholder="搜索工具（名称 / 服务商 / 能力）..."
                        value={mcpSearch}
                        onChange={(e) => setMcpSearch(e.target.value)}
                      />
                      <span className="sync-stats">
                        共 {currentAppMcpServices.length} 项
                      </span>
                    </div>
                    {filteredMcpServices.length === 0 ? (
                      <div className="empty">
                        <div className="empty-icon">🔍</div>
                        <div>没有匹配「{mcpSearch.trim()}」的工具。</div>
                      </div>
                    ) : (
                      <div className="list">
                        {filteredMcpServices.map((s) => (
                          <div
                            key={s.id}
                            className={`card ${s.enabledForCurrentApp ? 'enabled' : ''}`}
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
                                {mcpCapability(s, currentApp)}
                              </div>
                              <div className="row mcp-actions">
                                <button
                                  className="btn primary"
                                  disabled={busy}
                                  onClick={() =>
                                    onUemcpEnable(s, currentApp)
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
                  </>
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
                  <>
                    {/* 技能搜索 */}
                    <div className="model-toolbar">
                      <input
                        type="text"
                        className="search-input"
                        placeholder="搜索技能（名称 / 描述 / 厂商）..."
                        value={skillSearch}
                        onChange={(e) => setSkillSearch(e.target.value)}
                      />
                      <span className="sync-stats">
                        共 {skillCatalog.skills.length} 项
                      </span>
                    </div>
                    {filteredSkills.length === 0 ? (
                      <div className="empty">
                        <div className="empty-icon">🔍</div>
                        <div>没有匹配「{skillSearch.trim()}」的技能。</div>
                      </div>
                    ) : (
                    <div className="list">
                      {filteredSkills.map((skill: RemoteSkillPackage) => (
                      <div
                        key={`${skill.id}-${skill.version}`}
                        className={`card ${skill.installed && skill.enabled ? 'enabled' : ''}`}
                      >
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
                              currentApp === 'workbuddy' &&
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
                              skill.enabled ? (
                                <span className="badge ok">已启用</span>
                              ) : (
                                <span className="badge">已停用</span>
                              )
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
                  </>
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

      {/* 提示词新建/编辑弹窗 */}
      {showPromptEditor && (
        <div className="modal-backdrop" onClick={() => setShowPromptEditor(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>{editingPrompt ? '编辑提示词' : '新建提示词'}</h3>
            <div className="form">
              <div className="field">
                <label>名称</label>
                <input
                  type="text"
                  value={promptForm.name}
                  maxLength={50}
                  placeholder="例如：周报生成"
                  onChange={(e) => setPromptForm((s) => ({ ...s, name: e.target.value }))}
                />
              </div>
              <div className="field">
                <label>内容</label>
                <textarea
                  className="prompt-textarea"
                  rows={10}
                  maxLength={5000}
                  value={promptForm.content}
                  placeholder="提示词正文，支持多行"
                  onChange={(e) => setPromptForm((s) => ({ ...s, content: e.target.value }))}
                />
              </div>
              <div className="actions">
                <button className="btn" onClick={() => setShowPromptEditor(false)}>
                  取消
                </button>
                <button className="btn primary" disabled={promptBusy} onClick={savePrompt}>
                  保存
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 提示词查看详情弹窗 */}
      {viewingPrompt && (
        <div className="modal-backdrop" onClick={() => setViewingPrompt(null)}>
          <div className="modal prompt-detail-modal" onClick={(e) => e.stopPropagation()}>
            <h3>
              {viewingPrompt.name}
              {viewingPrompt.source === 'company' ? (
                <span className="badge builtin">公司模板</span>
              ) : (
                <span className="badge">个人提示词</span>
              )}
            </h3>
            {viewingPrompt.description && (
              <div className="sub" style={{ color: 'var(--muted)', fontSize: 13 }}>
                {viewingPrompt.description}
              </div>
            )}
            <pre className="prompt-detail-content">{viewingPrompt.content}</pre>
            <div className="actions">
              <button className="btn" onClick={() => setViewingPrompt(null)}>
                关闭
              </button>
              {viewingPrompt.source === 'company' ? (
                <>
                  <button
                    className="btn"
                    disabled={promptBusy}
                    onClick={() => {
                      if (viewingPrompt.template) void onSaveTemplateAsPersonal(viewingPrompt.template)
                    }}
                  >
                    另存为个人提示词
                  </button>
                  <button
                    className="btn primary"
                    onClick={() => void onCopyPrompt(viewingPrompt.content)}
                  >
                    使用
                  </button>
                </>
              ) : (
                <>
                  <button
                    className="btn danger"
                    disabled={promptBusy}
                    onClick={() => {
                      if (viewingPrompt.prompt) void onDeletePrompt(viewingPrompt.prompt)
                    }}
                  >
                    删除
                  </button>
                  <button
                    className="btn"
                    onClick={() => {
                      if (viewingPrompt.prompt) {
                        const target = viewingPrompt.prompt
                        setViewingPrompt(null)
                        openPromptEdit(target)
                      }
                    }}
                  >
                    编辑
                  </button>
                  <button
                    className="btn primary"
                    onClick={() => void onCopyPrompt(viewingPrompt.content)}
                  >
                    使用
                  </button>
                </>
              )}
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
