import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import type { BrowserWindow } from 'electron'
import type {
  AppId,
  SessionArchiveState,
  SessionMessage,
  SessionMeta
} from '../shared/types'
import type { AppAdapter } from './adapters/types'
import { getAdapter } from './adapters'
import { atomicWriteJson, dataDir, ensureDir, getEnabledModel } from './store'
import { isPlatformConfigured, platformErrorMessage, postPlatformJson } from './assets/platform'
import { resolveIdentity } from './assets/archive'

/**
 * 会话归档：把本地应用历史会话定期上报公司 AI 能力平台。
 *
 * - 复用资产归档的平台令牌（getPlatformToken / postPlatformJson），401 自动换新重试。
 * - 增量上报：只上传新增/变更（文件 mtime/size 变化）的会话，成功后在本地状态文件
 *   记录指纹，下个周期跳过。平台按 (source, external_id) 整体覆盖，重复上报安全。
 * - 平台契约：每请求最多 20 会话、每会话最多 2000 条消息；实测还受请求体大小约束
 *   （>~1MB 返回 413），因此按「量 + 体积」双重预算分批，超长消息/会话自动截尾。
 * - 始终开启（不提供关闭入口）；仅当 AI 能力平台已配置时才实际上传。
 */

const INTERVAL_MS = 5 * 60 * 1000
const MAX_SESSIONS_PER_REQUEST = 20 // 平台契约：单请求会话数上限
const MAX_MESSAGES_PER_SESSION = 2000 // 平台契约：单会话消息数上限
const PAGE_LIMIT = 1000
/** 单条消息正文截断（长代码粘贴 / 大段报错只留正文开头）。 */
const MAX_MESSAGE_CHARS = 8000

/**
 * 安全截断：普通 slice 可能把 emoji 等代理对从中间切开，留下孤立代理项；
 * JSON.stringify 会把它序列化为 \udXXX 转义，平台 serde 会拒绝整个请求体（400）。
 * 截断点落在高代理项上时回退一位，再兜底清除源数据里可能已有的孤立代理项。
 */
const LONE_SURROGATE_RE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

function platformText(s: string, max: number): string {
  let cut = s.length > max ? s.slice(0, max) : s
  const last = cut.length ? cut.charCodeAt(cut.length - 1) : 0
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1) // 末尾是高代理项：截断切开了代理对
  return cut.replace(LONE_SURROGATE_RE, '�')
}
/**
 * 单会话 JSON 体预算（按 UTF-8 字节估算）：采集到该预算即停在最近的窗口。
 * 选中（source, external_id）上报给平台的副本是"最近窗口"，超长就会话只保留它。
 */
const SESSION_BODY_BUDGET = 700 * 1024
/** 单请求 body 目标（实测 >~1MB 会被拒，留足余量）；超长会话会独占一个请求。 */
const REQUEST_BODY_TARGET = 820 * 1024
/** 单条消息在 JSON 里的固定包装开销（seq/role/occurred_at 等），估算体积用。 */
const MESSAGE_WRAPPER_BYTES = (() => {
  const sample = Buffer.byteLength(
    JSON.stringify({ seq: 123456, role: 'assistant', occurred_at: '2026-09-30T00:00:00.000Z' })
  )
  return sample + 64 // 留余量覆盖无时间戳等差异
})()

interface Deps {
  getMainWindow: () => BrowserWindow | null
}

interface EntryRecord {
  sourcePath: string
  mtimeMs: number
  size: number
  uploadedAt: string
}

/** 状态文件：external_id → 上传时的会话文件指纹。 */
type StateFile = Record<string, EntryRecord>

interface PendingSession {
  meta: SessionMeta
  session: Record<string, unknown>
  mtimeMs: number
  size: number
}

let deps: Deps | null = null
let timer: NodeJS.Timeout | null = null
let running = false
let lastRun: SessionArchiveState['lastRun'] = null

function statePath(): string {
  return path.join(dataDir(), 'session-archive-state.json')
}

function loadState(): StateFile {
  const file = statePath()
  if (!fs.existsSync(file)) return {}
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as StateFile
    }
  } catch {
    // 损坏的状态文件不影响上传，从空表开始
  }
  return {}
}

function saveState(state: StateFile): void {
  try {
    ensureDir(dataDir())
    atomicWriteJson(statePath(), state)
  } catch (err) {
    console.error('[sessions] archive state persist failed:', err)
  }
}

function stateEnabled(): boolean {
  // 会话归档始终开启；仅要求平台配置完成
  return isPlatformConfigured()
}

function sourceFromApp(app: AppId | string): string {
  if (app === 'codex' || app === 'workbuddy') return app
  return 'other'
}

/** 采集端唯一 ID：带 app 前缀避免两类会话 id 撞名；限长 128。 */
function externalIdFor(app: string, sessionId: string): string {
  return `${app}:${sessionId}`.slice(0, 128)
}

function isDeleted(file: string): boolean {
  try {
    fs.statSync(file)
    return false
  } catch {
    return true
  }
}

/**
 * 分页向更早读取最「近」的会话消息：按消息数（≤2000）与单会话 JSON 体预算（≤700KB）
 * 双重截断，返回时间正序；超长会话只保留最近窗口。预算按 UTF-8 实际字节估算，
 * 中文等宽字符不会被低估。
 */
async function readMessagesUpTo(adapter: AppAdapter, sessionId: string): Promise<SessionMessage[]> {
  if (!adapter.readSessionMessages) return []
  // 游标从文件尾部向更早翻页，页按「新→旧」收集；每页内部本就时间正序
  const pages: SessionMessage[][] = []
  let totalEst = 0
  let cursor: number | undefined
  for (let round = 0; round < 12; round++) {
    const page = await adapter.readSessionMessages(
      sessionId,
      cursor === undefined ? { limit: PAGE_LIMIT } : { cursor, limit: PAGE_LIMIT }
    )
    if (page.messages.length === 0) break
    const kept: SessionMessage[] = []
    for (const m of page.messages) {
      const contentBytes = Buffer.byteLength(m.text.slice(0, MAX_MESSAGE_CHARS), 'utf8')
      const toolBytes = m.toolCalls?.length
        ? Buffer.byteLength(JSON.stringify(m.toolCalls), 'utf8')
        : 0
      if (
        kept.length + pages.reduce((n, p) => n + p.length, 0) >= MAX_MESSAGES_PER_SESSION ||
        totalEst + contentBytes + toolBytes + MESSAGE_WRAPPER_BYTES > SESSION_BODY_BUDGET
      ) {
        break
      }
      totalEst += contentBytes + toolBytes + MESSAGE_WRAPPER_BYTES
      kept.push(m)
    }
    pages.push(kept)
    if (kept.length < page.messages.length) break
    if (!page.hasMore) break
    cursor = page.cursor
  }
  // 恢复时间正序：只反转页序，页内部顺序保持原样。
  // 不能对拼接后的数组整体 reverse——那会把每页内部也倒成新→旧。
  const ordered: SessionMessage[] = []
  let remaining = MAX_MESSAGES_PER_SESSION
  for (let i = pages.length - 1; i >= 0 && remaining > 0; i--) {
    const page = pages[i]
    const take = page.length > remaining ? page.slice(page.length - remaining) : page
    ordered.push(...take)
    remaining -= take.length
  }
  return ordered
}

function toPlatformSession(
  meta: SessionMeta,
  messages: SessionMessage[],
  identity: { username: string; displayName: string } | null
): Record<string, unknown> {
  const enabledModel = getEnabledModel(meta.app as AppId)
  const session: Record<string, unknown> = {
    external_id: externalIdFor(meta.app, meta.sessionId),
    source: sourceFromApp(meta.app),
    user_identifier: identity?.username || 'unknown',
    started_at: meta.createdAt,
    // client_meta：会话级环境元信息（平台预留字段）
    client_meta: {
      app_version: app.getVersion(),
      platform: `${process.platform} ${process.arch}`,
      project_dir: meta.projectDir ? platformText(meta.projectDir, 200) : undefined,
      model: enabledModel?.modelId
    },
    messages: messages.map((m, i) => {
      const message: Record<string, unknown> = {
        seq: i,
        role: m.role, // user / assistant / tool（tool 消息为工具名+参数+输出摘要）
        content: platformText(m.text, MAX_MESSAGE_CHARS)
      }
      if (m.timestamp) message.occurred_at = m.timestamp
      if (m.toolCalls && m.toolCalls.length) {
        message.tool_calls = m.toolCalls.map((tc) => ({
          name: platformText(tc.name, 128),
          ...(tc.args ? { args: platformText(tc.args, 200) } : {}),
          ...(tc.result ? { result: platformText(tc.result, 500) } : {}),
          ...(tc.status ? { status: platformText(tc.status, 32) } : {})
        }))
      }
      return message
    })
  }
  if (meta.title) session.title = platformText(meta.title, 200)
  if (meta.summary) session.summary = platformText(meta.summary, 500)
  if (identity?.displayName) session.display_name = platformText(identity.displayName, 128)
  if (meta.lastActiveAt) session.ended_at = meta.lastActiveAt
  return session
}

/** 本周期变更（新增/文件变化）会话清单；未变化的上传过即跳过。 */
async function collectChangedSessions(): Promise<
  { meta: SessionMeta; mtimeMs: number; size: number }[]
> {
  const state = loadState()
  const changed: { meta: SessionMeta; mtimeMs: number; size: number }[] = []
  for (const app of ['codex', 'workbuddy'] as AppId[]) {
    const adapter = getAdapter(app)
    if (!adapter.listSessions) continue
    let metas: SessionMeta[]
    try {
      metas = await adapter.listSessions()
    } catch {
      continue
    }
    for (const meta of metas) {
      if (!meta.sourcePath || isDeleted(meta.sourcePath)) continue
      let stat: fs.Stats
      try {
        stat = fs.statSync(meta.sourcePath)
      } catch {
        continue
      }
      const key = externalIdFor(meta.app, meta.sessionId)
      const prev = state[key]
      if (
        prev &&
        prev.sourcePath === meta.sourcePath &&
        prev.mtimeMs === stat.mtimeMs &&
        prev.size === stat.size
      ) {
        continue // 已上传且未变化
      }
      changed.push({ meta, mtimeMs: stat.mtimeMs, size: stat.size })
    }
  }
  return changed
}

/** 按「会话数 + 请求体体积」双预算把待传会话切成请求批次。 */
function chunkPendingSessions(pending: PendingSession[]): PendingSession[][] {
  const batches: PendingSession[][] = []
  let current: PendingSession[] = []
  let currentBytes = Buffer.byteLength('{"sessions":[]}')
  for (const item of pending) {
    const sessionBytes = Buffer.byteLength(JSON.stringify(item.session))
    const overCount = current.length >= MAX_SESSIONS_PER_REQUEST
    const overBytes = current.length > 0 && currentBytes + sessionBytes >= REQUEST_BODY_TARGET
    if (overCount || overBytes) {
      batches.push(current)
      current = []
      currentBytes = Buffer.byteLength('{"sessions":[]}')
    }
    current.push(item)
    currentBytes += sessionBytes + 1
  }
  if (current.length) batches.push(current)
  return batches
}

/** 把已确认接受的会话标记为已上传（只认 response.results 里给出的 external_id）。 */
function markUploaded(
  batch: PendingSession[],
  results: unknown,
  state: StateFile
): void {
  const accepted = new Set<string>()
  if (Array.isArray(results)) {
    for (const r of results) {
      if (r && typeof r === 'object') {
        const id = (r as Record<string, unknown>).external_id
        if (typeof id === 'string' && id) accepted.add(id)
      }
    }
  }
  const now = new Date().toISOString()
  for (const { meta, mtimeMs, size } of batch) {
    const key = externalIdFor(meta.app, meta.sessionId)
    // 响应已给出 results 但本会话不在其中 → 未接受，留给下轮重试
    if (Array.isArray(results) && !accepted.has(key)) continue
    state[key] = { sourcePath: meta.sourcePath, mtimeMs, size, uploadedAt: now }
  }
  saveState(state)
}

function getState(): SessionArchiveState {
  return {
    enabled: true,
    platformConfigured: isPlatformConfigured(),
    lastRun
  }
}

function broadcast(): void {
  const win = deps?.getMainWindow()
  if (!win || win.isDestroyed()) return
  try {
    win.webContents.send('sessions:archive-updated', getState())
  } catch {
    /* ignore */
  }
}

async function runArchiveCycle(manual: boolean): Promise<void> {
  if (running) return
  if (!stateEnabled()) {
    if (manual) throw new Error('AI 能力平台未配置完成')
    return
  }
  running = true
  try {
    const identity = await resolveIdentity()
    const identityInfo = identity
      ? { username: identity.username, displayName: identity.displayName }
      : null
    const changed = await collectChangedSessions()
    if (changed.length === 0) {
      lastRun = {
        at: new Date().toISOString(),
        ok: true,
        message: '无新增或变更的会话，跳过上传',
        uploaded: 0,
        failed: 0
      }
      broadcast()
      return
    }

    // 先读出各会话消息并映射，跳过/计入失败；再按体积分批上传
    const pending: PendingSession[] = []
    const empties: { meta: SessionMeta; mtimeMs: number; size: number }[] = []
    let failed = 0
    let skipped = 0
    for (const { meta, mtimeMs, size } of changed) {
      try {
        const adapter = getAdapter(meta.app as AppId)
        const messages = await readMessagesUpTo(adapter, meta.sessionId)
        if (messages.length === 0) {
          // 无可解析消息的会话不上传；记入状态避免每个周期重复扫描，
          // 文件后续若有消息（mtime/size 变化）自然重新上传
          skipped++
          empties.push({ meta, mtimeMs, size })
          continue
        }
        pending.push({
          meta,
          mtimeMs,
          size,
          session: toPlatformSession(meta, messages, identityInfo)
        })
      } catch (err) {
        failed++
        console.error(`[sessions] 读取会话消息失败 ${meta.app}/${meta.sessionId}:`, err)
      }
    }
    if (pending.length === 0 && failed === 0) {
      lastRun = {
        at: new Date().toISOString(),
        ok: true,
        message: `扫描 ${changed.length} 个变更会话${skipped ? `，跳过 ${skipped} 个空会话` : ''}，均无可上传内容`,
        uploaded: 0,
        failed: 0
      }
      broadcast()
      return
    }

    const state = loadState()
    let uploaded = 0
    for (const batch of chunkPendingSessions(pending)) {
      const { status, body } = await postPlatformJson('/api/v1/agent-monitor/sessions', {
        sessions: batch.map((b) => b.session)
      })
      if (status >= 200 && status < 300) {
        const results = body?.results
        const acceptedInBatch = Array.isArray(results) ? results.length : batch.length
        uploaded += acceptedInBatch
        markUploaded(batch, results, state)
      } else {
        failed += batch.length
        console.error(
          `[sessions] 上传批次失败 HTTP ${status}:`,
          platformErrorMessage(body, '上传失败', status)
        )
      }
    }

    // 空会话也记入状态，避免每个周期重复扫描
    if (empties.length) {
      const now = new Date().toISOString()
      for (const { meta, mtimeMs, size } of empties) {
        const key = externalIdFor(meta.app, meta.sessionId)
        if (!state[key]) {
          state[key] = { sourcePath: meta.sourcePath, mtimeMs, size, uploadedAt: now }
        }
      }
      saveState(state)
    }

    lastRun = {
      at: new Date().toISOString(),
      ok: failed === 0,
      message:
        `扫描 ${changed.length} 个变更会话：成功 ${uploaded}，失败 ${failed}` +
        (skipped ? `，跳过 ${skipped} 个空会话` : ''),
      uploaded,
      failed
    }
    broadcast()
  } catch (err) {
    lastRun = {
      at: new Date().toISOString(),
      ok: false,
      message: err instanceof Error ? err.message : String(err),
      uploaded: 0,
      failed: 0
    }
    broadcast()
    if (manual) throw err
  } finally {
    running = false
  }
}

/** 应用启动时接线：启动即跑一轮（若有变更），随后固定周期推进。 */
export function initSessionArchive(injected: Deps): void {
  deps = injected
  if (timer) clearInterval(timer)
  // 平台未配置时各周期内部会直接跳过；这样后配置平台无需重启即可开始上传
  void runArchiveCycle(false).catch((err) =>
    console.error('[sessions] archive init cycle failed:', err)
  )
  timer = setInterval(() => {
    void runArchiveCycle(false).catch((err) =>
      console.error('[sessions] archive cycle failed:', err)
    )
  }, INTERVAL_MS)
  timer.unref?.()
}

/** 手动立即上传一轮（设置开启瞬间、或界面按钮）。 */
export async function runSessionArchiveNow(): Promise<SessionArchiveState> {
  await runArchiveCycle(true)
  return getState()
}

export function getSessionArchiveState(): SessionArchiveState {
  return getState()
}