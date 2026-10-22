import { getSettings } from '../store'

/**
 * AI 能力平台数据归档
 *
 * 云盘上传完成后调用：先以 key_id + secret 换取 access_token（官方有效期 2 小时，
 * 内存缓存、过期自动刷新、401 强制换新重试一次），再按逻辑键调用 files/import
 * 把已在云盘桶中的对象登记到平台数据层，返回平台文件 id（status 先 pending，后台复制完成后变 ready）。
 *
 * 凭据来自设置中「AI能力平台配置」（assetBaseUrl / assetKey / assetSecret）。
 */

const TOKEN_TTL_MS = 2 * 60 * 60 * 1000
const REQUEST_TIMEOUT_MS = 20 * 1000

interface PlatformConnection {
  baseUrl: string
  key: string
  secret: string
}

let tokenCache: { token: string; expiresAt: number } | null = null

function getPlatformConnection(): PlatformConnection {
  const s = getSettings()
  return {
    baseUrl: s.assetBaseUrl.trim(),
    key: s.assetKey.trim(),
    secret: s.assetSecret.trim()
  }
}

/** 平台是否已完整配置（Base URL + Key + Secret 齐备才尝试数据归档）。 */
export function isPlatformConfigured(): boolean {
  const conn = getPlatformConnection()
  return Boolean(conn.baseUrl && conn.key && conn.secret)
}

/** GET /api/v1/cloud-drives 返回的单个云盘 AK/SK 配置。 */
export interface PlatformCloudDrive {
  drive?: string
  provider?: string
  access_key?: string
  secret_key?: string
  bucket?: string
  endpoint?: string
  path_prefix?: string
}

export interface PlatformCloudDrives {
  skill: PlatformCloudDrive | null
  ai_assets: PlatformCloudDrive | null
}

const DRIVES_CACHE_TTL_MS = 5 * 60 * 1000
let drivesCache: { value: PlatformCloudDrives; expiresAt: number } | null = null

function toPlatformCloudDrive(value: unknown): PlatformCloudDrive | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as PlatformCloudDrive
}

/** 读取平台云盘 AK/SK；skill 与 ai_assets 共用一次请求，5 分钟缓存。 */
export async function fetchPlatformCloudDrives(force = false): Promise<PlatformCloudDrives> {
  if (!force && drivesCache && Date.now() < drivesCache.expiresAt) {
    return drivesCache.value
  }
  const { ok, status, body } = await platformRequest('GET', '/api/v1/cloud-drives')
  if (!ok || !body) {
    throw new Error(platformErrorMessage(body, '获取平台云盘配置失败', status))
  }
  const drives: PlatformCloudDrives = {
    skill: toPlatformCloudDrive(body.skill),
    ai_assets: toPlatformCloudDrive(body.ai_assets)
  }
  drivesCache = { value: drives, expiresAt: Date.now() + DRIVES_CACHE_TTL_MS }
  return drives
}

/** 去尾斜杠的 API 根地址。 */
function apiRoot(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = REQUEST_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer))
}

/** 非 2xx 响应统一抛出可读错误（尽量取服务端 message）。 */
async function throwResponseError(resp: Response, fallback: string): Promise<never> {
  const text = await resp.text().catch(() => '')
  let message = ''
  try {
    const parsed = JSON.parse(text) as { message?: unknown; error?: unknown; detail?: unknown }
    const pick = (v: unknown): string => {
      if (typeof v === 'string') return v
      if (v && typeof v === 'object') {
        const m = (v as Record<string, unknown>).message
        if (typeof m === 'string') return m
      }
      return ''
    }
    message = pick(parsed.message) || pick(parsed.error) || pick(parsed.detail)
  } catch {
    /* 非 JSON 错误体，保留原始文本 */
  }
  throw new Error(message || `${fallback} HTTP ${resp.status}`)
}

function pickAccessToken(body: Record<string, unknown>): string {
  for (const key of ['access_token', 'token']) {
    const v = body[key]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  for (const wrapper of [body.data, body.result]) {
    if (wrapper && typeof wrapper === 'object') {
      const d = wrapper as Record<string, unknown>
      for (const key of ['access_token', 'token']) {
        const v = d[key]
        if (typeof v === 'string' && v.trim()) return v.trim()
      }
    }
  }
  return ''
}

/** key_id + secret 换取平台访问令牌；带缓存，过期自动刷新。 */
export async function getPlatformToken(force = false): Promise<string> {
  const conn = getPlatformConnection()
  if (!conn.baseUrl || !conn.key || !conn.secret) {
    throw new Error('未配置 AI 能力平台（请在设置中填写 Base URL / Key / Secret）')
  }
  if (!force && tokenCache && Date.now() < tokenCache.expiresAt) {
    return tokenCache.token
  }
  const resp = await fetchWithTimeout(`${apiRoot(conn.baseUrl)}/api/v1/auth/api-token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key_id: conn.key, secret: conn.secret })
  })
  if (!resp.ok) {
    await throwResponseError(resp, '换取平台令牌失败')
  }
  const body = (await resp.json().catch(() => ({}))) as Record<string, unknown>
  const token = pickAccessToken(body)
  if (!token) throw new Error('换取平台令牌响应缺少 access_token')
  tokenCache = { token, expiresAt: Date.now() + TOKEN_TTL_MS }
  return token
}

/** 从平台错误响应中提取可读消息（兼容 {error:{code,message}} 与平铺 message）。 */
export function platformErrorMessage(
  body: Record<string, unknown> | null,
  fallback: string,
  status?: number
): string {
  if (body) {
    const err = body.error
    if (err && typeof err === 'object') {
      const m = (err as Record<string, unknown>).message
      if (typeof m === 'string' && m) return m
    }
    if (typeof body.message === 'string' && body.message) return body.message
    if (typeof body.detail === 'string' && body.detail) return body.detail
  }
  return `${fallback}${status ? ` HTTP ${status}` : ''}`
}

/** 带平台令牌的通用请求（401 自动换新重试一次）；失败返回体解析为对象（可能为 null）。 */
export async function platformRequest(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  payload?: unknown
): Promise<{ status: number; ok: boolean; body: Record<string, unknown> | null }> {
  const conn = getPlatformConnection()
  const url = `${apiRoot(conn.baseUrl)}${path}`
  const submit = (token: string): Promise<Response> =>
    fetchWithTimeout(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(payload === undefined ? {} : { 'content-type': 'application/json' })
      },
      body: payload === undefined ? undefined : JSON.stringify(payload)
    })
  let resp = await submit(await getPlatformToken())
  // 令牌过期（401）：强制换新令牌重试一次
  if (resp.status === 401) {
    resp = await submit(await getPlatformToken(true))
  }
  const text = await resp.text()
  let body: Record<string, unknown> | null = null
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : null
  } catch {
    /* 非 JSON 响应 */
  }
  return { status: resp.status, ok: resp.ok, body }
}

/** 带平台令牌的 POST（401 自动换新重试一次）；失败返回体解析为对象（可能为 null）。 */
export async function postPlatformJson(
  path: string,
  payload: unknown
): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const { status, body } = await platformRequest('POST', path, payload)
  return { status, body }
}

export interface PlatformImportOptions {
  /** 逻辑键：云盘对象 key 去掉组织 path_prefix 后的业务路径 */
  key: string
  name?: string
  mime?: string
  folderId?: string
  /** 生成提示词（平台侧随文件记录展示） */
  prompt?: string
  /** 生成来源会话（如 workbuddy:<uuid>） */
  sessionId?: string
  /** 生成工具名（如 image_generation；请求键 tool_name → 平台 metadata_tool_name） */
  toolName?: string
  /** 生成模型（如 gemini-3-pro-image） */
  model?: string
  /** 来源应用渠道（workbuddy / codex） */
  sourceApp?: string
}

export interface PlatformImportResult {
  fileId: string
  status: string
}

/** 从 files/import 响应里取文件记录（兼容 {success,data} 包裹与平铺两种结构）。 */
function pickImportedFile(body: Record<string, unknown>): { id: string; status?: string } | null {
  const candidate =
    body.data !== undefined && body.data !== null && typeof body.data === 'object'
      ? (body.data as Record<string, unknown>)
      : null
  const sources = candidate && candidate.id !== undefined ? candidate : body
  const id = sources.id !== undefined ? String(sources.id) : ''
  if (!id) return null
  const status = typeof sources.status === 'string' ? sources.status : ''
  return { id, status }
}

/** 数据归档：把已上传到云盘桶的对象按逻辑键导入平台，返回文件 id 与后台状态。 */
export async function importAssetToPlatform(
  opts: PlatformImportOptions
): Promise<PlatformImportResult> {
  const conn = getPlatformConnection()
  if (!conn.baseUrl.trim()) {
    throw new Error('未配置 AI 能力平台 Base URL')
  }
  const payload: Record<string, string> = { key: opts.key }
  if (opts.name) payload.name = opts.name
  if (opts.mime) payload.mime = opts.mime
  if (opts.folderId) payload.folder_id = opts.folderId
  if (opts.prompt) payload.prompt = opts.prompt
  if (opts.sessionId) payload.session_id = opts.sessionId
  if (opts.toolName) payload.tool_name = opts.toolName
  if (opts.model) payload.model = opts.model
  if (opts.sourceApp) payload.source_app = opts.sourceApp

  const submit = (token: string): Promise<Response> =>
    fetchWithTimeout(`${apiRoot(conn.baseUrl)}/api/v1/files/import`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify(payload)
    })

  let resp = await submit(await getPlatformToken())
  // 令牌过期（401）：强制换新令牌重试一次
  if (resp.status === 401) {
    resp = await submit(await getPlatformToken(true))
  }
  if (!resp.ok) {
    await throwResponseError(resp, '数据归档失败')
  }
  const body = (await resp.json().catch(() => ({}))) as Record<string, unknown>
  const file = pickImportedFile(body)
  if (!file) throw new Error('数据归档响应缺少文件 id')
  return { fileId: file.id, status: file.status || 'pending' }
}
