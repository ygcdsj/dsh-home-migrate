/**
 * routes.ts — host HTTP API（client 面板通过同源 fetch 调用，docs §6.5）。
 * 路由模式参照 dshmarket（host.webServer.register + ctx.inject(['webServer'])）。
 * 安全（SECURITY_REVIEW F2/F5，2026-08-19）：
 *  - Host 白名单：仅放行 127.0.0.1 / localhost / [::1]（含端口）——非 loopback 绑定即拒绝；
 *  - CSRF token：先 GET /dsh-migrate/api/session 领取，写操作请求头 x-dshmig-token 携带（纵深）；
 *  - Sec-Fetch-Site：cross-site 拒绝（浏览器纵深）；
 *  - readBody 流式限长（8MB），超限 413 并断开，不缓冲完整 body。
 */
import type { Context } from 'cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exportDsh } from './export.js'
import { importDsh } from './import.js'
import { MAX_UNCOMPRESSED_TOTAL } from './archive.js'

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

// ── 安全校验（F2）─────────────────────────────────────────────
// Host 白名单：仅本机回环（含端口）。
const ALLOWED_HOSTS = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/
// 进程级 CSRF token：UI 经 GET /session 领取，写操作请求头携带。
let csrfToken = randomBytes(32).toString('hex')

function hostAllowed(req: IncomingMessage): boolean {
  const host = req.headers.host
  return typeof host === 'string' && ALLOWED_HOSTS.test(host)
}

function csrfOk(req: IncomingMessage): boolean {
  return req.headers['x-dshmig-token'] === csrfToken
}

/** Sec-Fetch-Site 纵深：same-origin / none 放行，cross-site 拒绝（非浏览器无此头 = 放行）。 */
function fetchSiteOk(req: IncomingMessage): boolean {
  const sf = req.headers['sec-fetch-site']
  if (typeof sf !== 'string' || sf === '') return true
  return sf === 'same-origin' || sf === 'none'
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

// ── body 读取（F5：流式限长，超限 413）────────────────────────
const MAX_BODY_BYTES = 8 * 1024 * 1024

interface BodyResult {
  body: Record<string, unknown>
  error?: { status: number; message: string }
}

async function readBody(request: IncomingMessage): Promise<BodyResult> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += b.length
    if (total > MAX_BODY_BYTES) {
      request.destroy()
      return { body: {}, error: { status: 413, message: `request body too large (limit ${MAX_BODY_BYTES} bytes)` } }
    }
    chunks.push(b)
  }
  try {
    const raw = Buffer.concat(chunks).toString('utf8')
    return raw ? { body: JSON.parse(raw) as Record<string, unknown> } : { body: {} }
  } catch {
    return { body: {} }
  }
}

const MAX_UPLOAD_BYTES = 64 * 1024 * 1024 // archiveData（base64 文本）上限
const MAX_ARCHIVE_FILE_BYTES = MAX_UNCOMPRESSED_TOTAL // 磁盘归档文件本体上限（防读入内存 DoS，F5）

/**
 * 解析归档来源：archive（磁盘路径）或 archiveData（浏览器 File 的 base64）。
 * 后者写入系统临时目录，返回 cleanup 供 handler 完成后清理。
 */
function resolveArchive(body: Record<string, unknown>): { path: string; cleanup: () => void } | { error: string } {
  if (typeof body.archive === 'string' && body.archive !== '') {
    try {
      const sz = statSync(body.archive).size
      if (sz > MAX_ARCHIVE_FILE_BYTES) return { error: `archive file too large (${sz} bytes, limit ${MAX_ARCHIVE_FILE_BYTES})` }
    } catch { return { error: 'archive file not readable' } }
    return { path: body.archive, cleanup: () => {} }
  }
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
      if (!hostAllowed(req)) { sendJson(res, 403, { error: 'non-loopback host rejected (bind DSH web to loopback)' }); return }
      if (!sameOrigin(req)) { sendJson(res, 403, { error: 'cross-origin request rejected' }); return }
      if (!csrfOk(req)) { sendJson(res, 403, { error: 'missing/invalid CSRF token (GET /dsh-migrate/api/session first)' }); return }
      if (!fetchSiteOk(req)) { sendJson(res, 403, { error: 'cross-site request rejected (Sec-Fetch-Site)' }); return }
      void readBody(req).then(({ body, error }) => {
        if (error) { sendJson(res, error.status, { error: error.message }); return }
        try { handler(req, res, body) } catch (e) { sendJson(res, 500, { error: String(e) }) }
      })
    }

  // CSRF token 领取（GET，本机回环可访问）
  register('/dsh-migrate/api/session', (req, res) => {
    if (!methodIs(req, 'GET')) { sendJson(res, 405, { error: 'GET required' }); return }
    if (!hostAllowed(req)) { sendJson(res, 403, { error: 'non-loopback host rejected' }); return }
    sendJson(res, 200, { token: csrfToken })
  })

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
