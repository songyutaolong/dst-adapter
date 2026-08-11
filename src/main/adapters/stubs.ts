import type { ApplyResult, DetectResult, Provider } from '../../shared/types'
import type { AppAdapter } from './types'
import type { AppId } from '../../shared/types'
import { APP_META } from '../../shared/types'

function stub(id: AppId): AppAdapter {
  const meta = APP_META[id]
  return {
    id,
    name: meta.name,
    implemented: false,
    async detect(): Promise<DetectResult> {
      return {
        installed: false,
        detail: '框架占位：尚未实现检测与写入'
      }
    },
    async readLive(): Promise<unknown> {
      return null
    },
    async writeLive(_provider: Provider): Promise<ApplyResult> {
      return {
        ok: false,
        message: `${meta.name} 适配器尚未实现，敬请期待`
      }
    }
  }
}

export const cursorAdapter = stub('cursor')
export const continueAdapter = stub('continue')
export const clineAdapter = stub('cline')
export const cherryStudioAdapter = stub('cherry-studio')
export const claudeCodeAdapter = stub('claude-code')
export const claudeDesktopAdapter = stub('claude-desktop')
export const vscodeAdapter = stub('vscode')
