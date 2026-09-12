import http from 'http'
import { createHash, createHmac, randomUUID } from 'crypto'
import { readFile, stat } from 'fs/promises'
import path from 'path'
import type { AddressInfo } from 'net'
import type { McpService } from '../../shared/types'
import { toApiRoot } from '../../shared/url'
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
 *   - image_editing    图生图/编辑（输入图片 Base64 + 编辑指令，支持多参考图：image 可传 string 或多张 string[]）
 *   - video_generation 文生视频（提交任务，返回 task_id；支持 doubao-seedance-2.0）
 *   - video_from_image 图生视频（提交任务，返回 task_id）
 *   - video_task_query 查询视频生成任务状态（单次查询，不轮询；轮询节奏由调用方控制）
 *   - file_upload      文件上传（返回临时公网访问 URL；支持腾讯 COS / 阿里 OSS）
 *   - text_to_model_3d / image_to_model_3d / multiview_to_model_3d
 *   - generation_3d_task_query 查询 3D 生成任务状态
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

type CloudStorageProvider = 'cos' | 'oss'

interface CloudStorageConfig {
  organization_id: number
  provider: CloudStorageProvider
  bucket: string
  region?: string
  endpoint: string
  path_prefix?: string
  custom_domain?: string
  credentials: {
    secret_id?: string
    secret_key?: string
    access_key_id?: string
    access_key_secret?: string
  }
}

interface SignedCosUrlInput {
  method: 'GET' | 'PUT'
  host: string
  key: string
  secretId: string
  secretKey: string
  expires: number
  headers?: Record<string, string>
  params?: Record<string, string>
}

interface SignedOssUrlInput {
  method: 'GET' | 'PUT'
  baseUrl: string
  bucket: string
  key: string
  accessKeyId: string
  accessKeySecret: string
  expires: number
  contentType?: string
}

interface OssTarget {
  protocol: string
  uploadHost: string
  publicHost: string
}

const MAX_FILE_UPLOAD_SIZE = 200 * 1024 * 1024
const MIN_PRESIGNED_EXPIRES = 60
const MAX_PRESIGNED_EXPIRES = 7 * 24 * 60 * 60

/** 三个 3D 提交工具共用的高级参数说明；真正提交时仍使用三个独立 endpoint。 */
const THREE_D_METADATA_SCHEMA = {
  type: 'object',
  description:
    'Tripo 高级参数，可选：negative_prompt、enable_image_autofix、texture_alignment、orientation、model_seed、image_seed、face_limit、texture、pbr、texture_seed、texture_quality、geometry_quality、auto_size、quad、smart_low_poly、generate_parts、compress、export_orientation、export_uv',
  properties: {
    negative_prompt: { type: 'string' },
    enable_image_autofix: { type: 'boolean' },
    texture_alignment: { type: 'string', enum: ['original_image', 'geometry'] },
    orientation: { type: 'string', enum: ['default', 'align_image'] },
    model_seed: { type: 'integer' },
    image_seed: { type: 'integer' },
    face_limit: { type: 'integer', minimum: -1 },
    texture: { type: 'boolean' },
    pbr: { type: 'boolean' },
    texture_seed: { type: 'integer' },
    texture_quality: { type: 'string', enum: ['standard', 'detailed', 'extreme'] },
    geometry_quality: { type: 'string', enum: ['standard', 'detailed'] },
    auto_size: { type: 'boolean' },
    quad: { type: 'boolean' },
    smart_low_poly: { type: 'boolean' },
    generate_parts: { type: 'boolean' },
    compress: { type: 'string' },
    export_orientation: { type: 'string' },
    export_uv: { type: 'boolean' }
  },
  additionalProperties: true
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

/** Gemini 图片模型支持的宽高比白名单（官方 API：generationConfig.imageConfig.aspectRatio）。 */
const GEMINI_ASPECT_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'] as const

/** Gemini 图片模型支持的分辨率档位白名单（官方 API：generationConfig.imageConfig.imageSize，按长边）。 */
const GEMINI_IMAGE_SIZES = ['1K', '2K', '4K'] as const

/** 将 OpenAI 风格尺寸（如 "1024x1024"）映射为 Gemini 宽高比 + 分辨率档位。无法解析/匹配时返回 null。 */
function resolveGeminiAspectAndSize(size: string): { aspectRatio: string; imageSize: string } | null {
  const m = /^(\d+)\s*[xX*]\s*(\d+)$/.exec(size.trim())
  if (!m) return null
  const w = Number(m[1])
  const h = Number(m[2])
  if (w <= 0 || h <= 0) return null

  // 在白名单中找与目标比例最接近的（相对误差 ≤ 5%）
  const target = w / h
  let best: { ratio: string; err: number } | null = null
  for (const ratio of GEMINI_ASPECT_RATIOS) {
    const [a, b] = ratio.split(':').map(Number)
    const err = Math.abs(a / b - target) / target
    if (!best || err < best.err) best = { ratio, err }
  }
  if (!best || best.err > 0.05) return null

  // 长边 → 分辨率档位：1K=1024 / 2K=2048 / 4K=4096（约）
  const longEdge = Math.max(w, h)
  let imageSize: string = '1K'
  if (longEdge >= 3000) imageSize = '4K'
  else if (longEdge >= 1300) imageSize = '2K'

  return { aspectRatio: best.ratio, imageSize }
}

/**
 * 解析 Gemini 图片生成配置（统一走 size 字段，可与 aspectRatio 组合）：
 * - size 支持两种语法：档位 1K/2K/4K（直写 imageSize），或像素 WxH（如 1024x1024，映射宽高比+档位）
 * - aspectRatio 独立提供（如 16:9），可单独使用或与 size 档位组合
 * - 均未提供/非法时返回 undefined（走 Gemini API 默认 1:1 / 1K）
 */
function resolveGeminiImageConfig(params?: Record<string, unknown>): Record<string, string> | undefined {
  const p = params || {}
  let aspectRatio = typeof p.aspectRatio === 'string' ? p.aspectRatio.trim() : ''
  if (aspectRatio && !(GEMINI_ASPECT_RATIOS as readonly string[]).includes(aspectRatio)) aspectRatio = ''

  let imageSize = ''
  const sizeParam = typeof p.size === 'string' ? p.size.trim() : ''
  if (sizeParam && (GEMINI_IMAGE_SIZES as readonly string[]).includes(sizeParam)) {
    // 档位直配：1K / 2K / 4K
    imageSize = sizeParam
  } else if (sizeParam) {
    // 像素格式：映射宽高比 + 档位
    const mapped = resolveGeminiAspectAndSize(sizeParam)
    if (mapped) {
      console.log(`[mcp] Gemini size "${sizeParam}" → aspectRatio=${mapped.aspectRatio}, imageSize=${mapped.imageSize}`)
      if (!aspectRatio) aspectRatio = mapped.aspectRatio
      if (!imageSize) imageSize = mapped.imageSize
    }
  }

  if (!aspectRatio && !imageSize) return undefined
  const config: Record<string, string> = {}
  if (aspectRatio) config.aspectRatio = aspectRatio
  if (imageSize) config.imageSize = imageSize
  return config
}

/** 将 Gemini 档位（1K/2K/4K）转为 OpenAI 像素尺寸（1:1 基准；4K 受官方单边 3840px / 总像素上限约束，取 16:9 满幅）。非档位值原样返回。 */
function normalizeOpenAiSize(size: string): string {
  const s = size.trim()
  if (s === '1K' || s === '1k') return '1024x1024'
  if (s === '2K' || s === '2k') return '2048x2048'
  if (s === '4K' || s === '4k') return '3840x2160'
  return s
}

/** 调用 Gemini 原生 API 生成图片 */
async function generateImageGemini(
  service: McpService,
  model: string,
  prompt: string,
  params?: Record<string, unknown>
): Promise<unknown> {
  const endpoint = `${service.baseUrl.replace(/\/+$/, '')}/v1beta/models/${model}:generateContent`
  const imageConfig = resolveGeminiImageConfig(params)
  const body: Record<string, unknown> = {
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
  if (imageConfig) {
    ;(body.generationConfig as Record<string, unknown>).imageConfig = imageConfig
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
    return generateImageGemini(service, model, prompt, params)
  }

  // 其他模型走 OpenAI 兼容 API
  const body: Record<string, unknown> = {
    model,
    prompt,
    n: typeof params?.n === 'number' ? params.n : 1
  }
  const size = params?.size
  if (typeof size === 'string' && size.trim()) body.size = normalizeOpenAiSize(size)
  // quality：仅白名单取值，缺省/非法值回退 medium
  const quality = params?.quality
  body.quality = typeof quality === 'string' && ['low', 'medium', 'high'].includes(quality) ? quality : 'medium'

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

/** 解析一个或多个输入图片参数：支持单张 string 或多张 string[]（多参考图）。 */
function decodeImagesParam(imageParam: unknown): DecodedImage[] {
  const rawList = Array.isArray(imageParam)
    ? imageParam
    : typeof imageParam === 'string'
      ? [imageParam]
      : []
  if (rawList.length === 0) {
    throw { code: -32602, message: '缺少参数 image（输入图片 Base64，支持单张 string 或多张 string[]）' } as JsonRpcError
  }
  return rawList.map(v => {
    if (typeof v !== 'string') {
      throw { code: -32602, message: '参数 image 的每一项必须是 Base64 字符串' } as JsonRpcError
    }
    return decodeImageParam(v)
  })
}

/** ArrayBuffer → Base64（Gemini inline_data 需要）。 */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

/** 调用 Gemini 原生 API 进行图生图/编辑（支持多张输入图） */
async function editImageGemini(
  service: McpService,
  model: string,
  prompt: string,
  images: DecodedImage[],
  params?: Record<string, unknown>
): Promise<unknown> {
  const endpoint = `${service.baseUrl.replace(/\/+$/, '')}/v1beta/models/${model}:generateContent`

  // parts 中依次挂载多张输入图，最后是编辑指令文本
  const parts: Array<Record<string, unknown>> = images.map(img => ({
    inline_data: {
      mime_type: img.mime,
      data: arrayBufferToBase64(img.buffer)
    }
  }))
  parts.push({ text: prompt })

  const imageConfig = resolveGeminiImageConfig(params)
  const body: Record<string, unknown> = {
    contents: [
      {
        parts
      }
    ],
    generationConfig: {
      responseModalities: ['IMAGE', 'TEXT']
    }
  }
  if (imageConfig) {
    ;(body.generationConfig as Record<string, unknown>).imageConfig = imageConfig
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
  const images = decodeImagesParam(params?.image)

  const model = pickModel(service, params)

  // Gemini 模型走原生 API
  if (isGeminiModel(model)) {
    return editImageGemini(service, model, prompt, images, params)
  }

  // 其他模型走 OpenAI 兼容 API（images/edits 支持多 image 字段）
  const fd = new FormData()
  fd.append('model', model)
  fd.append('prompt', prompt)
  for (const img of images) {
    fd.append('image', new Blob([img.buffer], { type: img.mime }), img.filename)
  }
  const size = params?.size
  if (typeof size === 'string' && size.trim()) fd.append('size', normalizeOpenAiSize(size))
  const n = params?.n
  if (typeof n === 'number') fd.append('n', String(n))
  // quality：仅白名单取值，缺省/非法值回退 medium
  const quality = params?.quality
  fd.append('quality', typeof quality === 'string' && ['low', 'medium', 'high'].includes(quality) ? quality : 'medium')

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

  // 可选参数统一放入 metadata：resolution
  const metadata: Record<string, unknown> = {}

  const resolution = params?.resolution
  if (typeof resolution === 'string' && resolution.trim()) {
    metadata.resolution = resolution.trim()
  }

  // 可选参数：seconds（对外唯一时长参数；仍兼容历史客户端显式传 duration；合法性校验：4-15 整数或 -1）
  const seconds = params?.seconds ?? params?.duration
  if (typeof seconds === 'number') {
    const secInt = Math.floor(seconds)
    if (secInt !== -1 && (secInt < 4 || secInt > 15)) {
      throw { code: -32602, message: 'seconds 必须为 4-15 的整数，或 -1（模型自动选择时长）' } as JsonRpcError
    }
    metadata.duration = secInt
  }

  // 可选参数：ratio
  const ratio = params?.ratio
  if (typeof ratio === 'string' && ratio.trim()) {
    metadata.ratio = ratio.trim()
  }

  // 可选参数：fps
  const fps = params?.fps
  if (typeof fps === 'number' && (fps === 24 || fps === 60)) {
    metadata.fps = fps
  }

  // 可选参数：generate_audio（兼容旧参数名 audio）
  const generateAudio = params?.generate_audio ?? params?.audio
  if (typeof generateAudio === 'boolean') {
    metadata.generate_audio = generateAudio
  }

  // 可选参数：seed
  const seed = params?.seed
  if (typeof seed === 'number' && Number.isInteger(seed)) {
    metadata.seed = seed
  }

  // 可选参数：watermark
  const watermark = params?.watermark
  if (typeof watermark === 'boolean') {
    metadata.watermark = watermark
  }

  body.metadata = metadata

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
  // content 与可选参数统一放入 metadata
  const metadata: Record<string, unknown> = { content }
  const body: Record<string, unknown> = { model, prompt }

  // 可选参数：resolution
  const resolution = params?.resolution
  if (typeof resolution === 'string' && resolution.trim()) {
    metadata.resolution = resolution.trim()
  }

  // 可选参数：seconds（对外唯一时长参数；仍兼容历史客户端显式传 duration；合法性校验：4-15 整数或 -1）
  const seconds = params?.seconds ?? params?.duration
  if (typeof seconds === 'number') {
    const secInt = Math.floor(seconds)
    if (secInt !== -1 && (secInt < 4 || secInt > 15)) {
      throw { code: -32602, message: 'seconds 必须为 4-15 的整数，或 -1（模型自动选择时长）' } as JsonRpcError
    }
    metadata.duration = secInt
  }

  // 可选参数：ratio
  const ratio = params?.ratio
  if (typeof ratio === 'string' && ratio.trim()) {
    metadata.ratio = ratio.trim()
  }

  // 可选参数：fps
  const fps = params?.fps
  if (typeof fps === 'number' && (fps === 24 || fps === 60)) {
    metadata.fps = fps
  }

  // 可选参数：generate_audio（兼容旧参数名 audio）
  const generateAudio = params?.generate_audio ?? params?.audio
  if (typeof generateAudio === 'boolean') {
    metadata.generate_audio = generateAudio
  }

  // 可选参数：seed
  const seed = params?.seed
  if (typeof seed === 'number' && Number.isInteger(seed)) {
    metadata.seed = seed
  }

  // 可选参数：watermark
  const watermark = params?.watermark
  if (typeof watermark === 'boolean') {
    metadata.watermark = watermark
  }

  // 可选参数：reference_video
  const referenceVideo = params?.reference_video
  if (typeof referenceVideo === 'string' && referenceVideo.trim()) {
    metadata.reference_video = referenceVideo.trim() // Base64 编码的参考视频
  }

  body.metadata = metadata

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

/** 3D 模型已由平台统一；此参数只作为特殊场景的可选覆盖。 */
function pick3DModel(service: McpService, params?: Record<string, unknown>): string | undefined {
  const requested = params && typeof params.model === 'string' ? params.model.trim() : ''
  return requested || service.modelId.trim() || undefined
}

function apply3DModel(body: Record<string, unknown>, model: string | undefined): void {
  if (model) body.model = model
}

/** 校验并提取 3D 生成的高级参数；这些字段会原样传给 new-api 的 metadata。 */
function parse3DMetadata(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw { code: -32602, message: '参数 metadata 必须是对象' } as JsonRpcError
  }
  return value as Record<string, unknown>
}

function assert3DResponseSuccess(result: any, action: string): void {
  const succeeded = result?.code === 'success' || result?.code === 0
  if (!succeeded) {
    const reason = result?.message || result?.error_message || `${action} 失败`
    throw { code: -32603, message: reason } as JsonRpcError
  }
}

/** 文生 3D：独立调用 POST /v1/3d/generations/text-to-model */
async function generateTextToModel3D(
  service: McpService,
  params?: Record<string, unknown>
): Promise<unknown> {
  if (!service.apiKey.trim()) {
    throw { code: -32603, message: '未配置 API Key，请在设置中填写后再请求' } as JsonRpcError
  }
  const prompt = typeof params?.prompt === 'string' ? params.prompt.trim() : ''
  if (!prompt) {
    throw { code: -32602, message: '缺少参数 prompt（3D 模型描述）' } as JsonRpcError
  }

  const body: Record<string, unknown> = {
    prompt,
    metadata: parse3DMetadata(params?.metadata)
  }
  apply3DModel(body, pick3DModel(service, params))
  const endpoint = `${toApiRoot(service.baseUrl)}/v1/3d/generations/text-to-model`
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
    throw { code: resp.status, message: `文生 3D 提交失败 ${resp.status}: ${text.slice(0, 500)}` } as JsonRpcError
  }

  const result = text ? (jsonOrThrow(text) as any) : null
  assert3DResponseSuccess(result, '文生 3D')
  const taskId = result?.data?.task_id
  if (!taskId) {
    throw { code: -32603, message: '文生 3D 返回缺少 task_id' } as JsonRpcError
  }
  return {
    tool: 'text_to_model_3d',
    task_id: taskId,
    status: result.data?.status || 'submitted',
    progress: result.data?.progress || '10%'
  }
}

/** 图生 3D：独立调用 POST /v1/3d/generations/image-to-model，图片字段是 input */
async function generateImageToModel3D(
  service: McpService,
  params?: Record<string, unknown>
): Promise<unknown> {
  if (!service.apiKey.trim()) {
    throw { code: -32603, message: '未配置 API Key，请在设置中填写后再请求' } as JsonRpcError
  }
  const input = typeof params?.input === 'string' ? params.input.trim() : ''
  if (!input) {
    throw { code: -32602, message: '缺少参数 input（单张图片 URL）' } as JsonRpcError
  }

  const body: Record<string, unknown> = {
    input,
    metadata: parse3DMetadata(params?.metadata)
  }
  apply3DModel(body, pick3DModel(service, params))
  const endpoint = `${toApiRoot(service.baseUrl)}/v1/3d/generations/image-to-model`
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
    throw { code: resp.status, message: `图生 3D 提交失败 ${resp.status}: ${text.slice(0, 500)}` } as JsonRpcError
  }

  const result = text ? (jsonOrThrow(text) as any) : null
  assert3DResponseSuccess(result, '图生 3D')
  const taskId = result?.data?.task_id
  if (!taskId) {
    throw { code: -32603, message: '图生 3D 返回缺少 task_id' } as JsonRpcError
  }
  return {
    tool: 'image_to_model_3d',
    task_id: taskId,
    status: result.data?.status || 'submitted',
    progress: result.data?.progress || '10%'
  }
}

/** 多视图生 3D：独立调用 POST /v1/3d/generations/multiview-to-model，图片字段是 inputs */
async function generateMultiviewToModel3D(
  service: McpService,
  params?: Record<string, unknown>
): Promise<unknown> {
  if (!service.apiKey.trim()) {
    throw { code: -32603, message: '未配置 API Key，请在设置中填写后再请求' } as JsonRpcError
  }
  const inputs = params?.inputs
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw { code: -32602, message: '缺少参数 inputs（多视图图片数组）' } as JsonRpcError
  }
  for (const item of inputs) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw { code: -32602, message: 'inputs 的每一项必须是对象，例如 {"front":"https://..."}' } as JsonRpcError
    }
  }

  const body: Record<string, unknown> = {
    inputs,
    metadata: parse3DMetadata(params?.metadata)
  }
  apply3DModel(body, pick3DModel(service, params))
  const endpoint = `${toApiRoot(service.baseUrl)}/v1/3d/generations/multiview-to-model`
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
    throw { code: resp.status, message: `多视图 3D 提交失败 ${resp.status}: ${text.slice(0, 500)}` } as JsonRpcError
  }

  const result = text ? (jsonOrThrow(text) as any) : null
  assert3DResponseSuccess(result, '多视图 3D')
  const taskId = result?.data?.task_id
  if (!taskId) {
    throw { code: -32603, message: '多视图 3D 返回缺少 task_id' } as JsonRpcError
  }
  return {
    tool: 'multiview_to_model_3d',
    task_id: taskId,
    status: result.data?.status || 'submitted',
    progress: result.data?.progress || '10%'
  }
}

/** 查询 3D 生成任务状态：独立调用 GET /v1/3d/generations/{task_id} */
async function query3DGenerationTask(service: McpService, taskId: string): Promise<unknown> {
  const endpoint = `${toApiRoot(service.baseUrl)}/v1/3d/generations/${encodeURIComponent(taskId)}`
  const resp = await fetch(endpoint, {
    headers: { authorization: `Bearer ${service.apiKey.trim()}` }
  })
  const text = await resp.text()
  if (!resp.ok) {
    throw { code: resp.status, message: `查询 3D 任务失败 ${resp.status}: ${text.slice(0, 500)}` } as JsonRpcError
  }

  const result = text ? (jsonOrThrow(text) as any) : null
  assert3DResponseSuccess(result, '查询 3D 任务')
  const data = result?.data
  if (!data || typeof data !== 'object') {
    throw { code: -32603, message: '查询 3D 任务返回为空' } as JsonRpcError
  }

  return {
    task_id: data.task_id || taskId,
    status: data.status,
    progress: data.progress,
    result_url: data.result_url,
    fail_reason: data.fail_reason,
    data
  }
}

/** 通过 Provider Key 读取所属组织的云存储配置（凭据只在内存中短暂使用）。 */
async function getCloudStorageConfig(
  service: McpService,
  provider?: CloudStorageProvider
): Promise<CloudStorageConfig> {
  if (!service.apiKey.trim()) {
    throw { code: -32603, message: '未配置 API Key，请在设置中填写后再请求' } as JsonRpcError
  }

  const query = provider ? `provider=${provider}` : ''
  const endpoint = `${toApiRoot(service.baseUrl)}/api/cloud-storage/config${query ? `?${query}` : ''}`
  const resp = await fetch(endpoint, {
    headers: { authorization: `Bearer ${service.apiKey.trim()}` }
  })
  const text = await resp.text()
  if (!resp.ok) {
    throw { code: resp.status, message: `获取云存储配置失败 ${resp.status}: ${text.slice(0, 500)}` } as JsonRpcError
  }

  let body: { success?: boolean; data?: CloudStorageConfig; message?: string }
  try {
    body = text ? (jsonOrThrow(text) as typeof body) : {}
  } catch {
    throw { code: -32603, message: '云存储配置返回不是有效 JSON' } as JsonRpcError
  }

  const data = body.data
  if (!body.success || !data || (data.provider !== 'cos' && data.provider !== 'oss')) {
    throw { code: -32603, message: body.message || '云存储未配置，或存储类型不是 COS/OSS' } as JsonRpcError
  }
  if (!data.bucket) {
    throw { code: -32603, message: '云存储配置缺少 bucket' } as JsonRpcError
  }
  if (
    data.provider === 'cos' &&
    (!data.region || !data.credentials?.secret_id || !data.credentials?.secret_key)
  ) {
    throw { code: -32603, message: '腾讯云 COS 配置缺少 region 或凭据' } as JsonRpcError
  }
  if (
    data.provider === 'oss' &&
    (!data.endpoint || !data.credentials?.access_key_id || !data.credentials?.access_key_secret)
  ) {
    throw { code: -32603, message: '阿里云 OSS 配置缺少 endpoint 或凭据' } as JsonRpcError
  }
  return data
}

function canonicalList(values: Record<string, string>, formatter: (key: string, value: string) => string): string {
  return Object.entries(values)
    .map(([key, value]) => formatter(encodeURIComponent(key).toLowerCase(), encodeURIComponent(value)))
    .sort()
    .join('&')
}

/** 生成腾讯云 COS 预签名 URL；只签名业务参数与显式请求头。 */
function buildSignedCosUrl(input: SignedCosUrlInput): string {
  const requestPath = input.key
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/')
  const requestPathname = `/${requestPath}`
  const signaturePathname = `/${input.key}`
  const now = Math.floor(Date.now() / 1000)
  const keyTime = `${now};${now + input.expires}`
  const signKey = createHmac('sha1', input.secretKey).update(keyTime).digest('hex')

  const params = Object.fromEntries(
    Object.entries(input.params || {}).map(([key, value]) => [key.toLowerCase(), value])
  )
  const headers = Object.fromEntries(
    Object.entries(input.headers || {}).map(([key, value]) => [key.toLowerCase(), value])
  )
  const paramsString = canonicalList(params, (key, value) => `${key}=${value}`)
  const headersString = canonicalList(headers, (key, value) => `${key}=${value.replace(/\s+/g, ' ').trim()}`)
  const httpString = `${input.method.toLowerCase()}\n${signaturePathname}\n${paramsString}\n${headersString}\n`
  const stringToSign = `sha1\n${keyTime}\n${createHash('sha1').update(httpString).digest('hex')}\n`
  const signature = createHmac('sha1', signKey).update(stringToSign).digest('hex')

  const query = new URLSearchParams({
    'q-sign-algorithm': 'sha1',
    'q-ak': input.secretId,
    'q-sign-time': keyTime,
    'q-key-time': keyTime,
    'q-header-list': Object.keys(headers).sort().join(';'),
    'q-url-param-list': Object.keys(params).sort().join(';'),
    'q-signature': signature
  })
  return `https://${input.host}${requestPathname}?${query.toString()}`
}

/** COS API 必须走虚拟主机域名；自定义域名只用于公开访问 URL。 */
function cosApiHost(config: CloudStorageConfig): string {
  return `${config.bucket}.cos.${config.region}.myqcloud.com`
}

function cosPublicHost(config: CloudStorageConfig): string {
  const custom = config.custom_domain?.trim().replace(/\/+$/, '')
  if (custom) return custom.replace(/^https?:\/\//i, '')
  return cosApiHost(config)
}

/** 生成 OSS V1 预签名 URL；上传时显式签名 Content-Type。 */
function buildSignedOssUrl(input: SignedOssUrlInput): string {
  const pathname = input.key
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/')
  const expires = Math.floor(Date.now() / 1000) + input.expires
  const contentType = input.contentType || ''
  const stringToSign = [
    input.method,
    '',
    contentType,
    String(expires),
    `/${input.bucket}/${input.key}`
  ].join('\n')
  const signature = createHmac('sha1', input.accessKeySecret)
    .update(stringToSign)
    .digest('base64')

  const query = new URLSearchParams({
    OSSAccessKeyId: input.accessKeyId,
    Expires: String(expires),
    Signature: signature
  })
  return `${input.baseUrl}/${pathname}?${query.toString()}`
}

/** OSS 走虚拟主机域名；管理端可能存区域 Endpoint 或已带 bucket 的完整 Endpoint。 */
function resolveOssTarget(config: CloudStorageConfig): OssTarget {
  const rawEndpoint = config.endpoint.trim()
  const endpointUrl = new URL(/^https?:\/\//i.test(rawEndpoint) ? rawEndpoint : `https://${rawEndpoint}`)
  const endpointHost = endpointUrl.host
  const uploadHost = endpointHost.startsWith(`${config.bucket}.`)
    ? endpointHost
    : `${config.bucket}.${endpointHost}`
  const custom = config.custom_domain?.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '')

  return {
    protocol: endpointUrl.protocol.replace(':', ''),
    uploadHost,
    publicHost: custom || uploadHost
  }
}

function sanitizeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() || ''
  return base
    .replace(/[\\/:*?"<>|\r\n\t]+/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 120)
}

function guessContentType(filename: string): string {
  const ext = path.extname(filename).toLowerCase()
  const types: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.csv': 'text/csv',
    '.json': 'application/json',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.zip': 'application/zip'
  }
  return types[ext] || 'application/octet-stream'
}

function parsePresignedExpires(value: unknown): number {
  const requested = typeof value === 'number' ? value : Number(value)
  const expires = Number.isFinite(requested) ? Math.floor(requested) : 3600
  return Math.min(Math.max(expires, MIN_PRESIGNED_EXPIRES), MAX_PRESIGNED_EXPIRES)
}

function decodeUploadContent(
  content: string,
  filename: string
): { buffer: Buffer; filename: string; contentType: string } {
  const trimmed = content.trim()
  const dataUri = /^data:([^;,]+);base64,(.+)$/s.exec(trimmed)
  const base64 = dataUri ? dataUri[2] : trimmed
  const buffer = Buffer.from(base64, 'base64')
  if (buffer.length === 0) {
    throw { code: -32602, message: '参数 content 不是有效的 Base64 文件数据' } as JsonRpcError
  }
  const inferredName = dataUri ? `file.${dataUri[1].split('/')[1] || 'bin'}` : 'file.bin'
  const finalName = sanitizeFileName(filename || inferredName) || inferredName
  return { buffer, filename: finalName, contentType: guessContentType(finalName) }
}

async function readUploadFile(file: string): Promise<Buffer> {
  const stats = await stat(file)
  if (!stats.isFile()) {
    throw { code: -32602, message: 'file_path 不是普通文件' } as JsonRpcError
  }
  if (stats.size > MAX_FILE_UPLOAD_SIZE) {
    throw { code: -32602, message: `文件过大（上限 ${Math.floor(MAX_FILE_UPLOAD_SIZE / 1024 / 1024)}MB）` } as JsonRpcError
  }
  const buffer = await readFile(file)
  if (buffer.length === 0) {
    throw { code: -32602, message: '文件内容为空，无法上传' } as JsonRpcError
  }
  if (buffer.byteLength > MAX_FILE_UPLOAD_SIZE) {
    throw { code: -32602, message: `文件过大（上限 ${Math.floor(MAX_FILE_UPLOAD_SIZE / 1024 / 1024)}MB）` } as JsonRpcError
  }
  return buffer
}

/** 上传文件到组织绑定的 COS/OSS，并返回带过期时间的公网访问 URL。 */
async function uploadFileToCloudStorage(
  service: McpService,
  params?: Record<string, unknown>
): Promise<unknown> {
  const rawProvider = typeof params?.provider === 'string' ? params.provider.trim().toLowerCase() : ''
  if (rawProvider && rawProvider !== 'cos' && rawProvider !== 'oss') {
    throw { code: -32602, message: 'provider 仅支持 cos 或 oss' } as JsonRpcError
  }
  const config = await getCloudStorageConfig(service, (rawProvider || undefined) as CloudStorageProvider | undefined)
  const filePath = typeof params?.file_path === 'string' ? params.file_path.trim() : ''
  const content = typeof params?.content === 'string' ? params.content.trim() : ''
  if (Boolean(filePath) === Boolean(content)) {
    throw { code: -32602, message: 'file_path 和 content 必须二选一' } as JsonRpcError
  }

  const inputName = typeof params?.file_name === 'string' ? params.file_name : ''
  let buffer: Buffer
  let filename: string
  if (filePath) {
    buffer = await readUploadFile(filePath)
    filename = sanitizeFileName(path.basename(filePath) || inputName || 'file.bin') || 'file.bin'
  } else {
    const decoded = decodeUploadContent(content, inputName)
    buffer = decoded.buffer
    filename = decoded.filename
  }
  if (buffer.byteLength > MAX_FILE_UPLOAD_SIZE) {
    throw { code: -32602, message: `文件过大（上限 ${Math.floor(MAX_FILE_UPLOAD_SIZE / 1024 / 1024)}MB）` } as JsonRpcError
  }

  const expires = parsePresignedExpires(params?.expires_in)
  const datePath = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const normalizedPrefix = config.path_prefix?.replace(/^\/+|\/+$/g, '') || ''
  const key = [normalizedPrefix, 'mcp-uploads', datePath, `${randomUUID()}_${filename}`]
    .filter(Boolean)
    .join('/')
  const contentType = guessContentType(filename)

  let uploadUrl: string
  let publicUrl: string
  if (config.provider === 'oss') {
    const target = resolveOssTarget(config)
    const accessKeyId = config.credentials.access_key_id || ''
    const accessKeySecret = config.credentials.access_key_secret || ''
    uploadUrl = buildSignedOssUrl({
      method: 'PUT',
      baseUrl: `${target.protocol}://${target.uploadHost}`,
      bucket: config.bucket,
      key,
      accessKeyId,
      accessKeySecret,
      expires: 600,
      contentType
    })
    publicUrl = buildSignedOssUrl({
      method: 'GET',
      baseUrl: `${target.protocol}://${target.publicHost}`,
      bucket: config.bucket,
      key,
      accessKeyId,
      accessKeySecret,
      expires
    })
  } else {
    uploadUrl = buildSignedCosUrl({
      method: 'PUT',
      host: cosApiHost(config),
      key,
      secretId: config.credentials.secret_id || '',
      secretKey: config.credentials.secret_key || '',
      expires: 600,
      headers: { 'content-type': contentType }
    })
    publicUrl = buildSignedCosUrl({
      method: 'GET',
      host: cosPublicHost(config),
      key,
      secretId: config.credentials.secret_id || '',
      secretKey: config.credentials.secret_key || '',
      expires
    })
  }

  const uploadResp = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'content-type': contentType },
    body: new Uint8Array(buffer)
  })
  if (!uploadResp.ok) {
    const errorText = await uploadResp.text()
    throw {
      code: uploadResp.status,
      message: `${config.provider.toUpperCase()} 上传失败 ${uploadResp.status}: ${errorText.slice(0, 800)}`
    } as JsonRpcError
  }

  return {
    url: publicUrl,
    key,
    bucket: config.bucket,
    provider: config.provider,
    filename,
    size: buffer.byteLength,
    content_type: contentType,
    expires_in: expires,
    expires_at: new Date(Date.now() + expires * 1000).toISOString()
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
            size: {
              type: 'string',
              description:
                '图片尺寸：像素格式如 1024x1024，或档位 1K/2K/4K（Gemini 档位直写；OpenAI 档位转像素，4K→3840x2160）'
            },
            aspectRatio: {
              type: 'string',
              enum: GEMINI_ASPECT_RATIOS,
              description: 'Gemini 图片宽高比：1:1、16:9、9:16 等，仅 Gemini 模型生效'
            },
            quality: {
              type: 'string',
              enum: ['low', 'medium', 'high'],
              description: '图片质量：low / medium / high，默认 medium'
            }
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
              oneOf: [
                { type: 'string' },
                { type: 'array', items: { type: 'string' } }
              ],
              description: '输入图片（必填）：单张 Base64 字符串，或 Base64 字符串数组（多参考图），每项可带 data:image/png;base64, 前缀，每张上限 50MB'
            },
            prompt: { type: 'string', description: '编辑指令/重绘描述（必填）' },
            model: {
              type: 'string',
              enum: BUILTIN_MCP_IMAGE_DEFAULTS.models,
              description: '模型 ID，缺省使用默认模型'
            },
            n: { type: 'integer', description: '生成数量，默认 1' },
            size: {
              type: 'string',
              description:
                '图片尺寸：像素格式如 1024x1024，或档位 1K/2K/4K（Gemini 档位直写；OpenAI 档位转像素，4K→3840x2160）'
            },
            aspectRatio: {
              type: 'string',
              enum: GEMINI_ASPECT_RATIOS,
              description: 'Gemini 图片宽高比：1:1、16:9、9:16 等，仅 Gemini 模型生效'
            },
            quality: {
              type: 'string',
              enum: ['low', 'medium', 'high'],
              description: '图片质量：low / medium / high，默认 medium'
            }
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
            seconds: {
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
            seconds: {
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
  } else if (serviceType === 'file-upload') {
    return [
      {
        name: 'file_upload',
        description: '上传本地文件或 Base64 内容到腾讯云 COS 或阿里云 OSS，返回带过期时间的临时公网访问 URL',
        inputSchema: {
          type: 'object',
          properties: {
            file_path: {
              type: 'string',
              description: '本地文件绝对路径；与 content 二选一'
            },
            content: {
              type: 'string',
              description: '文件内容（Base64，支持 data:image/png;base64,... 前缀）；与 file_path 二选一'
            },
            file_name: {
              type: 'string',
              description: 'content 模式下的文件名，用于识别扩展名'
            },
            provider: {
              type: 'string',
              enum: ['cos', 'oss'],
              description: '云存储类型：cos（腾讯云）或 oss（阿里云）；缺省使用组织当前启用的存储'
            },
            expires_in: {
              type: 'integer',
              description: 'URL 有效期（秒），默认 3600，范围 60 到 604800'
            }
          }
        }
      }
    ]
  } else if (serviceType === '3d-generation') {
    return [
      {
        name: 'text_to_model_3d',
        description: '文生 3D：根据文字描述生成 3D 模型任务，独立调用 text-to-model 接口',
        inputSchema: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: '3D 模型描述（必填）' },
            model: {
              type: 'string',
              description: '可选模型 ID；不传时使用平台统一模型'
            },
            metadata: THREE_D_METADATA_SCHEMA
          },
          required: ['prompt']
        }
      },
      {
        name: 'image_to_model_3d',
        description: '图生 3D：根据单张图片生成 3D 模型任务，独立调用 image-to-model 接口',
        inputSchema: {
          type: 'object',
          properties: {
            input: { type: 'string', description: '单张输入图片 URL（必填）' },
            model: {
              type: 'string',
              description: '可选模型 ID；不传时使用平台统一模型'
            },
            metadata: THREE_D_METADATA_SCHEMA
          },
          required: ['input']
        }
      },
      {
        name: 'multiview_to_model_3d',
        description: '多视图生 3D：根据多视角图片生成 3D 模型任务，独立调用 multiview-to-model 接口',
        inputSchema: {
          type: 'object',
          properties: {
            inputs: {
              type: 'array',
              items: {
                type: 'object',
                description:
                  '视角图片对象，键可为 front、back、left、right、top、bottom 等官方视角；例如 {"front":"https://...","left":"https://..."}',
                additionalProperties: { type: 'string' }
              },
              minItems: 1,
              description: '多视角图片数组（必填）'
            },
            model: {
              type: 'string',
              description: '可选模型 ID；不传时使用平台统一模型'
            },
            metadata: THREE_D_METADATA_SCHEMA
          },
          required: ['inputs']
        }
      },
      {
        name: 'generation_3d_task_query',
        description: '查询 3D 生成任务状态和结果 URL（单次查询，不轮询）',
        inputSchema: {
          type: 'object',
          properties: {
            task_id: {
              type: 'string',
              description: '任务 ID（三个 3D 提交工具返回）'
            }
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
            name:
              service.type === 'video-generation'
                ? 'dst-video-mcp'
                : service.type === 'file-upload'
                  ? 'dst-file-mcp'
                  : service.type === '3d-generation'
                    ? 'dst-3d-mcp'
                    : 'dst-image-mcp',
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
        } else if (service.type === 'file-upload') {
          if (toolName === 'file_upload') {
            output = await uploadFileToCloudStorage(service, args)
          } else {
            throw { code: -32602, message: `未知工具: ${toolName}` } as JsonRpcError
          }
        } else if (service.type === '3d-generation') {
          if (toolName === 'text_to_model_3d') {
            output = await generateTextToModel3D(service, args)
          } else if (toolName === 'image_to_model_3d') {
            output = await generateImageToModel3D(service, args)
          } else if (toolName === 'multiview_to_model_3d') {
            output = await generateMultiviewToModel3D(service, args)
          } else if (toolName === 'generation_3d_task_query') {
            const taskId = typeof args.task_id === 'string' ? args.task_id.trim() : ''
            if (!taskId) {
              throw { code: -32602, message: '缺少参数 task_id' } as JsonRpcError
            }
            output = await query3DGenerationTask(service, taskId)
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
