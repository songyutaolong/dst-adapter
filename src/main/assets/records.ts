import fs from 'fs'
import path from 'path'
import type { AssetRecord, AssetRecordStatus } from '../../shared/types'
import { atomicWriteJson, dataDir, ensureDir } from '../store'

/**
 * 生成记录持久化：~/.dst-adapter/assets/records.json
 *
 * 与 db.json 分离：记录无限增长，且轮询器频繁更新状态，
 * 混入 db.json 会拖累其整体写入与备份轮转。
 * 内存为准、防抖落盘；before-quit 时同步 flush。
 */

const RECORDS_VERSION = 1
const MAX_RECORDS = 500
const PENDING_DIR_CAP = 512 * 1024 * 1024
const SAVE_DEBOUNCE_MS = 1000

function assetsDir(): string {
  return path.join(dataDir(), 'assets')
}

function recordsPath(): string {
  return path.join(assetsDir(), 'records.json')
}

function pendingDir(): string {
  return path.join(assetsDir(), 'pending')
}

export function pendingFilePathFor(id: string, fileName: string): string {
  return path.join(pendingDir(), `${id}_${fileName}`)
}

interface RecordsFile {
  version: number
  records: AssetRecord[]
}

let records: AssetRecord[] | null = null
let saveTimer: NodeJS.Timeout | null = null

function isTerminal(status: AssetRecordStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'expired'
}

function loadOnce(): AssetRecord[] {
  if (records) return records
  ensureDir(assetsDir())
  ensureDir(pendingDir())
  const file = recordsPath()
  if (!fs.existsSync(file)) {
    records = []
    return records
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as RecordsFile
    records = Array.isArray(parsed.records) ? parsed.records : []
  } catch {
    // 损坏文件保留现场后从空表开始，避免单个坏文件拖垮归档
    try {
      fs.renameSync(file, `${recordsPath()}.corrupt-${Date.now()}.json`)
    } catch {
      /* ignore */
    }
    records = []
  }
  return records
}

function persistNow(): void {
  const list = loadOnce()
  atomicWriteJson(recordsPath(), { version: RECORDS_VERSION, records: list } satisfies RecordsFile)
}

function scheduleSave(): void {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    try {
      persistNow()
    } catch (err) {
      console.error('[assets] records persist failed:', err)
    }
  }, SAVE_DEBOUNCE_MS)
}

/** before-quit 同步落盘（正常退出不丢防抖窗口内的更新）。 */
export function flushAssetRecordsSync(): void {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  if (records) {
    try {
      persistNow()
    } catch (err) {
      console.error('[assets] records flush failed:', err)
    }
  }
}

/** 倒序（最新在前）。 */
export function listAssetRecords(): AssetRecord[] {
  return [...loadOnce()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
}

export function getAssetRecord(id: string): AssetRecord | undefined {
  return loadOnce().find((r) => r.id === id)
}

export function findAssetRecordByTaskId(taskId: string): AssetRecord | undefined {
  return loadOnce().find((r) => r.taskId === taskId)
}

export function upsertAssetRecord(record: AssetRecord): void {
  const list = loadOnce()
  const idx = list.findIndex((r) => r.id === record.id)
  if (idx >= 0) list[idx] = record
  else list.unshift(record)
  pruneRecords()
  scheduleSave()
}

export function deleteAssetRecord(id: string): void {
  const list = loadOnce()
  const idx = list.findIndex((r) => r.id === id)
  if (idx < 0) return
  const [removed] = list.splice(idx, 1)
  if (removed?.localBufferPath) {
    try {
      fs.unlinkSync(removed.localBufferPath)
    } catch {
      /* 文件可能已不存在 */
    }
  }
  scheduleSave()
}

/** 只淘汰最旧的终态记录；进行中/待重试的永不淘汰。 */
function pruneRecords(): void {
  const list = loadOnce()
  if (list.length <= MAX_RECORDS) return
  const sorted = [...list].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
  let toDrop = list.length - MAX_RECORDS
  for (const candidate of sorted) {
    if (toDrop <= 0) break
    if (!isTerminal(candidate.status)) continue
    const idx = list.indexOf(candidate)
    if (idx >= 0) {
      list.splice(idx, 1)
      toDrop--
    }
  }
}

/** 失败缓存目录总量控制：超限时从最旧的上传失败缓存开始清理，并标记对应记录。 */
export function enforcePendingCap(): void {
  const dir = pendingDir()
  let entries: { file: string; size: number; mtime: number }[]
  try {
    entries = fs
      .readdirSync(dir)
      .map((name) => {
        const file = path.join(dir, name)
        const st = fs.statSync(file)
        return { file, size: st.size, mtime: st.mtimeMs }
      })
      .filter((e) => e.size > 0)
  } catch {
    return
  }
  let total = entries.reduce((sum, e) => sum + e.size, 0)
  if (total <= PENDING_DIR_CAP) return
  entries.sort((a, b) => a.mtime - b.mtime)
  const list = loadOnce()
  for (const entry of entries) {
    if (total <= PENDING_DIR_CAP) break
    const record = list.find((r) => r.localBufferPath === entry.file)
    // 只清理已无重试价值或失败重试的缓存；进行中（uploading）不动
    if (record && (record.status === 'uploading' || record.status === 'pending')) continue
    try {
      fs.unlinkSync(entry.file)
      total -= entry.size
      if (record) {
        record.localBufferPath = undefined
        record.error = '本地缓存已清理，无法重试'
        scheduleSave()
      }
    } catch {
      /* ignore */
    }
  }
}
