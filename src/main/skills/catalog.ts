import { createHash, createHmac } from 'crypto'
import type {
  RemoteSkillPackage,
  SkillCatalogResult,
  SkillRepositoryInfo
} from '../../shared/types'
import { getDstConnection } from '../store'
import { ensureSkPrefix, toApiRoot } from '../../shared/url'
import { compareVersions } from './version'

type SkillStorageProvider = 'oss' | 'cos'

interface StorageCredentials {
  accessKeyId?: string
  accessKeySecret?: string
  secretId?: string
  secretKey?: string
  securityToken?: string
}

interface SkillRepositoryConfig {
  provider: SkillStorageProvider
  bucket: string
  endpoint: string
  region?: string
  pathPrefix: string
  customDomain?: string
  credentials: StorageCredentials
}

interface ApiEnvelope {
  success?: boolean
  message?: string
  data?: unknown
}

interface StorageObject {
  key: string
  size: number
  etag: string
  lastModified: string
}

interface StorageListResult {
  objects: StorageObject[]
  nextMarker?: string
}

interface SkillIndexEntry {
  id?: unknown
  name?: unknown
  description?: unknown
  version?: unknown
  archivePath?: unknown
  sha256?: unknown
  size?: unknown
  vendor?: unknown
  minWorkBuddyVersion?: unknown
}

interface SkillIndex {
  version: number
  generatedAt?: string
  skills: SkillIndexEntry[]
}

const CONFIG_CACHE_TTL_MS = 5 * 60 * 1000
const CATALOG_CACHE_TTL_MS = 60 * 1000
const MAX_LIST_PAGES = 100
const MAX_SKILLS = 1000
const MAX_ARCHIVE_SIZE = 200 * 1024 * 1024
const ARCHIVE_DOWNLOAD_TIMEOUT_MS = 120 * 1000
const CONFIG_ENDPOINT_PATH =
  process.env.DST_SKILL_REPOSITORY_CONFIG_PATH || '/api/skill-storage/config?provider=oss'
const INDEX_OBJECT_NAME = 'index.json'

let configCache: { value: SkillRepositoryConfig; expiresAt: number } | null = null
let catalogCache: { value: SkillCatalogResult; expiresAt: number } | null = null

function normalizePrefix(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value
    .replace(/\\/g, '/')
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean)
    .join('/')
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function parseRepositoryConfig(
  raw: unknown,
  dedicatedEndpoint: boolean
): SkillRepositoryConfig {
  const root = asRecord(raw)
  if (!root) throw new Error('Skill 仓储配置返回为空')

  const provider = String(root.provider || '').trim().toLowerCase() as SkillStorageProvider
  if (provider !== 'oss' && provider !== 'cos') {
    throw new Error(`Skill 仓储当前仅支持 OSS/COS，服务端返回 ${provider || '未知类型'}`)
  }

  const bucket = firstString(root.bucket)
  const endpoint = firstString(root.endpoint)
  const region = firstString(root.region)
  const pathPrefix = dedicatedEndpoint
    ? normalizePrefix(
        firstString(root.path_prefix, root.prefix, root.skill_prefix, root.repository_prefix)
      )
    : normalizePrefix(
        firstString(root.skill_path_prefix, root.skill_prefix, root.repository_prefix)
      )
  if (!bucket) throw new Error('Skill 仓储配置缺少 bucket')
  if (provider === 'oss' && !endpoint) throw new Error('Skill 仓储配置缺少 OSS endpoint')
  if (provider === 'cos' && !endpoint && !region) {
    throw new Error('Skill 仓储配置缺少 COS endpoint 或 region')
  }

  const rawCredentials = asRecord(root.credentials)
  const credentials: StorageCredentials = {
    accessKeyId: firstString(
      rawCredentials?.access_key_id,
      rawCredentials?.accessKeyId,
      root.access_key_id
    ),
    accessKeySecret: firstString(
      rawCredentials?.access_key_secret,
      rawCredentials?.accessKeySecret,
      root.access_key_secret
    ),
    secretId: firstString(
      rawCredentials?.secret_id,
      rawCredentials?.secretId,
      root.secret_id
    ),
    secretKey: firstString(
      rawCredentials?.secret_key,
      rawCredentials?.secretKey,
      root.secret_key
    ),
    securityToken: firstString(
      rawCredentials?.security_token,
      rawCredentials?.securityToken,
      rawCredentials?.sts_token
    )
  }
  if (provider === 'oss' && (!credentials.accessKeyId || !credentials.accessKeySecret)) {
    throw new Error('Skill 仓储配置缺少 OSS 凭据')
  }
  if (provider === 'cos' && (!credentials.secretId || !credentials.secretKey)) {
    throw new Error('Skill 仓储配置缺少 COS 凭据')
  }

  return {
    provider,
    bucket,
    endpoint: endpoint || '',
    region,
    pathPrefix,
    customDomain: firstString(root.custom_domain, root.customDomain),
    credentials
  }
}

async function fetchRepositoryConfig(): Promise<SkillRepositoryConfig> {
  if (configCache && configCache.expiresAt > Date.now()) return configCache.value

  const connection = getDstConnection()
  if (!connection.apiKey.trim()) {
    throw new Error('未配置 API Key，请先在设置中填写 Provider Key')
  }

  const apiRoot = toApiRoot(connection.endpoint)
  const authHeader = { authorization: `Bearer ${ensureSkPrefix(connection.apiKey)}` }
  const candidates = [`${apiRoot}${CONFIG_ENDPOINT_PATH}`]

  for (let index = 0; index < candidates.length; index += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 20000)
    try {
      const response = await fetch(candidates[index], {
        headers: authHeader,
        signal: controller.signal
      })
      const text = await response.text()
      if (!response.ok) {
        if (response.status === 404 && index < candidates.length - 1) continue
        throw new Error(`获取 Skill 仓储配置失败 ${response.status}: ${text.slice(0, 500)}`)
      }

      let body: ApiEnvelope
      try {
        body = text ? JSON.parse(text) as ApiEnvelope : {}
      } catch {
        throw new Error('Skill 仓储配置返回不是有效 JSON')
      }
      if (!body.success || body.data === undefined) {
        throw new Error(body.message || 'Skill 仓储未配置或配置返回无效')
      }

      const config = parseRepositoryConfig(body.data, index === 0)
      configCache = { value: config, expiresAt: Date.now() + CONFIG_CACHE_TTL_MS }
      return config
    } finally {
      clearTimeout(timer)
    }
  }
  throw new Error('获取 Skill 仓储配置失败：没有可用配置接口')
}

function ossPercentEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  )
}

function buildCanonicalQuery(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([key, value]) => ({
      key: ossPercentEncode(key),
      value: ossPercentEncode(value)
    }))
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((item) => `${item.key}=${item.value}`)
    .join('&')
}

function resolveOssOrigin(config: SkillRepositoryConfig): string {
  const rawEndpoint = config.endpoint.trim()
  const endpoint = /^https?:\/\//i.test(rawEndpoint) ? rawEndpoint : `https://${rawEndpoint}`
  const url = new URL(endpoint)
  const host = url.host.toLowerCase().startsWith(`${config.bucket.toLowerCase()}.`)
    ? url.host
    : `${config.bucket}.${url.host}`
  return `${url.protocol}//${host}`
}

function resolveCosOrigin(config: SkillRepositoryConfig): string {
  if (config.endpoint) {
    const endpoint = /^https?:\/\//i.test(config.endpoint)
      ? config.endpoint
      : `https://${config.endpoint}`
    const url = new URL(endpoint)
    const host = url.host.toLowerCase().startsWith(`${config.bucket.toLowerCase()}.`)
      ? url.host
      : `${config.bucket}.${url.host}`
    return `${url.protocol}//${host}`
  }
  if (!config.region) throw new Error('COS endpoint 或 region 缺失')
  return `https://${config.bucket}.cos.${config.region}.myqcloud.com`
}

function ossCredentials(config: SkillRepositoryConfig): {
  id: string
  secret: string
  token?: string
} {
  const { accessKeyId, accessKeySecret, securityToken } = config.credentials
  if (!accessKeyId || !accessKeySecret) throw new Error('OSS 凭据不完整')
  return { id: accessKeyId, secret: accessKeySecret, token: securityToken }
}

function canonicalList(
  values: Record<string, string>,
  formatter: (key: string, value: string) => string
): string {
  return Object.entries(values)
    .map(([key, value]) =>
      formatter(encodeURIComponent(key).toLowerCase(), encodeURIComponent(value))
    )
    .sort()
    .join('&')
}

function cosAuthorization(
  config: SkillRepositoryConfig,
  key: string,
  params: Record<string, string> = {}
): string {
  const { secretId, secretKey } = config.credentials
  if (!secretId || !secretKey) throw new Error('COS 凭据不完整')

  const now = Math.floor(Date.now() / 1000)
  const keyTime = `${now};${now + 10 * 60}`
  const signKey = createHmac('sha1', secretKey).update(keyTime).digest('hex')
  const paramsString = canonicalList(params, (name, value) => `${name}=${value}`)
  const httpString = ['get', `/${key}`, paramsString, '', ''].join('\n')
  const stringToSign = `sha1\n${keyTime}\n${createHash('sha1').update(httpString).digest('hex')}\n`
  const signature = createHmac('sha1', signKey).update(stringToSign).digest('hex')

  return [
    'q-sign-algorithm=sha1',
    `q-ak=${encodeURIComponent(secretId)}`,
    `q-sign-time=${encodeURIComponent(keyTime)}`,
    `q-key-time=${encodeURIComponent(keyTime)}`,
    'q-header-list=',
    `q-url-param-list=${encodeURIComponent(Object.keys(params).sort().join(';'))}`,
    `q-signature=${signature}`
  ].join('&')
}

function ossAuthorization(
  config: SkillRepositoryConfig
): { date: string; authorization: string } {
  const credentials = ossCredentials(config)
  const date = new Date().toUTCString()
  const canonicalHeaders = credentials.token
    ? `x-oss-security-token:${credentials.token}\n`
    : ''
  // OSS ListObjects query parameters are not part of V1 CanonicalizedResource.
  const canonicalResource = `/${config.bucket}/`
  const stringToSign = [
    'GET',
    '',
    '',
    date,
    `${canonicalHeaders}${canonicalResource}`
  ].join('\n')
  const signature = createHmac('sha1', credentials.secret)
    .update(stringToSign)
    .digest('base64')
  return {
    date,
    authorization: `OSS ${credentials.id}:${signature}`
  }
}

function decodeXmlValue(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&')
}

function xmlChild(block: string, tagName: string): string | undefined {
  const match = new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`, 'i').exec(block)
  return match ? decodeXmlValue(match[1].trim()) : undefined
}

function normalizeObjectKey(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const key = normalizePrefix(value)
  if (!key || key.split('/').includes('..')) return undefined
  return key
}

function resolveIndexedObjectKey(value: unknown, prefix: string): string | undefined {
  const key = normalizeObjectKey(value)
  if (!key) return undefined
  if (key === prefix || key.startsWith(`${prefix}/`)) return key
  return [prefix, key].filter(Boolean).join('/')
}

function objectKeyWithPrefix(value: string, prefix: string): string {
  return [prefix, value].filter(Boolean).join('/')
}

function parseSkillIndex(raw: string): SkillIndex {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('index.json 不是有效 JSON')
  }

  const root = asRecord(parsed)
  const version = Number(root?.version)
  const rawSkills = root?.skills
  if (!root || version !== 1 || !Array.isArray(rawSkills)) {
    throw new Error('index.json 版本或结构不受支持')
  }

  const generatedAtRaw = root.generatedAt
  return {
    version,
    generatedAt:
      typeof generatedAtRaw === 'string' && generatedAtRaw.trim()
        ? new Date(generatedAtRaw.trim()).toISOString()
        : undefined,
    skills: rawSkills.filter((item): item is SkillIndexEntry => asRecord(item) !== null)
  }
}

async function fetchOssObject(
  config: SkillRepositoryConfig,
  key: string
): Promise<string | undefined> {
  const origin = resolveOssOrigin(config)
  const credentials = ossCredentials(config)
  const encodedKey = key.split('/').map(ossPercentEncode).join('/')
  const canonicalResource = `/${config.bucket}/${key}`
  const canonicalHeaders = credentials.token
    ? `x-oss-security-token:${credentials.token}\n`
    : ''
  const date = new Date().toUTCString()
  const stringToSign = [
    'GET',
    '',
    '',
    date,
    `${canonicalHeaders}${canonicalResource}`
  ].join('\n')
  const signature = createHmac('sha1', credentials.secret)
    .update(stringToSign)
    .digest('base64')

  const response = await fetch(`${origin}/${encodedKey}`, {
    headers: {
      date,
      authorization: `OSS ${credentials.id}:${signature}`,
      ...(credentials.token
        ? { 'x-oss-security-token': credentials.token }
        : {})
    }
  })
  if (response.status === 404) return undefined
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`读取 ${key} 失败 ${response.status}: ${text.slice(0, 500)}`)
  }
  return text
}

async function fetchCosObject(
  config: SkillRepositoryConfig,
  key: string
): Promise<string | undefined> {
  const encodedKey = key.split('/').map(ossPercentEncode).join('/')
  const response = await fetch(`${resolveCosOrigin(config)}/${encodedKey}`, {
    headers: {
      authorization: cosAuthorization(config, key)
    }
  })
  if (response.status === 404) return undefined
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`读取 ${key} 失败 ${response.status}: ${text.slice(0, 500)}`)
  }
  return text
}

async function fetchStorageObject(
  config: SkillRepositoryConfig,
  key: string
): Promise<string | undefined> {
  return config.provider === 'cos' ? fetchCosObject(config, key) : fetchOssObject(config, key)
}

async function fetchStorageBuffer(
  config: SkillRepositoryConfig,
  key: string
): Promise<Buffer> {
  const headers = config.provider === 'oss'
    ? (() => {
        const credentials = ossCredentials(config)
        const canonicalResource = `/${config.bucket}/${key}`
        const canonicalHeaders = credentials.token
          ? `x-oss-security-token:${credentials.token}\n`
          : ''
        const date = new Date().toUTCString()
        const signature = createHmac('sha1', credentials.secret)
          .update([
            'GET',
            '',
            '',
            date,
            `${canonicalHeaders}${canonicalResource}`
          ].join('\n'))
          .digest('base64')
        return {
          date,
          authorization: `OSS ${credentials.id}:${signature}`,
          ...(credentials.token ? { 'x-oss-security-token': credentials.token } : {})
        }
      })()
    : { authorization: cosAuthorization(config, key) }

  const encodedKey = key.split('/').map(ossPercentEncode).join('/')
  const origin = config.provider === 'cos' ? resolveCosOrigin(config) : resolveOssOrigin(config)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ARCHIVE_DOWNLOAD_TIMEOUT_MS)
  try {
    const response = await fetch(`${origin}/${encodedKey}`, {
      headers,
      signal: controller.signal
    })
    if (!response.ok) {
      const detail = response.body ? (await response.text()).slice(0, 500) : ''
      if (response.status === 404) throw new Error(`Skill 包不存在：${key}`)
      throw new Error(`下载 ${key} 失败 ${response.status}: ${detail}`)
    }

    const data = Buffer.from(await response.arrayBuffer())
    const contentLength = Number(response.headers.get('content-length'))
    if (Number.isFinite(contentLength) && contentLength >= 0 && contentLength !== data.length) {
      throw new Error(`Skill 包传输不完整：期望 ${contentLength} 字节，实际 ${data.length} 字节`)
    }
    if (data.length === 0) throw new Error(`Skill 包为空：${key}`)
    if (data.length > MAX_ARCHIVE_SIZE) {
      throw new Error(`Skill 包超过大小限制 ${MAX_ARCHIVE_SIZE} 字节`)
    }
    return data
  } finally {
    clearTimeout(timer)
  }
}

function parseStorageListXml(xml: string): StorageListResult {
  const blocks = xml.match(/<Contents>([\s\S]*?)<\/Contents>/gi) || []
  const objects = blocks.map((block) => {
    const key = xmlChild(block, 'Key')
    const size = Number(xmlChild(block, 'Size'))
    const etag = xmlChild(block, 'ETag') || ''
    const lastModified = xmlChild(block, 'LastModified') || ''
    if (!key || !Number.isFinite(size)) return null
    return { key, size, etag, lastModified }
  }).filter((item): item is StorageObject => item !== null)

  const truncated = (xmlChild(xml, 'IsTruncated') || '').toLowerCase() === 'true'
  const nextMarker = truncated
    ? xmlChild(xml, 'NextContinuationToken') || xmlChild(xml, 'NextMarker')
    : undefined
  return { objects, nextMarker }
}

async function listOssObjects(config: SkillRepositoryConfig): Promise<StorageObject[]> {
  const origin = resolveOssOrigin(config)
  const objects: StorageObject[] = []
  let continuationToken: string | undefined

  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const params: Record<string, string> = {
      'max-keys': '1000',
      ...(config.pathPrefix ? { prefix: config.pathPrefix } : {}),
      ...(continuationToken ? { marker: continuationToken } : {})
    }
    const canonicalQuery = buildCanonicalQuery(params)
    const { date, authorization } = ossAuthorization(config)
    const response = await fetch(`${origin}/?${canonicalQuery}`, {
      headers: {
        date,
        authorization,
        ...(config.credentials.securityToken
          ? { 'x-oss-security-token': config.credentials.securityToken }
          : {})
      }
    })
    const text = await response.text()
    if (!response.ok) {
      throw new Error(`扫描 OSS Skill 仓储失败 ${response.status}: ${text.slice(0, 500)}`)
    }

    const result = parseStorageListXml(text)
    objects.push(...result.objects)
    continuationToken = result.nextMarker
    if (!continuationToken) break
  }

  return objects
}

async function listCosObjects(config: SkillRepositoryConfig): Promise<StorageObject[]> {
  const origin = resolveCosOrigin(config)
  const objects: StorageObject[] = []
  let marker: string | undefined

  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const params: Record<string, string> = {
      'max-keys': '1000',
      ...(config.pathPrefix ? { prefix: config.pathPrefix } : {}),
      ...(marker ? { marker } : {})
    }
    const query = new URLSearchParams(params)
    const response = await fetch(`${origin}/?${query}`, {
      headers: {
        authorization: cosAuthorization(config, '', params)
      }
    })
    const text = await response.text()
    if (!response.ok) {
      throw new Error(`扫描 COS Skill 仓储失败 ${response.status}: ${text.slice(0, 500)}`)
    }

    const result = parseStorageListXml(text)
    objects.push(...result.objects)
    marker = result.nextMarker
    if (!marker) break
  }

  return objects
}

async function listStorageObjects(config: SkillRepositoryConfig): Promise<StorageObject[]> {
  return config.provider === 'cos' ? listCosObjects(config) : listOssObjects(config)
}

function isVersion(value: string): boolean {
  return /^v?\d+(?:\.\d+)*(?:[-+][0-9A-Za-z.-]+)?$/i.test(value)
}

function packageIdFromKey(key: string, prefix: string): { id: string; version?: string } {
  const relative = prefix && key.startsWith(`${prefix}/`)
    ? key.slice(prefix.length + 1)
    : key
  const segments = relative.split('/').filter(Boolean)
  const fileName = segments[segments.length - 1] || key
  const fileStem = fileName.replace(/\.zip$/i, '')
  let version: string | undefined

  if (segments.length >= 2 && isVersion(segments[segments.length - 2])) {
    version = segments[segments.length - 2]
  }

  const versionInName = /[-_]v?\d+(?:\.\d+)+/i.exec(fileStem)
  if (!version && versionInName) {
    version = fileStem.slice(versionInName.index + 1)
  }

  let id = fileStem
  if (versionInName) id = fileStem.slice(0, versionInName.index)
  if (!id || /^(?:skill|package)$/i.test(id)) {
    id = segments[segments.length - (version ? 3 : 2)] || fileStem || 'skill'
  }
  return { id: id.toLowerCase(), version }
}

function toCatalog(
  config: SkillRepositoryConfig,
  objects: StorageObject[]
): SkillCatalogResult {
  const byId = new Map<string, RemoteSkillPackage>()

  for (const object of objects) {
    if (!object.key.toLowerCase().endsWith('.zip')) continue
    if (/(^|\/)_/.test(object.key) || /(^|\/)\./.test(object.key)) continue
    if (/[\\\u0000]/.test(object.key)) continue

    const { id, version } = packageIdFromKey(object.key, config.pathPrefix)
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id)) continue

    const previous = byId.get(id)
    const current: RemoteSkillPackage = {
      id,
      name: id,
      version: version || 'unknown',
      objectKey: object.key,
      size: object.size,
      etag: object.etag.replace(/^"|"$/g, ''),
      lastModified: object.lastModified
        ? new Date(object.lastModified).toISOString()
        : undefined
    }

    if (!previous) {
      byId.set(id, current)
      continue
    }
    const currentNewer = current.version && previous.version
      ? compareVersions(current.version, previous.version) >= 0
      : Boolean(current.lastModified && (!previous.lastModified ||
          current.lastModified >= previous.lastModified))
    if (currentNewer) byId.set(id, current)
  }

  const repository: SkillRepositoryInfo = {
    provider: config.provider,
    bucket: config.bucket,
    prefix: config.pathPrefix
  }
  return {
    ok: true,
    message: byId.size > 0 ? `已获取 ${byId.size} 个 Skill` : 'Skill 仓储为空',
    skills: [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)).slice(0, MAX_SKILLS),
    repository,
    generatedAt: new Date().toISOString()
  }
}

function packageFromIndexEntry(
  entry: SkillIndexEntry,
  prefix: string,
  objectsByKey: Map<string, StorageObject>
): RemoteSkillPackage | null {
  const id = firstString(entry.id)
  const objectKey = resolveIndexedObjectKey(entry.archivePath, prefix)
  if (!id || !objectKey || !/^[a-z0-9][a-z0-9._-]*$/i.test(id)) return null

  const object = objectsByKey.get(objectKey)
  const size = Number(entry.size)
  return {
    id,
    name: firstString(entry.name) || id,
    description: firstString(entry.description),
    version: firstString(entry.version) || 'unknown',
    objectKey,
    size: Number.isFinite(size) && size >= 0 ? size : object?.size ?? 0,
    sha256: firstString(entry.sha256),
    vendor: firstString(entry.vendor),
    minWorkBuddyVersion: firstString(entry.minWorkBuddyVersion),
    etag: object?.etag.replace(/^"|"$/g, ''),
    lastModified: object?.lastModified
      ? new Date(object.lastModified).toISOString()
      : undefined
  }
}

function mergeIndexedCatalog(
  scanned: SkillCatalogResult,
  config: SkillRepositoryConfig,
  objects: StorageObject[],
  index: SkillIndex
): SkillCatalogResult {
  const objectsByKey = new Map(objects.map((object) => [object.key, object]))
  const byId = new Map<string, RemoteSkillPackage>()

  for (const entry of index.skills) {
    const skill = packageFromIndexEntry(entry, config.pathPrefix, objectsByKey)
    if (skill) byId.set(skill.id, skill)
  }

  // 索引是目录来源；未及时写入 index.json 的历史 zip 仍保留在目录末尾。
  for (const skill of scanned.skills) {
    if (!byId.has(skill.id)) byId.set(skill.id, skill)
  }

  const skills = [...byId.values()]
    .sort((a, b) => a.id.localeCompare(b.id))
    .slice(0, MAX_SKILLS)
  return {
    ok: true,
    message:
      skills.length > 0
        ? `已从 index.json 获取 ${skills.length} 个 Skill`
        : 'index.json 中没有可用 Skill',
    skills,
    repository: scanned.repository,
    generatedAt: index.generatedAt || scanned.generatedAt
  }
}

function staleCatalog(error: unknown): SkillCatalogResult {
  return {
    ok: false,
    message: `获取 Skill 清单失败：${error instanceof Error ? error.message : String(error)}`,
    skills: catalogCache?.value.skills || [],
    repository: catalogCache?.value.repository,
    generatedAt: catalogCache?.value.generatedAt,
    fromCache: Boolean(catalogCache)
  }
}

/** 使用 Provider Key 获取仓储配置，并用返回的临时凭据扫描 OSS/COS Skill 包。 */
export async function fetchSkillCatalog(force = false): Promise<SkillCatalogResult> {
  if (!force && catalogCache && catalogCache.expiresAt > Date.now()) {
    return { ...catalogCache.value, fromCache: true }
  }

  try {
    if (force) configCache = null
    const config = await fetchRepositoryConfig()
    const objects = await listStorageObjects(config)
    let catalog = toCatalog(config, objects)

    const indexKey = objectKeyWithPrefix(INDEX_OBJECT_NAME, config.pathPrefix)
    if (objects.some((object) => object.key === indexKey)) {
      try {
        const rawIndex = await fetchStorageObject(config, indexKey)
        if (rawIndex) {
          catalog = mergeIndexedCatalog(catalog, config, objects, parseSkillIndex(rawIndex))
        }
      } catch (indexError) {
        catalog = {
          ...catalog,
          message: `${catalog.message}；读取 index.json 失败：${
            indexError instanceof Error ? indexError.message : String(indexError)
          }`
        }
      }
    }

    catalogCache = { value: catalog, expiresAt: Date.now() + CATALOG_CACHE_TTL_MS }
    return catalog
  } catch (err) {
    configCache = null
    return staleCatalog(err)
  }
}

function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

function assertExpectedSkill(
  skill: RemoteSkillPackage
): asserts skill is RemoteSkillPackage & { sha256: string } {
  if (!skill.version || skill.version === 'unknown') {
    throw new Error(`Skill ${skill.id} 缺少有效版本，无法在线更新`)
  }
  if (!skill.sha256) {
    throw new Error(`Skill ${skill.id} 缺少 sha256 校验值，无法在线更新`)
  }
  if (!skill.size || skill.size <= 0) {
    throw new Error(`Skill ${skill.id} 缺少有效包大小，无法在线更新`)
  }
}

/** 强制刷新目录并固定索引项后下载包；不向调用方暴露仓储凭据。 */
export async function downloadSkillPackage(id: string): Promise<{
  skill: RemoteSkillPackage
  data: Buffer
  sha256: string
}> {
  const skillId = id.trim().toLowerCase()
  const catalog = await fetchSkillCatalog(true)
  if (!catalog.ok) throw new Error(catalog.message)

  const skill = catalog.skills.find((item) => item.id === skillId)
  if (!skill) throw new Error(`Skill 仓储中不存在：${skillId}`)
  assertExpectedSkill(skill)

  const config = await fetchRepositoryConfig()
  const data = await fetchStorageBuffer(config, skill.objectKey)
  const actualSha256 = sha256Hex(data)
  const expectedSha256 = skill.sha256.toLowerCase()
  if (actualSha256 !== expectedSha256) {
    throw new Error(`Skill 包 SHA-256 校验失败：期望 ${expectedSha256}，实际 ${actualSha256}`)
  }
  if (data.length !== skill.size) {
    throw new Error(`Skill 包大小校验失败：期望 ${skill.size} 字节，实际 ${data.length} 字节`)
  }

  return { skill, data, sha256: actualSha256 }
}
