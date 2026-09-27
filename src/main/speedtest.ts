import type { GatewayMeResult, SpeedTestResult } from '../shared/types'
import { ensureSkPrefix, toOpenAiRoot } from '../shared/url'

export async function fetchModels(
  endpoint: string,
  apiKey: string
): Promise<{ ok: boolean; models: string[]; error?: string }> {
  const root = toOpenAiRoot(endpoint)
  if (!root) {
    return { ok: false, models: [], error: 'endpoint 为空' }
  }
  if (!apiKey.trim()) {
    return { ok: false, models: [], error: '请先填写 API Key' }
  }
  const url = `${root}/models`
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 20000)
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${ensureSkPrefix(apiKey)}`
      },
      signal: controller.signal
    })
    clearTimeout(timer)
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return {
        ok: false,
        models: [],
        error: text.slice(0, 200) || res.statusText || `HTTP ${res.status}`
      }
    }
    const body = (await res.json()) as {
      data?: Array<{ id?: string }>
    }
    const models = (body.data || [])
      .map((m) => m.id)
      .filter((id): id is string => Boolean(id))
    return { ok: true, models }
  } catch (err) {
    return {
      ok: false,
      models: [],
      error: err instanceof Error ? err.message : String(err)
    }
  }
}

export async function speedTest(
  endpoint: string,
  apiKey: string
): Promise<SpeedTestResult> {
  const started = Date.now()
  const result = await fetchModels(endpoint, apiKey)
  const latencyMs = Date.now() - started
  if (!result.ok) {
    return { ok: false, latencyMs, error: result.error }
  }
  return {
    ok: true,
    latencyMs,
    status: 200,
    modelsSample: result.models.slice(0, 5)
  }
}

/** GET /v1/me：用网关 API Key 换取最小用户/组织身份。 */
export async function fetchMe(
  endpoint: string,
  apiKey: string
): Promise<GatewayMeResult> {
  const root = toOpenAiRoot(endpoint)
  if (!root) {
    return { ok: false, error: 'endpoint 为空' }
  }
  if (!apiKey.trim()) {
    return { ok: false, error: '请先填写 API Key' }
  }
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 20000)
    const res = await fetch(`${root}/me`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${ensureSkPrefix(apiKey)}`
      },
      signal: controller.signal
    })
    clearTimeout(timer)
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      let message = text.slice(0, 200) || res.statusText || `HTTP ${res.status}`
      try {
        const parsed = JSON.parse(text) as { error?: { message?: string } }
        if (parsed?.error?.message) message = parsed.error.message
      } catch {
        /* 非 JSON 错误体，保留原始文本 */
      }
      return { ok: false, status: res.status, error: message }
    }
    const body = (await res.json()) as {
      success?: boolean
      data?: {
        user?: { id?: number; username?: string; display_name?: string }
        organization?: { id?: number; name?: string } | null
      }
    }
    const user = body.data?.user
    if (!body.success || !user?.username) {
      return { ok: false, status: res.status, error: '响应格式不符合预期' }
    }
    return {
      ok: true,
      status: res.status,
      info: {
        user: {
          id: user.id ?? 0,
          username: user.username,
          display_name: user.display_name || user.username
        },
        organization: body.data?.organization
          ? {
              id: body.data.organization.id ?? 0,
              name: body.data.organization.name || ''
            }
          : null
      }
    }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    }
  }
}
