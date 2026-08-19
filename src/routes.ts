/**
 * routes.ts — host HTTP API（client 面板通过同源 fetch 调用，docs §6.5）。
 * 路由模式参照 dshmarket（host.webServer.register + ctx.inject(['webServer'])）。
 * 同源校验：Origin 存在时必须与 Host 一致（防跨站请求；本插件的写操作仅限本机）。
 * 2026-08-19 增：pick-directory（宿主 ctx.directoryPicker 原生目录选择）+ archiveData（浏览器文件选择上传）。
 */
import type { Context } from 'cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exportDsh } from './export.js'
import { importDsh } from './import.js'

interface WebServerService {
  register(route: {
    kind: 'exact'
    path: string
    handler: (request: IncomingMessage, response: ServerResponse) => void
  }): () => void
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data))
}

/** 读取并解析 JSON body（IncomingMessage 异步迭代，dshmarket 同款）。 */
async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  try {
    const chunks: Buffer[] = []
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }
    const raw = Buffer.concat(chunks).toString('utf8')
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** 同源校验：Origin 存在时必须与 Host 一致；无 Origin（CLI/同源导航）放行。 */
function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  const host = req.headers.host
  if (typeof origin !== 'string' || origin === '') return true
  if (typeof host !== 'string') return false
  try { return new URL(origin).host === host } catch { return false }
}

function methodIs(req: IncomingMessage, m: string): boolean {
  return (req.method ?? 'GET').toUpperCase() === m
}

const MAX_UPLOAD_BYTES = 64 * 1024 * 1024

/**
 * 解析归档来源：archive（磁盘路径）或 archiveData（浏览器 File 的 base64）。
 * 后者写入系统临时目录，返回 cleanup 供 handler 完成后清理。
 */
function resolveArchive(body: Record<string, unknown>): { path: string; cleanup: () => void } | { error: string } {
  if (typeof body.archive === 'string' && body.archive !== '') return { path: body.archive, cleanup: () => {} }
  if (typeof body.archiveData === 'string' && body.archiveData !== '') {
    if (body.archiveData.length > MAX_UPLOAD_BYTES) return { error: `archive too large (limit ${MAX_UPLOAD_BYTES} bytes base64)` }
    let buf: Buffer
    try { buf = Buffer.from(body.archiveData, 'base64') } catch { return { error: 'invalid base64 archiveData' } }
    const dir = mkdtempSync(join(tmpdir(), 'dshmig-upload-'))
    const file = join(dir, 'upload.dshmig')
    writeFileSync(file, buf)
    return { path: file, cleanup: () => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* 尽力清理 */ } } }
  }
  return { error: 'archive（路径）或 archiveData（base64 内容）参数必填' }
}

/** 注册全部迁移 API；返回组合 disposer。在 ctx.inject(['webServer']) 回调内调用。 */
export function mountMigrateRoutes(ctx: Context): () => void {
  const disposers: (() => void)[] = []
  const host = ctx as unknown as { webServer: WebServerService; get?: (name: string) => unknown }

  const register = (path: string, handler: (req: IncomingMessage, res: ServerResponse) => void): void => {
    disposers.push(host.webServer.register({ kind: 'exact', path, handler }))
  }

  const guarded = (handler: (req: IncomingMessage, res: ServerResponse, body: Record<string, unknown>) => void | Promise<void>) =>
    (req: IncomingMessage, res: ServerResponse): void => {
      if (!methodIs(req, 'POST')) { sendJson(res, 405, { error: 'POST required' }); return }
      if (!sameOrigin(req)) { sendJson(res, 403, { error: 'cross-origin request rejected' }); return }
      void readBody(req).then((body) => handler(req, res, body)).catch((e) => sendJson(res, 500, { error: String(e) }))
    }

  register('/dsh-migrate/api/export-preview', guarded((_req, res) => {
    sendJson(res, 200, exportDsh({ dryRun: true }))
  }))

  register('/dsh-migrate/api/export', guarded((_req, res, body) => {
    const outDir = typeof body.outDir === 'string' && body.outDir !== '' ? body.outDir : undefined
    sendJson(res, 200, exportDsh({ dryRun: false, outDir }))
  }))

  register('/dsh-migrate/api/import-dryrun', guarded((_req, res, body) => {
    const r = resolveArchive(body)
    if ('error' in r) { sendJson(res, 400, { ok: false, error: r.error }); return }
    try { sendJson(res, 200, importDsh({ archive: r.path, dryRun: true })) } finally { r.cleanup() }
  }))

  register('/dsh-migrate/api/import', guarded((_req, res, body) => {
    const r = resolveArchive(body)
    if ('error' in r) { sendJson(res, 400, { ok: false, error: r.error }); return }
    try {
      sendJson(res, 200, importDsh({
        archive: r.path,
        includeSettings: body.includeSettings !== false,
        dryRun: false,
      }))
    } finally { r.cleanup() }
  }))

  // 原生目录选择（导出产物目录）：宿主 ctx.directoryPicker（native/browse 后端均可）；
  // 远程部署无该服务时返回 501，UI 降级为手动输入。
  // 注意：pick(signal) 必须传 AbortSignal（实现内部访问 signal.aborted）；顺带用 timeout 做超时保护。
  register('/dsh-migrate/api/pick-directory', guarded(async (_req, res) => {
    const picker = host.get?.('directoryPicker') as
      { capability?: () => { pick?: (signal?: AbortSignal) => Promise<string | null> } } | undefined
    if (!picker?.capability) {
      sendJson(res, 501, { ok: false, error: 'directoryPicker 服务不可用（远程部署无原生选择器，请手动输入路径）' })
      return
    }
    try {
      const signal = AbortSignal.timeout(15_000)
      const picked = await picker.capability().pick?.(signal)
      if (picked === undefined || picked === null) sendJson(res, 200, { ok: true, cancelled: true })
      else sendJson(res, 200, { ok: true, path: picked })
    } catch (e) {
      const name = (e as { name?: string })?.name
      sendJson(res, name === 'TimeoutError' ? 504 : 500, {
        ok: false,
        error: name === 'TimeoutError' ? '目录选择超时（15 秒无响应）' : String(e),
      })
    }
  }))

  return () => { for (const d of disposers) d() }
}
