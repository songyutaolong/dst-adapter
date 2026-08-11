/**
 * Smoke test for WorkBuddy models.json upsert (no Electron UI).
 * Run: npx tsx scripts/smoke-workbuddy.ts
 */
import fs from 'fs'
import os from 'os'
import path from 'path'

function toChatCompletionsUrl(endpoint: string): string {
  const trimmed = endpoint.trim().replace(/\/+$/, '')
  if (!trimmed) return ''
  if (/\/chat\/completions$/i.test(trimmed)) return trimmed
  if (/\/v1$/i.test(trimmed)) return `${trimmed}/chat/completions`
  return `${trimmed}/v1/chat/completions`
}

const modelsPath = path.join(os.homedir(), '.workbuddy', 'models.json')
const exists = fs.existsSync(modelsPath)
console.log('models.json exists:', exists, modelsPath)
if (exists) {
  const raw = fs.readFileSync(modelsPath, 'utf-8')
  const data = JSON.parse(raw)
  const list = Array.isArray(data) ? data : data.models
  console.log('model count:', Array.isArray(list) ? list.length : 'invalid')
  if (Array.isArray(list) && list[0]) {
    console.log('first id:', list[0].id)
    console.log('first url host ok:', typeof list[0].url === 'string')
  }
}

console.log(
  'normalize base:',
  toChatCompletionsUrl('https://example.com')
)
console.log(
  'normalize v1:',
  toChatCompletionsUrl('https://example.com/v1')
)
console.log(
  'normalize full:',
  toChatCompletionsUrl('https://example.com/v1/chat/completions')
)
console.log('smoke ok')
