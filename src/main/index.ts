import {
  app,
  BrowserWindow,
  Menu,
  shell
} from 'electron'
import { join } from 'path'
import { registerIpc } from './ipc'
import { createTray, rebuildTrayMenu } from './tray'
import { createProvider } from './store'
import { parseDeepLink } from '../shared/url'
import type { AppId } from '../shared/types'

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

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 680,
    minWidth: 800,
    minHeight: 560,
    show: false,
    title: '大算头适配器',
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

app.whenReady().then(() => {
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
