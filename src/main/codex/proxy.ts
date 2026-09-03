import http from 'http'
import type { AddressInfo } from 'net'
import { randomUUID } from 'crypto'
import type { Provider } from '../../shared/types'
import {
  toChatCompletionsUrl,
  toOpenAiRoot
} from '../../shared/url'

let server: http.Server | null = null
let activeProvider: Provider | null = null
let activePort = 0

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

async function readJson(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk))
  return JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}')
}

function mapContentParts(content: any): unknown {
  if (!Array.isArray(content)) return content ?? ''
  return content.map((part: any) => {
    if (part?.type === 'input_text' || part?.type === 'output_text') {
      return { type: 'text', text: part.text || '' }
    }
    if (part?.type === 'input_image') {
      return {
        type: 'image_url',
        image_url: { url: part.image_url || part.url || '' }
      }
    }
    return part
  })
}

function inputToMessages(input: any): Array<Record<string, unknown>> {
  if (typeof input === 'string') return [{ role: 'user', content: input }]
  if (!Array.isArray(input)) return []

  const knownCallIds = new Set<string>()
  for (const item of input) {
    if (item?.type !== 'function_call') continue
    const callId = String(item.call_id || item.id || '').trim()
    if (callId) knownCallIds.add(callId)
  }

  const messages: Array<Record<string, unknown>> = []
  let pendingToolCalls: Array<Record<string, unknown>> = []

  const flushToolCalls = () => {
    if (!pendingToolCalls.length) return
    messages.push({
      role: 'assistant',
      content: null,
      tool_calls: pendingToolCalls
    })
    pendingToolCalls = []
  }

  for (const item of input) {
    if (!item || typeof item !== 'object') continue

    if (item.type === 'function_call') {
      const callId = String(item.call_id || item.id || '').trim()
      const name = String(item.name || '').trim()
      if (!callId || !name) continue
      pendingToolCalls.push({
        id: callId,
        type: 'function',
        function: {
          name,
          arguments:
            typeof item.arguments === 'string'
              ? item.arguments
              : JSON.stringify(item.arguments ?? {})
        }
      })
      continue
    }

    // Flush before non-function_call items so tool_calls stay contiguous.
    flushToolCalls()

    if (item.type === 'function_call_output') {
      const callId = String(item.call_id || '').trim()
      if (!callId) continue
      if (!knownCallIds.has(callId)) {
        console.warn(
          `[codex-proxy] drop function_call_output without matching tool_call: ${callId}`
        )
        continue
      }
      messages.push({
        role: 'tool',
        tool_call_id: callId,
        content:
          typeof item.output === 'string'
            ? item.output
            : JSON.stringify(item.output ?? '')
      })
      continue
    }

    // Skip Responses-only items that Chat Completions cannot represent.
    if (
      item.type === 'reasoning' ||
      item.type === 'web_search_call' ||
      item.type === 'file_search_call' ||
      item.type === 'computer_call' ||
      item.type === 'computer_call_output' ||
      item.type === 'local_shell_call' ||
      item.type === 'local_shell_call_output' ||
      item.type === 'custom_tool_call' ||
      item.type === 'custom_tool_call_output' ||
      item.type === 'code_interpreter_call' ||
      item.type === 'image_generation_call'
    ) {
      continue
    }

    if (item.type === 'message' || item.role) {
      const role = item.role || 'user'
      messages.push({
        role,
        content: mapContentParts(item.content)
      })
    }
  }

  flushToolCalls()
  return messages
}

function normalizeTools(tools: any[]): Array<Record<string, unknown>> {
  const normalized: Array<Record<string, unknown>> = []
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') continue

    // Responses API: { type:'function', name, description, parameters }
    // Chat Completions: { type:'function', function:{ name, ... } }
    const isFunction =
      tool.type === 'function' ||
      tool.type === 'custom' ||
      Boolean(tool.function) ||
      typeof tool.name === 'string'

    if (!isFunction) {
      // Skip built-ins (local_shell / web_search / computer_use / ...) —
      // Chat Completions upstreams usually reject them.
      continue
    }

    const fn = tool.function && typeof tool.function === 'object'
      ? tool.function
      : tool
    const name = String(fn.name || tool.name || '').trim()
    if (!name) continue

    normalized.push({
      type: 'function',
      function: {
        name,
        description: fn.description || tool.description || '',
        parameters:
          fn.parameters ||
          tool.parameters ||
          fn.input_schema ||
          tool.input_schema ||
          { type: 'object', properties: {} }
      }
    })
  }
  return normalized
}

function toChatRequest(body: any): Record<string, unknown> {
  const request: Record<string, unknown> = {
    model: body.model,
    messages: inputToMessages(body.input),
    stream: false
  }
  if (body.instructions) {
    request.messages = [
      { role: 'system', content: body.instructions },
      ...(request.messages as any[])
    ]
  }
  if (Array.isArray(body.tools)) {
    const tools = normalizeTools(body.tools)
    if (tools.length) {
      request.tools = tools
      request.tool_choice = body.tool_choice || 'auto'
    }
  }
  if (body.temperature !== undefined) request.temperature = body.temperature
  if (body.max_output_tokens !== undefined) {
    request.max_tokens = body.max_output_tokens
  }
  return request
}

function toResponsesBody(chat: any, requestBody: any): any {
  const choice = chat?.choices?.[0] || {}
  const message = choice.message || {}
  const output: any[] = []
  const messageId = `msg_${randomUUID()}`

  if (message.content) {
    output.push({
      id: messageId,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{
        type: 'output_text',
        text: typeof message.content === 'string'
          ? message.content
          : JSON.stringify(message.content),
        annotations: []
      }]
    })
  }
  for (const call of message.tool_calls || []) {
    // Chat Completions uses one id; Responses needs call_id for round-trip.
    // Keep call_id === tool_calls[].id so later function_call_output can match.
    const callId = String(call.id || `call_${randomUUID()}`)
    output.push({
      id: `fc_${randomUUID()}`,
      type: 'function_call',
      status: 'completed',
      call_id: callId,
      name: call.function?.name || '',
      arguments: call.function?.arguments || '{}'
    })
  }

  return {
    id: `resp_${randomUUID()}`,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    model: chat?.model || requestBody.model,
    output,
    usage: {
      input_tokens: chat?.usage?.prompt_tokens || 0,
      output_tokens: chat?.usage?.completion_tokens || 0,
      total_tokens: chat?.usage?.total_tokens || 0
    }
  }
}

function writeSse(res: http.ServerResponse, response: any): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive'
  })
  let sequence = 0
  const emit = (type: string, data: any) => {
    res.write(`event: ${type}\n`)
    res.write(`data: ${JSON.stringify({ type, sequence_number: sequence++, ...data })}\n\n`)
  }
  emit('response.created', { response: { ...response, status: 'in_progress', output: [] } })
  for (let index = 0; index < response.output.length; index++) {
    const item = response.output[index]
    emit('response.output_item.added', { output_index: index, item })
    if (item.type === 'message') {
      const text = item.content?.[0]?.text || ''
      emit('response.content_part.added', {
        item_id: item.id,
        output_index: index,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] }
      })
      emit('response.output_text.delta', {
        item_id: item.id,
        output_index: index,
        content_index: 0,
        delta: text
      })
      emit('response.output_text.done', {
        item_id: item.id,
        output_index: index,
        content_index: 0,
        text
      })
      emit('response.content_part.done', {
        item_id: item.id,
        output_index: index,
        content_index: 0,
        part: item.content[0]
      })
    } else if (item.type === 'function_call') {
      emit('response.function_call_arguments.delta', {
        item_id: item.id,
        output_index: index,
        delta: item.arguments
      })
      emit('response.function_call_arguments.done', {
        item_id: item.id,
        output_index: index,
        arguments: item.arguments
      })
    }
    emit('response.output_item.done', { output_index: index, item })
  }
  emit('response.completed', { response })
  res.end()
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
  if (!activeProvider) return json(res, 503, { error: 'No active provider' })
  if (req.method === 'GET' && req.url?.endsWith('/models')) {
    const upstream = await fetch(`${toOpenAiRoot(activeProvider.endpoint)}/models`, {
      headers: { Authorization: `Bearer ${activeProvider.apiKey.trim()}` }
    })
    res.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') || 'application/json'
    })
    res.end(Buffer.from(await upstream.arrayBuffer()))
    return
  }
  if (req.method !== 'POST' || !req.url?.endsWith('/responses')) {
    return json(res, 404, { error: 'Not found' })
  }

  try {
    const body = await readJson(req)
    const upstream = await fetch(toChatCompletionsUrl(activeProvider.endpoint), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${activeProvider.apiKey.trim()}`
      },
      body: JSON.stringify(toChatRequest(body))
    })
    if (!upstream.ok) {
      const error = await upstream.text()
      return json(res, upstream.status, { error })
    }
    const chat = await upstream.json()
    const response = toResponsesBody(chat, body)
    if (body.stream) writeSse(res, response)
    else json(res, 200, response)
  } catch (error) {
    json(res, 500, {
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

export async function startCodexProxy(provider: Provider): Promise<number> {
  activeProvider = provider
  if (server && activePort) return activePort
  server = http.createServer((req, res) => {
    void handle(req, res)
  })
  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject)
    server!.listen(0, '127.0.0.1', () => resolve())
  })
  activePort = (server.address() as AddressInfo).port
  return activePort
}

export async function stopCodexProxy(): Promise<void> {
  if (!server) return
  await new Promise<void>((resolve) => server!.close(() => resolve()))
  server = null
  activeProvider = null
  activePort = 0
}
