import type {
  ApplyResult,
  DetectResult,
  Provider
} from '../../shared/types'

export type McpServerEntry = { type: string; url: string; name?: string }

export interface AppAdapter {
  id: string
  name: string
  implemented: boolean
  detect(): Promise<DetectResult>
  readLive(): Promise<unknown>
  writeLive(provider: Provider): Promise<ApplyResult>
  /** 合并/移除 MCP 服务配置到目标应用 */
  writeMcp?(
    merge: Record<string, McpServerEntry>,
    removeKeys?: string[]
  ): Promise<ApplyResult>
  launch?(): Promise<void | { message?: string }>
  requiresQuitBeforeWrite?: boolean
}
