import type { SpeedTestResult } from '../shared/types'
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
