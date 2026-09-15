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

for (const fileName of files) {
  const filePath = path.join(releaseDir, fileName)
  if (!statSync(filePath).isFile()) continue

  const body = readFileSync(filePath)
  const objectKey = `${prefix}/${fileName}`
  const date = new Date().toUTCString()
  const contentType = contentTypeFor(fileName)
  const cacheControl = cacheControlFor(fileName)
  const contentMd5 = createHash('md5').update(body).digest('base64')
  const canonicalizedHeaders = 'x-oss-object-acl:public-read\n'
  const canonicalizedResource = `/${bucket}/${objectKey}`
  const stringToSign = [
    'PUT',
    contentMd5,
    contentType,
    date,
    `${canonicalizedHeaders}${canonicalizedResource}`
  ].join('\n')
  const response = await fetch(`${uploadOrigin}/${encodeObjectPath(objectKey)}`, {
    method: 'PUT',
    headers: {
      Authorization: authorization(stringToSign, accessKeyId, accessKeySecret),
      'Content-MD5': contentMd5,
      'Content-Type': contentType,
      'Cache-Control': cacheControl,
      Date: date,
      'x-oss-object-acl': 'public-read'
    },
    body
  })

  if (!response.ok) {
    const detail = await response.text()
    throw new Error(`Failed to upload ${fileName}: HTTP ${response.status} ${detail}`)
  }
  await response.arrayBuffer()
  console.log(`Uploaded ${fileName} (${body.length} bytes, ${cacheControl})`)
}

console.log('OSS release upload complete.')
