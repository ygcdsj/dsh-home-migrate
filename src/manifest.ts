/**
 * manifest.ts — manifest 生成/解析 + sha256 校验清单（docs §5 归档格式）。
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { assertSafeRel } from './safe.js'

export const MANIFEST_FORMAT_VERSION = 1
export const TOOL_VERSION = '0.0.1'

export interface ManifestFile { path: string; sha256: string; size: number }
export interface ManifestLink { dep: string; vendorPath: string }
export interface SecretReport {
  excludedFiles: string[]
  redactedFields: { file: string; field: string; line: number }[]
  /** 未做凭据扫描的文件（二进制/不可读/代码文件/vendor 非配置），最多 100 条；unscannedTotal 为总数。 */
  unscannedFiles: string[]
  unscannedTotal: number
}

export interface Manifest {
  formatVersion: number
  toolVersion: string
  createdAt: string
  source: { platform: string; arch: string; dshVersion: string; dshHome: string }
  profiles: string[]
  files: ManifestFile[]
  links: ManifestLink[]
  excluded: string[]
  secretReport: SecretReport
  notes: string
}

export function hashFile(absPath: string): string {
  return createHash('sha256').update(readFileSync(absPath)).digest('hex')
}

export function hashContent(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

export function buildManifest(
  opts: {
    platform: string
    arch: string
    dshVersion: string
    dshHome: string
    profiles: string[]
    files: ManifestFile[]
    links: ManifestLink[]
    excluded: string[]
    secretReport: SecretReport
  },
): Manifest {
  return {
    formatVersion: MANIFEST_FORMAT_VERSION,
    toolVersion: TOOL_VERSION,
    createdAt: new Date().toISOString(),
    source: { platform: opts.platform, arch: opts.arch, dshVersion: opts.dshVersion, dshHome: opts.dshHome },
    profiles: opts.profiles,
    files: opts.files,
    links: opts.links,
    excluded: opts.excluded,
    secretReport: opts.secretReport,
    notes: 'dsh-migrate MVP: same-OS migration; cross-OS import is rejected. Credentials are never carried.',
  }
}

export function parseManifest(json: string): Manifest {
  const m = JSON.parse(json) as Manifest
  if (m.formatVersion !== MANIFEST_FORMAT_VERSION) {
    throw new Error(`unsupported manifest formatVersion ${String(m.formatVersion)} (expected ${MANIFEST_FORMAT_VERSION})`)
  }
  if (!Array.isArray(m.files) || !Array.isArray(m.links) || !m.source || !Array.isArray(m.profiles)) {
    throw new Error('malformed manifest: missing files/links/source/profiles')
  }
  // 路径安全（SECURITY_REVIEW F1 + R-nit）：manifest 字段全由归档作者控制，解析即校验，
  // 拒绝 ..、绝对路径、盘符、空段、\、空白（zip 条目层 canonical 剥 ..，此处管 manifest 层）。
  // links[].dep 进入 node_modules/<dep> 路径，同样过白名单。
  for (const f of m.files) assertSafeRel(f.path, 'files[].path')
  for (const l of m.links) {
    assertSafeRel(l.vendorPath.replace(/^vendor\//, ''), 'links[].vendorPath')
    assertSafeRel(l.dep, 'links[].dep')
  }
  for (const p of m.profiles) assertSafeRel(p, 'profiles[]')
  return m
}
