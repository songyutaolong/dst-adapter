import {
  app,
  BrowserWindow,
  Menu,
  nativeImage,
  Tray,
  dialog
} from 'electron'
import fs from 'fs'
import path from 'path'
import { listProviders } from './store'
import { enableProvider } from './switcher'
import type { AppId } from '../shared/types'

let tray: Tray | null = null

function resolveTrayIconPath(): string | null {
  const candidates = [
    path.join(__dirname, '../../resources/tray.png'),
    path.join(process.resourcesPath, 'resources/tray.png'),
    path.join(process.resourcesPath, 'tray.png'),
    path.join(app.getAppPath(), 'resources/tray.png')
  ]
  for (const p of candidates) {
    if (fs.existsSync(p)) return p
  }
  return null
}

function trayIcon(): Electron.NativeImage {
  const iconPath = resolveTrayIconPath()
  if (iconPath) {
    let img = nativeImage.createFromPath(iconPath)
    if (!img.isEmpty()) {
      // Windows 托盘推荐 16x16，高 DPI 用 32x32
      if (process.platform === 'win32') {
        img = img.resize({ width: 16, height: 16 })
      }
      return img
    }
  }

  // 最后兜底：生成实心色块，避免空图标
  const size = 16
  const buf = Buffer.alloc(size * size * 4)
  for (let i = 0; i < size * size; i++) {
    const o = i * 4
    buf[o] = 15
    buf[o + 1] = 118
    buf[o + 2] = 110
    buf[o + 3] = 255
  }
  return nativeImage.createFromBuffer(buf, { width: size, height: size })
}

export function createTray(getMainWindow: () => BrowserWindow | null): Tray {
  const icon = trayIcon()
  tray = new Tray(icon)
  tray.setToolTip('大算头适配器')
  if (icon.isEmpty()) {
    console.warn('[tray] icon is empty, tray may be invisible')
  }
  rebuildTrayMenu(getMainWindow)

  tray.on('double-click', () => {
    const win = getMainWindow()
    if (win) {
      win.show()
      win.focus()
    }
  })

  tray.on('click', () => {
    if (process.platform === 'win32') {
      const win = getMainWindow()
      if (win) {
        win.show()
        win.focus()
      }
    }
  })

  return tray
}

export function rebuildTrayMenu(getMainWindow: () => BrowserWindow | null): void {
  if (!tray) return
  const providerMenu = (
    appId: AppId
  ): Electron.MenuItemConstructorOptions[] => {
    const providers = listProviders(appId)
    return providers.length
      ? providers.map((p) => ({
          label: `${p.enabled ? '● ' : ''}${p.name}`,
          click: async () => {
            const result = await enableProvider(p.id)
            rebuildTrayMenu(getMainWindow)
            if (!result.ok) {
              dialog.showErrorBox('启用失败', result.message)
            }
          }
        }))
      : [{ label: '暂无 Provider', enabled: false }]
  }

  const menu = Menu.buildFromTemplate([
    {
      label: '打开主界面',
      click: () => {
        const win = getMainWindow()
        if (win) {
          win.show()
          win.focus()
        }
      }
    },
    { type: 'separator' },
    { label: 'WorkBuddy 快切', submenu: providerMenu('workbuddy') },
    { label: 'Codex 快切', submenu: providerMenu('codex') },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        app.quit()
      }
    }
  ])
  tray.setContextMenu(menu)
}
