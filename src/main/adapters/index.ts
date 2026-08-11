import type { AppAdapter } from './types'
import { workbuddyAdapter } from './workbuddy'
import {
  cherryStudioAdapter,
  claudeCodeAdapter,
  claudeDesktopAdapter,
  clineAdapter,
  continueAdapter,
  cursorAdapter,
  vscodeAdapter
} from './stubs'
import type { AppId } from '../../shared/types'

const adapters: AppAdapter[] = [
  workbuddyAdapter,
  cursorAdapter,
  continueAdapter,
  clineAdapter,
  cherryStudioAdapter,
  claudeCodeAdapter,
  claudeDesktopAdapter,
  vscodeAdapter
]

export function getAdapter(app: AppId): AppAdapter {
  const found = adapters.find((a) => a.id === app)
  if (!found) throw new Error(`Unknown app: ${app}`)
  return found
}

export function listAdapters(): AppAdapter[] {
  return adapters
}
