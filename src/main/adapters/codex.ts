import fs from 'fs'
import os from 'os'
import path from 'path'
import type { ApplyResult, DetectResult, Provider } from '../../shared/types'
import { toOpenAiRoot } from '../../shared/url'
import { atomicWriteText, backupFile, getSettings, listProviders } from '../store'
import {
  findCodexExecutable,
  isCodexInstalled,
  launchCodex
} from '../codex/launcher'
import { startCodexProxy } from '../codex/proxy'
import type { AppAdapter } from './types'

function codexDir(): string {
  return path.join(os.homedir(), '.codex')
}

function configPath(): string {
  return path.join(codexDir(), 'config.toml')
}

function authPath(): string {
  return path.join(codexDir(), 'auth.json')
}

function tomlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function catalogPath(): string {
  return path.join(codexDir(), 'dasuantou-models.json')
}

function stripManagedConfig(raw: string): string {
  const lines = raw.split(/\r?\n/)
  const result: string[] = []
  let skippingManagedSection = false
  let inSection = false

  for (const line of lines) {
    if (/^\s*\[model_providers\.dasuantou(?:[.\]].*)?$/.test(line)) {
      skippingManagedSection = true
      continue
    }
    if (skippingManagedSection && /^\s*\[/.test(line)) {
      if (/^\s*\[model_providers\.dasuantou(?:[.\]].*)?$/.test(line)) {
        continue
      }
      skippingManagedSection = false
    }
    if (skippingManagedSection) continue
    if (/^\s*\[/.test(line)) inSection = true
    if (
      !inSection &&
      /^\s*(model|model_provider|model_catalog_json|model_reasoning_effort)\s*=/.test(
        line
      )
    ) {
      continue
    }
    if (/^\s*#\s*dasuantou-managed/.test(line)) continue
    result.push(line)
  }
  return result.join('\n').trim()
}

function buildModelCatalog(provider: Provider): unknown {
  const slug = (provider.model || 'default').trim()
  const displayName = (provider.name || provider.model || '大算头').trim() || slug
  return {
    models: [
      {
        slug,
        display_name: displayName,
        description: `${displayName}（通过大算头适配器）`,
        default_reasoning_level: 'medium',
        supported_reasoning_levels: [
          { effort: 'low', description: '快速' },
          { effort: 'medium', description: '均衡' },
          { effort: 'high', description: '深入' }
        ],
        shell_type: 'shell_command',
        visibility: 'list',
        supported_in_api: true,
        priority: 0,
        availability_nux: null,
        upgrade: null,
        base_instructions:
          'You are Codex, a coding agent. You help the user with software engineering tasks.',
        supports_reasoning_summaries: true,
        support_verbosity: false,
        default_verbosity: null,
        apply_patch_tool_type: null,
        truncation_policy: { mode: 'tokens', limit: 10000 },
        supports_parallel_tool_calls: true,
        experimental_supported_tools: [],
        context_window: 200000,
        max_context_window: 200000,
        input_modalities: ['text', 'image']
      }
    ]
  }
}

function buildConfig(
  existing: string,
  provider: Provider,
  baseUrl: string,
  catalogFile: string
): string {
  const preserved = stripManagedConfig(existing)
  const displayName = (provider.name || '大算头').trim() || '大算头'
  // Do NOT set env_key: Store/GUI launches cannot inherit shell env vars,
  // and env_key causes "Missing environment variable: OPENAI_API_KEY".
  const managed = [
    '# dasuantou-managed: Codex pure API provider',
    `model = ${tomlString(provider.model || 'default')}`,
    'model_provider = "dasuantou"',
    `model_catalog_json = ${tomlString(catalogFile)}`,
    '',
    '[model_providers.dasuantou]',
    `name = ${tomlString(displayName)}`,
    `base_url = ${tomlString(baseUrl)}`,
    'wire_api = "responses"',
    'requires_openai_auth = false',
    `experimental_bearer_token = ${tomlString(provider.apiKey.trim())}`
  ].join('\n')
  return `${managed}${preserved ? `\n\n${preserved}` : ''}\n`
}

async function resolveBaseUrl(provider: Provider): Promise<string> {
  if (provider.wireApi === 'responses') {
    return toOpenAiRoot(provider.endpoint)
  }
  const port = await startCodexProxy(provider)
  return `http://127.0.0.1:${port}/v1`
}

async function detect(): Promise<DetectResult> {
  const executable = findCodexExecutable()
  const configExists = fs.existsSync(codexDir())
  return {
    installed: isCodexInstalled(),
    configPath: configPath(),
    detail: executable
      ? `已检测到 Codex：${executable}`
      : configExists
        ? '检测到 Codex 配置，但未找到桌面应用'
        : '未检测到 Codex，点击下载前往官网'
  }
}

async function readLive(): Promise<unknown> {
  return {
    config: fs.existsSync(configPath())
      ? fs.readFileSync(configPath(), 'utf-8')
      : '',
    auth: fs.existsSync(authPath())
      ? JSON.parse(fs.readFileSync(authPath(), 'utf-8'))
      : null
  }
}

async function writeLive(provider: Provider): Promise<ApplyResult> {
  fs.mkdirSync(codexDir(), { recursive: true })
  const configBackup = backupFile('codex', configPath())
  const authBackup = backupFile('codex', authPath())
  const existing = fs.existsSync(configPath())
    ? fs.readFileSync(configPath(), 'utf-8')
    : ''

  const baseUrl = await resolveBaseUrl(provider)
  const catalogFile = catalogPath()
  atomicWriteText(
    catalogFile,
    `${JSON.stringify(buildModelCatalog(provider), null, 2)}\n`
  )
  atomicWriteText(
    configPath(),
    buildConfig(existing, provider, baseUrl, catalogFile.replace(/\\/g, '/'))
  )

  // Pure API mode: keep only the API key, no ChatGPT OAuth tokens.
  atomicWriteText(
    authPath(),
    `${JSON.stringify(
      {
        OPENAI_API_KEY: provider.apiKey.trim()
      },
      null,
      2
    )}\n`
  )

  return {
    ok: true,
    message: '已启用 Codex 纯 API（无需 OpenAI 账号）',
    backupPath: configBackup || authBackup
  }
}

async function launch(): Promise<{
  injected: boolean
  message: string
}> {
  const provider = listProviders('codex').find((item) => item.enabled)
  if (!provider) throw new Error('请先启用一个 Codex Provider')

  // Refresh proxy port + auth before every launch.
  await writeLive(provider)

  const enhancements = getSettings().codexEnhancements
  const result = await launchCodex(provider, enhancements)
  if (enhancements && !result.injected) {
    return {
      injected: false,
      message:
        'Codex 已启动，但界面增强未注入。请完全退出 Codex/ChatGPT 后重试「打开应用」。'
    }
  }
  return {
    injected: result.injected,
    message: result.injected
      ? 'Codex 已启动，并已注入界面增强'
      : 'Codex 已启动'
  }
}

export const codexAdapter: AppAdapter = {
  id: 'codex',
  name: 'Codex',
  implemented: false,
  detect,
  readLive,
  writeLive,
  launch
}
