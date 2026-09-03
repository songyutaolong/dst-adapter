import { app, Notification } from 'electron'
import type { BrowserWindow } from 'electron'
import { autoUpdater, type UpdateInfo } from 'electron-updater'
import type { UpdateState } from '../shared/types'

/**
 * 自动更新模块（electron-updater + GitHub Releases）
 *
 * - 开发模式（!app.isPackaged）下不初始化，状态置 unsupported。
 * - 自动更新已关闭：启动不检查、发现新版本不自动下载；
 *   仅在用户点击 UI「↻ 检查更新」时联网，下载 / 重启安装均为手动触发。
 * - 状态通过 'update:event' 推送给 renderer，IPC 也可主动查询快照。
 */

let getMainWindow: (() => BrowserWindow | null) | null = null
let wired = false

const initial: UpdateState = {
  status: 'idle',
  currentVersion: app.getVersion(),
  isPackaged: app.isPackaged,
  canUpdate: canAutoUpdate()
}

let state: UpdateState = { ...initial }
/** 本次检查是否由用户手动发起（决定错误/结果是否弹系统通知） */
let userInitiated = false

function canAutoUpdate(): boolean {
  if (!app.isPackaged) return false
  if (process.platform === 'darwin') return true // zip 更新，未签名时可能失败，见 README
  if (process.platform === 'win32') return true // NSIS 安装版；portable 不支持
  return false
}

function setState(patch: Partial<UpdateState>): void {
  state = { ...state, ...patch }
  broadcast()
}

function broadcast(): void {
  const win = getMainWindow?.()
  if (win && !win.isDestroyed()) {
    win.webContents.send('update:event', { ...state })
  }
}

function notify(title: string, body: string, onClick?: () => void): void {
  if (!Notification.isSupported()) return
  const n = new Notification({ title, body })
  if (onClick) n.on('click', onClick)
  n.show()
}

function updaterError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  console.error('[updater]', msg)
  return msg
}

/** 初始化：在 app.whenReady 中调用一次，仅打包版生效 */
export function initUpdater(getWin: () => BrowserWindow | null): void {
  getMainWindow = getWin
  if (!app.isPackaged || wired) return
  wired = true

  autoUpdater.autoDownload = false // 下载由本模块控制（静默检查时自动下载）
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.logger = console

  autoUpdater.on('checking-for-update', () => {
    setState({ status: 'checking' })
  })

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    setState({ status: 'available', version: info.version })
    // 自动更新已关闭：不自动下载，用户点击「下载更新」后才开始
  })

  autoUpdater.on('update-not-available', () => {
    setState({ status: 'up-to-date' })
    if (userInitiated) {
      notify('已是最新版本', `当前 v${app.getVersion()} 已是最新`)
    }
  })

  autoUpdater.on('download-progress', (p) => {
    setState({ status: 'downloading', percent: Math.round(p.percent) })
  })

  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    setState({ status: 'downloaded', version: info.version })
    notify(
      '更新已就绪',
      `v${info.version} 已下载完成，点击重启安装`,
      () => quitAndInstall()
    )
  })

  autoUpdater.on('error', (err) => {
    const message = updaterError(err)
    setState({ status: 'error', error: message })
    if (userInitiated) notify('检查更新失败', message)
  })
}

export function getUpdateState(): UpdateState {
  return { ...state }
}

/** 检查更新。userInitiated=true 时仅提示并返回；false（启动静默）时发现新版本自动下载。 */
export async function checkForUpdates(userInitiatedCheck: boolean): Promise<UpdateState> {
  userInitiated = userInitiatedCheck
  if (!app.isPackaged || !canAutoUpdate()) {
    setState({
      status: 'unsupported',
      error: '当前版本不支持自动更新，请使用安装版（Windows 请安装 NSIS 安装包）'
    })
    return getUpdateState()
  }
  try {
    await autoUpdater.checkForUpdates()
  } catch (err) {
    setState({ status: 'error', error: updaterError(err) })
  }
  return getUpdateState()
}

/** 下载更新（可重试） */
export async function downloadUpdate(): Promise<UpdateState> {
  if (!app.isPackaged || !canAutoUpdate()) return getUpdateState()
  try {
    setState({ status: 'downloading', percent: 0 })
    await autoUpdater.downloadUpdate()
  } catch (err) {
    setState({ status: 'error', error: updaterError(err) })
  }
  return getUpdateState()
}

/** 退出并安装（NSIS 弹安装向导，保留用户自定义安装目录） */
export function quitAndInstall(): void {
  if (state.status !== 'downloaded') return
  autoUpdater.quitAndInstall(false, true)
}