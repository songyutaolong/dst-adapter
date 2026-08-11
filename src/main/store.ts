import fs from 'fs'
import path from 'path'
import os from 'os'
import { randomUUID } from 'crypto'
import type { AppId, AppSettings, Provider } from '../shared/types'
import { DEFAULT_SETTINGS } from '../shared/types'

export interface DataStore {
  version: number
  settings: AppSettings
  providers: Provider[]
}

function dataDir(): string {
  return path.join(os.homedir(), '.dst-adapter')
}

function dbPath(): string {
  return path.join(dataDir(), 'db.json')
}

export function backupsDir(app?: string): string {
  const base = path.join(dataDir(), 'backups')
  return app ? path.join(base, app) : base
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
}

function emptyStore(): DataStore {
  return {
    version: 1,
    settings: { ...DEFAULT_SETTINGS },
    providers: []
  }
}

function atomicWriteJson(filePath: string, data: unknown): void {
  ensureDir(path.dirname(filePath))
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8')
  fs.renameSync(tmp, filePath)
}

export function loadStore(): DataStore {
  ensureDir(dataDir())
  const file = dbPath()
  if (!fs.existsSync(file)) {
    const store = emptyStore()
    atomicWriteJson(file, store)
    return store
  }
  try {
    const raw = fs.readFileSync(file, 'utf-8')
    const parsed = JSON.parse(raw) as DataStore
    return {
      version: parsed.version ?? 1,
      settings: { ...DEFAULT_SETTINGS, ...(parsed.settings || {}) },
      providers: Array.isArray(parsed.providers) ? parsed.providers : []
    }
  } catch {
    const store = emptyStore()
    atomicWriteJson(file, store)
    return store
  }
}

export function saveStore(store: DataStore): void {
  atomicWriteJson(dbPath(), store)
}

export function listProviders(app?: AppId): Provider[] {
  const store = loadStore()
  const list = store.providers
  return app ? list.filter((p) => p.app === app) : list
}

export function getProvider(id: string): Provider | undefined {
  return loadStore().providers.find((p) => p.id === id)
}

export function createProvider(
  input: Omit<Provider, 'id' | 'createdAt' | 'updatedAt' | 'enabled'> & {
    enabled?: boolean
  }
): Provider {
  const store = loadStore()
  const now = new Date().toISOString()
  const provider: Provider = {
    id: randomUUID(),
    name: input.name,
    app: input.app,
    endpoint: input.endpoint,
    apiKey: input.apiKey,
    model: input.model,
    vendor: input.vendor || 'dst',
    supportsToolCall: input.supportsToolCall ?? true,
    supportsImages: input.supportsImages ?? false,
    supportsReasoning: input.supportsReasoning ?? false,
    enabled: false,
    createdAt: now,
    updatedAt: now
  }
  store.providers.push(provider)
  saveStore(store)
  return provider
}

export function updateProvider(
  id: string,
  patch: Partial<Omit<Provider, 'id' | 'createdAt'>>
): Provider {
  const store = loadStore()
  const idx = store.providers.findIndex((p) => p.id === id)
  if (idx < 0) throw new Error('Provider not found')
  store.providers[idx] = {
    ...store.providers[idx],
    ...patch,
    id,
    updatedAt: new Date().toISOString()
  }
  saveStore(store)
  return store.providers[idx]
}

export function deleteProvider(id: string): void {
  const store = loadStore()
  const target = store.providers.find((p) => p.id === id)
  if (!target) throw new Error('Provider not found')
  if (target.enabled) {
    throw new Error('不能删除当前启用的 Provider，请先切换到其他配置')
  }
  store.providers = store.providers.filter((p) => p.id !== id)
  saveStore(store)
}

export function markEnabled(app: AppId, providerId: string): void {
  const store = loadStore()
  for (const p of store.providers) {
    if (p.app === app) {
      p.enabled = p.id === providerId
      p.updatedAt = new Date().toISOString()
    }
  }
  saveStore(store)
}

export function getSettings(): AppSettings {
  return loadStore().settings
}

export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  const store = loadStore()
  store.settings = { ...store.settings, ...patch }
  saveStore(store)
  return store.settings
}

export function backupFile(app: string, sourcePath: string): string | undefined {
  if (!fs.existsSync(sourcePath)) return undefined
  const dir = backupsDir(app)
  ensureDir(dir)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dest = path.join(dir, `${stamp}${path.extname(sourcePath) || '.json'}`)
  fs.copyFileSync(sourcePath, dest)
  rotateBackups(app, getSettings().backupKeep)
  return dest
}

function rotateBackups(app: string, keep: number): void {
  const dir = backupsDir(app)
  if (!fs.existsSync(dir)) return
  const files = fs
    .readdirSync(dir)
    .map((name) => ({ name, full: path.join(dir, name) }))
    .map((f) => ({ ...f, mtime: fs.statSync(f.full).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
  for (const f of files.slice(Math.max(keep, 1))) {
    try {
      fs.unlinkSync(f.full)
    } catch {
      /* ignore */
    }
  }
}

export function atomicWriteText(filePath: string, content: string): void {
  ensureDir(path.dirname(filePath))
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, content, 'utf-8')
  fs.renameSync(tmp, filePath)
}

export function getDataDir(): string {
  return dataDir()
}
