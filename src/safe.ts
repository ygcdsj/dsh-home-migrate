/**
 * safe.ts — 归档路径安全校验（SECURITY_REVIEW F1 修复）。
 * 1) assertSafeRel：manifest 字段白名单（拒绝 ..、绝对路径、盘符、空段、\、空白）；
 * 2) ensureUnder：落地断言（纵深防御，写之前确认目标在指定根目录内）。
 */
import { resolve, sep } from 'node:path'

/** 允许的相对路径段：字母数字 @ . _ -，段间单个 /。拒绝绝对路径、盘符、空段、\、空白。 */
export const SAFE_REL = /^[A-Za-z0-9@._-]+(\/[A-Za-z0-9@._-]+)*$/

export function assertSafeRel(p: string, what: string): void {
  if (typeof p !== 'string' || !SAFE_REL.test(p)) {
    throw new Error(`unsafe ${what} in manifest: ${JSON.stringify(p)}`)
  }
  // '.'/'..' 段单独拒绝（字符类允许点，但纯点段是穿越）
  for (const seg of p.split('/')) {
    if (seg === '.' || seg === '..') {
      throw new Error(`unsafe ${what} in manifest: ${JSON.stringify(p)}`)
    }
  }
}

/** 断言 resolve(p) 位于 root 内（或等于 root）；Windows 大小写不敏感。返回规范化路径。 */
export function ensureUnder(root: string, p: string, what: string): string {
  const r = resolve(root)
  const d = resolve(p)
  if (d !== r && !d.toLowerCase().startsWith(r.toLowerCase() + sep)) {
    throw new Error(`unsafe ${what} escapes ${r}: ${p}`)
  }
  return d
}
