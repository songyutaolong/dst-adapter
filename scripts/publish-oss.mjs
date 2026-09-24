import { createHash, createHmac } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)

function argValues(name) {
  const values = []
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] !== name) continue
    const value = args[i + 1]
    if (!value) throw new Error(`${name} requires a value`)
    values.push(value)
    i += 1
  }
  return values
}

function requiredEnv(name) {
  const value = (process.env[name] || '').trim()
  if (!value) throw new Error(`Missing environment variable: ${name}`)
  return value
}

function normalizeSlashes(value) {
  return value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
}

function globToRegExp(pattern) {
  const source = pattern
    .split('.')
    .map((part) => part.split('*').map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*'))
    .join('\\.')
  return new RegExp(`^${source}$`)
}

function contentTypeFor(fileName) {
  if (/\.ya?ml$/i.test(fileName)) return 'application/yaml; charset=utf-8'
  if (/\.json$/i.test(fileName)) return 'application/json; charset=utf-8'
  if (/\.zip$/i.test(fileName)) return 'application/zip'
  if (/\.dmg$/i.test(fileName)) return 'application/x-apple-diskimage'
  if (/\.exe$/i.test(fileName)) return 'application/vnd.microsoft.portable-executable'
  return 'application/octet-stream'
}

function cacheControlFor(fileName) {
  return /^latest(?:-mac)?\.yml$/i.test(fileName)
    ? 'no-cache, no-store, must-revalidate'
    : 'public, max-age=31536000, immutable'
}

function encodeObjectPath(value) {
  return value
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/')
}

function authorization(stringToSign, accessKeyId, accessKeySecret) {
  return `OSS ${accessKeyId}:${createHmac('sha1', accessKeySecret).update(stringToSign).digest('base64')}`
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function positiveIntegerEnv(name, defaultValue) {
  const value = Number.parseInt(process.env[name] || '', 10)
  return Number.isFinite(value) && value > 0 ? value : defaultValue
}

const dryRun = args.includes('--dry-run')
const releaseDir = path.resolve(argValues('--dir')[0] || 'release')
const includes = argValues('--include')
const bucket = dryRun ? process.env.OSS_BUCKET || '<bucket>' : requiredEnv('OSS_BUCKET')
const accessKeySecret = dryRun ? '' : requiredEnv('OSS_ACCESS_KEY_SECRET')
const accessKeyId = dryRun ? '' : requiredEnv('OSS_ACCESS_KEY_ID')
const endpoint = (dryRun ? process.env.OSS_ENDPOINT || 'oss-cn-hangzhou.aliyuncs.com' : requiredEnv('OSS_ENDPOINT'))
  .replace(/^https?:\/\//, '')
  .replace(/\/+$/, '')
const prefix = normalizeSlashes(process.env.OSS_UPDATE_PREFIX || 'dst-adapter/releases')
const baseUrl = (dryRun ? process.env.DST_UPDATE_BASE_URL || 'https://<bucket>.oss-cn-hangzhou.aliyuncs.com' : requiredEnv('DST_UPDATE_BASE_URL'))
  .replace(/\/+$/, '')
const endpointHost = endpoint.toLowerCase().startsWith(`${bucket.toLowerCase()}.`)
  ? endpoint
  : `${bucket}.${endpoint}`
const uploadOrigin = `https://${endpointHost}`
const multipartThreshold = positiveIntegerEnv('OSS_MULTIPART_THRESHOLD', 8 * 1024 * 1024)
const multipartPartSize = positiveIntegerEnv('OSS_MULTIPART_PART_SIZE', 8 * 1024 * 1024)
const requestRetryCount = positiveIntegerEnv('OSS_UPLOAD_RETRIES', 3)
const requestTimeoutMs = positiveIntegerEnv('OSS_UPLOAD_TIMEOUT_MS', 4 * 60 * 1000)

if (!includes.length) throw new Error('At least one --include pattern is required')
if (!/^https:\/\//.test(baseUrl)) throw new Error('DST_UPDATE_BASE_URL must be an https:// URL')

const includeRegexes = includes.map(globToRegExp)
const files = readdirSync(releaseDir, { withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => entry.name)
  .filter((fileName) => includeRegexes.some((regex) => regex.test(fileName)))
  .sort()

if (!files.length) {
  throw new Error(`No release files under ${releaseDir} match: ${includes.join(', ')}`)
}

console.log(`Uploading ${files.length} files to oss://${bucket}/${prefix}/`)
console.log(`Update feed URL: ${baseUrl}/`)

if (dryRun) {
  for (const fileName of files) console.log(`Would upload ${fileName}`)
  process.exit(0)
}

function requestUrl(objectKey, params = []) {
  const query = params
    .map(({ key, value }) => (value
      ? `${encodeURIComponent(key)}=${encodeURIComponent(value)}`
      : encodeURIComponent(key)))
    .join('&')
  return `${uploadOrigin}/${encodeObjectPath(objectKey)}${query ? `?${query}` : ''}`
}

function canonicalizedResource(objectKey, params = []) {
  const query = params
    .map(({ key, value }) => (value ? `${key}=${value}` : key))
    .sort()
    .join('&')
  return `/${bucket}/${objectKey}${query ? `?${query}` : ''}`
}

async function ossRequest(method, objectKey, params, options) {
  let lastError
  for (let attempt = 1; attempt <= requestRetryCount; attempt += 1) {
    const date = new Date().toUTCString()
    const contentMd5 = options.body
      ? createHash('md5').update(options.body).digest('base64')
      : ''
    const headers = { Date: date }
    const canonicalizedHeaders = []

    if (contentMd5) headers['Content-MD5'] = contentMd5
    if (options.contentType) headers['Content-Type'] = options.contentType
    if (options.cacheControl) headers['Cache-Control'] = options.cacheControl
    if (options.publicRead) {
      headers['x-oss-object-acl'] = 'public-read'
      canonicalizedHeaders.push('x-oss-object-acl:public-read')
    }

    const stringToSign = [
      method,
      contentMd5,
      options.contentType || '',
      date,
      `${canonicalizedHeaders.length ? `${canonicalizedHeaders.sort().join('\n')}\n` : ''}${canonicalizedResource(objectKey, params)}`
    ].join('\n')
    headers.Authorization = authorization(stringToSign, accessKeyId, accessKeySecret)

    try {
      const response = await fetch(requestUrl(objectKey, params), {
        method,
        headers,
        body: options.body,
        signal: AbortSignal.timeout(requestTimeoutMs)
      })
      const detail = await response.text()
      const retryableStatus = response.status === 408 || response.status === 429 || response.status >= 500
      if (!response.ok && retryableStatus && attempt < requestRetryCount) {
        console.warn(`Retry ${method} ${objectKey}: HTTP ${response.status}`)
        await sleep(attempt * 2000)
        continue
      }
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${detail}`)
      }
      if (/<Error>/.test(detail)) throw new Error(detail)
      return { response, detail }
    } catch (err) {
      lastError = err
      if (err instanceof Error && err.message.startsWith(`HTTP `)) throw err
      if (attempt < requestRetryCount) {
        console.warn(`Retry ${method} ${objectKey}: ${err instanceof Error ? err.message : String(err)}`)
        await sleep(attempt * 2000)
        continue
      }
    }
  }
  throw lastError || new Error(`OSS request failed: ${method} ${objectKey}`)
}

async function uploadMultipart(fileName, objectKey, body, contentType, cacheControl) {
  const initiated = await ossRequest('POST', objectKey, [{ key: 'uploads', value: '' }], {
    contentType,
    publicRead: true
  })
  const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(initiated.detail)?.[1]
  if (!uploadId) throw new Error(`Failed to start multipart upload for ${fileName}`)

  try {
    const parts = []
    for (let index = 0; index < body.length; index += multipartPartSize) {
      const partNumber = parts.length + 1
      const part = body.subarray(index, index + multipartPartSize)
      const uploaded = await ossRequest('PUT', objectKey, [
        { key: 'partNumber', value: String(partNumber) },
        { key: 'uploadId', value: uploadId }
      ], { body: part })
      const etag = uploaded.response.headers.get('etag')
      if (!etag) throw new Error(`Missing OSS ETag for ${fileName} part ${partNumber}`)
      parts.push({ partNumber, etag })
      console.log(`Uploaded ${fileName} part ${partNumber}/${Math.ceil(body.length / multipartPartSize)}`)
    }

    const completeBody = Buffer.from([
      '<CompleteMultipartUpload>',
      ...parts.map((part) => `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>${part.etag}</ETag></Part>`),
      '</CompleteMultipartUpload>'
    ].join(''))
    await ossRequest('POST', objectKey, [{ key: 'uploadId', value: uploadId }], {
      body: completeBody,
      contentType: 'application/xml; charset=utf-8'
    })
    await ossRequest('PUT', objectKey, [{ key: 'acl', value: '' }], {
      publicRead: true
    })
    console.log(`Uploaded ${fileName} (${body.length} bytes, ${cacheControl}, multipart)`)
  } catch (err) {
    await ossRequest('DELETE', objectKey, [{ key: 'uploadId', value: uploadId }], {}).catch(() => undefined)
    throw err
  }
}

for (const fileName of files) {
  const filePath = path.join(releaseDir, fileName)
  if (!statSync(filePath).isFile()) continue

  const body = readFileSync(filePath)
  const objectKey = `${prefix}/${fileName}`
  const contentType = contentTypeFor(fileName)
  const cacheControl = cacheControlFor(fileName)
  if (body.length > multipartThreshold) {
    await uploadMultipart(fileName, objectKey, body, contentType, cacheControl)
    continue
  }

  await ossRequest('PUT', objectKey, [], {
    body,
    contentType,
    cacheControl,
    publicRead: true
  })
  console.log(`Uploaded ${fileName} (${body.length} bytes, ${cacheControl})`)
}

console.log('OSS release upload complete.')
