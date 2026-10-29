import {
  app,
  BrowserWindow,
  Menu,
  nativeImage,
  shell
} from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { registerIpc } from './ipc'
import { createTray, rebuildTrayMenu } from './tray'
import { createProvider, loadStore, getDstConnection, listMcpServices, markMcpServiceRunning } from './store'
import { parseDeepLink } from '../shared/url'
import type { AppId } from '../shared/types'
import { stopCodexProxy } from './codex/proxy'
import { launchMcpService, getMcpRuntime } from './mcp/launcher'
import { setToolCallHook, queryVideoTask, query3DGenerationTask } from './mcp/server'
import { archiveToolCall, flushAssetRecordsSync, initAssetArchiver } from './assets/archive'
import { initSessionArchive } from './sessionArchive'
import { initUpdater } from './update'
import { applyLaunchAtLogin } from './login'
import { migrateLegacySkillWorkDirectories } from './skills/maintenance'
import { ensureMcpToApp } from './switcher'
import { BUILTIN_MCP_UEMCP_ID } from '../shared/types'

let mainWindow: BrowserWindow | null = null
let pendingDeepLink: string | null = null

// dev 模式下Electron 取 package.json name 作为应用名, 统一成产品名
app.setName('dst Ai控制台')

async function maintainWorkBuddySkills(): Promise<void> {
  try {
    await migrateLegacySkillWorkDirectories({
      skillsRoot: join(app.getPath('home'), '.workbuddy', 'skills'),
      backupRoot: join(app.getPath('home'), '.dst-adapter', 'backups', 'workbuddy-skills')
    })
  } catch (err) {
    console.error('[Skills] WorkBuddy 历史目录迁移失败', err)
  }
}

async function maintainCodexSkills(): Promise<void> {
  try {
    await migrateLegacySkillWorkDirectories({
      skillsRoot: join(app.getPath('home'), '.codex', 'skills'),
      backupRoot: join(app.getPath('home'), '.dst-adapter', 'backups', 'codex-skills')
    })
  } catch (err) {
    console.error('[Skills] Codex 历史目录迁移失败', err)
  }
}

async function maintainUemcp(): Promise<void> {
  try {
    const service = listMcpServices().find((s) => s.id === BUILTIN_MCP_UEMCP_ID)
    if (!service) return
    const apps = (service.enabledApps || []).filter((app): app is 'workbuddy' | 'codex' =>
      app === 'workbuddy' || app === 'codex')
    if (!apps.length) return

    for (const app of apps) {
      const result = await ensureMcpToApp(app, service.id)
      if (result.ok) {
        console.log(`[MCP] ${app} UEMCP config: ${result.message}`)
      } else {
        console.warn(`[MCP] ${app} UEMCP config: ${result.message}`)
      }
    }
  } catch (err) {
    console.error('[MCP] UEMCP 配置检查失败', err)
  }
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    const url = argv.find((a) => a.startsWith('dstadapter://'))
    if (url) handleDeepLink(url)
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  })
}

function getMainWindow(): BrowserWindow | null {
  return mainWindow
}

function resolveAppIcon(): Electron.NativeImage | undefined {
  // 窗口/任务栏图标优先用 icon.png(圆角+科技蓝+适配LOGO), 兜底旧 tray.png
  const candidates = [
    join(__dirname, '../../resources/icon.png'),
    join(__dirname, '../../resources/tray.png')
  ]
  for (const p of candidates) {
    if (!existsSync(p)) continue
    const img = nativeImage.createFromPath(p)
    if (!img.isEmpty()) return img
  }
  return undefined
}

function createWindow(): void {
  const icon = resolveAppIcon()
  mainWindow = new BrowserWindow({
    width: 960,
    height: 680,
    minWidth: 800,
    minHeight: 560,
    show: false,
    title: 'dst Ai控制台',
    ...(icon ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.on('close', (e) => {
    if (!(app as typeof app & { isQuitting?: boolean }).isQuitting) {
      e.preventDefault()
      mainWindow?.hide()
    }
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function handleDeepLink(url: string): void {
  const parsed = parseDeepLink(url)
  if (!parsed || !parsed.endpoint || !parsed.apiKey) {
    pendingDeepLink = url
    mainWindow?.webContents.send('deeplink:incoming', { url, parsed })
    return
  }
  try {
    const provider = createProvider({
      name: parsed.name || 'Imported Provider',
      app: (parsed.app || 'workbuddy') as AppId,
      endpoint: parsed.endpoint,
      apiKey: parsed.apiKey,
      model: parsed.model || 'default',
      vendor: parsed.vendor || 'dst'
    })
    rebuildTrayMenu(getMainWindow)
    mainWindow?.webContents.send('deeplink:imported', provider)
  } catch (err) {
    mainWindow?.webContents.send('deeplink:error', {
      message: err instanceof Error ? err.message : String(err)
    })
  }
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null)
  await maintainWorkBuddySkills()
  await maintainCodexSkills()
  await maintainUemcp()

  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient('dstadapter', process.execPath, [
        join(process.argv[1])
      ])
    }
  } else {
    app.setAsDefaultProtocolClient('dstadapter')
  }

  registerIpc(getMainWindow)
  createWindow()
  createTray(getMainWindow)
  initUpdater(getMainWindow)

  applyLaunchAtLogin(loadStore().settings.launchAtLogin)

  // 软件打开后自动启动内置 MCP HTTP 服务
  const conn = getDstConnection()
  const mcpList = listMcpServices()
  for (const svc of mcpList.filter((s) => s.builtin && s.type !== 'ue-mcp')) {
    if (getMcpRuntime(svc.id).running) continue
    if (!conn.apiKey.trim()) {
      console.warn(`[MCP] Skip auto-start ${svc.id}: Provider API Key 未配置`)
      continue
    }
    const result = await launchMcpService({
      ...svc,
      baseUrl: conn.endpoint,
      apiKey: conn.apiKey
    })
    if (result.ok) {
      markMcpServiceRunning(svc.id, true, result.port)
      console.log(`[MCP] ${svc.id} auto-started on port ${result.port}`)
    } else {
      console.error(`[MCP] ${svc.id} auto-start failed: ${result.error}`)
    }
  }

  const fromArgv = process.argv.find((a) => a.startsWith('dstadapter://'))
  if (fromArgv) handleDeepLink(fromArgv)
  if (pendingDeepLink) handleDeepLink(pendingDeepLink)

  // 生成资产自动归档：tools/call 钩子 + 轮询器（依赖注入，避免与 server.ts 循环依赖）
  initAssetArchiver({
    getMainWindow: () => mainWindow,
    queryVideoTask,
    query3DGenerationTask
  })
  setToolCallHook(archiveToolCall)

  // 会话归档：始终开启，平台配置完成后定期把本地会话上报公司 AI 能力平台（增量，5 分钟周期）
  initSessionArchive({ getMainWindow: () => mainWindow })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
    else mainWindow?.show()
  })
})

app.on('before-quit', () => {
  ;(app as typeof app & { isQuitting?: boolean }).isQuitting = true
  flushAssetRecordsSync()
  void stopCodexProxy()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    // keep tray alive — do not quit
  }
})

app.on('open-url', (event, url) => {
  event.preventDefault()
  handleDeepLink(url)
})
