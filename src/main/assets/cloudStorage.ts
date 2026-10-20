import { createHash, createHmac, randomUUID } from 'crypto'
import path from 'path'
import { toApiRoot } from '../../shared/url'

/**
 * 组织云存储（COS/OSS）上传模块
 *
 * 从 mcp/server.ts 抽取的预签名上传实现，供两处共用：
 * - file_upload MCP 工具（key 前缀 mcp-uploads）
 * - 生成资产自动归档（key 前缀 mcp-generations）
 *
 * 凭据经网关 `GET /api/cloud-storage/config` 按组织下发，只在内存中短暂使用。
 * 错误统一抛 `{ code, message }` 形状，与 MCP JSON-RPC 错误兼容。
 */

export type CloudStorageProvider = 'cos' | 'oss'

export interface CloudStorageConfig {
  organization_id: number
  provider: CloudStorageProvider
  bucket: string
  region?: string
  endpoint: string
  path_prefix?: string
  custom_domain?: string
  credentials: {
    secret_id?: string
    secret_key?: string
    access_key_id?: string
    access_key_secret?: string
  }
}

export interface CloudUploadResult {
  url: string
  key: string
  bucket: string
  provider: CloudStorageProvider
  filename: string
  size: number
  content_type: string
  expires_in: number
  expires_at: string
  /** 逻辑键：对象 key 去掉组织 path_prefix（数据归档 files/import 用它定位对象） */
  logicalKey: string
}

interface SignedCosUrlInput {
  method: 'GET' | 'PUT'
  host: string
  key: string
  secretId: string
  secretKey: string
  expires: number
  headers?: Record<string, string>
  params?: Record<string, string>
}

interface SignedOssUrlInput {
  method: 'GET' | 'PUT'
  baseUrl: string
  bucket: string
  key: string
  accessKeyId: string
  accessKeySecret: string
  expires: number
  contentType?: string
}

interface OssTarget {
  protocol: string
  uploadHost: string
  publicHost: string
}

export const MAX_FILE_UPLOAD_SIZE = 200 * 1024 * 1024
export const MIN_PRESIGNED_EXPIRES = 60
export const MAX_PRESIGNED_EXPIRES = 7 * 24 * 60 * 60

const CONFIG_CACHE_TTL_MS = 5 * 60 * 1000

const configCache = new Map<string, { config: CloudStorageConfig; fetchedAt: number }>()

function cacheKey(apiKey: string, provider?: CloudStorageProvider): string {
  const hash = createHash('sha256').update(apiKey).digest('hex').slice(0, 16)
  return `${hash}:${provider || 'default'}`
}

function invalidateConfig(apiKey: string, provider?: CloudStorageProvider): void {
  configCache.delete(cacheKey(apiKey, provider))
}

/** 通过 Provider Key 读取所属组织的云存储配置（凭据只在内存中短暂使用；5 分钟缓存）。 */
export async function getCloudStorageConfig(
  baseUrl: string,
  apiKey: string,
  provider?: CloudStorageProvider,
  opts?: { noCache?: boolean }
): Promise<CloudStorageConfig> {
  const key = apiKey.trim()
  if (!key) {
    throw { code: -32603, message: '未配置 API Key，请在设置中填写后再请求' }
  }
  const cacheId = cacheKey(key, provider)
  const cached = configCache.get(cacheId)
  if (!opts?.noCache && cached && Date.now() - cached.fetchedAt < CONFIG_CACHE_TTL_MS) {
    return cached.config
  }

  const query = provider ? `provider=${provider}` : ''
  const endpoint = `${toApiRoot(baseUrl)}/api/cloud-storage/config${query ? `?${query}` : ''}`
  const resp = await fetch(endpoint, {
    headers: { authorization: `Bearer ${key}` }
  })
  const text = await resp.text()
  if (!resp.ok) {
    throw { code: resp.status, message: `获取云存储配置失败 ${resp.status}: ${text.slice(0, 500)}` }
  }

  let body: { success?: boolean; data?: CloudStorageConfig; message?: string }
  try {
    body = text ? (JSON.parse(text) as typeof body) : {}
  } catch {
    throw { code: -32603, message: '云存储配置返回不是有效 JSON' }
  }

  const data = body.data
  if (!body.success || !data || (data.provider !== 'cos' && data.provider !== 'oss')) {
    throw { code: -32603, message: body.message || '云存储未配置，或存储类型不是 COS/OSS' }
  }
  if (!data.bucket) {
    throw { code: -32603, message: '云存储配置缺少 bucket' }
  }
  if (
    data.provider === 'cos' &&
    (!data.region || !data.credentials?.secret_id || !data.credentials?.secret_key)
  ) {
    throw { code: -32603, message: '腾讯云 COS 配置缺少 region 或凭据' }
  }
  if (
    data.provider === 'oss' &&
    (!data.endpoint || !data.credentials?.access_key_id || !data.credentials?.access_key_secret)
  ) {
    throw { code: -32603, message: '阿里云 OSS 配置缺少 endpoint 或凭据' }
  }
  configCache.set(cacheId, { config: data, fetchedAt: Date.now() })
  return data
}

function canonicalList(values: Record<string, string>, formatter: (key: string, value: string) => string): string {
  return Object.entries(values)
    .map(([key, value]) => formatter(encodeURIComponent(key).toLowerCase(), encodeURIComponent(value)))
    .sort()
    .join('&')
}

/** 生成腾讯云 COS 预签名 URL；只签名业务参数与显式请求头。 */
function buildSignedCosUrl(input: SignedCosUrlInput): string {
  const requestPath = input.key
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/')
  const requestPathname = `/${requestPath}`
  const signaturePathname = `/${input.key}`
  const now = Math.floor(Date.now() / 1000)
  const keyTime = `${now};${now + input.expires}`
  const signKey = createHmac('sha1', input.secretKey).update(keyTime).digest('hex')

  const params = Object.fromEntries(
    Object.entries(input.params || {}).map(([key, value]) => [key.toLowerCase(), value])
  )
  const headers = Object.fromEntries(
    Object.entries(input.headers || {}).map(([key, value]) => [key.toLowerCase(), value])
  )
  const paramsString = canonicalList(params, (key, value) => `${key}=${value}`)
  const headersString = canonicalList(headers, (key, value) => `${key}=${value.replace(/\s+/g, ' ').trim()}`)
  const httpString = `${input.method.toLowerCase()}\n${signaturePathname}\n${paramsString}\n${headersString}\n`
  const stringToSign = `sha1\n${keyTime}\n${createHash('sha1').update(httpString).digest('hex')}\n`
  const signature = createHmac('sha1', signKey).update(stringToSign).digest('hex')

  const query = new URLSearchParams({
    'q-sign-algorithm': 'sha1',
    'q-ak': input.secretId,
    'q-sign-time': keyTime,
    'q-key-time': keyTime,
    'q-header-list': Object.keys(headers).sort().join(';'),
    'q-url-param-list': Object.keys(params).sort().join(';'),
    'q-signature': signature
  })
  return `https://${input.host}${requestPathname}?${query.toString()}`
}

/** COS API 必须走虚拟主机域名；自定义域名只用于公开访问 URL。 */
function cosApiHost(config: CloudStorageConfig, bucket?: string): string {
  return `${bucket || config.bucket}.cos.${config.region}.myqcloud.com`
}

function cosPublicHost(config: CloudStorageConfig, bucket?: string): string {
  const custom = config.custom_domain?.trim().replace(/\/+$/, '')
  if (custom) return custom.replace(/^https?:\/\//i, '')
  return cosApiHost(config, bucket)
}

/** 生成 OSS V1 预签名 URL；上传时显式签名 Content-Type。 */
function buildSignedOssUrl(input: SignedOssUrlInput): string {
  const pathname = input.key
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/')
  const expires = Math.floor(Date.now() / 1000) + input.expires
  const contentType = input.contentType || ''
  const stringToSign = [
    input.method,
    '',
    contentType,
    String(expires),
    `/${input.bucket}/${input.key}`
  ].join('\n')
  const signature = createHmac('sha1', input.accessKeySecret)
    .update(stringToSign)
    .digest('base64')

  const query = new URLSearchParams({
    OSSAccessKeyId: input.accessKeyId,
    Expires: String(expires),
    Signature: signature
  })
  return `${input.baseUrl}/${pathname}?${query.toString()}`
}

/** OSS 走虚拟主机域名；管理端可能存区域 Endpoint 或已带 bucket 的完整 Endpoint。 */
function resolveOssTarget(config: CloudStorageConfig, bucket?: string): OssTarget {
  const targetBucket = bucket || config.bucket
  const rawEndpoint = config.endpoint.trim()
  const endpointUrl = new URL(/^https?:\/\//i.test(rawEndpoint) ? rawEndpoint : `https://${rawEndpoint}`)
  const endpointHost = endpointUrl.host
  const uploadHost = endpointHost.startsWith(`${targetBucket}.`)
    ? endpointHost
    : `${targetBucket}.${endpointHost}`
  const custom = config.custom_domain?.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '')

  return {
    protocol: endpointUrl.protocol.replace(':', ''),
    uploadHost,
    publicHost: custom || uploadHost
  }
}

/** 对象 key 路径段清洗：去分隔符/控制字符（中文等非 ASCII 保留，签名时会 URL 编码）。 */
export function sanitizeKeySegment(value: string): string {
  return value
    .replace(/[\\/:*?"<>|\r\n\t]+/g, '_')
    .trim()
    .slice(0, 64)
}

/** 本地时区日期路径段 YYYYMMDD（归档按生成日期分目录用）。 */
export function localDatePath(date?: Date | string): string {
  const d = date ? new Date(date) : new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}${m}${day}`
}

export function sanitizeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() || ''
  return base
    .replace(/[\\/:*?"<>|\r\n\t]+/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 120)
}

export function guessContentType(filename: string): string {
  const ext = path.extname(filename).toLowerCase()
  const types: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.csv': 'text/csv',
    '.json': 'application/json',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.zip': 'application/zip',
    '.glb': 'model/gltf-binary',
    '.gltf': 'model/gltf+json',
    '.fbx': 'application/octet-stream',
    '.obj': 'text/plain',
    '.usdz': 'model/vnd.usdz+zip'
  }
  return types[ext] || 'application/octet-stream'
}

export function parsePresignedExpires(value: unknown): number {
  const requested = typeof value === 'number' ? value : Number(value)
  const expires = Number.isFinite(requested) ? Math.floor(requested) : 3600
  return Math.min(Math.max(expires, MIN_PRESIGNED_EXPIRES), MAX_PRESIGNED_EXPIRES)
}

export interface UploadToCloudOptions {
  baseUrl: string
  apiKey: string
  buffer: Buffer
  filename: string
  contentType?: string
  provider?: CloudStorageProvider
  /** 对象 key 的业务前缀段；file_upload 用 mcp-uploads，生成归档用 mcp-generations。 */
  keyPrefix?: string
  /** 完整业务路径段（斜杠分隔，如 mcp-generations/<用户>/<日期>/<类型>）；提供时取代 keyPrefix+日期的默认结构。 */
  keyPath?: string
  /** 返回公网 GET 链接的有效期（秒）。 */
  expiresIn?: number
}

/** 单次「取配置 → 组 key → 预签名 → PUT」；供上传失败重试复用。 */
async function putOnce(opts: UploadToCloudOptions, noCache: boolean): Promise<CloudUploadResult> {
  const config = await getCloudStorageConfig(opts.baseUrl, opts.apiKey, opts.provider, { noCache })
  const expires = opts.expiresIn ?? 3600
  const businessPath =
    opts.keyPath?.replace(/^\/+|\/+$/g, '') || [opts.keyPrefix || 'mcp-uploads', localDatePath()].join('/')
  const normalizedPrefix = config.path_prefix?.replace(/^\/+|\/+$/g, '') || ''
  const objectName = `${randomUUID()}_${opts.filename}`
  const logicalKey = [businessPath, objectName].join('/')
  const key = [normalizedPrefix, logicalKey].filter(Boolean).join('/')
  const contentType = opts.contentType || guessContentType(opts.filename)

  let uploadUrl: string
  let publicUrl: string
  if (config.provider === 'oss') {
    const target = resolveOssTarget(config)
    const accessKeyId = config.credentials.access_key_id || ''
    const accessKeySecret = config.credentials.access_key_secret || ''
    uploadUrl = buildSignedOssUrl({
      method: 'PUT',
      baseUrl: `${target.protocol}://${target.uploadHost}`,
      bucket: config.bucket,
      key,
      accessKeyId,
      accessKeySecret,
      expires: 600,
      contentType
    })
    publicUrl = buildSignedOssUrl({
      method: 'GET',
      baseUrl: `${target.protocol}://${target.publicHost}`,
      bucket: config.bucket,
      key,
      accessKeyId,
      accessKeySecret,
      expires
    })
  } else {
    uploadUrl = buildSignedCosUrl({
      method: 'PUT',
      host: cosApiHost(config),
      key,
      secretId: config.credentials.secret_id || '',
      secretKey: config.credentials.secret_key || '',
      expires: 600,
      headers: { 'content-type': contentType }
    })
    publicUrl = buildSignedCosUrl({
      method: 'GET',
      host: cosPublicHost(config),
      key,
      secretId: config.credentials.secret_id || '',
      secretKey: config.credentials.secret_key || '',
      expires
    })
  }

  const uploadResp = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'content-type': contentType },
    body: new Uint8Array(opts.buffer)
  })
  if (!uploadResp.ok) {
    const errorText = await uploadResp.text()
    const err = {
      code: uploadResp.status,
      message: `${config.provider.toUpperCase()} 上传失败 ${uploadResp.status}: ${errorText.slice(0, 800)}`
    }
    // 401/403 多为组织临时凭据过期 → 失效缓存后交由上层重试一次
    if (uploadResp.status === 401 || uploadResp.status === 403) {
      ;(err as { retryable?: boolean }).retryable = true
    }
    throw err
  }

  return {
    url: publicUrl,
    key,
    logicalKey,
    bucket: config.bucket,
    provider: config.provider,
    filename: opts.filename,
    size: opts.buffer.byteLength,
    content_type: contentType,
    expires_in: expires,
    expires_at: new Date(Date.now() + expires * 1000).toISOString()
  }
}

/** 上传文件到组织绑定的 COS/OSS，并返回带过期时间的公网访问 URL。 */
export async function uploadToCloudStorage(opts: UploadToCloudOptions): Promise<CloudUploadResult> {
  try {
    return await putOnce(opts, false)
  } catch (err) {
    if ((err as { retryable?: boolean })?.retryable) {
      invalidateConfig(opts.apiKey, opts.provider)
      return putOnce(opts, true)
    }
    throw err
  }
}

/** 为已归档对象重签一个公网 GET 链接（记录页按需获取）。 */
export async function signObjectGetUrl(opts: {
  baseUrl: string
  apiKey: string
  provider: CloudStorageProvider
  bucket: string
  key: string
  region?: string
  expiresIn?: number
}): Promise<{ url: string; expiresAt: string }> {
  const expires = opts.expiresIn ?? 24 * 60 * 60
  const config = await getCloudStorageConfig(opts.baseUrl, opts.apiKey, opts.provider)
  const configForBucket: CloudStorageConfig = { ...config, bucket: opts.bucket, region: opts.region || config.region }

  let url: string
  if (configForBucket.provider === 'oss') {
    const target = resolveOssTarget(configForBucket)
    url = buildSignedOssUrl({
      method: 'GET',
      baseUrl: `${target.protocol}://${target.publicHost}`,
      bucket: opts.bucket,
      key: opts.key,
      accessKeyId: config.credentials.access_key_id || '',
      accessKeySecret: config.credentials.access_key_secret || '',
      expires
    })
  } else {
    url = buildSignedCosUrl({
      method: 'GET',
      host: cosPublicHost(configForBucket),
      key: opts.key,
      secretId: config.credentials.secret_id || '',
      secretKey: config.credentials.secret_key || '',
      expires
    })
  }
  return { url, expiresAt: new Date(Date.now() + expires * 1000).toISOString() }
}
