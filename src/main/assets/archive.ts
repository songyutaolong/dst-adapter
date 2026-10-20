import fs from 'fs'
import { createWriteStream } from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import { randomUUID } from 'crypto'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import type { BrowserWindow } from 'electron'
import type {
  AssetKind,
  AssetRecord,
  AssetRecordArchive,
  AssetRecordIdentity
} from '../../shared/types'
import { getDstConnection } from '../store'
import { fetchMe } from '../speedtest'
import type { McpServiceConnection, ToolCallHookContext } from '../mcp/server'
import {
  guessContentType,
  localDatePath,
  MAX_FILE_UPLOAD_SIZE,
  sanitizeFileName,
  sanitizeKeySegment,
  signObjectGetUrl,
  uploadToCloudStorage,
  type CloudStorageProvider
} from './cloudStorage'
import {
  deleteAssetRecord,
  enforcePendingCap,
  findAssetRecordByTaskId,
  flushAssetRecordsSync,
  getAssetRecord,
  listAssetRecords,
  pendingFilePathFor,
  upsertAssetRecord
} from './records'
import { importAssetToPlatform, isPlatformConfigured } from './platform'

/**
 * 生成资产自动归档管线
 *
 * server.ts 的 tools/call 钩子（setToolCallHook）在工具成功返回后调用
 * archiveToolCall；图片同步归档，视频/3D 先记 pending 再由轮询器推进。
 * 归档全程 fire-and-forget，任何异常不影响 MCP 工具响应。
 *
 * 依赖（窗口句柄、上游查询函数）由 index.ts 注入，避免与 server.ts 循环依赖。
 */

/** 查询函数只用到 baseUrl/apiKey，收窄入参便于以连接信息直接调用。 */
type TaskQueryFn = (service: McpServiceConnection, taskId: string) => Promise<unknown>

interface ArchiverDeps {
  getMainWindow: () => BrowserWindow | null
  queryVideoTask: TaskQueryFn
  query3DGenerationTask: TaskQueryFn
}

let deps: ArchiverDeps | null = null

/* ───────────────────────── 工具分类 ───────────────────────── */

const IMAGE_SYNC_TOOLS = new Set(['image_generation', 'image_editing'])
const VIDEO_SUBMIT_TOOLS = new Set(['video_generation', 'video_from_image'])
const MODEL3D_SUBMIT_TOOLS = new Set([
  'text_to_model_3d',
  'image_to_model_3d',
  'multiview_to_model_3d',
  'texture_model_3d',
  'decimate_mesh_3d',
  'segment_mesh_3d',
  'rig_check_3d',
  'rig_model_3d'
])
const QUERY_TOOLS = new Set(['video_task_query', 'generation_3d_task_query'])

/** 3D 后处理工具没有 prompt，用操作名合成记录描述。 */
const POSTPROCESS_LABELS: Record<string, string> = {
  texture_model_3d: '贴图',
  decimate_mesh_3d: '重拓扑',
  segment_mesh_3d: '网格分割',
  rig_check_3d: '绑骨检测',
  rig_model_3d: '绑骨'
}

const TASK_POLL_INTERVAL_MS = 5000
const TASK_POLL_BACKOFF_MAX_MS = 60000
const TASK_GIVEUP_MS = 30 * 60 * 1000
const TASK_NOT_FOUND_THRESHOLD = 3
const DOWNLOAD_TIMEOUT_MS = 120 * 1000

/* ───────────────────────── 身份解析 ───────────────────────── */

let identityCache: { at: number; identity: AssetRecordIdentity | null } | null = null
const IDENTITY_TTL_OK = 10 * 60 * 1000
const IDENTITY_TTL_FAIL = 60 * 1000

async function resolveIdentityInner(): Promise<AssetRecordIdentity | null> {
  const now = Date.now()
  if (identityCache && now - identityCache.at < (identityCache.identity ? IDENTITY_TTL_OK : IDENTITY_TTL_FAIL)) {
    return identityCache.identity
  }
  try {
    const conn = getDstConnection()
    if (!conn.apiKey.trim()) {
      identityCache = { at: now, identity: null }
      return null
    }
    const me = await fetchMe(conn.endpoint, conn.apiKey)
    const identity: AssetRecordIdentity | null = me.ok && me.info
      ? {
          userId: me.info.user.id,
          username: me.info.user.username,
          displayName: me.info.user.display_name,
          orgId: me.info.organization?.id ?? 0,
          orgName: me.info.organization?.name || ''
        }
      : null
    identityCache = { at: now, identity }
    return identity
  } catch {
    identityCache = { at: now, identity: null }
    return null
  }
}

/** 会话归档等模块复用同一份用户身份缓存。 */
export function resolveIdentity(): Promise<AssetRecordIdentity | null> {
  return resolveIdentityInner()
}

/* ───────────────────────── 入参清洗 ───────────────────────── */

const OMIT_PLACEHOLDER = (n: number) => `‹已省略 ${n} 字符›`

function sanitizeValue(value: unknown, depth: number): unknown {
  if (typeof value === 'string') {
    return value.length > 512 ? OMIT_PLACEHOLDER(value.length) : value
  }
  if (value === null || typeof value !== 'object') return value
  if (depth > 3) return '…'
  if (Array.isArray(value)) {
    return value.slice(0, 8).map((item) => sanitizeValue(item, depth + 1))
  }
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 16)) {
    out[k] = sanitizeValue(v, depth + 1)
  }
  return out
}

/** 记录入参：base64/超长字段替换为占位符，整体超过 2048 字符只保留标量字段。 */
function sanitizeParams(args: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(args)) {
    sanitized[k] = sanitizeValue(v, 0)
  }
  if (JSON.stringify(sanitized).length > 2048) {
    const scalarsOnly: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(sanitized)) {
      if (v === null || typeof v !== 'object') scalarsOnly[k] = v
    }
    return scalarsOnly
  }
  return sanitized
}

function extractPrompt(toolName: string, args: Record<string, unknown>): string {
  const raw = typeof args.prompt === 'string' ? args.prompt.trim() : ''
  if (raw) return raw.slice(0, 2000)
  const label = POSTPROCESS_LABELS[toolName]
  if (label) {
    const input = typeof args.input === 'string' ? args.input : ''
    return input ? `${label}：${input.slice(0, 160)}` : label
  }
  return ''
}

/* ───────────────────────── 变更推送 ───────────────────────── */

let lastBroadcastAt = 0
let broadcastTimer: NodeJS.Timeout | null = null
const BROADCAST_THROTTLE_MS = 2000

function broadcastAssetsChanged(): void {
  const win = deps?.getMainWindow()
  if (!win || win.isDestroyed()) return
  const now = Date.now()
  const remaining = lastBroadcastAt + BROADCAST_THROTTLE_MS - now
  if (remaining <= 0) {
    lastBroadcastAt = now
    try {
      win.webContents.send('assets:changed')
    } catch {
      /* ignore */
    }
    return
  }
  if (!broadcastTimer) {
    broadcastTimer = setTimeout(() => {
      broadcastTimer = null
      lastBroadcastAt = Date.now()
      try {
        win.webContents.send('assets:changed')
      } catch {
        /* ignore */
      }
    }, remaining)
  }
}

/* ───────────────────────── 归档入口（钩子） ───────────────────────── */

/** tools/call 钩子入口；同步签名，内部异步推进，绝不抛出。 */
export function archiveToolCall(ctx: ToolCallHookContext): void {
  if (!deps) return
  try {
    if (QUERY_TOOLS.has(ctx.toolName)) {
      noteTaskQueried(ctx.toolName, ctx.output)
      return
    }
    const kind: AssetKind | null = IMAGE_SYNC_TOOLS.has(ctx.toolName)
      ? 'image'
      : VIDEO_SUBMIT_TOOLS.has(ctx.toolName)
        ? 'video'
        : MODEL3D_SUBMIT_TOOLS.has(ctx.toolName)
          ? 'model3d'
          : null
    if (!kind) return // file_upload 等手动工具不归档

    void (async () => {
      try {
        if (kind === 'image') {
          await archiveImageOutput(ctx)
        } else {
          await archiveTaskSubmit(ctx, kind)
        }
      } catch (err) {
        console.error('[assets] archive failed:', err)
      }
    })()
  } catch {
    /* 钩子兜底：任何异常不影响工具调用 */
  }
}

function baseRecordFields(ctx: ToolCallHookContext): {
  callId: string
  toolName: string
  sourceApp: string
  prompt: string
  params: Record<string, unknown>
} {
  return {
    callId: randomUUID(),
    toolName: ctx.toolName,
    sourceApp: ctx.clientName?.trim() || 'unknown',
    prompt: extractPrompt(ctx.toolName, ctx.args),
    params: stripTransportParams(sanitizeParams(ctx.args))
  }
}

function modelFromArgs(args: Record<string, unknown>): string | undefined {
  return typeof args.model === 'string' && args.model.trim() ? args.model.trim() : undefined
}

/** 从工具入参取出生成来源会话（客户端在 tools/call 参数里携带 session_id）。 */
function sessionIdFromArgs(args: Record<string, unknown>): string | undefined {
  const value = args.session_id
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 200) : undefined
}

/** 去掉仅用于归档传输的参数（session_id），避免污染展示的「入参」。 */
function stripTransportParams(params: Record<string, unknown>): Record<string, unknown> {
  if (!('session_id' in params)) return params
  const rest: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(params)) {
    if (k !== 'session_id') rest[k] = v
  }
  return rest
}

/** 图片：同步输出，data[] 每项一条记录；b64 立即写本地缓存再异步上传。 */
async function archiveImageOutput(ctx: ToolCallHookContext): Promise<void> {
  const output = ctx.output as { data?: Array<{ b64_json?: unknown; mime_type?: unknown }> }
  const items = Array.isArray(output?.data) ? output.data : []
  if (items.length === 0) return
  const identity = await resolveIdentity()
  const base = baseRecordFields(ctx)
  const model = modelFromArgs(ctx.args)

  for (const item of items) {
    const b64 = typeof item.b64_json === 'string' ? item.b64_json : ''
    if (!b64) continue
    const id = randomUUID()
    const mimeType = typeof item.mime_type === 'string' ? item.mime_type : 'image/png'
    const ext = mimeType.split('/')[1]?.split(';')[0] || 'png'
    const fileName = sanitizeFileName(`image.${ext}`) || 'image.png'
    const buffer = Buffer.from(b64, 'base64')
    if (buffer.length === 0) continue

    const bufferPath = pendingFilePathFor(id, fileName)
    await fsp.mkdir(path.dirname(bufferPath), { recursive: true })
    await fsp.writeFile(bufferPath, buffer)

    const record: AssetRecord = {
      id,
      callId: base.callId,
      kind: 'image',
      toolName: base.toolName,
      sourceApp: base.sourceApp,
      prompt: base.prompt,
      sessionId: sessionIdFromArgs(ctx.args),
      params: base.params,
      model,
      identity,
      // 图片字节已在手，但统一从 pending 走受控转移，避免状态守卫拦截
      status: 'pending',
      fileName,
      mimeType,
      size: buffer.byteLength,
      localBufferPath: bufferPath,
      attempts: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
    upsertAssetRecord(record)
    broadcastAssetsChanged()
    void processUpload(record.id).catch((err) => console.error('[assets] image upload failed:', err))
  }
}

/** 视频/3D：提交时只回 task_id，先记 pending；提示词与入参在此刻捕获。 */
async function archiveTaskSubmit(ctx: ToolCallHookContext, kind: AssetKind): Promise<void> {
  const output = ctx.output as { task_id?: unknown }
  const taskId = typeof output?.task_id === 'string' ? output.task_id.trim() : ''
  if (!taskId) return
  const identity = await resolveIdentity()
  const base = baseRecordFields(ctx)

  const record: AssetRecord = {
    id: randomUUID(),
    callId: base.callId,
    kind,
    toolName: base.toolName,
    sourceApp: base.sourceApp,
    prompt: base.prompt,
    sessionId: sessionIdFromArgs(ctx.args),
    params: base.params,
    model: modelFromArgs(ctx.args),
    identity,
    status: 'pending',
    taskId,
    fileName: kind === 'video' ? `${sanitizeFileName(taskId)}.mp4` : `${sanitizeFileName(taskId)}.glb`,
    attempts: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }
  upsertAssetRecord(record)
  broadcastAssetsChanged()
  ensurePoller()
}

/* ───────────────────────── 任务结果处理 ───────────────────────── */

const VIDEO_DONE = ['completed', 'succeeded', 'success']
const TASK_FAILED = ['failed', 'failure', 'error', 'cancelled', 'canceled']

function pickString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const v = obj[key]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return undefined
}

function fileNameFromUrl(url: string, fallback: string): string {
  try {
    const base = new URL(url).pathname.split('/').pop() || ''
    const name = sanitizeFileName(base)
    if (name && name !== '' && name.includes('.')) return name
  } catch {
    /* ignore */
  }
  return fallback
}

/**
 * 解析上游查询结果并推进记录：拿到 URL → 下载上传；失败 → 终态；否则更新进度。
 * 轮询器与客户端主动查询都会走到这里。
 */
async function handleTaskResult(record: AssetRecord, output: unknown): Promise<void> {
  const data = (output && typeof output === 'object' ? output : {}) as Record<string, unknown>
  const nested = (data.data && typeof data.data === 'object' ? data.data : {}) as Record<string, unknown>
  const merged: Record<string, unknown> = { ...nested, ...data }
  const status = String(merged.status || '').toLowerCase()
  const failReason = pickString(merged, ['fail_reason', 'failReason', 'error']) || '上游任务失败'
  const updated: AssetRecord = {
    ...record,
    taskStatus: status || record.taskStatus,
    updatedAt: new Date().toISOString()
  }

  if (TASK_FAILED.includes(status)) {
    updated.status = 'failed'
    updated.failReason = failReason
    upsertAssetRecord(updated)
    broadcastAssetsChanged()
    return
  }

  const resultUrl =
    updated.kind === 'video'
      ? pickString(merged, ['video_url', 'url', 'output_url', 'result_url'])
      : pickString(merged, ['result_url', 'output_url', 'url'])
  const done = VIDEO_DONE.includes(status) || (!status && Boolean(resultUrl))

  if (!done || !resultUrl) {
    if (status) upsertAssetRecord(updated) // 只更新进度，继续等待
    return
  }

  updated.resultUrl = resultUrl
  updated.fileName = fileNameFromUrl(resultUrl, updated.fileName || `${updated.taskId}.bin`)
  upsertAssetRecord(updated)
  broadcastAssetsChanged()
  void processUpload(updated.id).catch((err) => console.error('[assets] task upload failed:', err))
}

/* ───────────────────────── 轮询器 ───────────────────────── */

interface PollState {
  nextPollAt: number
  pollCount: number
  consecutiveNotFound: number
  inFlight: boolean
}

const pollStates = new Map<string, PollState>()
let pollTimer: NodeJS.Timeout | null = null

function ensurePoller(): void {
  if (pollTimer) return
  pollTimer = setInterval(() => {
    void tickPoller().catch((err) => console.error('[assets] poller tick failed:', err))
  }, TASK_POLL_INTERVAL_MS)
  // 不阻止进程退出
  pollTimer.unref?.()
}

async function tickPoller(): Promise<void> {
  const pending = listAssetRecords().filter((r) => r.status === 'pending' && r.taskId)
  if (pending.length === 0) {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
      pollStates.clear()
    }
    return
  }
  const now = Date.now()
  let launched = 0
  for (const record of pending) {
    if (launched >= 4) break
    const state = pollStates.get(record.id) || { nextPollAt: 0, pollCount: 0, consecutiveNotFound: 0, inFlight: false }
    pollStates.set(record.id, state)
    if (state.inFlight || state.nextPollAt > now) continue
    if (now - Date.parse(record.createdAt) > TASK_GIVEUP_MS) {
      const expired: AssetRecord = { ...record, status: 'expired', error: '查询超时（30 分钟）', updatedAt: new Date().toISOString() }
      upsertAssetRecord(expired)
      broadcastAssetsChanged()
      pollStates.delete(record.id)
      continue
    }
    state.inFlight = true
    launched++
    void pollTask(record, state).catch((err) => console.error('[assets] poll failed:', err))
  }
}

async function pollTask(record: AssetRecord, state: PollState): Promise<void> {
  try {
    const conn = getDstConnection()
    if (!conn.apiKey.trim()) {
      backoff(state)
      return
    }
    const query = record.kind === 'video' ? deps!.queryVideoTask : deps!.query3DGenerationTask
    const output = await query({ baseUrl: conn.endpoint, apiKey: conn.apiKey }, record.taskId!)
    state.pollCount = 0
    state.consecutiveNotFound = 0
    const fresh = getAssetRecord(record.id)
    if (fresh && fresh.status === 'pending') {
      await handleTaskResult(fresh, output)
    }
  } catch (err) {
    const e = err as { code?: number; message?: string }
    state.pollCount++
    if (e.code === 404) {
      state.consecutiveNotFound++
      if (state.consecutiveNotFound >= TASK_NOT_FOUND_THRESHOLD) {
        const fresh = getAssetRecord(record.id)
        if (fresh && fresh.status === 'pending') {
          upsertAssetRecord({ ...fresh, status: 'failed', failReason: '任务不存在（上游 404）', updatedAt: new Date().toISOString() })
          broadcastAssetsChanged()
        }
        pollStates.delete(record.id)
        return
      }
    }
    backoff(state)
  } finally {
    state.inFlight = false
  }
}

function backoff(state: PollState): void {
  const delay = Math.min(TASK_POLL_INTERVAL_MS * 2 ** Math.max(0, state.pollCount - 1), TASK_POLL_BACKOFF_MAX_MS)
  state.nextPollAt = Date.now() + delay
}

/** 客户端主动查询任务时顺手推进归档（比轮询器更早拿到结果）。 */
function noteTaskQueried(toolName: string, output: unknown): void {
  try {
    const data = (output && typeof output === 'object' ? output : {}) as Record<string, unknown>
    const taskId = typeof data.task_id === 'string' ? data.task_id.trim() : ''
    if (!taskId) return
    const record = findAssetRecordByTaskId(taskId)
    if (!record || record.status !== 'pending') return
    void handleTaskResult(record, output).catch((err) =>
      console.error('[assets] noteTaskQueried failed:', err)
    )
  } catch {
    /* ignore */
  }
}

/* ───────────────────────── 下载与上传 ───────────────────────── */

/** 受控转移：仅 pending/upload_failed → uploading，防止轮询与手动重试并发双跑。 */
function transitionToUploading(record: AssetRecord): AssetRecord | null {
  const fresh = getAssetRecord(record.id)
  if (!fresh || (fresh.status !== 'pending' && fresh.status !== 'upload_failed')) return null
  const updated: AssetRecord = {
    ...fresh,
    status: 'uploading',
    attempts: fresh.attempts + 1,
    error: undefined,
    updatedAt: new Date().toISOString()
  }
  upsertAssetRecord(updated)
  return updated
}

async function downloadToPending(record: AssetRecord): Promise<{ bufferPath: string; size: number }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)
  try {
    const resp = await fetch(record.resultUrl!, { signal: controller.signal })
    if (!resp.ok || !resp.body) {
      throw new Error(`下载失败 HTTP ${resp.status}`)
    }
    const declared = Number(resp.headers.get('content-length') || 0)
    if (declared > MAX_FILE_UPLOAD_SIZE) {
      throw new Error(`文件过大（上限 ${Math.floor(MAX_FILE_UPLOAD_SIZE / 1024 / 1024)}MB）`)
    }
    const bufferPath = pendingFilePathFor(record.id, record.fileName)
    await fsp.mkdir(path.dirname(bufferPath), { recursive: true })
    const ws = createWriteStream(bufferPath)
    let written = 0
    const nodeStream = Readable.fromWeb(resp.body as import('stream/web').ReadableStream)
    nodeStream.on('data', (chunk: Buffer) => {
      written += chunk.length
      if (written > MAX_FILE_UPLOAD_SIZE) {
        nodeStream.destroy(new Error(`文件过大（上限 ${Math.floor(MAX_FILE_UPLOAD_SIZE / 1024 / 1024)}MB）`))
      }
    })
    await pipeline(nodeStream, ws)
    const size = written || (await fsp.stat(bufferPath)).size
    if (size === 0) throw new Error('下载内容为空')
    return { bufferPath, size }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 归档对象 key 的业务路径：mcp-generations/<用户>/<生成日期>/<资产类型>。
 * 用户取记录里的身份快照（纯用户名，重试后不变）；日期按生成时间取本地日期，
 * 跨天重试仍归入生成当天；身份缺失（未配置 Key 等）落 unknown 目录。
 */
function archiveKeyPath(record: AssetRecord): string {
  const user = record.identity?.username?.trim() || 'unknown'
  return ['mcp-generations', sanitizeKeySegment(user) || 'unknown', localDatePath(record.createdAt), record.kind].join('/')
}

async function processUpload(recordId: string): Promise<AssetRecord> {
  const record = getAssetRecord(recordId)
  if (!record) throw new Error('记录不存在')
  const claimed = transitionToUploading(record)
  if (!claimed) throw new Error('记录状态不允许上传')
  broadcastAssetsChanged()

  const current = () => getAssetRecord(recordId)!
  const fail = async (message: string) => {
    const failed: AssetRecord = { ...current(), status: 'upload_failed', error: message, updatedAt: new Date().toISOString() }
    upsertAssetRecord(failed)
    broadcastAssetsChanged()
    enforcePendingCap()
    return failed
  }

  try {
    let bufferPath = claimed.localBufferPath
    let size = claimed.size
    if (!bufferPath || !fs.existsSync(bufferPath)) {
      if (!claimed.resultUrl) {
        return await fail('缺少下载源（无本地缓存且无结果 URL）')
      }
      const downloaded = await downloadToPending(claimed)
      bufferPath = downloaded.bufferPath
      size = downloaded.size
      upsertAssetRecord({ ...current(), localBufferPath: bufferPath, size })
    }
    const buffer = await fsp.readFile(bufferPath)
    const conn = getDstConnection()
    if (!conn.apiKey.trim()) {
      return await fail('未配置 Provider API Key，无法上传云存储')
    }
    const uploaded = await uploadToCloudStorage({
      baseUrl: conn.endpoint,
      apiKey: conn.apiKey,
      buffer,
      filename: claimed.fileName,
      contentType: claimed.mimeType || guessContentType(claimed.fileName),
      keyPath: archiveKeyPath(claimed),
      expiresIn: 3600
    })
    // 云盘归档后，把对象按逻辑键登记到 AI 能力平台数据层（files/import）。
    // 失败不阻断记录完成：文件已安全落地云盘，错误记入 archive 供单独重试。
    let archive: AssetRecordArchive | undefined
    if (isPlatformConfigured()) {
      try {
        const imported = await importAssetToPlatform({
          key: uploaded.logicalKey,
          name: claimed.fileName,
          mime: uploaded.content_type,
          // 平台文件记录展示提示词、来源会话与生成元信息
          ...(claimed.prompt ? { prompt: claimed.prompt } : {}),
          ...(claimed.sessionId ? { sessionId: claimed.sessionId } : {}),
          ...(claimed.toolName ? { toolName: claimed.toolName } : {}),
          ...(claimed.model ? { model: claimed.model } : {}),
          ...(claimed.sourceApp ? { sourceApp: claimed.sourceApp } : {})
        })
        archive = {
          fileId: imported.fileId,
          status: imported.status,
          importedAt: new Date().toISOString()
        }
      } catch (err) {
        console.error('[assets] platform import failed:', err)
        archive = {
          fileId: '',
          status: 'failed',
          importedAt: new Date().toISOString(),
          error: err instanceof Error ? err.message : String(err)
        }
      }
    }
    const done: AssetRecord = {
      ...current(),
      status: 'completed',
      size: uploaded.size,
      mimeType: uploaded.content_type,
      localBufferPath: undefined,
      cloud: {
        provider: uploaded.provider as CloudStorageProvider,
        bucket: uploaded.bucket,
        key: uploaded.key,
        logicalKey: uploaded.logicalKey,
        uploadedAt: new Date().toISOString(),
        size: uploaded.size,
        contentType: uploaded.content_type
      },
      ...(archive ? { archive } : {}),
      error: undefined,
      completedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
    upsertAssetRecord(done)
    try {
      fs.unlinkSync(bufferPath)
    } catch {
      /* 缓存文件可能已不存在 */
    }
    broadcastAssetsChanged()
    return done
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[assets] upload failed:', message)
    return await fail(message)
  }
}

/* ───────────────────────── 对外操作（IPC 侧） ───────────────────────── */

export async function retryAssetRecord(id: string): Promise<AssetRecord> {
  const record = getAssetRecord(id)
  if (!record) throw new Error('记录不存在')
  if (record.status === 'upload_failed') return processUpload(id)
  // 云盘已归档但平台数据导入失败：只重试导入，不重复上传
  if (record.status === 'completed' && record.archive?.status === 'failed') {
    return retryPlatformImport(record)
  }
  throw new Error('当前状态不支持重试')
}

/** 仅重跑 AI 能力平台数据归档；云盘对象已就位，无需重复上传。 */
async function retryPlatformImport(record: AssetRecord): Promise<AssetRecord> {
  const logicalKey = record.cloud?.logicalKey
  if (!logicalKey) throw new Error('记录缺少归档逻辑键，无法重试数据归档')
  const imported = await importAssetToPlatform({
    key: logicalKey,
    name: record.fileName,
    mime: record.cloud?.contentType,
    ...(record.prompt ? { prompt: record.prompt } : {}),
    ...(record.sessionId ? { sessionId: record.sessionId } : {}),
    ...(record.toolName ? { toolName: record.toolName } : {}),
    ...(record.model ? { model: record.model } : {}),
    ...(record.sourceApp ? { sourceApp: record.sourceApp } : {})
  })
  const fresh = getAssetRecord(record.id)
  if (!fresh) throw new Error('记录不存在')
  const updated: AssetRecord = {
    ...fresh,
    archive: {
      fileId: imported.fileId,
      status: imported.status,
      importedAt: new Date().toISOString(),
      error: undefined
    },
    updatedAt: new Date().toISOString()
  }
  upsertAssetRecord(updated)
  broadcastAssetsChanged()
  return updated
}

export async function signAssetRecordUrl(id: string): Promise<{ url: string; expiresAt: string }> {
  const record = getAssetRecord(id)
  if (!record?.cloud) throw new Error('记录尚未归档到云存储')
  const conn = getDstConnection()
  if (!conn.apiKey.trim()) throw new Error('未配置 Provider API Key')
  return signObjectGetUrl({
    baseUrl: conn.endpoint,
    apiKey: conn.apiKey,
    provider: record.cloud.provider,
    bucket: record.cloud.bucket,
    key: record.cloud.key,
    region: record.cloud.region,
    expiresIn: 24 * 60 * 60
  })
}

export { deleteAssetRecord, listAssetRecords, flushAssetRecordsSync }

/* ───────────────────────── 初始化与恢复 ───────────────────────── */

/**
 * 应用启动时接线：注入依赖、恢复中断记录（残留 uploading → 可重试）、
 * 重新挂起 pending 任务轮询。
 */
export function initAssetArchiver(injected: ArchiverDeps): void {
  deps = injected

  const now = new Date().toISOString()
  for (const record of listAssetRecords()) {
    if (record.status === 'uploading') {
      // 进程被杀/崩溃残留：本地缓存仍在，可手动重试
      upsertAssetRecord({ ...record, status: 'upload_failed', error: '应用退出中断，可重试', updatedAt: now })
    }
  }
  if (listAssetRecords().some((r) => r.status === 'pending')) {
    ensurePoller()
  }
  enforcePendingCap()
  console.log('[assets] archiver initialized')
}
