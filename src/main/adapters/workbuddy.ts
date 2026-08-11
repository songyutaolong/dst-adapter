import fs from 'fs'
import path from 'path'
import os from 'os'
import { shell } from 'electron'
import type { ApplyResult, DetectResult, Provider } from '../../shared/types'
import { providerToWorkBuddyModel } from '../../shared/url'
import { atomicWriteText, backupFile } from '../store'
import type { AppAdapter } from './types'

type WorkBuddyModel = ReturnType<typeof providerToWorkBuddyModel>

function homeWorkbuddyDir(): string {
  return path.join(os.homedir(), '.workbuddy')
}

function modelsPath(): string {
  return path.join(homeWorkbuddyDir(), 'models.json')
}

function findInstallDirs(): string[] {
  const dirs: string[] = []
  const local = process.env.LOCALAPPDATA
  if (local) {
    dirs.push(path.join(local, 'Programs', 'WorkBuddy'))
    dirs.push(path.join(local, 'WorkBuddy'))
  }
  if (process.platform === 'darwin') {
    dirs.push('/Applications/WorkBuddy.app')
  }
  return dirs
}

function parseModels(raw: string): WorkBuddyModel[] {
  const data = JSON.parse(raw)
  if (Array.isArray(data)) return data
  if (data && Array.isArray(data.models)) return data.models
  return []
}

function serializeModels(models: WorkBuddyModel[]): string {
  // WorkBuddy on this machine uses a bare array
  return `${JSON.stringify(models, null, 2)}\n`
}

async function detect(): Promise<DetectResult> {
  const configDir = homeWorkbuddyDir()
  const configExists = fs.existsSync(configDir)
  const installHit = findInstallDirs().some((d) => fs.existsSync(d))
  const installed = configExists || installHit
  return {
    installed,
    configPath: modelsPath(),
    detail: installed
      ? configExists
        ? '已检测到 WorkBuddy 配置目录'
        : '已检测到 WorkBuddy 安装目录'
      : '未检测到 WorkBuddy'
  }
}

async function readLive(): Promise<unknown> {
  const file = modelsPath()
  if (!fs.existsSync(file)) return []
  return parseModels(fs.readFileSync(file, 'utf-8'))
}

async function writeLive(provider: Provider): Promise<ApplyResult> {
  const file = modelsPath()
  const dir = homeWorkbuddyDir()
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  const backupPath = backupFile('workbuddy', file)
  let models: WorkBuddyModel[] = []
  if (fs.existsSync(file)) {
    try {
      models = parseModels(fs.readFileSync(file, 'utf-8'))
    } catch {
      models = []
    }
  }

  const next = providerToWorkBuddyModel(provider)
  const idx = models.findIndex((m) => m.id === next.id)
  if (idx >= 0) {
    models[idx] = { ...models[idx], ...next }
  } else {
    models.push(next)
  }

  atomicWriteText(file, serializeModels(models))
  return {
    ok: true,
    message: `已写入 WorkBuddy models.json（模型 ${next.id}）`,
    backupPath
  }
}

async function launch(): Promise<void> {
  if (process.platform === 'darwin') {
    await shell.openPath('/Applications/WorkBuddy.app')
    return
  }
  const candidates = [
    ...findInstallDirs().map((d) => path.join(d, 'WorkBuddy.exe')),
    ...findInstallDirs().flatMap((d) => {
      try {
        return fs
          .readdirSync(d)
          .filter((n) => n.toLowerCase().endsWith('.exe'))
          .map((n) => path.join(d, n))
      } catch {
        return [] as string[]
      }
    })
  ]
  for (const exe of candidates) {
    if (fs.existsSync(exe)) {
      await shell.openPath(exe)
      return
    }
  }
  throw new Error('未找到 WorkBuddy 可执行文件')
}

export const workbuddyAdapter: AppAdapter = {
  id: 'workbuddy',
  name: 'WorkBuddy',
  implemented: true,
  detect,
  readLive,
  writeLive,
  launch
}
