import type {
  ApplyResult,
  DetectResult,
  Provider,
  SkillCatalogResult
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
  /** 拉取目标应用可用的远端 Skill 目录 */
  listSkills?(force?: boolean): Promise<SkillCatalogResult>
  /** 更新已安装 Skill 的模型调用开关 */
  setSkillEnabled?(id: string, enabled: boolean): Promise<ApplyResult>
  /** 从远端仓储安装或更新 Skill */
  updateSkill?(id: string): Promise<ApplyResult>
  /** 查询目标应用是否正在运行 */
  isRunning?(): Promise<boolean>
  launch?(): Promise<void | { message?: string }>
  requiresQuitBeforeWrite?: boolean
}
