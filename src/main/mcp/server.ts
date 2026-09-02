import http from 'http'
import type { AddressInfo } from 'net'
import type { McpService } from '../../shared/types'
import {
  BUILTIN_MCP_IMAGE_DEFAULTS,
  BUILTIN_MCP_VIDEO_DEFAULTS,
  MCP_DEFAULT_PORT
} from '../../shared/types'

/**
 * Streamable HTTP MCP Server（单端点）
 *
 * - 传输协议：MCP Streamable HTTP（2025-06-18 草案）
 *   - GET  /            → SSE 流（客户端建立流，接收服务端消息/通知）
 *   - POST /            → JSON-RPC 2.0 调用（initialize / tools/list / tools/call / ping）
 * - 工具：
 *   - image_generation 文生图（模型 ID 由请求参数 model 决定）
 *   - image_editing    图生图/编辑（输入图片 Base64 + 编辑指令）
 *   - video_generation 文生视频（提交任务，返回 task_id；支持 doubao-seedance-2.0）
 *   - video_from_image 图生视频（提交任务，返回 task_id）
 *   - video_task_query 查询视频生成任务状态（单次查询，不轮询；轮询节奏由调用方控制）
 */

export const MCP_PROTOCOL_VERSION = '2025-06-18'

/** 服务端兼容的 MCP 协议版本（全部已发布版本）；initialize 时回客户端请求的版本，避免版本不匹配。 */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18'] as const

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: string | number | null
  method: string
  params?: Record<string, unknown>
}

export interface JsonRpcError {
  code: number
  message: string
  data?: unknown
}

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: string | number | null
  result?: unknown
  error?: JsonRpcError
}

export interface McpServerHandle {
  server: http.Server
  port: number
}

function jsonOrThrow(raw: string): unknown {
  return JSON.parse(raw)
}

function pickModel(service: McpService, params?: Record<string, unknown>): string {
  const requested = params && typeof params.model === 'string' ? params.model.trim() : ''
  const supported = BUILTIN_MCP_IMAGE_DEFAULTS.models
  // 用户传了模型且在内置支持列表内 → 用该模型；否则回退内置默认
  return supported.includes(requested) ? requested : service.modelId || BUILTIN_MCP_IMAGE_DEFAULTS.models[0]
}

/** 判断是否为 Gemini 原生 API 模型 */
function isGeminiModel(model: string): boolean {
  return model === 'gemini-3-pro-image'
}

/** 调用 Gemini 原生 API 生成图片 */
async function generateImageGemini(
  service: McpService,
  model: string,
  prompt: string
): Promise<unknown> {
  const endpoint = `${service.baseUrl.replace(/\/+$/, '')}/v1beta/models/${model}:generateContent`
  const body = {
    contents: [
      {
        parts: [
          {
            text: prompt
          }
        ]
      }
    ],
    generationConfig: {
      responseModalities: ['IMAGE', 'TEXT']
    }
  }

  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${service.apiKey.trim()}`
    },
    body: JSON.stringify(body)
  })
  const text = await resp.text()
  if (!resp.ok) {
    throw { code: resp.status, message: `上游返回 ${resp.status}: ${text.slice(0, 500)}` } as JsonRpcError
  }

  // 转换 Gemini 响应为 OpenAI 兼容格式
  const geminiResp = text ? jsonOrThrow(text) as any : null
  if (!geminiResp) return null

  const candidates = geminiResp.candidates || []
  const data: any[] = []

  for (const candidate of candidates) {
    const parts = candidate.content?.parts || []
    for (const part of parts) {
      // Gemini 响应使用驼峰命名：inlineData / mimeType
      if (part.inlineData?.data) {
        data.push({
          b64_json: part.inlineData.data,
          mime_type: part.inlineData.mimeType || 'image/png'
        })
      }
    }
  }

  return { data }
}

/** 调用上游图片生成 API（{baseUrl}/v1/images/generations）。 */
async function generateImage(
  service: McpService,
  params?: Record<string, unknown>
): Promise<unknown> {
  if (!service.apiKey.trim()) {
    throw { code: -32603, message: '未配置 API Key，请在设置中填写后再请求' } as JsonRpcError
  }
  const prompt = typeof params?.prompt === 'string' ? params.prompt.trim() : ''
  if (!prompt) {
    throw { code: -32602, message: '缺少参数 prompt（图片描述）' } as JsonRpcError
  }

  const model = pickModel(service, params)

  // Gemini 模型走原生 API
  if (isGeminiModel(model)) {
    return generateImageGemini(service, model, prompt)
  }

  // 其他模型走 OpenAI 兼容 API
  const body: Record<string, unknown> = {
    model,
    prompt,
    n: typeof params?.n === 'number' ? params.n : 1
  }
  const size = params?.size
  if (typeof size === 'string' && size.trim()) body.size = size.trim()

  const endpoint = `${service.baseUrl.replace(/\/+$/, '')}/v1/images/generations`
  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${service.apiKey.trim()}`
    },
    body: JSON.stringify(body)
  })
  const text = await resp.text()
  if (!resp.ok) {
    throw { code: resp.status, message: `上游返回 ${resp.status}: ${text.slice(0, 500)}` } as JsonRpcError
  }
  return text ? jsonOrThrow(text) : null
}

interface DecodedImage {
  buffer: ArrayBuffer
  mime: string
  filename: string
}

/** 解析客户端传入的图片参数：支持纯 Base64 或 data:image/xxx;base64,... 前缀。 */
function decodeImageParam(image: string): DecodedImage {
  const trimmed = image.trim()
  const dataUri = /^data:([^;,]+);base64,(.+)$/s.exec(trimmed)
  let b64 = trimmed
  let mime = 'image/png'
  if (dataUri) {
    mime = dataUri[1]
    b64 = dataUri[2]
  }
  const buffer = Buffer.from(b64, 'base64')
  if (buffer.length === 0) {
    throw { code: -32602, message: '参数 image 不是有效的 Base64 图片数据' } as JsonRpcError
  }
  if (buffer.length > 50 * 1024 * 1024) {
    throw { code: -32602, message: '图片过大（上限 50MB）' } as JsonRpcError
  }
  const ext = (mime.split('/')[1] || 'png').split(';')[0] || 'png'
  // Buffer 复制进 ArrayBuffer：BlobPart 需要 ArrayBuffer 而非 Buffer<ArrayBufferLike>
  const ab = new ArrayBuffer(buffer.byteLength)
  new Uint8Array(ab).set(buffer)
  return { buffer: ab, mime, filename: `image.${ext}` }
}

/** 调用 Gemini 原生 API 进行图生图/编辑 */
async function editImageGemini(
  service: McpService,
  model: string,
  prompt: string,
  imageBuffer: ArrayBuffer,
  imageMime: string
): Promise<unknown> {
  const endpoint = `${service.baseUrl.replace(/\/+$/, '')}/v1beta/models/${model}:generateContent`
  
  // 将 ArrayBuffer 转为 base64
  const bytes = new Uint8Array(imageBuffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  const b64 = btoa(binary)

  const body = {
    contents: [
      {
        parts: [
          {
            inline_data: {
              mime_type: imageMime,
              data: b64
            }
          },
          {
            text: prompt
          }
        ]
      }
    ],
    generationConfig: {
      responseModalities: ['IMAGE', 'TEXT']
    }
  }

  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${service.apiKey.trim()}`
    },
    body: JSON.stringify(body)
  })
  const text = await resp.text()
  if (!resp.ok) {
    throw { code: resp.status, message: `上游返回 ${resp.status}: ${text.slice(0, 500)}` } as JsonRpcError
  }

  // 转换 Gemini 响应为 OpenAI 兼容格式
  const geminiResp = text ? jsonOrThrow(text) as any : null
  if (!geminiResp) return null

  const candidates = geminiResp.candidates || []
  const data: any[] = []

  for (const candidate of candidates) {
    const parts = candidate.content?.parts || []
    for (const part of parts) {
      // Gemini 响应使用驼峰命名：inlineData / mimeType
      if (part.inlineData?.data) {
        data.push({
          b64_json: part.inlineData.data,
          mime_type: part.inlineData.mimeType || 'image/png'
        })
      }
    }
  }

  return { data }
}

/** 调用上游图生图/编辑 API（{baseUrl}/v1/images/edits，multipart/form-data）。 */
async function editImage(
  service: McpService,
  params?: Record<string, unknown>
): Promise<unknown> {
  if (!service.apiKey.trim()) {
    throw { code: -32603, message: '未配置 API Key，请在设置中填写后再请求' } as JsonRpcError
  }
  const prompt = typeof params?.prompt === 'string' ? params.prompt.trim() : ''
  if (!prompt) {
    throw { code: -32602, message: '缺少参数 prompt（编辑指令）' } as JsonRpcError
  }
  const imageParam = typeof params?.image === 'string' ? params.image : ''
  if (!imageParam) {
    throw { code: -32602, message: '缺少参数 image（输入图片 Base64）' } as JsonRpcError
  }
  const { buffer, mime, filename } = decodeImageParam(imageParam)

  const model = pickModel(service, params)

  // Gemini 模型走原生 API
  if (isGeminiModel(model)) {
    return editImageGemini(service, model, prompt, buffer, mime)
  }

  // 其他模型走 OpenAI 兼容 API
  const fd = new FormData()
  fd.append('model', model)
  fd.append('prompt', prompt)
  fd.append('image', new Blob([buffer], { type: mime }), filename)
  const size = params?.size
  if (typeof size === 'string' && size.trim()) fd.append('size', size.trim())
  const n = params?.n
  if (typeof n === 'number') fd.append('n', String(n))

  const endpoint = `${service.baseUrl.replace(/\/+$/, '')}/v1/images/edits`
  const resp = await fetch(endpoint, {
    method: 'POST',
    // fetch 会根据 FormData 自动生成 multipart boundary 与 content-type
    headers: { authorization: `Bearer ${service.apiKey.trim()}` },
    body: fd
  })
  const text = await resp.text()
  if (!resp.ok) {
    throw { code: resp.status, message: `上游返回 ${resp.status}: ${text.slice(0, 500)}` } as JsonRpcError
  }
  return text ? jsonOrThrow(text) : null
}

/** 为视频生成服务选择模型 */
function pickVideoModel(service: McpService, params?: Record<string, unknown>): string {
  const requested = params && typeof params.model === 'string' ? params.model.trim() : ''
  const supported = BUILTIN_MCP_VIDEO_DEFAULTS.models
  return supported.includes(requested) ? requested : service.modelId || BUILTIN_MCP_VIDEO_DEFAULTS.models[0]
}

/** 查询视频生成任务状态（单次查询，不轮询；由调用方控制轮询节奏） */
async function queryVideoTask(service: McpService, taskId: string): Promise<unknown> {
  const endpoint = `${service.baseUrl.replace(/\/+$/, '')}/v1/video/generations/${taskId}`

  const resp = await fetch(endpoint, {
    method: 'GET',
    headers: {
      authorization: `Bearer ${service.apiKey.trim()}`
    }
  })
  const text = await resp.text()
  if (!resp.ok) {
    throw { code: resp.status, message: `查询失败 ${resp.status}: ${text.slice(0, 500)}` } as JsonRpcError
  }

  const result = text ? (jsonOrThrow(text) as any) : null
  if (!result) {
    throw { code: -32603, message: '查询返回为空' } as JsonRpcError
  }

  // 解析任务状态 - 支持多种字段名和嵌套结构
  const data = result.data || result
  const rawStatus = data.status || data.state || data.task_status || data.taskStatus || data.task_state
  // 无状态字段但直接携带视频 URL（同步返回风格）视为已完成
  const status = rawStatus || (data.video_url || data.url || data.output_url ? 'completed' : undefined)

  return {
    task_id: taskId,
    status,
    ...data
  }
}

/** 调用上游视频生成 API（文生视频，异步任务模式） */
async function generateVideo(
  service: McpService,
  params?: Record<string, unknown>
): Promise<unknown> {
  if (!service.apiKey.trim()) {
    throw { code: -32603, message: '未配置 API Key，请在设置中填写后再请求' } as JsonRpcError
  }
  const prompt = typeof params?.prompt === 'string' ? params.prompt.trim() : ''
  if (!prompt) {
    throw { code: -32602, message: '缺少参数 prompt（视频描述）' } as JsonRpcError
  }

  const model = pickVideoModel(service, params)
  const body: Record<string, unknown> = {
    model,
    prompt
  }

  // 可选参数：resolution
  const resolution = params?.resolution
  if (typeof resolution === 'string' && resolution.trim()) {
    body.resolution = resolution.trim()
  }

  // 可选参数：duration（合法性校验：4-15 整数或 -1）
  const duration = params?.duration
  if (typeof duration === 'number') {
    const durInt = Math.floor(duration)
    if (durInt !== -1 && (durInt < 4 || durInt > 15)) {
      throw { code: -32602, message: 'duration 必须为 4-15 的整数，或 -1（模型自动选择时长）' } as JsonRpcError
    }
    body.duration = durInt
  }

  // 可选参数：ratio
  const ratio = params?.ratio
  if (typeof ratio === 'string' && ratio.trim()) {
    body.ratio = ratio.trim()
  }

  // 可选参数：fps
  const fps = params?.fps
  if (typeof fps === 'number' && (fps === 24 || fps === 60)) {
    body.fps = fps
  }

  // 可选参数：generate_audio（兼容旧参数名 audio）
  const generateAudio = params?.generate_audio ?? params?.audio
  if (typeof generateAudio === 'boolean') {
    body.generate_audio = generateAudio
  }

  // 可选参数：seed
  const seed = params?.seed
  if (typeof seed === 'number' && Number.isInteger(seed)) {
    body.seed = seed
  }

  // 可选参数：watermark
  const watermark = params?.watermark
  if (typeof watermark === 'boolean') {
    body.watermark = watermark
  }

  // 提交任务
  const endpoint = `${service.baseUrl.replace(/\/+$/, '')}/v1/video/generations`
  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${service.apiKey.trim()}`
    },
    body: JSON.stringify(body)
  })
  const text = await resp.text()
  if (!resp.ok) {
    throw { code: resp.status, message: `上游返回 ${resp.status}: ${text.slice(0, 500)}` } as JsonRpcError
  }
  
  const submitResult = text ? jsonOrThrow(text) as any : null
  if (!submitResult) {
    throw { code: -32603, message: '上游返回为空' } as JsonRpcError
  }
  
  // 获取 task_id；有则返回任务 ID 供调用方查询（不做轮询）
  const taskId = submitResult.task_id || submitResult.id || submitResult.taskId
  if (!taskId) {
    // 如果没有 task_id，可能是同步返回，直接返回结果
    return submitResult
  }

  return {
    ...submitResult,
    task_id: taskId,
    status: submitResult.status || submitResult.state || 'submitted'
  }
}

/** 调用上游视频生成 API（图生视频，异步任务模式，支持参考图/首尾帧两种模式） */
async function generateVideoFromImage(
  service: McpService,
  params?: Record<string, unknown>
): Promise<unknown> {
  if (!service.apiKey.trim()) {
    throw { code: -32603, message: '未配置 API Key，请在设置中填写后再请求' } as JsonRpcError
  }
  const prompt = typeof params?.prompt === 'string' ? params.prompt.trim() : ''
  if (!prompt) {
    throw { code: -32602, message: '缺少参数 prompt（视频描述）' } as JsonRpcError
  }

  // 统一 content 处理（参考图和首尾帧都用 content）
  const content = params?.content
  if (!Array.isArray(content) || content.length === 0) {
    throw { code: -32602, message: '缺少参数 content（图片内容数组），必须提供至少一项' } as JsonRpcError
  }

  // 按 role 分组
  const refs = content.filter(c => (c as Record<string, unknown>).role === 'reference_image')
  const firsts = content.filter(c => (c as Record<string, unknown>).role === 'first_frame')
  const lasts = content.filter(c => (c as Record<string, unknown>).role === 'last_frame')

  const hasRefs = refs.length > 0
  const hasFirstLast = firsts.length > 0 || lasts.length > 0

  // 互斥校验：reference_image 与 first_frame/last_frame 不能混用
  if (hasRefs && hasFirstLast) {
    throw { code: -32602, message: 'reference_image（参考图）和 first_frame/last_frame（首尾帧）不能混用，请选择一种模式' } as JsonRpcError
  }
  if (!hasRefs && !hasFirstLast) {
    throw { code: -32602, message: 'content 中必须包含至少一张图片（role 为 reference_image、first_frame 或 last_frame）' } as JsonRpcError
  }

  // 首尾帧模式校验：必须恰好 1 个 first_frame + 1 个 last_frame
  if (hasFirstLast) {
    if (firsts.length !== 1 || lasts.length !== 1) {
      throw { code: -32602, message: `首尾帧模式必须恰好 1 个 first_frame 和 1 个 last_frame，当前 first_frame=${firsts.length}, last_frame=${lasts.length}` } as JsonRpcError
    }
  }

  // 校验每项格式
  for (const item of content as Array<Record<string, unknown>>) {
    const type = item.type
    if (type === 'text') {
      if (typeof item.text !== 'string') {
        throw { code: -32602, message: 'content 中 type=text 的项必须包含 text 字段' } as JsonRpcError
      }
    } else if (type === 'image_url') {
      if (!item.image_url || typeof (item.image_url as Record<string, unknown>).url !== 'string') {
        throw { code: -32602, message: 'content 中 type=image_url 的项必须包含 image_url.url 字段' } as JsonRpcError
      }
      if (!item.role) {
        throw { code: -32602, message: 'content 中 type=image_url 的项必须包含 role 字段（reference_image/first_frame/last_frame）' } as JsonRpcError
      }
    } else {
      throw { code: -32602, message: `content 项 type 必须为 text 或 image_url，当前为 ${String(type)}` } as JsonRpcError
    }
  }

  const model = pickVideoModel(service, params)
  const body: Record<string, unknown> = { model, prompt, content }

  // 可选参数：resolution
  const resolution = params?.resolution
  if (typeof resolution === 'string' && resolution.trim()) {
    body.resolution = resolution.trim()
  }

  // 可选参数：duration（合法性校验：4-15 整数或 -1）
  const duration = params?.duration
  if (typeof duration === 'number') {
    const durInt = Math.floor(duration)
    if (durInt !== -1 && (durInt < 4 || durInt > 15)) {
      throw { code: -32602, message: 'duration 必须为 4-15 的整数，或 -1（模型自动选择时长）' } as JsonRpcError
    }
    body.duration = durInt
  }

  // 可选参数：ratio
  const ratio = params?.ratio
  if (typeof ratio === 'string' && ratio.trim()) {
    body.ratio = ratio.trim()
  }

  // 可选参数：fps
  const fps = params?.fps
  if (typeof fps === 'number' && (fps === 24 || fps === 60)) {
    body.fps = fps
  }

  // 可选参数：generate_audio（兼容旧参数名 audio）
  const generateAudio = params?.generate_audio ?? params?.audio
  if (typeof generateAudio === 'boolean') {
    body.generate_audio = generateAudio
  }

  // 可选参数：seed
  const seed = params?.seed
  if (typeof seed === 'number' && Number.isInteger(seed)) {
    body.seed = seed
  }

  // 可选参数：watermark
  const watermark = params?.watermark
  if (typeof watermark === 'boolean') {
    body.watermark = watermark
  }

  // 可选参数：reference_video
  const referenceVideo = params?.reference_video
  if (typeof referenceVideo === 'string' && referenceVideo.trim()) {
    body.reference_video = referenceVideo.trim() // Base64 编码的参考视频
  }

  // 提交任务
  const endpoint = `${service.baseUrl.replace(/\/+$/, '')}/v1/video/generations`
  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${service.apiKey.trim()}`
    },
    body: JSON.stringify(body)
  })
  const text = await resp.text()
  if (!resp.ok) {
    throw { code: resp.status, message: `上游返回 ${resp.status}: ${text.slice(0, 500)}` } as JsonRpcError
  }
  
  const submitResult = text ? jsonOrThrow(text) as any : null
  if (!submitResult) {
    throw { code: -32603, message: '上游返回为空' } as JsonRpcError
  }
  
  // 获取 task_id；有则返回任务 ID 供调用方查询（不做轮询）
  const taskId = submitResult.task_id || submitResult.id || submitResult.taskId
  if (!taskId) {
    // 如果没有 task_id，可能是同步返回，直接返回结果
    return submitResult
  }

  return {
    ...submitResult,
    task_id: taskId,
    status: submitResult.status || submitResult.state || 'submitted'
  }
}

/** tools/list 声明。 */
function listTools(serviceType: string): unknown[] {
  if (serviceType === 'image-generation') {
    return [
      {
        name: 'image_generation',
        description: '生成图片（支持 Gemini 3 Pro Image / GPT Image 2），模型由参数 model 指定',
        inputSchema: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: '图片描述（必填）' },
            model: {
              type: 'string',
              enum: BUILTIN_MCP_IMAGE_DEFAULTS.models,
              description: '模型 ID，缺省使用默认模型'
            },
            n: { type: 'integer', description: '生成数量，默认 1' },
            size: { type: 'string', description: '图片尺寸，如 1024x1024' }
          },
          required: ['prompt']
        }
      },
      {
        name: 'image_editing',
        description: '图生图（基于输入图片重绘/编辑，支持 Gemini 3 Pro Image / GPT Image 2），模型由参数 model 指定',
        inputSchema: {
          type: 'object',
          properties: {
            image: {
              type: 'string',
              description: '输入图片（必填）：Base64 编码，可带 data:image/png;base64, 前缀，上限 50MB'
            },
            prompt: { type: 'string', description: '编辑指令/重绘描述（必填）' },
            model: {
              type: 'string',
              enum: BUILTIN_MCP_IMAGE_DEFAULTS.models,
              description: '模型 ID，缺省使用默认模型'
            },
            n: { type: 'integer', description: '生成数量，默认 1' },
            size: { type: 'string', description: '图片尺寸，如 1024x1024' }
          },
          required: ['image', 'prompt']
        }
      }
    ]
  } else if (serviceType === 'video-generation') {
    return [
      {
        name: 'video_generation',
        description: '文生视频（根据描述生成视频，支持 doubao-seedance-2.0），模型由参数 model 指定',
        inputSchema: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: '视频描述（必填）' },
            model: {
              type: 'string',
              enum: BUILTIN_MCP_VIDEO_DEFAULTS.models,
              description: '模型 ID，缺省使用默认模型'
            },
            resolution: {
              type: 'string',
              enum: BUILTIN_MCP_VIDEO_DEFAULTS.resolutions,
              description: '视频分辨率：480p、720p、1080p、4K'
            },
            duration: {
              type: 'integer',
              description: '视频时长（秒）：4-15 的整数，或 -1（模型自动选择）'
            },
            ratio: {
              type: 'string',
              enum: BUILTIN_MCP_VIDEO_DEFAULTS.ratios,
              description: '宽高比：21:9、16:9、4:3、1:1、3:4、9:16、adaptive'
            },
            fps: {
              type: 'integer',
              enum: BUILTIN_MCP_VIDEO_DEFAULTS.fps,
              description: '帧率：24 或 60'
            },
            generate_audio: {
              type: 'boolean',
              description: '是否生成音频，默认 false（兼容旧参数名 audio）'
            },
            seed: {
              type: 'integer',
              description: '随机种子，整数'
            },
            watermark: {
              type: 'boolean',
              description: '是否添加水印，默认 false'
            }
          },
          required: ['prompt']
        }
      },
      {
        name: 'video_from_image',
        description: '图生视频（基于输入图片生成视频，支持 doubao-seedance-2.0），模型由参数 model 指定',
        inputSchema: {
          type: 'object',
          properties: {
            content: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  type: { type: 'string', enum: ['text', 'image_url'], description: '内容类型：text（提示文本）或 image_url（图片）' },
                  text: { type: 'string', description: '文本内容（type=text 时必填）' },
                  image_url: {
                    type: 'object',
                    properties: {
                      url: { type: 'string', description: '图片 URL（type=image_url 时必填）' }
                    },
                    required: ['url']
                  },
                  role: { type: 'string', enum: ['reference_image', 'first_frame', 'last_frame'], description: '图片角色：reference_image（参考图）/ first_frame（首帧）/ last_frame（尾帧）' }
                },
                required: ['type']
              },
              description: '图片内容数组（必填）：支持参考图模式（role=reference_image，可多张）和首尾帧模式（role=first_frame+last_frame，各一张），两种模式不能混用'
            },
            prompt: { type: 'string', description: '视频描述（必填，与 content 中 text 项互补）' },
            model: {
              type: 'string',
              enum: BUILTIN_MCP_VIDEO_DEFAULTS.models,
              description: '模型 ID，缺省使用默认模型'
            },
            resolution: {
              type: 'string',
              enum: BUILTIN_MCP_VIDEO_DEFAULTS.resolutions,
              description: '视频分辨率：480p、720p、1080p、4K'
            },
            duration: {
              type: 'integer',
              description: '视频时长（秒）：4-15 的整数，或 -1（模型自动选择）'
            },
            ratio: {
              type: 'string',
              enum: BUILTIN_MCP_VIDEO_DEFAULTS.ratios,
              description: '宽高比：21:9、16:9、4:3、1:1、3:4、9:16、adaptive'
            },
            fps: {
              type: 'integer',
              enum: BUILTIN_MCP_VIDEO_DEFAULTS.fps,
              description: '帧率：24 或 60'
            },
            generate_audio: {
              type: 'boolean',
              description: '是否生成音频，默认 false（兼容旧参数名 audio）'
            },
            seed: {
              type: 'integer',
              description: '随机种子，整数'
            },
            watermark: {
              type: 'boolean',
              description: '是否添加水印，默认 false'
            },
            reference_video: {
              type: 'string',
              description: '参考视频（可选）：Base64 编码，用于风格迁移'
            }
          },
          required: ['content', 'prompt']
        }
      },
      {
        name: 'video_task_query',
        description: '查询视频生成任务状态（单次查询，不轮询；轮询节奏由调用方控制）',
        inputSchema: {
          type: 'object',
          properties: {
            task_id: { type: 'string', description: '任务 ID（video_generation / video_from_image 返回）' }
          },
          required: ['task_id']
        }
      }
    ]
  }
  return []
}

async function dispatch(
  service: McpService,
  req: JsonRpcRequest
): Promise<JsonRpcResponse> {
  const id = req.id ?? null
  try {
    let result: unknown = null
    switch (req.method) {
      case 'initialize': {
        // 版本协商：优先回客户端请求的已发布版本，未知版本才回默认版本，
        // 避免支持旧版协议的客户端（如某些 WorkBuddy 版本）判定协议不兼容而断开。
        const p = (req.params || {}) as Record<string, unknown>
        const requested =
          typeof p.protocolVersion === 'string' ? p.protocolVersion : MCP_PROTOCOL_VERSION
        const negotiated = (
          SUPPORTED_PROTOCOL_VERSIONS as readonly string[]
        ).includes(requested)
          ? requested
          : MCP_PROTOCOL_VERSION
        result = {
          protocolVersion: negotiated,
          capabilities: { tools: { listChanged: false } },
          serverInfo: {
            name: service.type === 'video-generation' ? 'dst-video-mcp' : 'dst-image-mcp',
            version: '0.1.0'
          }
        }
        break
      }
      case 'notifications/initialized':
        // 通知：无响应（HTTP 层已对无 id 的请求回 202 空响应；此处兜底）
        return { jsonrpc: '2.0', id }
      case 'tools/list':
        result = { tools: listTools(service.type) }
        break
      case 'tools/call': {
        const p = (req.params || {}) as Record<string, unknown>
        const args = (p.arguments as Record<string, unknown>) || {}
        let output: unknown
        const toolName = String(p.name)

        // 根据服务类型限制可调用的工具
        if (service.type === 'image-generation') {
          if (toolName === 'image_generation') {
            output = await generateImage(service, args)
          } else if (toolName === 'image_editing') {
            output = await editImage(service, args)
          } else {
            throw { code: -32602, message: `未知工具: ${toolName}` } as JsonRpcError
          }
        } else if (service.type === 'video-generation') {
          if (toolName === 'video_generation') {
            output = await generateVideo(service, args)
          } else if (toolName === 'video_from_image') {
            output = await generateVideoFromImage(service, args)
          } else if (toolName === 'video_task_query') {
            const taskId = typeof args.task_id === 'string' ? args.task_id.trim() : ''
            if (!taskId) {
              throw { code: -32602, message: '缺少参数 task_id' } as JsonRpcError
            }
            output = await queryVideoTask(service, taskId)
          } else {
            throw { code: -32602, message: `未知工具: ${toolName}` } as JsonRpcError
          }
        } else {
          throw { code: -32602, message: `不支持的服务类型: ${service.type}` } as JsonRpcError
        }
        result = {
          content: [
            {
              type: 'text',
              text: typeof output === 'string' ? output : JSON.stringify(output, null, 2)
            }
          ],
          isError: false
        }
        break
      }
      case 'ping':
        result = {}
        break
      default:
        throw { code: -32601, message: `方法不存在: ${req.method}` } as JsonRpcError
    }
    return { jsonrpc: '2.0', id, result }
  } catch (err) {
    const e = err as JsonRpcError
    return {
      jsonrpc: '2.0',
      id,
      error: { code: e.code || -32603, message: e.message || String(err) }
    }
  }
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf-8')
}

/** 启动 Streamable HTTP MCP 服务；返回服务器与真实端口。端口默认固定（MCP_DEFAULT_PORT），被占用时报错。 */
export async function startMcpServer(
  service: McpService,
  port: number = MCP_DEFAULT_PORT
): Promise<McpServerHandle> {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')

    // GET / → SSE 流
    if (req.method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive'
      })
      res.write('\n')
      const keepAlive = setInterval(() => res.write('\n'), 15000)
      req.on('close', () => clearInterval(keepAlive))
      return
    }

    // POST / → JSON-RPC
    if (req.method === 'POST') {
      let body: JsonRpcRequest
      try {
        body = JSON.parse(await readBody(req)) as JsonRpcRequest
      } catch {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
        res.end(
          JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON 解析失败' } })
        )
        return
      }

      if (url.pathname !== '/') {
        res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id ?? null, error: { code: -32601, message: 'Not Found' } }))
        return
      }

      // JSON-RPC 2.0 通知（请求无 id 字段，如 notifications/initialized）：
      // 规范要求回 202 Accepted 空响应，不产生 JSON-RPC 响应体，严格客户端会校验这一点。
      if (body.id === undefined) {
        res.writeHead(202)
        res.end()
        return
      }

      const response = await dispatch(service, body)
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(response))
      return
    }

    res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: 'Method Not Allowed' }))
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve())
  })
  const actualPort = (server.address() as AddressInfo).port
  return { server, port: actualPort }
}