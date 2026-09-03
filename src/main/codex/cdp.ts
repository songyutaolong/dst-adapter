import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { CODEX_INJECTION_SOURCE } from './inject'

const execFileAsync = promisify(execFile)

function buildInjectionRunner(webSocketDebuggerUrl: string): string {
  return `const source = ${JSON.stringify(CODEX_INJECTION_SOURCE)};
const url = ${JSON.stringify(webSocketDebuggerUrl)};
const socket = new WebSocket(url);
const timer = setTimeout(() => {
  try { socket.close(); } catch {}
  console.error('CDP_TIMEOUT');
  process.exit(2);
}, 10000);
socket.addEventListener('open', () => {
  socket.send(JSON.stringify({
    id: 1,
    method: 'Page.addScriptToEvaluateOnNewDocument',
    params: { source }
  }));
  socket.send(JSON.stringify({
    id: 2,
    method: 'Runtime.evaluate',
    params: { expression: source, returnByValue: true }
  }));
});
socket.addEventListener('message', (event) => {
  try {
    const message = JSON.parse(String(event.data));
    if (message.id === 2) {
      clearTimeout(timer);
      socket.close();
      if (message.error) {
        console.error(JSON.stringify(message.error));
        process.exit(3);
      }
      process.exit(0);
    }
  } catch {}
});
socket.addEventListener('error', () => {
  clearTimeout(timer);
  console.error('CDP_ERROR');
  process.exit(4);
});
`
}

export async function injectCodexTarget(
  webSocketDebuggerUrl: string
): Promise<void> {
  // Avoid Windows command-line length limits that break `node -e`.
  const file = path.join(
    os.tmpdir(),
    `dasuantou-codex-inject-${process.pid}-${Date.now()}.js`
  )
  fs.writeFileSync(file, buildInjectionRunner(webSocketDebuggerUrl), 'utf-8')
  try {
    await execFileAsync('node', [file], {
      windowsHide: true,
      timeout: 15000,
      maxBuffer: 1024 * 1024
    })
  } finally {
    try {
      fs.unlinkSync(file)
    } catch {
      // ignore cleanup errors
    }
  }
}
