import {
  app,
  BrowserWindow,
  Menu,
  nativeImage,
  Tray,
  dialog
} from 'electron'
import path from 'path'
import { listProviders } from './store'
import { enableProvider } from './switcher'
import type { AppId } from '../shared/types'

let tray: Tray | null = null

function trayIcon(): Electron.NativeImage {
  // 16x16 simple PNG (blue square) as data URL fallback
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAFUlEQVQ4T2NkYGD4z0ABYBw1gGE0DAB+9QXbfWnH1QAAAABJRU5ErkJggg==',
    'base64'
  )
  return nativeImage.createFromBuffer(png)
}

export function createTray(getMainWindow: () => BrowserWindow | null): Tray {
  tray = new Tray(trayIcon())
  tray.setToolTip('大算头适配器')
  rebuildTrayMenu(getMainWindow)

  tray.on('double-click', () => {
    const win = getMainWindow()
    if (win) {
      win.show()
      win.focus()
    }
  })

  return tray
}

export function rebuildTrayMenu(getMainWindow: () => BrowserWindow | null): void {
  if (!tray) return
  const appId: AppId = 'workbuddy'
  const providers = listProviders(appId)
  const providerItems: Electron.MenuItemConstructorOptions[] = providers.length
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
    { label: 'WorkBuddy 快切', enabled: false },
    ...providerItems,
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
