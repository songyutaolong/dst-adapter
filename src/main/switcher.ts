import type { AppId, ApplyResult, Provider, SettingsRewriteEvent } from '../shared/types'
import { getAdapter } from './adapters'
import {
  getProvider,
  getModel,
  markEnabled,
  enableModel as markModelEnabled,
  disableModel as markModelDisabled,
  listProviders,
  getMcpConnectionInfo,
  markMcpServiceEnabled
} from './store'

function matchesExpectedMcpEntry(
  existing: unknown,
  expected: Record<string, unknown>
): boolean {
  return Object.entries(expected).every(([key, value]) => {
    if (Array.isArray(value)) {
      const current = existing as Record<string, unknown> | null
      return (
        Array.isArray(current?.[key]) &&
        JSON.stringify(current?.[key]) === JSON.stringify(value)
      )
    }
    return (existing as Record<string, unknown> | null)?.[key] === value
  })
}

export async function enableProvider(providerId: string): Promise<ApplyResult> {
  const provider = getProvider(providerId)
  if (!provider) {
    return { ok: false, message: 'Provider 不存在' }
  }
  const adapter = getAdapter(provider.app)
  if (!adapter.implemented) {
    return {
      ok: false,
      message: `${adapter.name} 适配器尚未实现，敬请期待`
    }
  }
  const detect = await adapter.detect()
  if (!detect.installed) {
    return {
      ok: false,
      message: `未检测到 ${adapter.name}，请先安装后再启用`
    }
  }
  const result = await adapter.writeLive(provider)
  if (!result.ok) return result
  markEnabled(provider.app as AppId, provider.id)
  return result
}

export async function enableProviderObject(
  provider: Provider
): Promise<ApplyResult> {
  return enableProvider(provider.id)
}

/**
 * 路由/上游协议变化后：把已启用 Provider 的最新配置重写进应用。
 * 轻量路径，不重跑 detect/markEnabled；异常在此吞掉，保证设置保存本身不失败。
 */
export async function rewriteEnabledProviders(
  apps: AppId[]
): Promise<SettingsRewriteEvent[]> {
  const results: SettingsRewriteEvent[] = []
  for (const app of apps) {
    const adapter = getAdapter(app)
    if (!adapter.implemented) continue
    const provider = listProviders(app).find((p) => p.enabled)
    if (!provider) {
      results.push({ app, ok: true, message: '无启用 Provider，跳过重写' })
      continue
    }
    try {
      const r = await adapter.writeLive(provider)
      results.push({ app, ok: r.ok, message: r.message })
    } catch (err) {
      results.push({
        app,
        ok: false,
        message: err instanceof Error ? err.message : String(err)
      })
    }
  }
  return results
}

/** 启用某个模型：将当前应用的 Provider 配置 + 该模型写入应用配置文件。 */
export async function enableModel(app: AppId, modelId: string): Promise<ApplyResult> {
  const model = getModel(modelId)
  if (!model) {
    return { ok: false, message: '模型不存在' }
  }
  if (model.app !== app) {
    return { ok: false, message: '模型不属于当前应用' }
  }
  // 与 launch 一致优先取已启用 Provider；未启用过时回退第一个
  const providers = listProviders(app)
  const provider = providers.find((item) => item.enabled) ?? providers[0]
  if (!provider) {
    return { ok: false, message: '请先配置 Provider 再启用模型' }
  }
  const adapter = getAdapter(app)
  if (!adapter.implemented) {
    return {
      ok: false,
      message: `${adapter.name} 适配器尚未实现，敬请期待`
    }
  }
  const detect = await adapter.detect()
  if (!detect.installed) {
    return {
      ok: false,
      message: `未检测到 ${adapter.name}，请先安装后再启用`
    }
  }
  // 以 Provider 为基础，覆写为当前模型的配置
  const providerForWrite: Provider = {
    ...provider,
    model: model.modelId,
    supportsToolCall: model.config?.supportsToolCall ?? model.supportsFunctionCalling ?? true,
    supportsImages: model.config?.supportsImages ?? model.supportsVision ?? false,
    supportsReasoning: model.config?.supportsReasoning ?? false
  }
  // activeModel：显式把该模型设为 Codex 当前激活模型（同时加入 catalog）
  const result = await adapter.writeLive(providerForWrite, { activeModel: model.modelId })
  if (!result.ok) return result
  markModelEnabled(modelId, app)
  return result
}

/** 停用某个模型：从应用配置中移除（支持多模型的应用），并更新本机标记。 */
export async function disableModel(modelId: string): Promise<ApplyResult> {
  const model = getModel(modelId)
  if (!model) {
    return { ok: false, message: '模型不存在' }
  }

  const adapter = getAdapter(model.app)
  if (adapter.implemented && adapter.removeModel) {
    const detect = await adapter.detect()
    if (detect.installed) {
      const result = await adapter.removeModel(model.modelId)
      if (!result.ok) return result
      markModelDisabled(modelId)
      return result
    }
  }

  markModelDisabled(modelId)
  return { ok: true, message: '模型已停用' }
}

/** 将内置 MCP 配置合并进当前应用，或从应用中移除。 */
export async function applyMcpToApp(
  app: AppId,
  serviceId: string,
  enabled: boolean
): Promise<ApplyResult> {
  const adapter = getAdapter(app)
  if (!adapter.implemented || !adapter.writeMcp) {
    return {
      ok: false,
      message: `${adapter.name} 尚不支持写入 MCP 配置`
    }
  }
  const detect = await adapter.detect()
  if (!detect.installed) {
    return {
      ok: false,
      message: `未检测到 ${adapter.name}，请先安装后再启用 MCP`
    }
  }
  const info = getMcpConnectionInfo(serviceId)
  const entry = info.json
  const result = enabled
    ? await adapter.writeMcp({ [info.key]: entry }, [])
    : await adapter.writeMcp({}, [info.key])
  if (!result.ok) return result
  markMcpServiceEnabled(serviceId, app, enabled)
  return result
}

/**
 * 检查目标应用中的 MCP 配置；仅在缺失或内容不一致时重新写入。
 */
export async function ensureMcpToApp(
  app: AppId,
  serviceId: string
): Promise<ApplyResult> {
  const adapter = getAdapter(app)
  if (!adapter.implemented || !adapter.writeMcp) {
    return {
      ok: false,
      message: `${adapter.name} 尚不支持写入 MCP 配置`
    }
  }
  if (adapter.readMcp) {
    const info = getMcpConnectionInfo(serviceId)
    const existing = await adapter.readMcp()
    if (
      info.key in existing &&
      matchesExpectedMcpEntry(existing[info.key], info.json as Record<string, unknown>)
    ) {
      markMcpServiceEnabled(serviceId, app, true)
      return {
        ok: true,
        message: `${adapter.name} 已存在 ${info.key} MCP 配置`
      }
    }
  }

  return applyMcpToApp(app, serviceId, true)
}
