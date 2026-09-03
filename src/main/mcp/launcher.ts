import http from 'http'
import type { McpService } from '../../shared/types'
import {
  BUILTIN_MCP_IMAGE_ID,
  BUILTIN_MCP_IMAGE_PORT,
  BUILTIN_MCP_VIDEO_ID,
  BUILTIN_MCP_VIDEO_PORT,
  MCP_DEFAULT_PORT
} from '../../shared/types'
import { startMcpServer } from './server'

// 管理运行中的 MCP 服务（真实本地 HTTP 服务）
const runningServers = new Map<string, { server: http.Server; port: number }>()

export interface McpLaunchResult {
  ok: boolean
  port?: number
  error?: string
}

/** 根据服务 ID 获取对应端口 */
function getPortForService(serviceId: string): number {
  if (serviceId === BUILTIN_MCP_IMAGE_ID) return BUILTIN_MCP_IMAGE_PORT
  if (serviceId === BUILTIN_MCP_VIDEO_ID) return BUILTIN_MCP_VIDEO_PORT
  return MCP_DEFAULT_PORT
}

/**
 * 启动 MCP 服务（Streamable HTTP，监听 127.0.0.1 固定端口）。
 * 内置服务使用各自固定端口：图片 17888，视频 17889。
 * 固定端口保证客户端配置一次后长期有效；应用重启端口不变。
 */
export async function launchMcpService(service: McpService): Promise<McpLaunchResult> {
  if (runningServers.has(service.id)) {
    return { ok: false, error: '服务已在运行中' }
  }

  try {
    const port = getPortForService(service.id)
    const { server, port: actualPort } = await startMcpServer(service, port)
    runningServers.set(service.id, { server, port: actualPort })
    return { ok: true, port: actualPort }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    }
  }
}

/**
 * 停止 MCP 服务
 */
export async function stopMcpService(serviceId: string): Promise<{ ok: boolean; error?: string }> {
  const entry = runningServers.get(serviceId)
  if (!entry) {
    return { ok: false, error: '服务未运行' }
  }

  try {
    await new Promise<void>((resolve) => {
      entry.server.close(() => resolve())
    })
    runningServers.delete(serviceId)
    return { ok: true }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    }
  }
}

/**
 * 获取某个服务的真实运行时状态（与持久化 store 无关）。
 * store 中的 running/port 每次 load 都会被清空，运行时状态必须以这里为准。
 */
export function getMcpRuntime(serviceId: string): { running: boolean; port?: number } {
  const entry = runningServers.get(serviceId)
  return entry ? { running: true, port: entry.port } : { running: false }
}

/**
 * 检查 MCP 服务是否运行中
 */
export function isMcpServiceRunning(serviceId: string): boolean {
  return runningServers.has(serviceId)
}

/**
 * 获取运行中的 MCP 服务数量
 */
export function getRunningMcpCount(): number {
  return runningServers.size
}