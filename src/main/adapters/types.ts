import type {
  ApplyResult,
  DetectResult,
  Provider
} from '../../shared/types'

export interface AppAdapter {
  id: string
  name: string
  implemented: boolean
  detect(): Promise<DetectResult>
  readLive(): Promise<unknown>
  writeLive(provider: Provider): Promise<ApplyResult>
  launch?(): Promise<void | { injected?: boolean; message?: string }>
  requiresQuitBeforeWrite?: boolean
}
