import type { AppId, Provider } from './types'

/** Normalize user endpoint into OpenAI-compatible chat completions URL for WorkBuddy. */
export function toChatCompletionsUrl(endpoint: string): string {
  const trimmed = endpoint.trim().replace(/\/+$/, '')
  if (!trimmed) return ''
  if (/\/chat\/completions$/i.test(trimmed)) return trimmed
  if (/\/v1$/i.test(trimmed)) return `${trimmed}/chat/completions`
  return `${trimmed}/v1/chat/completions`
}

/** Homepage / console URL for in-app split browser. */
export function toHomepageUrl(endpoint: string): string {
  const trimmed = endpoint.trim().replace(/\/+$/, '')
  if (!trimmed) return 'http://ai.i-shadowclub.com'
  return trimmed
    .replace(/\/chat\/completions$/i, '')
    .replace(/\/v1$/i, '')
    .replace(/\/+$/, '')
}

/** Base URL for /v1/models speed test. */
export function toOpenAiRoot(endpoint: string): string {
  const trimmed = endpoint.trim().replace(/\/+$/, '')
  if (!trimmed) return ''
  if (/\/chat\/completions$/i.test(trimmed)) {
    return trimmed.replace(/\/chat\/completions$/i, '')
  }
  if (/\/v1$/i.test(trimmed)) return trimmed
  return `${trimmed}/v1`
}

export function ensureSkPrefix(apiKey: string): string {
  const key = apiKey.trim()
  if (!key) return key
  return key.startsWith('sk-') ? key : `sk-${key}`
}

export function providerToWorkBuddyModel(provider: Provider) {
  return {
    id: provider.model || provider.name,
    name: provider.model || provider.name,
    vendor: provider.vendor || 'dst',
    url: toChatCompletionsUrl(provider.endpoint),
    apiKey: ensureSkPrefix(provider.apiKey),
    supportsToolCall: provider.supportsToolCall ?? true,
    supportsImages: provider.supportsImages ?? false,
    supportsReasoning: provider.supportsReasoning ?? false,
    useCustomProtocol: false
  }
}

export function parseDeepLink(url: string): Partial<Provider> | null {
  try {
    const u = new URL(url)
    if (u.protocol !== 'dstadapter:') return null
    if (!u.pathname.includes('import') && !u.host.includes('import')) {
      // dstadapter://v1/import?... → host=v1 pathname=/import
    }
    const params = u.searchParams
    if (params.get('resource') && params.get('resource') !== 'provider') {
      return null
    }
    const app = (params.get('app') || 'workbuddy') as AppId
    return {
      name: params.get('name') || 'Imported Provider',
      app,
      endpoint: params.get('endpoint') || '',
      apiKey: params.get('apiKey') || '',
      model: params.get('model') || '',
      vendor: params.get('vendor') || 'dst',
      enabled: params.get('enabled') === 'true'
    }
  } catch {
    return null
  }
}
