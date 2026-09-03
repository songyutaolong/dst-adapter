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
import { createProvider, loadStore } from './store'
import { parseDeepLink } from '../shared/url'
import type { AppId } from '../shared/types'
import { stopCodexProxy } from './codex/proxy'
import { launchMcpService } from './mcp/launcher'
import { initUpdater } from './update'

let mainWindow: BrowserWindow | null = null
let pendingDeepLink: string | null = null

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
    title: `大算头适配器 v${app.getVersion()}`,
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
  // 自动更新已关闭：不自动联网检查，仅在用户点击左下角 ↻ 时手动检查

  // 自动启动已启用的 MCP 服务
  const store = loadStore()
  console.log(`[MCP] Store loaded: ${store.mcpServices.length} services`)
  for (const svc of store.mcpServices) {
    console.log(`[MCP] Service: ${svc.id}, enabled=${svc.enabled}, type=${svc.type}`)
    if (svc.enabled && svc.type === 'video-generation') {
      console.log(`[MCP] Auto-starting ${svc.id}...`)
      const result = await launchMcpService(svc)
      if (result.ok) {
        console.log(`[MCP] ${svc.id} started on port ${result.port}`)
      } else {
        console.error(`[MCP] ${svc.id} start failed: ${result.error}`)
      }
    }
  }

  const fromArgv = process.argv.find((a) => a.startsWith('dstadapter://'))
  if (fromArgv) handleDeepLink(fromArgv)
  if (pendingDeepLink) handleDeepLink(pendingDeepLink)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
    else mainWindow?.show()
  })
})

app.on('before-quit', () => {
  ;(app as typeof app & { isQuitting?: boolean }).isQuitting = true
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
