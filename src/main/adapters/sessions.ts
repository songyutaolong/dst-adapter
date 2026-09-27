import fs from 'fs'
import { promises as fsp } from 'fs'
import path from 'path'
import os from 'os'
import type {
  ApplyResult,
  SessionMeta,
  SessionMessage,
  SessionMessagesOptions,
  SessionMessagesPage
} from '../../shared/types'

/**
 * 会话管理：只读扫描各应用落盘的历史会话文件。
 *
 * 列表页借鉴 cc-switch 的头尾采样策略——单条会话 jsonl 可能很大，
 * 元信息只从头 N 行 / 尾 M 行提取，点开具体会话时才全量解析。
 *
 * - WorkBuddy: ~/.workbuddy/projects/<项目目录>/<会话id>.jsonl
 * - Codex:     ~/.codex/sessions/年/月/日/rollout-<时间戳>-<会话id>.jsonl
 *              另有 ~/.codex/session_index.jsonl 提供官方维护的标题索引
 */

const sessionIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

function parseJsonLine(line: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(line) as unknown
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function readRange(file: string, start: number, end: number): string {
  const fd = fs.openSync(file, 'r')
  try {
    const length = Math.max(0, end - start)
    if (!length) return ''
    const buffer = Buffer.alloc(length)
    let read = 0
    while (read < length) {
      const n = fs.readSync(fd, buffer, read, length - read, start + read)
      if (n <= 0) break
      read += n
    }
    return buffer.subarray(0, read).toString('utf8')
  } finally {
    fs.closeSync(fd)
  }
}

function toLines(raw: string): string[] {
  return raw.split(/\r?\n/).filter((line) => line.trim())
}

/** 读取文件头部前 count 行（窗口不足时翻倍扩读，避免整文件加载）。 */
function readHeadLines(file: string, count: number, size: number): string[] {
  let window = Math.min(size, 64 * 1024)
  for (;;) {
    const lines = toLines(readRange(file, 0, window))
    if (lines.length > count || window >= size) return lines.slice(0, count)
    window = Math.min(size, window * 4)
  }
}

/** 读取文件尾部后 count 行（窗口首行被截断时丢弃）。 */
function readTailLines(file: string, count: number, size: number): string[] {
  let window = Math.min(size, 64 * 1024)
  for (;;) {
    const start = size - window
    let raw = readRange(file, start, size)
    if (start > 0) {
      const prevByte = readRange(file, start - 1, start)
      if (!prevByte.endsWith('\n')) {
        const newline = raw.indexOf('\n')
        raw = newline >= 0 ? raw.slice(newline + 1) : ''
      }
    }
    const lines = toLines(raw)
    if (lines.length > count || start === 0) return lines.slice(-count)
    window = Math.min(size, window * 4)
  }
}

/**
 * 消息分页游标读取：从 end 字节往回收至少 count 行完整行。
 * 返回行数组与窗口起始偏移（作为下一页游标）。start>0 即还有更早内容。
 * 窗口起点切在多字节 UTF-8 中间时，首行不完整会被丢弃，只保留完整行，无乱码风险。
 */
function readLinesBefore(
  file: string,
  end: number,
  count: number
): { lines: string[]; start: number } {
  let window = Math.min(end, 256 * 1024)
  for (;;) {
    const start = Math.max(0, end - window)
    let raw = readRange(file, start, end)
    if (start > 0) {
      const newline = raw.indexOf('\n')
      raw = newline >= 0 ? raw.slice(newline + 1) : ''
    }
    const lines = toLines(raw)
    if (lines.length >= count || start === 0) return { lines, start }
    window = Math.min(end, window * 4)
  }
}

// 长扫描时定期让出事件循环，避免主进程 IPC 被批量文件解析阻塞
const yieldToEventLoop = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve))

// 小于该体积的会话文件一次性全量解析（可做工具配对与文件清单），
// 超过则走尾部游标窗口流式读取，内存与 IPC 传输量都有上界
const SMALL_SESSION_FILE = 4 * 1024 * 1024
const DEFAULT_MESSAGE_PAGE = 100

function clampPageLimit(limit: number | undefined): number {
  return Math.max(1, Math.min(limit ?? DEFAULT_MESSAGE_PAGE, 1000))
}

/**
 * 游标窗口读取直到解析出 limit 条消息（或到文件头）。
 * 行数与消息数比例不定（推理/工具行占大头），按消息数达标才能保证每页足量。
 */
function readMessageWindow<T extends { messages: SessionMessage[] }>(
  file: string,
  end: number,
  limit: number,
  createState: () => T,
  parseLine: (line: string, state: T) => void
): { messages: SessionMessage[]; start: number } {
  let wantLines = limit * 4
  for (;;) {
    const { lines, start } = readLinesBefore(file, end, wantLines)
    const state = createState()
    for (const line of lines) parseLine(line, state)
    if (state.messages.length >= limit || start === 0) {
      return { messages: state.messages.slice(-limit), start }
    }
    wantLines *= 4
  }
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      if (part && typeof part === 'object') {
        const text = (part as Record<string, unknown>).text
        if (typeof text === 'string') return text
      }
      return ''
    })
    .filter(Boolean)
    .join('\n')
    .trim()
}

// 应用注入的上下文包裹不是用户真实输入，标题/摘要/消息展示均跳过
function isNoiseText(text: string): boolean {
  return /^<(system-reminder|app-context|environment_context|user_context|ide_context|app-state|permissions)/i.test(
    text.trimStart()
  )
}

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max)}…` : clean
}

// 工具调用/输出展示：保留换行结构、剥离控制字符，只限总长
function truncateBlock(text: string, max: number): string {
  const clean = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim()
  return clean.length > max ? `${clean.slice(0, max)}…` : clean
}

/** 从工具调用参数里挑出最关键的单一字段（命令/代码/路径），失败则截断原文。 */
function summarizeToolArgs(rawArgs: unknown): string {
  if (typeof rawArgs !== 'string' || !rawArgs.trim()) return ''
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(rawArgs) as Record<string, unknown>
  } catch {
    return truncateBlock(rawArgs, 300)
  }
  const preferred = [
    'command', 'cmd', 'code', 'script', 'file_path', 'path', 'filePath',
    'pattern', 'query', 'url', 'content'
  ]
  for (const key of preferred) {
    const value = parsed[key]
    if (typeof value === 'string' && value.trim()) return truncateBlock(value, 400)
  }
  return truncateBlock(JSON.stringify(parsed), 300)
}

/** apply_patch 补丁 → 「修改 x、新增 y、删除 z」摘要。 */
function summarizePatch(input: string): string {
  const verbs: Record<string, string> = { Update: '修改', Add: '新增', Delete: '删除' }
  const ops: string[] = []
  for (const match of input.matchAll(/\*\*\* (Update|Add|Delete) File: (.+)/g)) {
    ops.push(`${verbs[match[1]] || match[1]} ${match[2].trim()}`)
  }
  return ops.join('、')
}

// 工具输出可能是纯字符串，也可能是 {type:"text", text} 包装
function toolOutputText(output: unknown): string {
  if (typeof output === 'string') return output
  if (output && typeof output === 'object') {
    const text = (output as Record<string, unknown>).text
    if (typeof text === 'string') return text
  }
  return ''
}

function epochMsToIso(value: unknown): string | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? new Date(value).toISOString()
    : undefined
}

function byLastActiveDesc(a: SessionMeta, b: SessionMeta): number {
  return b.lastActiveAt.localeCompare(a.lastActiveAt)
}

// ── WorkBuddy ──

function workbuddyProjectsRoot(): string {
  return path.join(os.homedir(), '.workbuddy', 'projects')
}

// 项目目录名形如 c-Users-xxx-WorkBuddy-2026-07-07-22-18-41，去掉尾部启动时间戳
function workbuddyProjectLabel(dirName: string): string {
  return dirName.replace(/-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}$/, '')
}

function findWorkBuddySessionFile(sessionId: string): string | null {
  if (!sessionIdPattern.test(sessionId)) return null
  const root = workbuddyProjectsRoot()
  if (!fs.existsSync(root)) return null
  for (const dir of fs.readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue
    const file = path.join(root, dir.name, `${sessionId}.jsonl`)
    if (fs.existsSync(file)) return file
  }
  return null
}

function parseWorkBuddySessionMeta(
  file: string,
  sessionId: string,
  projectDirName: string
): SessionMeta {
  const size = fs.statSync(file).size
  // 头部采样放宽到 40 行：ai-title 行出现在首轮对话之后，中间夹着快照/推理行
  const head = readHeadLines(file, 40, size)
  const tail = readTailLines(file, 32, size)

  let createdAt: string | undefined
  let cwd: string | undefined
  let aiTitle = ''
  let firstUserText = ''
  for (const line of head) {
    const row = parseJsonLine(line)
    if (!row) continue
    if (!createdAt) createdAt = epochMsToIso(row.timestamp)
    if (!cwd && typeof row.cwd === 'string' && row.cwd) cwd = row.cwd
    if (
      !aiTitle &&
      row.type === 'ai-title' &&
      typeof row.aiTitle === 'string' &&
      row.aiTitle.trim()
    ) {
      aiTitle = row.aiTitle.trim()
    }
    if (!firstUserText && row.type === 'message' && row.role === 'user') {
      const text = extractText(row.content)
      if (text && !isNoiseText(text)) firstUserText = text
    }
  }

  let lastActiveAt: string | undefined
  let lastText = ''
  for (let i = tail.length - 1; i >= 0; i--) {
    const row = parseJsonLine(tail[i])
    if (!row) continue
    if (!lastActiveAt) lastActiveAt = epochMsToIso(row.timestamp)
    if (
      !lastText &&
      row.type === 'message' &&
      (row.role === 'user' || row.role === 'assistant')
    ) {
      const text = extractText(row.content)
      if (text && !isNoiseText(text)) lastText = text
    }
    if (lastActiveAt && lastText) break
  }

  const stat = fs.statSync(file)
  const projectDir = cwd || workbuddyProjectLabel(projectDirName)
  return {
    app: 'workbuddy',
    sessionId,
    title: aiTitle || (firstUserText ? truncate(firstUserText, 60) : projectDir),
    summary: truncate(lastText || firstUserText, 160),
    projectDir,
    createdAt: createdAt || stat.birthtime.toISOString(),
    lastActiveAt: lastActiveAt || stat.mtime.toISOString(),
    sourcePath: file
  }
}

export async function listWorkBuddySessions(): Promise<SessionMeta[]> {
  const root = workbuddyProjectsRoot()
  let projects: fs.Dirent[]
  try {
    projects = await fsp.readdir(root, { withFileTypes: true })
  } catch {
    return []
  }

  const sessions: SessionMeta[] = []
  let scanned = 0
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const projectPath = path.join(root, project.name)
    let entries: fs.Dirent[]
    try {
      entries = await fsp.readdir(projectPath, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
      const file = path.join(projectPath, entry.name)
      try {
        sessions.push(
          parseWorkBuddySessionMeta(file, entry.name.replace(/\.jsonl$/, ''), project.name)
        )
      } catch {
        // 单个损坏会话不阻塞整个列表
      }
      // 每解析若干个文件让出一次事件循环，几千会话时主进程仍可响应 IPC
      if (++scanned % 16 === 0) await yieldToEventLoop()
    }
  }
  return sessions.sort(byLastActiveDesc)
}

// WorkBuddy 行解析状态：工具配对（callId 回填）与文件快照清单跨行累积
interface WorkBuddyParseState {
  messages: SessionMessage[]
  toolCalls: Map<string, number>
  touchedFiles: Set<string>
}

function createWorkBuddyParseState(): WorkBuddyParseState {
  return { messages: [], toolCalls: new Map(), touchedFiles: new Set() }
}

function parseWorkBuddyLine(line: string, state: WorkBuddyParseState): void {
  if (!line.trim()) return
  const row = parseJsonLine(line)
  if (!row) return
  const { messages, toolCalls, touchedFiles } = state
  if (row.type === 'function_call') {
    const name = typeof row.name === 'string' && row.name ? row.name : '工具'
    const args = summarizeToolArgs(row.arguments)
    messages.push({
      role: 'tool',
      text: args ? `⚡ ${name}\n${args}` : `⚡ ${name}`,
      timestamp: epochMsToIso(row.timestamp)
    })
    if (typeof row.callId === 'string') toolCalls.set(row.callId, messages.length - 1)
    return
  }
  if (row.type === 'function_call_result') {
    const output = truncateBlock(toolOutputText(row.output), 800)
    const suffix = `→ ${output || '（无输出）'}`
    const idx = typeof row.callId === 'string' ? toolCalls.get(row.callId) : undefined
    if (idx !== undefined) {
      messages[idx].text += `\n${suffix}`
    } else {
      const name = typeof row.name === 'string' && row.name ? row.name : '工具'
      messages.push({ role: 'tool', text: `⚡ ${name}\n${suffix}`, timestamp: epochMsToIso(row.timestamp) })
    }
    return
  }
  if (row.type === 'file-history-snapshot') {
    // snapshot.trackedFileBackups 记录写文件前的备份点，即本会话改动过的文件
    const snapshot = row.snapshot as Record<string, unknown> | undefined
    const backups = snapshot?.trackedFileBackups
    if (backups && typeof backups === 'object') {
      for (const key of Object.keys(backups)) {
        if (key) touchedFiles.add(key)
      }
    }
    return
  }
  if (row.type !== 'message') return
  if (row.role !== 'user' && row.role !== 'assistant') return
  const text = extractText(row.content)
  if (!text || isNoiseText(text)) return
  messages.push({ role: row.role, text, timestamp: epochMsToIso(row.timestamp) })
}

function appendTouchedFilesSummary(state: WorkBuddyParseState): void {
  const { messages, touchedFiles } = state
  if (touchedFiles.size) {
    messages.push({
      role: 'tool',
      text: `📁 本会话写入/修改过的文件（${touchedFiles.size} 个）：\n${[...touchedFiles]
        .map((f) => `- ${f}`)
        .join('\n')}`
    })
  }
}

export async function readWorkBuddySessionMessages(
  sessionId: string,
  opts?: SessionMessagesOptions
): Promise<SessionMessagesPage> {
  const file = findWorkBuddySessionFile(sessionId)
  if (!file) throw new Error('会话不存在或已被删除')

  const size = fs.statSync(file).size
  const limit = clampPageLimit(opts?.limit)

  // 小文件且是首页：全量解析（工具完整配对 + 文件清单 + 精确总数）
  if (opts?.cursor === undefined && size <= SMALL_SESSION_FILE) {
    const state = createWorkBuddyParseState()
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      parseWorkBuddyLine(line, state)
    }
    appendTouchedFilesSummary(state)
    return { messages: state.messages, hasMore: false, total: state.messages.length }
  }

  // 大文件 / 翻页：只读游标窗口，向更早方向按需加载
  const end = opts?.cursor ?? size
  const { messages, start } = readMessageWindow(
    file,
    end,
    limit,
    createWorkBuddyParseState,
    parseWorkBuddyLine
  )
  return {
    messages,
    hasMore: start > 0,
    cursor: start > 0 ? start : undefined
  }
}

export async function deleteWorkBuddySession(
  sessionId: string
): Promise<ApplyResult> {
  const file = findWorkBuddySessionFile(sessionId)
  if (!file) return { ok: true, message: '会话不存在，可能已被删除' }

  fs.rmSync(file)
  // 同名 sidecar 目录存放快照等附属数据（若存在）一并清理
  const sidecar = file.replace(/\.jsonl$/, '')
  if (fs.existsSync(sidecar) && fs.statSync(sidecar).isDirectory()) {
    fs.rmSync(sidecar, { recursive: true, force: true })
  }
  return { ok: true, message: '会话已删除' }
}

// ── Codex ──

function codexHome(): string {
  return path.join(os.homedir(), '.codex')
}

function codexSessionsRoot(): string {
  return path.join(codexHome(), 'sessions')
}

function codexSessionIndexPath(): string {
  return path.join(codexHome(), 'session_index.jsonl')
}

/** 官方索引：{id, thread_name, updated_at}，提供标题与最后活跃时间。 */
function readCodexSessionIndex(): Map<string, { title?: string; updatedAt?: string }> {
  const file = codexSessionIndexPath()
  const result = new Map<string, { title?: string; updatedAt?: string }>()
  if (!fs.existsSync(file)) return result
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    const row = parseJsonLine(line)
    if (!row || typeof row.id !== 'string') continue
    result.set(row.id, {
      title:
        typeof row.thread_name === 'string' && row.thread_name.trim()
          ? row.thread_name
          : undefined,
      updatedAt: typeof row.updated_at === 'string' ? row.updated_at : undefined
    })
  }
  return result
}

async function listCodexRolloutFiles(root: string): Promise<string[]> {
  const files: string[] = []
  const walk = async (dir: string) => {
    let entries: fs.Dirent[]
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(full)
    }
  }
  await walk(root)
  return files
}

// rollout-2026-09-26T21-57-45-<uuid>.jsonl → 取末尾 5 段重组会话 id
function sessionIdFromRolloutName(name: string): string {
  const base = name.replace(/\.jsonl$/, '')
  const parts = base.split('-')
  return parts.length >= 6 ? parts.slice(-5).join('-') : base
}

function parseCodexSessionMeta(
  file: string,
  index: Map<string, { title?: string; updatedAt?: string }>
): SessionMeta {
  const size = fs.statSync(file).size
  const head = readHeadLines(file, 6, size)

  let sessionId = sessionIdFromRolloutName(path.basename(file))
  let cwd = ''
  let createdAt: string | undefined
  let firstUserText = ''
  for (const line of head) {
    const row = parseJsonLine(line)
    if (!row) continue
    const payload = row.payload as Record<string, unknown> | undefined
    if (row.type === 'session_meta' && payload) {
      if (typeof payload.session_id === 'string') sessionId = payload.session_id
      if (typeof payload.cwd === 'string' && payload.cwd) cwd = payload.cwd
      if (typeof payload.timestamp === 'string') createdAt = payload.timestamp
    } else if (
      !firstUserText &&
      row.type === 'response_item' &&
      payload &&
      payload.type === 'message' &&
      payload.role === 'user'
    ) {
      const text = extractText(payload.content)
      if (text && !isNoiseText(text)) firstUserText = text
    }
  }

  const stat = fs.statSync(file)
  const indexed = index.get(sessionId)
  const projectDir = cwd || 'Codex'
  const title =
    indexed?.title || (firstUserText ? truncate(firstUserText, 60) : path.basename(projectDir))
  return {
    app: 'codex',
    sessionId,
    title: truncate(title, 60),
    summary: truncate(firstUserText || indexed?.title || '', 160),
    projectDir,
    createdAt: createdAt || stat.birthtime.toISOString(),
    lastActiveAt: indexed?.updatedAt || stat.mtime.toISOString(),
    sourcePath: file
  }
}

export async function listCodexSessions(): Promise<SessionMeta[]> {
  const files = await listCodexRolloutFiles(codexSessionsRoot())
  if (!files.length) return []

  const index = readCodexSessionIndex()
  const sessions: SessionMeta[] = []
  for (const file of files) {
    try {
      sessions.push(parseCodexSessionMeta(file, index))
    } catch {
      // 跳过损坏的 rollout 文件
    }
    if (sessions.length % 16 === 0) await yieldToEventLoop()
  }
  return sessions.sort(byLastActiveDesc)
}

async function findCodexRolloutFile(sessionId: string): Promise<string | null> {
  if (!sessionIdPattern.test(sessionId)) return null
  for (const file of await listCodexRolloutFiles(codexSessionsRoot())) {
    if (path.basename(file).endsWith(`-${sessionId}.jsonl`)) return file
  }
  return null
}

interface CodexParseState {
  messages: SessionMessage[]
  toolCalls: Map<string, number>
}

function createCodexParseState(): CodexParseState {
  return { messages: [], toolCalls: new Map() }
}

function parseCodexLine(line: string, state: CodexParseState): void {
  if (!line.trim()) return
  const row = parseJsonLine(line)
  if (!row || row.type !== 'response_item') return
  const payload = row.payload as Record<string, unknown> | undefined
  if (!payload) return
  const { messages, toolCalls } = state
  const ts = typeof row.timestamp === 'string' ? row.timestamp : undefined
  if (payload.type === 'function_call') {
    const name = typeof payload.name === 'string' && payload.name ? payload.name : '工具'
    const args = summarizeToolArgs(payload.arguments)
    messages.push({
      role: 'tool',
      text: args ? `⚡ ${name}\n${args}` : `⚡ ${name}`,
      timestamp: ts
    })
    if (typeof payload.call_id === 'string') toolCalls.set(payload.call_id, messages.length - 1)
    return
  }
  if (payload.type === 'custom_tool_call') {
    // apply_patch 等自定义工具：input 即文件补丁，摘要里列出生效文件
    const name = typeof payload.name === 'string' && payload.name ? payload.name : '工具'
    const input = typeof payload.input === 'string' ? payload.input : ''
    const summary = summarizePatch(input)
    const body = truncateBlock(input, 600)
    messages.push({
      role: 'tool',
      text: summary ? `✏️ ${name}（${summary}）\n${body}` : `✏️ ${name}\n${body}`,
      timestamp: ts
    })
    if (typeof payload.call_id === 'string') toolCalls.set(payload.call_id, messages.length - 1)
    return
  }
  if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
    const output = truncateBlock(toolOutputText(payload.output), 800)
    const suffix = `→ ${output || '（无输出）'}`
    const idx = typeof payload.call_id === 'string' ? toolCalls.get(payload.call_id) : undefined
    if (idx !== undefined) {
      messages[idx].text += `\n${suffix}`
    } else {
      messages.push({ role: 'tool', text: `⚡ 工具\n${suffix}`, timestamp: ts })
    }
    return
  }
  if (payload.type !== 'message') return
  // developer/system 通道是应用注入的上下文，不属于对话内容
  if (payload.role !== 'user' && payload.role !== 'assistant') return
  const text = extractText(payload.content)
  if (!text || isNoiseText(text)) return
  messages.push({ role: payload.role, text, timestamp: ts })
}

export async function readCodexSessionMessages(
  sessionId: string,
  opts?: SessionMessagesOptions
): Promise<SessionMessagesPage> {
  const file = await findCodexRolloutFile(sessionId)
  if (!file) throw new Error('会话不存在或已被删除')

  const size = fs.statSync(file).size
  const limit = clampPageLimit(opts?.limit)

  if (opts?.cursor === undefined && size <= SMALL_SESSION_FILE) {
    const state = createCodexParseState()
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      parseCodexLine(line, state)
    }
    return { messages: state.messages, hasMore: false, total: state.messages.length }
  }

  const end = opts?.cursor ?? size
  const { messages, start } = readMessageWindow(
    file,
    end,
    limit,
    createCodexParseState,
    parseCodexLine
  )
  return {
    messages,
    hasMore: start > 0,
    cursor: start > 0 ? start : undefined
  }
}

export async function deleteCodexSession(sessionId: string): Promise<ApplyResult> {
  const file = await findCodexRolloutFile(sessionId)
  if (!file) return { ok: true, message: '会话不存在，可能已被删除' }
  fs.rmSync(file)
  return {
    ok: true,
    message: '会话已删除（官方索引条目将在 Codex 下次启动时自动失效）'
  }
}
