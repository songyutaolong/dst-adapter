import http from 'http'
import { readFile, stat } from 'fs/promises'
import path from 'path'
import { isIP, type AddressInfo } from 'net'
import type { McpService } from '../../shared/types'
import { toApiRoot } from '../../shared/url'
import {
  BUILTIN_MCP_IMAGE_DEFAULTS,
  BUILTIN_MCP_VIDEO_DEFAULTS,
  MCP_DEFAULT_PORT
} from '../../shared/types'
import {
  guessContentType,
  MAX_FILE_UPLOAD_SIZE,
  parsePresignedExpires,
  sanitizeFileName,
  uploadToCloudStorage,
  type CloudStorageProvider
} from '../assets/cloudStorage'

/**
 * Streamable HTTP MCP Server（单端点）
 *
 * - 传输协议：MCP Streamable HTTP（2025-06-18 草案）
 *   - GET  /            → SSE 流（客户端建立流，接收服务端消息/通知）
 *   - POST /            → JSON-RPC 2.0 调用（initialize / tools/list / tools/call / ping）
 * - 工具：
 *   - image_generation 文生图（模型 ID 由请求参数 model 决定）
 *   - image_editing    图生图/编辑（输入图片 Base64 + 编辑指令，支持多参考图：image 可传 string 或多张 string[]）
 *   - video_generation 文生/参考内容生视频（提交任务，返回 task_id；doubao-seedance 与 wan3 系列，后者自动适配 Wan3 media 请求格式）
 *   - video_from_image 参考内容生视频（参考图、帧控制、参考视频、参考音频；file/link 媒体仅 wan3 系列）
 *   - video_task_query 查询视频生成任务状态（单次查询，不轮询；轮询节奏由调用方控制）
 *   - file_upload      文件上传（返回临时公网访问 URL；支持腾讯 COS / 阿里 OSS）
 *   - text_to_model_3d / image_to_model_3d / multiview_to_model_3d
 *   - texture_model_3d / decimate_mesh_3d / segment_mesh_3d / rig_check_3d / rig_model_3d（TriPo 后处理）
 *   - generation_3d_task_query 查询 3D 生成/后处理任务状态
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

/**
 * 工具调用钩子：归档等旁路能力挂在 tools/call 成功返回后，
 * 由外部（index.ts）注入，server 自身不依赖归档模块，避免循环依赖。
 * 钩子必须自行兜底异常，且不得阻塞工具响应。
 */
export interface ToolCallHookContext {
  service: McpService
  toolName: string
  args: Record<string, unknown>
  /** 工具原始输出（未 JSON 序列化的对象） */
  output: unknown
  /** best-effort 识别的调用方（WorkBuddy / Codex / UA 片段），可能为空 */
  clientName?: string
}

let toolCallHook: ((ctx: ToolCallHookContext) => void) | null = null

export function setToolCallHook(fn: ((ctx: ToolCallHookContext) => void) | null): void {
  toolCallHook = fn
}

/** 任务查询只依赖网关连接信息；收窄入参，便于归档轮询器以连接对象直接调用。 */
export type McpServiceConnection = Pick<McpService, 'baseUrl' | 'apiKey'>

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

const VIDEO_CONTENT_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      type: {
        type: 'string',
        enum: ['text', 'image_url', 'video_url', 'audio_url', 'file', 'link'],
        description:
          '内容类型：text（提示文本）、image_url（图片）、video_url（公网参考视频 URL）、audio_url（公网参考音频 URL）、file（参考文件，仅 wan3 系列）、link（公开网页链接，仅 wan3 系列）'
      },
      text: { type: 'string', description: '文本内容（type=text 时必填）' },
      image_url: {
        type: 'object',
        properties: { url: { type: 'string', description: '图片 URL（type=image_url 时必填）' } },
        required: ['url']
      },
      video_url: {
        type: 'object',
        properties: { url: { type: 'string', description: '互联网可访问的参考视频 URL（type=video_url 时必填）' } },
        required: ['url']
      },
      audio_url: {
        type: 'object',
        properties: { url: { type: 'string', description: '互联网可访问的参考音频 URL（type=audio_url 时必填）' } },
        required: ['url']
      },
      file: {
        type: 'object',
        properties: { url: { type: 'string', description: '互联网可访问的参考文件 URL（type=file 时必填，仅 wan3 系列）' } },
        required: ['url']
      },
      link: {
        type: 'object',
        properties: { url: { type: 'string', description: '公开网页链接 URL（type=link 时必填，仅 wan3 系列）' } },
        required: ['url']
      },
      role: {
        type: 'string',
        enum: ['reference_image', 'first_frame', 'last_frame', 'reference_video', 'reference_audio'],
        description: '内容角色；video_url 使用 reference_video，audio_url 使用 reference_audio，file/link 无需 role'
      }
    },
    required: ['type']
  },
  description:
    '内容数组：支持参考图、首帧（可选尾帧）、互联网可访问的参考视频/音频 URL、file/link（仅 wan3 系列），以及可选 text 提示；media 类型必须提供至少一项；wan3 系列的参考视频/音频单段 1-15 秒且总时长不超过 15 秒'
} as const

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
  const endpoint = `${toApiRoot(service.baseUrl)}/v1beta/models/${model}:generateContent`
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

  const endpoint = `${toApiRoot(service.baseUrl)}/v1/images/generations`
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
  const endpoint = `${toApiRoot(service.baseUrl)}/v1beta/models/${model}:generateContent`

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

  const endpoint = `${toApiRoot(service.baseUrl)}/v1/images/edits`
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

/**
 * wan3 系列模型判定（按前缀匹配）：请求体走网关的 Wan3 格式。
 * wan3.0-video-prime（高速版）暂未加入白名单（隐藏）；恢复时只需加回 BUILTIN_MCP_VIDEO_DEFAULTS.models。
 */
function isWan3Model(model: string): boolean {
  return model.startsWith('wan3.0-video')
}

/** wan3 支持的分辨率档位（统一参数用小写 p，网关要求大写 P，且无 4K）。 */
const WAN3_RESOLUTIONS = ['480P', '720P', '1080P'] as const

function isPublicIpv4(host: string): boolean {
  const parts = host.split('.').map(Number)
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false

  const [a, b] = parts
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false
  if (a === 169 && b === 254) return false
  if (a === 172 && b >= 16 && b <= 31) return false
  if (a === 192 && b === 168) return false
  if (a === 100 && b >= 64 && b <= 127) return false
  if (a === 198 && (b === 18 || b === 19)) return false
  return true
}

function isPublicIpv6(host: string): boolean {
  const value = host.split('%')[0].toLowerCase()
  if (!value || value === '::' || value === '::1') return false
  if (value.startsWith('::ffff:')) return isPublicIpv4(value.slice(7))
  if (value.startsWith('fe8') || value.startsWith('fc') || value.startsWith('fd')) return false
  return true
}

function assertInternetHttpUrl(value: unknown, fieldName: string): void {
  if (typeof value !== 'string' || !value.trim()) {
    throw { code: -32602, message: `${fieldName} 必须是互联网可访问的 http/https URL 字符串` } as JsonRpcError
  }

  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw { code: -32602, message: `${fieldName} 不是合法 URL: ${value.trim()}` } as JsonRpcError
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw { code: -32602, message: `${fieldName} 只支持 http/https URL，当前协议为 ${url.protocol}` } as JsonRpcError
  }

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    throw { code: -32602, message: `${fieldName} 不能使用本机或本地域名，必须是互联网可访问的 URL` } as JsonRpcError
  }

  const ipVersion = isIP(host)
  if (ipVersion === 4 && !isPublicIpv4(host)) {
    throw { code: -32602, message: `${fieldName} 不能使用私有、回环或链路本地地址` } as JsonRpcError
  }
  if (ipVersion === 6 && !isPublicIpv6(host)) {
    throw { code: -32602, message: `${fieldName} 不能使用私有、回环或链路本地地址` } as JsonRpcError
  }
}

function extractVideoContent(params: Record<string, unknown> | undefined, required: boolean): unknown {
  const direct = params?.content
  const nested = params?.metadata
  const nestedContent =
    nested && typeof nested === 'object' && !Array.isArray(nested)
      ? (nested as Record<string, unknown>).content
      : undefined

  if (direct !== undefined && nestedContent !== undefined) {
    throw { code: -32602, message: 'content 与 metadata.content 不能同时提供，请只传一个' } as JsonRpcError
  }

  const content = direct !== undefined ? direct : nestedContent
  if (required && content === undefined) {
    throw { code: -32602, message: '缺少参数 content（内容数组），必须提供至少一项媒体内容' } as JsonRpcError
  }
  return content
}

function validateVideoContent(value: unknown, model?: string): unknown[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw { code: -32602, message: 'content 必须是非空数组，且至少包含一项媒体内容' } as JsonRpcError
  }

  const items = value as Array<Record<string, unknown>>
  const imageItems = items.filter(item => item.type === 'image_url')
  const mediaCount =
    imageItems.length +
    items.filter(item => ['video_url', 'audio_url', 'file', 'link'].includes(String(item.type))).length
  if (mediaCount === 0) {
    throw {
      code: -32602,
      message: 'content 中必须包含至少一项 image_url、video_url、audio_url、file 或 link 媒体内容'
    } as JsonRpcError
  }

  for (const item of items) {
    const type = item.type
    if (type === 'text') {
      if (typeof item.text !== 'string') {
        throw { code: -32602, message: 'content 中 type=text 的项必须包含 text 字段' } as JsonRpcError
      }
      continue
    }

    if (type === 'image_url' || type === 'video_url' || type === 'audio_url') {
      const media = item[type] as Record<string, unknown> | undefined
      if (!media || typeof media.url !== 'string') {
        throw { code: -32602, message: `content 中 type=${type} 的项必须包含 ${type}.url 字段` } as JsonRpcError
      }
      assertInternetHttpUrl(media.url, `content 中 type=${type} 的 ${type}.url`)

      const expectedRole =
        type === 'video_url' ? 'reference_video' : type === 'audio_url' ? 'reference_audio' : undefined
      if (expectedRole && item.role !== expectedRole) {
        throw { code: -32602, message: `content 中 type=${type} 的项 role 必须为 ${expectedRole}` } as JsonRpcError
      }
      if (!expectedRole && !['reference_image', 'first_frame', 'last_frame'].includes(String(item.role))) {
        throw {
          code: -32602,
          message: 'content 中 type=image_url 的项必须包含 role 字段（reference_image/first_frame/last_frame）'
        } as JsonRpcError
      }
      continue
    }

    if (type === 'file' || type === 'link') {
      if (model && !isWan3Model(model)) {
        throw { code: -32602, message: `content 中 type=${type} 媒体仅 wan3 系列模型支持` } as JsonRpcError
      }
      const media = item[type] as Record<string, unknown> | undefined
      if (!media || typeof media.url !== 'string') {
        throw { code: -32602, message: `content 中 type=${type} 的项必须包含 ${type}.url 字段` } as JsonRpcError
      }
      assertInternetHttpUrl(media.url, `content 中 type=${type} 的 ${type}.url`)
      continue
    }

    throw {
      code: -32602,
      message: `content 项 type 必须为 text、image_url、video_url、audio_url、file 或 link，当前为 ${String(type)}`
    } as JsonRpcError
  }

  const refs = imageItems.filter(item => item.role === 'reference_image')
  const firsts = imageItems.filter(item => item.role === 'first_frame')
  const lasts = imageItems.filter(item => item.role === 'last_frame')
  const hasRefs = refs.length > 0
  const hasFirstLast = firsts.length > 0 || lasts.length > 0

  if (hasRefs && hasFirstLast) {
    throw {
      code: -32602,
      message: 'reference_image（参考图）和 first_frame/last_frame（首尾帧）不能混用，请选择一种模式'
    } as JsonRpcError
  }
  if (imageItems.length > 0 && !hasRefs && !hasFirstLast) {
    throw {
      code: -32602,
      message: 'content 中 type=image_url 的项 role 必须为 reference_image、first_frame 或 last_frame'
    } as JsonRpcError
  }
  if (hasFirstLast && (firsts.length !== 1 || lasts.length > 1)) {
    throw {
      code: -32602,
      message: `帧控制模式必须恰好 1 个 first_frame，last_frame 最多 1 个，当前 first_frame=${firsts.length}, last_frame=${lasts.length}`
    } as JsonRpcError
  }

  // wan3 专属媒体规则：组合限制与数量上限（见 Wan3 接口文档）
  if (model && isWan3Model(model)) {
    const countType = (t: string) => items.filter(item => item.type === t).length
    if (
      hasFirstLast &&
      (countType('video_url') > 0 || countType('audio_url') > 0 || countType('file') > 0 || countType('link') > 0)
    ) {
      throw {
        code: -32602,
        message: 'wan3 的 first_frame/last_frame 不能与参考视频、参考音频、file 或 link 混用'
      } as JsonRpcError
    }
    if (countType('file') > 0 && countType('link') > 0) {
      throw { code: -32602, message: 'wan3 的 file 与 link 不能同时使用' } as JsonRpcError
    }
    const wan3Limits: Array<[string, number, number]> = [
      ['reference_image', refs.length, 10],
      ['reference_video', countType('video_url'), 5],
      ['reference_audio', countType('audio_url'), 5],
      ['file', countType('file'), 1],
      ['link', countType('link'), 1]
    ]
    for (const [mediaType, count, max] of wan3Limits) {
      if (count > max) {
        throw { code: -32602, message: `wan3 的 ${mediaType} 最多 ${max} 项，当前 ${count} 项` } as JsonRpcError
      }
    }
  }

  return value
}

/** 查询视频生成任务状态（单次查询，不轮询；由调用方控制轮询节奏） */
export async function queryVideoTask(service: McpServiceConnection, taskId: string): Promise<unknown> {
  const endpoint = `${toApiRoot(service.baseUrl)}/v1/video/generations/${taskId}`

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
  // 无状态字段但直接携带视频 URL（同步返回风格）视为已完成；result_url 为 Wan3 查询结果字段
  const status =
    rawStatus || (data.video_url || data.url || data.output_url || data.result_url ? 'completed' : undefined)

  return {
    task_id: taskId,
    status,
    ...data
  }
}

/** 提交视频生成任务：POST {baseUrl}/v1/video/generations，解析 task_id 返回（不轮询，查询节奏由调用方控制）。 */
async function submitVideoGeneration(service: McpService, body: Record<string, unknown>): Promise<unknown> {
  const endpoint = `${toApiRoot(service.baseUrl)}/v1/video/generations`
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

/** Seedance 系模型 metadata 打包：content + 分辨率/时长/比例/帧率/音频/种子/水印（沿用网关既有格式）。 */
function buildSeedanceMetadata(
  params: Record<string, unknown>,
  content: unknown[] | undefined
): Record<string, unknown> {
  // 可选参数统一放入 metadata：resolution
  const metadata: Record<string, unknown> = content === undefined ? {} : { content }

  const resolution = params.resolution
  if (typeof resolution === 'string' && resolution.trim()) {
    metadata.resolution = resolution.trim()
  }

  // 可选参数：seconds（对外唯一时长参数；仍兼容历史客户端显式传 duration；合法性校验：4-15 整数或 -1）
  const seconds = params.seconds ?? params.duration
  if (typeof seconds === 'number') {
    const secInt = Math.floor(seconds)
    if (secInt !== -1 && (secInt < 4 || secInt > 15)) {
      throw { code: -32602, message: 'seconds 必须为 4-15 的整数，或 -1（模型自动选择时长）' } as JsonRpcError
    }
    metadata.duration = secInt
  }

  // 可选参数：ratio
  const ratio = params.ratio
  if (typeof ratio === 'string' && ratio.trim()) {
    metadata.ratio = ratio.trim()
  }

  // 可选参数：fps
  const fps = params.fps
  if (typeof fps === 'number' && (fps === 24 || fps === 60)) {
    metadata.fps = fps
  }

  // 可选参数：generate_audio（兼容旧参数名 audio）
  const generateAudio = params.generate_audio ?? params.audio
  if (typeof generateAudio === 'boolean') {
    metadata.generate_audio = generateAudio
  }

  // 可选参数：seed
  const seed = params.seed
  if (typeof seed === 'number' && Number.isInteger(seed)) {
    metadata.seed = seed
  }

  // 可选参数：watermark
  const watermark = params.watermark
  if (typeof watermark === 'boolean') {
    metadata.watermark = watermark
  }

  return metadata
}

/**
 * wan3 系模型打包：content 翻译为网关 metadata.media（type 直接采用媒体角色，text 项并入提示词），
 * 分辨率大小写归一（无 4K）、时长放宽 2-30、generate_audio 映射为 audio、不支持 fps、
 * 额外支持 prompt_extend（wan3 专属，file/link 媒体必须开启）。
 */
function buildWan3Metadata(
  params: Record<string, unknown>,
  content: unknown[] | undefined
): { metadata: Record<string, unknown>; prompt: string } {
  const metadata: Record<string, unknown> = {}
  let prompt = typeof params.prompt === 'string' ? params.prompt.trim() : ''

  // content → metadata.media；合法性与组合限制已由 validateVideoContent 校验
  if (content && content.length > 0) {
    const media: Array<{ type: string; url: string }> = []
    for (const item of content as Array<Record<string, unknown>>) {
      const type = String(item.type)
      if (type === 'text') {
        if (typeof item.text === 'string' && item.text.trim()) prompt = `${prompt}\n${item.text.trim()}`
        continue
      }
      const field = item[type] as { url?: unknown } | undefined
      const url = typeof field?.url === 'string' ? field.url : ''
      if (!url) continue
      media.push({
        // image_url 按角色直译（reference_image/first_frame/last_frame）；video/audio 补全角色；file/link 与 wan3 媒体类型同名
        type:
          type === 'image_url'
            ? String(item.role)
            : type === 'video_url'
              ? 'reference_video'
              : type === 'audio_url'
                ? 'reference_audio'
                : type,
        url
      })
    }
    if (media.length > 0) metadata.media = media
  }

  // resolution：480p/720p/1080p → 480P/720P/1080P（wan3 无 4K）
  const resolution = typeof params.resolution === 'string' ? params.resolution.trim().toUpperCase() : ''
  if (resolution) {
    if (!(WAN3_RESOLUTIONS as readonly string[]).includes(resolution)) {
      throw {
        code: -32602,
        message: `wan3 系列模型仅支持 ${WAN3_RESOLUTIONS.join(' / ')} 分辨率，当前为 ${String(params.resolution)}`
      } as JsonRpcError
    }
    metadata.resolution = resolution
  }

  // duration：wan3 支持 2-30 或 -1（智能时长），比 Seedance 的 4-15 更宽
  const seconds = params.seconds ?? params.duration
  if (typeof seconds === 'number') {
    const secInt = Math.floor(seconds)
    if (secInt !== -1 && (secInt < 2 || secInt > 30)) {
      throw { code: -32602, message: 'wan3 的 seconds 必须为 2-30 的整数，或 -1（智能时长）' } as JsonRpcError
    }
    metadata.duration = secInt
  }

  // ratio：档位与统一枚举一致，直接透传
  const ratio = typeof params.ratio === 'string' ? params.ratio.trim() : ''
  if (ratio) metadata.ratio = ratio

  // 音频：统一参数 generate_audio（旧名 audio）→ wan3 的 audio（上游默认 true）
  const generateAudio = params.generate_audio ?? params.audio
  if (typeof generateAudio === 'boolean') {
    metadata.audio = generateAudio
  }

  // wan3 无 fps 参数，显式报错避免静默丢参
  if (params.fps !== undefined) {
    throw { code: -32602, message: 'wan3 系列模型不支持 fps 参数，请去掉后重试' } as JsonRpcError
  }

  // seed：-1 或 0-2147483647
  const seed = params.seed
  if (typeof seed === 'number' && Number.isInteger(seed)) {
    if (seed !== -1 && (seed < 0 || seed > 2147483647)) {
      throw { code: -32602, message: 'wan3 的 seed 必须为 -1 或 0-2147483647 的整数' } as JsonRpcError
    }
    metadata.seed = seed
  }

  // 可选参数：watermark
  const watermark = params.watermark
  if (typeof watermark === 'boolean') {
    metadata.watermark = watermark
  }

  // prompt_extend：wan3 专属；使用 file/link 媒体时上游要求必须为 true
  const promptExtend = params.prompt_extend
  if (typeof promptExtend === 'boolean') {
    metadata.prompt_extend = promptExtend
  }
  const usesFileOrLink =
    Array.isArray(metadata.media) &&
    (metadata.media as Array<{ type: string }>).some(m => m.type === 'file' || m.type === 'link')
  if (usesFileOrLink && promptExtend === false) {
    throw { code: -32602, message: '使用 file/link 媒体时 wan3 要求 prompt_extend 必须为 true' } as JsonRpcError
  }

  return { metadata, prompt }
}

/** 调用上游视频生成 API（文生/参考内容生视频，异步任务模式；Seedance 与 wan3 系列按模型分流打包） */
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
  const rawContent = extractVideoContent(params, false)
  const content = rawContent === undefined ? undefined : validateVideoContent(rawContent, model)

  const body: Record<string, unknown> = { model, prompt }
  if (isWan3Model(model)) {
    const wan3 = buildWan3Metadata(params || {}, content)
    body.prompt = wan3.prompt
    body.metadata = wan3.metadata
  } else {
    body.metadata = buildSeedanceMetadata(params || {}, content)
  }

  return submitVideoGeneration(service, body)
}

/** 调用上游视频生成 API（参考内容生视频，支持图片、帧控制、视频与音频引用） */
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

  const model = pickVideoModel(service, params)
  // 统一 content 处理：参考图、帧控制、参考视频和参考音频都用 content。
  const content = validateVideoContent(extractVideoContent(params, true), model)

  const body: Record<string, unknown> = { model, prompt }
  if (isWan3Model(model)) {
    const wan3 = buildWan3Metadata(params || {}, content)
    body.prompt = wan3.prompt
    body.metadata = wan3.metadata
  } else {
    body.metadata = buildSeedanceMetadata(params || {}, content)
  }

  return submitVideoGeneration(service, body)
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
  assertPublicHttpsUrl(input, 'input')

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
    for (const [view, url] of Object.entries(item as Record<string, unknown>)) {
      if (typeof url !== 'string' || !url.trim()) {
        throw { code: -32602, message: `inputs 的视角 ${view} 必须是公网 HTTPS 图片 URL` } as JsonRpcError
      }
      assertPublicHttpsUrl(url, `inputs.${view}`)
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
export async function query3DGenerationTask(service: McpServiceConnection, taskId: string): Promise<unknown> {
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

/* ───────────────────────── TriPo 后处理任务 ───────────────────────── */

/** 校验公网 HTTPS URL：不得携带用户信息/fragment，不得是本机、私网、回环或链路本地地址。 */
function assertPublicHttpsUrl(value: string, fieldName: string): void {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw { code: -32602, message: `${fieldName} 不是合法 URL: ${value}` } as JsonRpcError
  }
  if (url.protocol !== 'https:') {
    throw { code: -32602, message: `${fieldName} 必须是公网 HTTPS URL（当前协议 ${url.protocol}）` } as JsonRpcError
  }
  if (url.username || url.password) {
    throw { code: -32602, message: `${fieldName} 不能携带用户信息` } as JsonRpcError
  }
  if (url.hash) {
    throw { code: -32602, message: `${fieldName} 不能携带 fragment` } as JsonRpcError
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    throw { code: -32602, message: `${fieldName} 不能使用本机或本地域名，必须是公网 HTTPS URL` } as JsonRpcError
  }
  const ipVersion = isIP(host)
  if (ipVersion === 4 && !isPublicIpv4(host)) {
    throw { code: -32602, message: `${fieldName} 不能使用私网、回环或链路本地地址` } as JsonRpcError
  }
  if (ipVersion === 6 && !isPublicIpv6(host)) {
    throw { code: -32602, message: `${fieldName} 不能使用私网、回环或链路本地地址` } as JsonRpcError
  }
}

function assert3DApiKey(service: McpService): void {
  if (!service.apiKey.trim()) {
    throw { code: -32603, message: '未配置 API Key，请在设置中填写后再请求' } as JsonRpcError
  }
}

function pickPostProcessBoolean(params: Record<string, unknown>, key: string): boolean | undefined {
  const value = params[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'boolean') {
    throw { code: -32602, message: `参数 ${key} 必须是布尔值` } as JsonRpcError
  }
  return value
}

function pickPostProcessInteger(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw { code: -32602, message: `参数 ${key} 必须是整数` } as JsonRpcError
  }
  return value
}

function pickPostProcessEnum(
  params: Record<string, unknown>,
  key: string,
  allowed: readonly string[]
): string | undefined {
  const value = params[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw { code: -32602, message: `参数 ${key} 只支持 ${allowed.join(' / ')}` } as JsonRpcError
  }
  return value
}

/**
 * TriPo 后处理模型：只接受与接口匹配的公开模型前缀（如贴图只收 Tripo-Texture-*）。
 * 省略时不硬编码默认值，交给网关按接口默认模型路由。
 */
function pick3DPostProcessModel(
  service: McpService,
  params: Record<string, unknown>,
  family: string,
  action: string
): string | undefined {
  const requested = typeof params.model === 'string' ? params.model.trim() : ''
  if (requested) {
    if (!requested.startsWith(family)) {
      throw {
        code: -32602,
        message: `${action} 的 model 只能使用 ${family}* 系列公开模型，当前为 ${requested}`
      } as JsonRpcError
    }
    return requested
  }
  const fallback = service.modelId.trim()
  return fallback.startsWith(family) ? fallback : undefined
}

/** part_names：非空字符串数组，元素不能是空白字符串。 */
function parsePartNames(value: unknown, key: string): string[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || value.length === 0) {
    throw { code: -32602, message: `参数 ${key} 必须是非空字符串数组` } as JsonRpcError
  }
  const names = value.map((item) => (typeof item === 'string' ? item.trim() : ''))
  if (names.some((name) => !name)) {
    throw { code: -32602, message: `参数 ${key} 的元素不能是空白字符串` } as JsonRpcError
  }
  return names
}

/** texture_prompt：text / image / images 三者必选其一；style_image 只能搭配 text。 */
function parseTexturePrompt(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw { code: -32602, message: '参数 texture_prompt 必须是对象' } as JsonRpcError
  }
  const prompt = value as Record<string, unknown>
  const hasText = prompt.text !== undefined
  const hasImage = prompt.image !== undefined
  const hasImages = prompt.images !== undefined
  if ([hasText, hasImage, hasImages].filter(Boolean).length !== 1) {
    throw {
      code: -32602,
      message: 'texture_prompt 必须且只能包含 text / image / images 三者之一'
    } as JsonRpcError
  }

  const result: Record<string, unknown> = {}
  if (prompt.style_image !== undefined) {
    if (!hasText) {
      throw { code: -32602, message: 'texture_prompt.style_image 只能搭配 text 使用' } as JsonRpcError
    }
    if (typeof prompt.style_image !== 'string' || !prompt.style_image.trim()) {
      throw { code: -32602, message: 'texture_prompt.style_image 必须是公网 HTTPS 图片 URL' } as JsonRpcError
    }
    assertPublicHttpsUrl(prompt.style_image, 'texture_prompt.style_image')
    result.style_image = prompt.style_image.trim()
  }
  if (hasText) {
    if (typeof prompt.text !== 'string' || !prompt.text.trim()) {
      throw { code: -32602, message: 'texture_prompt.text 必须是非空字符串' } as JsonRpcError
    }
    if (prompt.text.length > 1024) {
      throw { code: -32602, message: 'texture_prompt.text 最长 1024 个字符' } as JsonRpcError
    }
    result.text = prompt.text
  } else if (hasImage) {
    if (typeof prompt.image !== 'string' || !prompt.image.trim()) {
      throw { code: -32602, message: 'texture_prompt.image 必须是公网 HTTPS 图片 URL' } as JsonRpcError
    }
    assertPublicHttpsUrl(prompt.image, 'texture_prompt.image')
    result.image = prompt.image.trim()
  } else {
    if (!Array.isArray(prompt.images) || prompt.images.length !== 4) {
      throw {
        code: -32602,
        message: 'texture_prompt.images 必须恰好包含 4 个公网 HTTPS 图片 URL'
      } as JsonRpcError
    }
    const images: string[] = []
    for (const item of prompt.images) {
      if (typeof item !== 'string' || !item.trim()) {
        throw { code: -32602, message: 'texture_prompt.images 的每一项都必须是 URL 字符串' } as JsonRpcError
      }
      assertPublicHttpsUrl(item, 'texture_prompt.images')
      images.push(item.trim())
    }
    result.images = images
  }
  return result
}

/** 提交 TriPo 后处理任务：统一 POST + 解析 {code:'success', data:{task_id,...}} 信封。 */
async function submit3DPostProcess(
  service: McpService,
  action: string,
  apiPath: string,
  body: Record<string, unknown>
): Promise<{ task_id: string; status: string; progress: string }> {
  const endpoint = `${toApiRoot(service.baseUrl)}${apiPath}`
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
    throw { code: resp.status, message: `${action} 提交失败 ${resp.status}: ${text.slice(0, 500)}` } as JsonRpcError
  }

  const result = text ? (jsonOrThrow(text) as any) : null
  assert3DResponseSuccess(result, action)
  const taskId = result?.data?.task_id
  if (!taskId) {
    throw { code: -32603, message: `${action} 返回缺少 task_id` } as JsonRpcError
  }
  return {
    task_id: taskId,
    status: result.data?.status || 'submitted',
    progress: result.data?.progress || '10%'
  }
}

/** 提取并校验后处理入参 input（公网 HTTPS URL）。 */
function pickPostProcessInput(params: Record<string, unknown>): string {
  const input = typeof params.input === 'string' ? params.input.trim() : ''
  if (!input) {
    throw { code: -32602, message: '缺少参数 input（待处理模型的公网 HTTPS URL）' } as JsonRpcError
  }
  assertPublicHttpsUrl(input, 'input')
  return input
}

/** 贴图：POST /v1/3d/models/texture */
async function postProcessTexture(
  service: McpService,
  params?: Record<string, unknown>
): Promise<unknown> {
  assert3DApiKey(service)
  const args = params || {}
  const input = pickPostProcessInput(args)

  const model = pick3DPostProcessModel(service, args, 'Tripo-Texture-', '贴图')
  const textureQuality = pickPostProcessEnum(args, 'texture_quality', [
    'fast',
    'standard',
    'detailed',
    'extreme'
  ])
  const delight = pickPostProcessBoolean(args, 'delight')
  // fast 与 delight 仅 Tripo-Texture-v3.5 支持（省略 model 时网关默认 v3.0）
  const v35Only: string[] = []
  if (textureQuality === 'fast') v35Only.push('texture_quality=fast')
  if (delight === true) v35Only.push('delight=true')
  if (v35Only.length > 0 && model !== 'Tripo-Texture-v3.5') {
    throw {
      code: -32602,
      message: `${v35Only.join('、')} 仅 Tripo-Texture-v3.5 支持；请传 model=Tripo-Texture-v3.5 或去掉该参数`
    } as JsonRpcError
  }

  const body: Record<string, unknown> = { input }
  if (model) body.model = model
  const pbr = pickPostProcessBoolean(args, 'pbr')
  if (pbr !== undefined) body.pbr = pbr
  const seed = pickPostProcessInteger(args, 'texture_seed')
  if (seed !== undefined) body.texture_seed = seed
  const alignment = pickPostProcessEnum(args, 'texture_alignment', ['original_image', 'geometry'])
  if (alignment) body.texture_alignment = alignment
  if (textureQuality) body.texture_quality = textureQuality
  const partNames = parsePartNames(args.part_names, 'part_names')
  if (partNames) body.part_names = partNames
  const compress = pickPostProcessEnum(args, 'compress', ['geometry'])
  if (compress) body.compress = compress
  const bake = pickPostProcessBoolean(args, 'bake')
  if (bake !== undefined) body.bake = bake
  if (delight !== undefined) body.delight = delight
  const texturePrompt = parseTexturePrompt(args.texture_prompt)
  if (texturePrompt) body.texture_prompt = texturePrompt

  const submitted = await submit3DPostProcess(service, '贴图', '/v1/3d/models/texture', body)
  return { tool: 'texture_model_3d', ...submitted }
}

/** 重拓扑/减面：POST /v1/3d/mesh/decimate */
async function postProcessDecimate(
  service: McpService,
  params?: Record<string, unknown>
): Promise<unknown> {
  assert3DApiKey(service)
  const args = params || {}
  const input = pickPostProcessInput(args)

  const faceLimit = pickPostProcessInteger(args, 'face_limit')
  if (faceLimit === undefined || faceLimit <= 0) {
    throw { code: -32602, message: '缺少参数 face_limit（目标面数，必须大于 0）' } as JsonRpcError
  }

  const model = pick3DPostProcessModel(service, args, 'Tripo-Retopology-', '重拓扑')
  const bake = pickPostProcessBoolean(args, 'bake')
  const partNames = parsePartNames(args.part_names, 'part_names')
  if (model === 'Tripo-Retopology-v1.0') {
    const unsupported: string[] = []
    if (bake !== undefined) unsupported.push('bake')
    if (partNames) unsupported.push('part_names')
    if (unsupported.length > 0) {
      throw {
        code: -32602,
        message: `${unsupported.join('、')} 仅 Tripo-Retopology-v2.0 支持`
      } as JsonRpcError
    }
  }

  const body: Record<string, unknown> = { input, face_limit: faceLimit }
  if (model) body.model = model
  const quad = pickPostProcessBoolean(args, 'quad')
  if (quad !== undefined) body.quad = quad
  if (bake !== undefined) body.bake = bake
  if (partNames) body.part_names = partNames

  const submitted = await submit3DPostProcess(service, '重拓扑', '/v1/3d/mesh/decimate', body)
  return { tool: 'decimate_mesh_3d', ...submitted }
}

/** 网格分割：POST /v1/3d/mesh/segment */
async function postProcessSegment(
  service: McpService,
  params?: Record<string, unknown>
): Promise<unknown> {
  assert3DApiKey(service)
  const args = params || {}
  const input = pickPostProcessInput(args)

  const model = pick3DPostProcessModel(service, args, 'Tripo-Segment-', '网格分割')
  const granularity = pickPostProcessEnum(args, 'segmentation_granularity', [
    'simple',
    'balanced',
    'detailed'
  ])
  const splitByConnectivity = pickPostProcessBoolean(args, 'split_by_connectivity')
  const refImage = typeof args.ref_image === 'string' ? args.ref_image.trim() : ''

  if (model === 'Tripo-Segment-v1.0') {
    const unsupported: string[] = []
    if (granularity) unsupported.push('segmentation_granularity')
    if (splitByConnectivity !== undefined) unsupported.push('split_by_connectivity')
    if (refImage) unsupported.push('ref_image')
    if (unsupported.length > 0) {
      throw {
        code: -32602,
        message: `${unsupported.join('、')} 仅 Tripo-Segment-v2.0 支持`
      } as JsonRpcError
    }
  }
  if (refImage) {
    assertPublicHttpsUrl(refImage, 'ref_image')
    if (granularity || splitByConnectivity !== undefined) {
      throw {
        code: -32602,
        message: 'ref_image 不能与 segmentation_granularity / split_by_connectivity 同时使用'
      } as JsonRpcError
    }
  }

  const body: Record<string, unknown> = { input }
  if (model) body.model = model
  if (granularity) body.segmentation_granularity = granularity
  if (splitByConnectivity !== undefined) body.split_by_connectivity = splitByConnectivity
  if (refImage) body.ref_image = refImage

  const submitted = await submit3DPostProcess(service, '网格分割', '/v1/3d/mesh/segment', body)
  return { tool: 'segment_mesh_3d', ...submitted }
}

/** 绑骨检测：POST /v1/3d/animations/rig-check（无模型参数，免费任务） */
async function postProcessRigCheck(
  service: McpService,
  params?: Record<string, unknown>
): Promise<unknown> {
  assert3DApiKey(service)
  const input = pickPostProcessInput(params || {})

  // URL 路径带扩展名时必须是 .glb
  let pathname = ''
  try {
    pathname = new URL(input).pathname.toLowerCase()
  } catch {
    /* pickPostProcessInput 已校验过合法性 */
  }
  const ext = path.extname(pathname)
  if (ext && ext !== '.glb') {
    throw {
      code: -32602,
      message: `绑骨检测的 input 路径带扩展名时必须是 .glb（当前 ${ext}）`
    } as JsonRpcError
  }

  const submitted = await submit3DPostProcess(service, '绑骨检测', '/v1/3d/animations/rig-check', {
    input
  })
  return { tool: 'rig_check_3d', ...submitted }
}

/** 绑骨：POST /v1/3d/animations/rig */
async function postProcessRig(
  service: McpService,
  params?: Record<string, unknown>
): Promise<unknown> {
  assert3DApiKey(service)
  const args = params || {}
  const input = pickPostProcessInput(args)

  const model = pick3DPostProcessModel(service, args, 'Tripo-Rigging-', '绑骨')
  const rigType = pickPostProcessEnum(args, 'rig_type', [
    'biped',
    'quadruped',
    'hexapod',
    'octopod',
    'avian',
    'serpentine',
    'aquatic'
  ])
  if (model === 'Tripo-Rigging-v1.0' && rigType && rigType !== 'biped') {
    throw {
      code: -32602,
      message: 'Tripo-Rigging-v1.0 仅支持 rig_type=biped；其他骨架类型请使用 Tripo-Rigging-v2.5'
    } as JsonRpcError
  }

  const body: Record<string, unknown> = { input }
  if (model) body.model = model
  if (rigType) body.rig_type = rigType
  const spec = pickPostProcessEnum(args, 'spec', ['tripo', 'mixamo'])
  if (spec) body.spec = spec
  const outFormat = pickPostProcessEnum(args, 'out_format', ['glb', 'fbx'])
  if (outFormat) body.out_format = outFormat

  const submitted = await submit3DPostProcess(service, '绑骨', '/v1/3d/animations/rig', body)
  return { tool: 'rig_model_3d', ...submitted }
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

  return uploadToCloudStorage({
    baseUrl: service.baseUrl,
    apiKey: service.apiKey,
    buffer,
    filename,
    provider: (rawProvider || undefined) as CloudStorageProvider | undefined,
    keyPrefix: 'mcp-uploads',
    expiresIn: parsePresignedExpires(params?.expires_in)
  })
}

/** tools/list 声明。 */
function listTools(serviceType: string): unknown[] {
  if (serviceType === 'image-generation') {
    return [
      {
        name: 'image_generation',
        description:
          '生成图片（支持 Gemini 3 Pro Image / GPT Image 2 / GPT Image 2.5 Flare / GPT Image 2.5 Sunburst），模型由参数 model 指定',
        inputSchema: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: '图片描述（必填）' },
            model: {
              type: 'string',
              enum: BUILTIN_MCP_IMAGE_DEFAULTS.models,
              description:
                '模型 ID，缺省使用默认模型；gpt-image-2.5-flare 偏极速生成，gpt-image-2.5-sunburst 偏高精度精修与多轮迭代一致性'
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
        description:
          '图生图（基于输入图片重绘/编辑，支持 Gemini 3 Pro Image / GPT Image 2 / GPT Image 2.5 Flare / GPT Image 2.5 Sunburst），模型由参数 model 指定',
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
              description:
                '模型 ID，缺省使用默认模型；gpt-image-2.5-flare 偏极速生成，gpt-image-2.5-sunburst 偏高精度精修与多轮迭代一致性'
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
        description: '文生/参考内容生视频（支持参考图、首帧可选尾帧、公网参考视频和音频 URL），模型由参数 model 指定',
        inputSchema: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: '视频描述（必填）' },
            content: VIDEO_CONTENT_SCHEMA,
            metadata: {
              type: 'object',
              properties: { content: VIDEO_CONTENT_SCHEMA },
              additionalProperties: false,
              description: '兼容上游请求写法：metadata.content 与顶层 content 等价，二者只能选一'
            },
            model: {
              type: 'string',
              enum: BUILTIN_MCP_VIDEO_DEFAULTS.models,
              description:
                '模型 ID，缺省使用默认模型；wan3.0-video 走 Wan3 接口，其余为 doubao-seedance'
            },
            resolution: {
              type: 'string',
              enum: BUILTIN_MCP_VIDEO_DEFAULTS.resolutions,
              description: '视频分辨率：480p、720p、1080p、4K；4K 仅 doubao-seedance 支持，wan3 系列为 480P/720P/1080P'
            },
            seconds: {
              type: 'integer',
              description: '视频时长（秒）：doubao-seedance 为 4-15、wan3 系列为 2-30 的整数，或 -1（模型自动选择）'
            },
            ratio: {
              type: 'string',
              enum: BUILTIN_MCP_VIDEO_DEFAULTS.ratios,
              description: '宽高比：21:9、16:9、4:3、1:1、3:4、9:16、adaptive'
            },
            fps: {
              type: 'integer',
              enum: BUILTIN_MCP_VIDEO_DEFAULTS.fps,
              description: '帧率：24 或 60（仅 doubao-seedance 支持，wan3 系列不支持）'
            },
            generate_audio: {
              type: 'boolean',
              description: '是否生成音频（兼容旧参数名 audio；Seedance 默认 false，wan3 系列上游默认 true）'
            },
            prompt_extend: {
              type: 'boolean',
              description: 'wan3 系列专属：是否开启提示词智能改写，默认 true；使用 file/link 媒体时必须为 true'
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
        description: '参考内容生视频（支持参考图、首帧可选尾帧、公网参考视频和音频 URL），模型由参数 model 指定',
        inputSchema: {
          type: 'object',
          properties: {
            content: VIDEO_CONTENT_SCHEMA,
            prompt: { type: 'string', description: '视频描述（必填，与 content 中 text 项互补）' },
            model: {
              type: 'string',
              enum: BUILTIN_MCP_VIDEO_DEFAULTS.models,
              description:
                '模型 ID，缺省使用默认模型；wan3.0-video 走 Wan3 接口，其余为 doubao-seedance'
            },
            resolution: {
              type: 'string',
              enum: BUILTIN_MCP_VIDEO_DEFAULTS.resolutions,
              description: '视频分辨率：480p、720p、1080p、4K；4K 仅 doubao-seedance 支持，wan3 系列为 480P/720P/1080P'
            },
            seconds: {
              type: 'integer',
              description: '视频时长（秒）：doubao-seedance 为 4-15、wan3 系列为 2-30 的整数，或 -1（模型自动选择）'
            },
            ratio: {
              type: 'string',
              enum: BUILTIN_MCP_VIDEO_DEFAULTS.ratios,
              description: '宽高比：21:9、16:9、4:3、1:1、3:4、9:16、adaptive'
            },
            fps: {
              type: 'integer',
              enum: BUILTIN_MCP_VIDEO_DEFAULTS.fps,
              description: '帧率：24 或 60（仅 doubao-seedance 支持，wan3 系列不支持）'
            },
            generate_audio: {
              type: 'boolean',
              description: '是否生成音频（兼容旧参数名 audio；Seedance 默认 false，wan3 系列上游默认 true）'
            },
            prompt_extend: {
              type: 'boolean',
              description: 'wan3 系列专属：是否开启提示词智能改写，默认 true；使用 file/link 媒体时必须为 true'
            },
            seed: {
              type: 'integer',
              description: '随机种子，整数'
            },
            watermark: {
              type: 'boolean',
              description: '是否添加水印，默认 false'
            },
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
        name: 'texture_model_3d',
        description:
          '模型贴图：为已有 3D 模型生成或更新贴图，提交 TriPo 后处理任务；提交后用 generation_3d_task_query 查询进度',
        inputSchema: {
          type: 'object',
          properties: {
            input: { type: 'string', description: '待处理模型的公网 HTTPS URL（必填）' },
            model: {
              type: 'string',
              description:
                '公开模型：Tripo-Texture-v3.5 / Tripo-Texture-v3.0（默认）/ Tripo-Texture-v2.5；texture_quality=fast 与 delight=true 仅 v3.5 支持'
            },
            pbr: { type: 'boolean', description: '是否生成 PBR 贴图' },
            texture_seed: { type: 'integer', description: '贴图随机种子' },
            texture_alignment: {
              type: 'string',
              enum: ['original_image', 'geometry'],
              description: '贴图对齐方式'
            },
            texture_quality: {
              type: 'string',
              enum: ['fast', 'standard', 'detailed', 'extreme'],
              description: '贴图质量档位，省略按 standard 计费；fast 仅 v3.5 支持'
            },
            part_names: {
              type: 'array',
              items: { type: 'string' },
              description: '需要处理的部件名列表，元素不能为空白字符串'
            },
            compress: { type: 'string', enum: ['geometry'], description: '压缩方式，仅允许 geometry' },
            bake: { type: 'boolean', description: '是否烘焙' },
            delight: { type: 'boolean', description: '是否去光照，仅 v3.5 支持设为 true' },
            texture_prompt: {
              type: 'object',
              description:
                '贴图提示词：text（≤1024 字符）/ image（单张公网 HTTPS 图片 URL）/ images（恰好 4 张公网 HTTPS 图片 URL）三者必选其一；style_image（公网 HTTPS URL）只能搭配 text 使用'
            }
          },
          required: ['input']
        }
      },
      {
        name: 'decimate_mesh_3d',
        description:
          '重拓扑/减面：降低 3D 模型面数，提交 TriPo 后处理任务；提交后用 generation_3d_task_query 查询进度',
        inputSchema: {
          type: 'object',
          properties: {
            input: { type: 'string', description: '待处理模型的公网 HTTPS URL（必填）' },
            model: {
              type: 'string',
              description:
                '公开模型：Tripo-Retopology-v2.0（默认）/ Tripo-Retopology-v1.0；bake 与 part_names 仅 v2.0 支持'
            },
            face_limit: { type: 'integer', description: '目标面数，必须大于 0（必填）' },
            quad: { type: 'boolean', description: '是否生成四边形面' },
            bake: { type: 'boolean', description: '是否烘焙，仅 v2.0 支持' },
            part_names: {
              type: 'array',
              items: { type: 'string' },
              description: '需要处理的部件名列表，仅 v2.0 支持'
            }
          },
          required: ['input', 'face_limit']
        }
      },
      {
        name: 'segment_mesh_3d',
        description:
          '网格分割：按部件拆分 3D 模型网格，提交 TriPo 后处理任务；提交后用 generation_3d_task_query 查询进度',
        inputSchema: {
          type: 'object',
          properties: {
            input: { type: 'string', description: '待处理模型的公网 HTTPS URL（必填）' },
            model: {
              type: 'string',
              description:
                '公开模型：Tripo-Segment-v2.0 / Tripo-Segment-v1.0（默认）；粒度/连通域/参考图仅 v2.0 支持'
            },
            segmentation_granularity: {
              type: 'string',
              enum: ['simple', 'balanced', 'detailed'],
              description: '分割粒度，仅 v2.0 支持；不能与 ref_image 同时使用'
            },
            split_by_connectivity: {
              type: 'boolean',
              description: '按连通域拆分，仅 v2.0 支持；不能与 ref_image 同时使用'
            },
            ref_image: {
              type: 'string',
              description: '公网 HTTPS 参考图 URL，仅 v2.0 支持；不能与粒度/连通域参数同时使用'
            }
          },
          required: ['input']
        }
      },
      {
        name: 'rig_check_3d',
        description:
          '绑骨检测：检测模型是否可绑骨及建议的骨架类型（免费任务，无模型参数）；结果见任务查询返回的 riggable / rig_type',
        inputSchema: {
          type: 'object',
          properties: {
            input: {
              type: 'string',
              description: '公网 HTTPS GLB URL（必填）；URL 路径带扩展名时必须是 .glb'
            }
          },
          required: ['input']
        }
      },
      {
        name: 'rig_model_3d',
        description:
          '绑骨：为 3D 模型绑定骨骼，提交 TriPo 后处理任务；提交后用 generation_3d_task_query 查询进度',
        inputSchema: {
          type: 'object',
          properties: {
            input: { type: 'string', description: '待处理模型的公网 HTTPS URL（必填）' },
            model: {
              type: 'string',
              description:
                '公开模型：Tripo-Rigging-v2.5 / Tripo-Rigging-v1.0（默认，仅支持 biped）'
            },
            rig_type: {
              type: 'string',
              enum: ['biped', 'quadruped', 'hexapod', 'octopod', 'avian', 'serpentine', 'aquatic'],
              description: '骨架类型；v1.0 仅支持 biped'
            },
            spec: { type: 'string', enum: ['tripo', 'mixamo'], description: '骨架规范' },
            out_format: { type: 'string', enum: ['glb', 'fbx'], description: '输出格式' }
          },
          required: ['input']
        }
      },
      {
        name: 'generation_3d_task_query',
        description: '查询 3D 生成/后处理任务状态和结果 URL（单次查询，不轮询）',
        inputSchema: {
          type: 'object',
          properties: {
            task_id: {
              type: 'string',
              description: '任务 ID（3D 生成/后处理提交工具返回）'
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
  req: JsonRpcRequest,
  clientName?: string
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
          } else if (toolName === 'texture_model_3d') {
            output = await postProcessTexture(service, args)
          } else if (toolName === 'decimate_mesh_3d') {
            output = await postProcessDecimate(service, args)
          } else if (toolName === 'segment_mesh_3d') {
            output = await postProcessSegment(service, args)
          } else if (toolName === 'rig_check_3d') {
            output = await postProcessRigCheck(service, args)
          } else if (toolName === 'rig_model_3d') {
            output = await postProcessRig(service, args)
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
        // 生成资产归档：工具成功返回后 fire-and-forget 通知钩子，绝不影响工具响应
        if (output !== null && output !== undefined && toolCallHook) {
          try {
            toolCallHook({ service, toolName, args, output, clientName })
          } catch {
            /* 归档入口异常不影响工具调用 */
          }
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
  // best-effort 调用方识别：initialize 的 clientInfo 优先（按 mcp-session-id 记忆），退路 User-Agent 关键字
  const sessionClients = new Map<string, string>()

  function resolveClientName(req: http.IncomingMessage): string | undefined {
    const sid = req.headers['mcp-session-id']
    if (typeof sid === 'string' && sid.trim()) {
      const known = sessionClients.get(sid.trim())
      if (known) return known
    }
    const ua = req.headers['user-agent']
    if (typeof ua === 'string' && ua.trim()) {
      const l = ua.toLowerCase()
      if (l.includes('workbuddy')) return 'WorkBuddy'
      if (l.includes('codex')) return 'Codex'
      return ua.slice(0, 80)
    }
    return undefined
  }

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

      // initialize 时顺手记忆 clientInfo（按 mcp-session-id），不改变响应内容
      if (body.method === 'initialize') {
        const clientInfoName = (body.params as { clientInfo?: { name?: unknown } } | undefined)?.clientInfo
          ?.name
        const sid = req.headers['mcp-session-id']
        if (typeof clientInfoName === 'string' && clientInfoName.trim() && typeof sid === 'string' && sid.trim()) {
          sessionClients.set(sid.trim(), clientInfoName.trim().slice(0, 80))
        }
      }

      // JSON-RPC 2.0 通知（请求无 id 字段，如 notifications/initialized）：
      // 规范要求回 202 Accepted 空响应，不产生 JSON-RPC 响应体，严格客户端会校验这一点。
      if (body.id === undefined) {
        res.writeHead(202)
        res.end()
        return
      }

      const response = await dispatch(service, body, resolveClientName(req))
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
