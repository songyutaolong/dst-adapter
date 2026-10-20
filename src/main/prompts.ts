import type { Prompt } from '../shared/types'
import type { PromptTemplate } from '../shared/prompts'
import { isPlatformConfigured, platformErrorMessage, platformRequest } from './assets/platform'

/**
 * 提示词管理平台对接（UP-Studio 第三方集成接口）
 *
 * - 公司模板：GET /api/v1/prompt-templates（只读，支持服务端过滤，此处拉全量后本地过滤）
 * - 个人提示词：GET/POST /api/v1/my-prompts、PUT/DELETE /api/v1/my-prompts/:id
 *
 * 复用 AI 能力平台的机器令牌（见 assets/platform），令牌过期自动换新重试。
 */

const PROMPT_NAME_MAX = 64
const PROMPT_CONTENT_MAX = 5000

/** 平台返回的模板原始结构（snake_case） */
interface PlatformTemplateRaw {
  id?: unknown
  name?: unknown
  content?: unknown
  summary?: unknown
  category?: unknown
  tags?: unknown
  target_workflow?: unknown
}

/** 平台返回的个人提示词原始结构（snake_case） */
interface PlatformMyPromptRaw {
  id?: unknown
  name?: unknown
  content?: unknown
  tags?: unknown
  created_at?: unknown
  updated_at?: unknown
}

function assertConfigured(): void {
  if (!isPlatformConfigured()) {
    throw new Error('未配置 AI 能力平台（请在设置中填写 Base URL / Key / Secret）')
  }
}

/** 非 2xx 统一抛可读错误。 */
function requireOk(
  ok: boolean,
  body: Record<string, unknown> | null,
  status: number,
  fallback: string
): void {
  if (!ok) throw new Error(platformErrorMessage(body, fallback, status))
}

/** 从响应中取数组（兼容裸数组与 {data:[...]} 包裹两种结构）。 */
function pickArray(body: Record<string, unknown> | null): Record<string, unknown>[] {
  if (Array.isArray(body)) return body as Record<string, unknown>[]
  if (body && Array.isArray(body.data)) return body.data as Record<string, unknown>[]
  return []
}

/** 从响应中取对象（兼容 {data:{...}} 包裹与平铺两种结构）。 */
function pickDataObject(body: Record<string, unknown> | null): Record<string, unknown> {
  if (body && typeof body.data === 'object' && body.data !== null && !Array.isArray(body.data)) {
    return body.data as Record<string, unknown>
  }
  return body ?? {}
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((t): t is string => typeof t === 'string')
    .map((t) => t.trim())
    .filter(Boolean)
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function mapTemplate(raw: Record<string, unknown>): PromptTemplate {
  const r = raw as PlatformTemplateRaw
  return {
    id: String(r.id ?? ''),
    name: String(r.name ?? ''),
    description: typeof r.summary === 'string' ? r.summary : '',
    content: String(r.content ?? ''),
    category: optionalString(r.category),
    tags: asStringArray(r.tags),
    targetWorkflow: optionalString(r.target_workflow)
  }
}

function mapMyPrompt(raw: Record<string, unknown>): Prompt {
  const r = raw as PlatformMyPromptRaw
  const fallbackTime = new Date(0).toISOString()
  return {
    id: String(r.id ?? ''),
    name: String(r.name ?? ''),
    content: String(r.content ?? ''),
    tags: asStringArray(r.tags),
    createdAt: typeof r.created_at === 'string' ? r.created_at : fallbackTime,
    updatedAt: typeof r.updated_at === 'string' ? r.updated_at : fallbackTime
  }
}

function validateName(name: unknown): string {
  const n = typeof name === 'string' ? name.trim() : ''
  if (!n) throw new Error('请填写提示词名称')
  if (n.length > PROMPT_NAME_MAX) throw new Error(`提示词名称不能超过 ${PROMPT_NAME_MAX} 个字符`)
  return n
}

function validateContent(content: unknown): string {
  const c = typeof content === 'string' ? content.trim() : ''
  if (!c) throw new Error('请填写提示词内容')
  if (c.length > PROMPT_CONTENT_MAX) {
    throw new Error(`提示词内容不能超过 ${PROMPT_CONTENT_MAX} 个字符`)
  }
  return c
}

/** 标签规整：undefined/null 表示不改；去空白、去重、剔除空项。 */
function normalizeTags(tags: unknown): string[] | undefined {
  if (tags === undefined || tags === null) return undefined
  if (!Array.isArray(tags)) throw new Error('标签必须是字符串数组')
  const list = tags
    .map((t) => (typeof t === 'string' ? t.trim() : ''))
    .filter(Boolean)
  return [...new Set(list)]
}

/** 拉取公司已上架提示词模板（只读，全量）。 */
export async function listPlatformPromptTemplates(): Promise<PromptTemplate[]> {
  assertConfigured()
  const { ok, status, body } = await platformRequest('GET', '/api/v1/prompt-templates')
  requireOk(ok, body, status, '获取公司提示词模板失败')
  return pickArray(body)
    .map(mapTemplate)
    .filter((t) => t.id && t.name)
}

/** 拉取当前账号的个人提示词列表。 */
export async function listPlatformMyPrompts(): Promise<Prompt[]> {
  assertConfigured()
  const { ok, status, body } = await platformRequest('GET', '/api/v1/my-prompts')
  requireOk(ok, body, status, '获取个人提示词失败')
  return pickArray(body)
    .map(mapMyPrompt)
    .filter((p) => p.id)
}

/** 新建个人提示词（名称/正文/标签），返回平台落库后的记录。 */
export async function createPlatformMyPrompt(
  input: Omit<Prompt, 'id' | 'createdAt' | 'updatedAt'>
): Promise<Prompt> {
  assertConfigured()
  const payload: Record<string, unknown> = {
    name: validateName(input.name),
    content: validateContent(input.content)
  }
  const tags = normalizeTags(input.tags)
  if (tags) payload.tags = tags
  const { ok, status, body } = await platformRequest('POST', '/api/v1/my-prompts', payload)
  requireOk(ok, body, status, '创建个人提示词失败')
  const created = pickDataObject(body)
  if (!created.id) throw new Error('创建个人提示词响应缺少 id')
  return mapMyPrompt(created)
}

/** 编辑本人个人提示词（字段缺省表示不改）。 */
export async function updatePlatformMyPrompt(
  id: string,
  patch: Partial<Omit<Prompt, 'id' | 'createdAt'>>
): Promise<Prompt> {
  assertConfigured()
  if (!id) throw new Error('缺少提示词 ID')
  const payload: Record<string, unknown> = {}
  if (patch.name !== undefined) payload.name = validateName(patch.name)
  if (patch.content !== undefined) payload.content = validateContent(patch.content)
  const tags = normalizeTags(patch.tags)
  if (tags !== undefined) payload.tags = tags
  const { ok, status, body } = await platformRequest(
    'PUT',
    `/api/v1/my-prompts/${encodeURIComponent(id)}`,
    payload
  )
  requireOk(ok, body, status, '保存个人提示词失败')
  const updated = pickDataObject(body)
  if (!updated.id) throw new Error('保存个人提示词响应缺少 id')
  return mapMyPrompt(updated)
}

/** 删除本人个人提示词（204 无返回体）。 */
export async function deletePlatformMyPrompt(id: string): Promise<boolean> {
  assertConfigured()
  if (!id) throw new Error('缺少提示词 ID')
  const { ok, status, body } = await platformRequest(
    'DELETE',
    `/api/v1/my-prompts/${encodeURIComponent(id)}`
  )
  requireOk(ok, body, status, '删除个人提示词失败')
  return true
}
