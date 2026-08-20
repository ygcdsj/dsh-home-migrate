/**
 * export.ts — 导出编排：scan → secret 扫描/脱敏 → manifest（sha256）→ zip。
 * dryRun 默认（§6.1）：返回预览；确认后才真正打包。
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { dshHomeDisplay } from '@deepseek-ai/dsh-home-paths'
import { scanHome, type ExportPlan } from './scan.js'
import { detectSecrets, redactSecrets, type SecretHit } from './secret.js'
import { buildManifest, hashContent, hashFile, type Manifest, type ManifestFile, type SecretReport } from './manifest.js'
import { createArchive, type ArchiveEntry } from './archive.js'

export interface ExportOptions {
  dryRun: boolean
  outDir?: string
  home?: string
}

export interface ExportResult {
  ok: boolean
  dryRun: boolean
  artifactPath?: string
  plan?: ExportPlan
  manifest?: Manifest
  secretReport?: SecretReport
  error?: string
}

// 扫描范围（SECURITY_REVIEW F4）：settings/presets/profile 全扫（代码文件除外）；
// vendor 仅扫配置文件扩展名（代码文件跳过——变量名/字符串常量误报率高）。
const TEXT_KINDS = new Set(['settings', 'preset', 'profile'])
const CODE_EXT = /\.(mjs|js|cjs|ts|tsx|jsx|mts|cts)$/i
const CONFIG_EXT = /\.(ya?ml|json|toml|ini|env(\.\w+)?)$/i
const UNSCANNED_CAP = 100 // unscannedFiles 列表上限（unscannedTotal 记录全量）

function detectDshVersion(): string {
  try {
    const r = spawnSync('dsh', ['--version'], { shell: process.platform === 'win32', timeout: 10_000, encoding: 'utf8' })
    const v = (r.stdout ?? '').trim().split('\n')[0] ?? ''
    return v || 'unknown'
  } catch {
    return 'unknown'
  }
}

// 自携带：读取运行中的本工具包元数据（src/ 下即仓库根，lib/ 下即安装包根）
const require2 = createRequire(import.meta.url)
const OWN_PKG = require2('../package.json') as { name?: string; version?: string }
export const TOOL_NAME = OWN_PKG.name ?? 'dsh-migrate'
export const TOOL_VERSION = OWN_PKG.version ?? '0.0.1'

/**
 * 把本工具（运行中的导出器自身）附加到归档内各 profile 的 package.json：
 * `dependencies` 加 `"<TOOL_NAME>": "^<TOOL_VERSION>"`，`dsh.profile.bundles` 追加同名 bundle。
 * 目标机导入后 pnpm install 即从 npm 装回、bundles 激活——迁移自带迁移工具，无需手动安装
 * （修复"迁移不带自己"：super-injector 运行时注入的工具不在 profile 依赖里，旧版不随迁移走）。
 * 幂等：profile 已显式依赖该工具时跳过。返回 relPath -> 重写后内容。
 */
function carryToolIntoProfiles(plan: ExportPlan): Map<string, string> {
  const rewritten = new Map<string, string>()
  for (const f of plan.files) {
    if (f.kind !== 'profile' || !f.relPath.endsWith('/package.json')) continue
    let pkg: Record<string, unknown>
    try { pkg = JSON.parse(readFileSync(f.absPath, 'utf8')) as Record<string, unknown> } catch { continue }
    const deps = (pkg.dependencies ?? {}) as Record<string, unknown>
    if (deps === null || typeof deps !== 'object' || Array.isArray(deps) || typeof deps[TOOL_NAME] === 'string') continue
    deps[TOOL_NAME] = '^' + TOOL_VERSION
    pkg.dependencies = deps
    const dsh = (pkg.dsh ?? {}) as { profile?: { bundles?: unknown } }
    const profile = dsh.profile ?? {}
    const bundles = Array.isArray(profile.bundles) ? [...(profile.bundles as string[])] : []
    if (!bundles.includes(TOOL_NAME)) bundles.push(TOOL_NAME)
    pkg.dsh = { ...dsh, profile: { ...profile, bundles } }
    rewritten.set(f.relPath, JSON.stringify(pkg, null, 2) + '\n')
  }
  return rewritten
}

export function exportDsh(opts: ExportOptions): ExportResult {
  try {
    const plan = scanHome(opts.home)
    // 自携带：把运行中的导出工具附加进归档 profile（目标机导入后自带迁移工具）
    const carried = carryToolIntoProfiles(plan)
    if (carried.size > 0) {
      plan.warnings.push(`已自动附加 ${TOOL_NAME}@^${TOOL_VERSION} 到导出 profile（目标机导入后自带迁移工具）`)
    }
    const secretReport: SecretReport = { excludedFiles: [...plan.excluded], redactedFields: [], unscannedFiles: [], unscannedTotal: 0 }
    const redacted = new Map<string, string>() // absPath -> 脱敏后内容
    const unscanned: string[] = []
    let unscannedTotal = 0
    const noteUnscanned = (relPath: string): void => {
      unscannedTotal++
      if (unscanned.length < UNSCANNED_CAP) unscanned.push(relPath)
    }

    for (const f of plan.files) {
      const isCode = CODE_EXT.test(f.relPath)
      const scannable = TEXT_KINDS.has(f.kind) || (f.kind === 'vendor' && CONFIG_EXT.test(f.relPath))
      if (!scannable || isCode) { noteUnscanned(f.relPath); continue }
      try {
        const raw = readFileSync(f.absPath, 'utf8')
        const hits = detectSecrets(raw, f.relPath)
        if (hits.length > 0) {
          const { text, redacted: done } = redactSecrets(raw, hits)
          if (done.length > 0) {
            redacted.set(f.absPath, text)
            secretReport.redactedFields.push(...done)
          }
        }
      } catch { noteUnscanned(f.relPath) /* 非 UTF-8 文本或不可读 */ }
    }
    secretReport.unscannedFiles = unscanned
    secretReport.unscannedTotal = unscannedTotal

    if (opts.dryRun) {
      return {
        ok: true,
        dryRun: true,
        plan,
        secretReport,
        manifest: buildManifest({
          platform: process.platform, arch: process.arch, dshVersion: 'dry-run',
          dshHome: dshHomeDisplay(plan.home), profiles: plan.profiles,
          files: [], links: plan.links.map((l) => ({ dep: l.dep, vendorPath: l.vendorRelPath })),
          excluded: plan.excluded, secretReport,
        }),
      }
    }

    // 打包
    const dshVersion = detectDshVersion()
    const entries: ArchiveEntry[] = []
    const manifestFiles: ManifestFile[] = []
    for (const f of plan.files) {
      const carriedContent = carried.get(f.relPath)
      if (carriedContent !== undefined) {
        entries.push({ path: f.relPath, content: carriedContent })
        manifestFiles.push({ path: f.relPath, sha256: hashContent(carriedContent), size: Buffer.byteLength(carriedContent) })
        continue
      }
      const content = redacted.get(f.absPath)
      if (content !== undefined) {
        entries.push({ path: f.relPath, content })
        manifestFiles.push({ path: f.relPath, sha256: hashContent(content), size: Buffer.byteLength(content) })
      } else {
        entries.push({ path: f.relPath, absPath: f.absPath })
        manifestFiles.push({ path: f.relPath, sha256: hashFile(f.absPath), size: f.size })
      }
    }

    const manifest = buildManifest({
      platform: process.platform, arch: process.arch, dshVersion,
      dshHome: dshHomeDisplay(plan.home), profiles: plan.profiles,
      files: manifestFiles, links: plan.links.map((l) => ({ dep: l.dep, vendorPath: l.vendorRelPath })),
      excluded: plan.excluded, secretReport,
    })

    const outDir = opts.outDir ?? join(homedir(), 'dsh-migrate-exports')
    mkdirSync(outDir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const artifactPath = join(outDir, `dsh-migrate-${plan.profiles.join('+') || 'noprofile'}-${stamp}.dshmig`)

    createArchive([{ path: 'manifest.json', content: JSON.stringify(manifest, null, 2) }, ...entries], artifactPath)

    return { ok: true, dryRun: false, artifactPath, plan, manifest, secretReport }
  } catch (e) {
    return { ok: false, dryRun: opts.dryRun, error: String(e) }
  }
}
