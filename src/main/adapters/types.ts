import type {
  ApplyResult,
  DetectResult,
  Provider,
  SessionMeta,
  SessionMessagesOptions,
  SessionMessagesPage,
  SkillCatalogResult
} from '../../shared/types'

export type HttpMcpServerEntry = {
  type: 'http'
  url: string
  name?: string
}

export type CommandMcpServerEntry = {
  command: string
  args?: string[]
  disabled?: boolean
}

export type McpServerEntry = HttpMcpServerEntry | CommandMcpServerEntry

export interface AppAdapter {
  id: string
  name: string
  implemented: boolean
  detect(): Promise<DetectResult>
  readLive(): Promise<unknown>
  /**
   * opts.activeModel：调用方显式激活的模型（如模型页点"启用"）；
   * 不传时保留应用内用户已选择的模型，避免每次写入都重置。
   */
  writeLive(provider: Provider, opts?: { activeModel?: string }): Promise<ApplyResult>
  /** 从应用配置中移除指定模型（支持多模型并存的应用） */
  removeModel?(modelId: string): Promise<ApplyResult>
  /** 合并/移除 MCP 服务配置到目标应用 */
  writeMcp?(
    merge: Record<string, McpServerEntry>,
    removeKeys?: string[]
  ): Promise<ApplyResult>
  /** 读取目标应用当前已存在的 MCP 配置 */
  readMcp?(): Promise<Record<string, McpServerEntry>>
  /** 拉取目标应用可用的远端 Skill 目录 */
  listSkills?(force?: boolean): Promise<SkillCatalogResult>
  /** 更新已安装 Skill 的模型调用开关 */
  setSkillEnabled?(id: string, enabled: boolean): Promise<ApplyResult>
  /** 从远端仓储安装或更新 Skill */
  updateSkill?(id: string): Promise<ApplyResult>
  /** 查询目标应用是否正在运行 */
  isRunning?(): Promise<boolean>
  /** 扫描应用本地落盘的历史会话（只读） */
  listSessions?(): Promise<SessionMeta[]>
  /** 分页读取会话消息：不传 cursor 返回最新一页，向更早方向翻页 */
  readSessionMessages?(
    sessionId: string,
    opts?: SessionMessagesOptions
  ): Promise<SessionMessagesPage>
  /** 删除一个历史会话（含落盘文件） */
  deleteSession?(sessionId: string): Promise<ApplyResult>
  launch?(): Promise<void | { message?: string }>
  requiresQuitBeforeWrite?: boolean
}
