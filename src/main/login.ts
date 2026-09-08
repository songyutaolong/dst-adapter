import { app } from 'electron'

/** 开机启动：写入操作系统登录项。 */
export function applyLaunchAtLogin(enabled: boolean): void {
  app.setLoginItemSettings({
    openAtLogin: enabled
  })
}
