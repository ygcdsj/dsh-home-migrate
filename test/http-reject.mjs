// SECURITY_REVIEW F2/F5：HTTP API 层拒绝用例（直接挂载 mountMigrateRoutes + 假 req/res）。
// 覆盖：Host 白名单 / CSRF token / Origin 同源 / Sec-Fetch-Site / 405 / body 限长 413。
import { mountMigrateRoutes } from '../lib/routes.js'

let pass = 0
let fail = 0
function check(name, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  cond ? pass++ : fail++
}

// ── 假 ctx / req / res ────────────────────────────────────────
const handlers = new Map()
const fakeHost = {
  webServer: {
    register: (route) => {
      handlers.set(route.path, route.handler)
      return () => handlers.delete(route.path)
    },
  },
  get: () => undefined,
}
const disposer = mountMigrateRoutes(fakeHost)

function makeRes() {
  const r = { status: 0, data: '' }
  return {
    writeHead: (s) => { r.status = s },
    end: (d) => { r.data = String(d ?? '') },
    _r: r,
  }
}

function makeReq({ method = 'POST', headers = {}, body } = {}) {
  const chunks = body !== undefined ? [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))] : []
  return {
    method,
    headers,
    destroy() {},
    [Symbol.asyncIterator]: async function* () {
      for (const c of chunks) yield c
    },
  }
}

function call(path, req) {
  const res = makeRes()
  const h = handlers.get(path)
  if (!h) return Promise.resolve({ status: -1, data: 'no handler' })
  h(req, res)
  // guarded 处理器是异步写响应（readBody await），等一拍再读
  return new Promise((resolve) => setTimeout(() => resolve({ status: res._r.status, data: res._r.data }), 30))
}

const VALID_HOST = '127.0.0.1:3080'

// ── 用例 ──────────────────────────────────────────────────────
// 1. GET /session（合法回环 host）→ 200 返回 token
{
  const r = await call('/dsh-migrate/api/session', makeReq({ method: 'GET', headers: { host: VALID_HOST } }))
  let token = ''
  try { token = JSON.parse(r.data).token ?? '' } catch { /* 保持空 */ }
  check('1 GET /session → 200 + token', r.status === 200 && token.length > 0, `status=${r.status}`)
  // 2. 带 token 的合法 POST → export-preview 放行（200）
  {
    const r2 = await call('/dsh-migrate/api/export-preview', makeReq({
      method: 'POST', headers: { host: VALID_HOST, 'x-dshmig-token': token },
    }))
    const body = JSON.parse(r2.data || '{}')
    check('2 合法 POST（token+loopback）→ 200 且含 ok', r2.status === 200 && 'ok' in body, `status=${r2.status} body keys=${Object.keys(body).join(',')}`)
  }
  // 3. 无 token → 403
  {
    const r3 = await call('/dsh-migrate/api/export-preview', makeReq({
      method: 'POST', headers: { host: VALID_HOST },
    }))
    check('3 无 token → 403', r3.status === 403, `status=${r3.status}`)
  }
  // 4. 伪造 token → 403
  {
    const r4 = await call('/dsh-migrate/api/export-preview', makeReq({
      method: 'POST', headers: { host: VALID_HOST, 'x-dshmig-token': 'deadbeef' },
    }))
    check('4 伪造 token → 403', r4.status === 403, `status=${r4.status}`)
  }
  // 5. 非回环 Host → 403（即使 token 正确）
  {
    const r5 = await call('/dsh-migrate/api/export-preview', makeReq({
      method: 'POST', headers: { host: 'evil.example.com', 'x-dshmig-token': token },
    }))
    check('5 非回环 Host → 403', r5.status === 403, `status=${r5.status}`)
  }
  // 6. 跨源 Origin → 403
  {
    const r6 = await call('/dsh-migrate/api/export-preview', makeReq({
      method: 'POST', headers: { host: VALID_HOST, 'x-dshmig-token': token, origin: 'http://evil.example.com' },
    }))
    check('6 跨源 Origin → 403', r6.status === 403, `status=${r6.status}`)
  }
  // 7. Sec-Fetch-Site: cross-site → 403
  {
    const r7 = await call('/dsh-migrate/api/export-preview', makeReq({
      method: 'POST', headers: { host: VALID_HOST, 'x-dshmig-token': token, 'sec-fetch-site': 'cross-site' },
    }))
    check('7 Sec-Fetch-Site: cross-site → 403', r7.status === 403, `status=${r7.status}`)
  }
  // 8. GET 打写端点 → 405
  {
    const r8 = await call('/dsh-migrate/api/export-preview', makeReq({ method: 'GET', headers: { host: VALID_HOST } }))
    check('8 GET 写端点 → 405', r8.status === 405, `status=${r8.status}`)
  }
  // 9. 超大 body → 413（readBody 流式限长，8MB）
  {
    const huge = Buffer.alloc(9 * 1024 * 1024, 'a')
    const r9 = await call('/dsh-migrate/api/import-dryrun', makeReq({
      method: 'POST', headers: { host: VALID_HOST, 'x-dshmig-token': token }, body: huge,
    }))
    check('9 超大 body → 413', r9.status === 413, `status=${r9.status}`)
  }
  // 10. GET /session 非回环 Host → 403
  {
    const r10 = await call('/dsh-migrate/api/session', makeReq({ method: 'GET', headers: { host: 'evil.example.com' } }))
    check('10 GET /session 非回环 Host → 403', r10.status === 403, `status=${r10.status}`)
  }
  // 11. R1：半请求断开（for-await 中途抛 aborted）→ 不产生 unhandled rejection，尽力 500
  {
    let unhandled = 0
    const onUnhandled = (reason) => { unhandled++; console.log('  ⚠ unhandledRejection:', String(reason)) }
    process.on('unhandledRejection', onUnhandled)
    const abortedReq = {
      method: 'POST',
      headers: { host: VALID_HOST, 'x-dshmig-token': token },
      destroy() {},
      [Symbol.asyncIterator]: async function* () {
        yield Buffer.from('{"archive":')
        throw new Error('aborted')
      },
    }
    const res = makeRes()
    handlers.get('/dsh-migrate/api/import-dryrun')(abortedReq, res)
    await new Promise((r2) => setTimeout(r2, 50))
    process.off('unhandledRejection', onUnhandled)
    check('11 半请求断开 → 无 unhandled rejection（进程不崩）', unhandled === 0, `unhandled=${unhandled}`)
    check('11 半请求断开 → 尽力 500', res._r.status === 500, `status=${res._r.status}`)
  }
}

disposer()

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
