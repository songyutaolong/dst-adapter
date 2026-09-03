import type { AppId, ApplyResult, Provider } from '../shared/types'
import { getAdapter } from './adapters'
import { getProvider, getModel, markEnabled, enableModel as markModelEnabled, listProviders } from './store'

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

/** 启用某个模型：将当前应用的 Provider 配置 + 该模型写入应用配置文件。 */
export async function enableModel(app: AppId, modelId: string): Promise<ApplyResult> {
  const model = getModel(modelId)
  if (!model) {
    return { ok: false, message: '模型不存在' }
  }
  if (model.app !== app) {
    return { ok: false, message: '模型不属于当前应用' }
  }
  const provider = listProviders(app)[0]
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
  const result = await adapter.writeLive(providerForWrite)
  if (!result.ok) return result
  markModelEnabled(modelId, app)
  return result
}
