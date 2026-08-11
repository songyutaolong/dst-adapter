import type { AppId, ApplyResult, Provider } from '../shared/types'
import { getAdapter } from './adapters'
import { getProvider, markEnabled } from './store'

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
