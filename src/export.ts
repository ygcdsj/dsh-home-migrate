/**
 * export.ts — 导出编排：scan → secret 扫描/脱敏 → manifest（sha256）→ zip。
 * dryRun 默认（§6.1）：返回预览；确认后才真正打包。
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
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

const TEXT_KINDS = new Set(['settings', 'preset', 'profile'])

function detectDshVersion(): string {
  try {
    const r = spawnSync('dsh', ['--version'], { shell: process.platform === 'win32', timeout: 10_000, encoding: 'utf8' })
    const v = (r.stdout ?? '').trim().split('\n')[0] ?? ''
    return v || 'unknown'
  } catch {
    return 'unknown'
  }
}

export function exportDsh(opts: ExportOptions): ExportResult {
  try {
    const plan = scanHome(opts.home)
    const secretReport: SecretReport = { excludedFiles: [...plan.excluded], redactedFields: [] }
    const redacted = new Map<string, string>() // absPath -> 脱敏后内容

    for (const f of plan.files) {
      if (!TEXT_KINDS.has(f.kind)) continue
      // 代码文件跳过字段级扫描（变量名/字符串常量误报率高；凭据主要出现在配置类文件中）
      if (/\.(mjs|js|cjs|ts|tsx|jsx|mts|cts)$/i.test(f.relPath)) continue
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
      } catch { /* 非 UTF-8 文本或不可读：跳过扫描 */ }
    }

    if (opts.dryRun) {
      return {
        ok: true,
        dryRun: true,
        plan,
        secretReport,
        manifest: buildManifest({
          platform: process.platform, arch: process.arch, dshVersion: 'dry-run',
          dshHome: plan.home, profiles: plan.profiles,
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
      dshHome: plan.home, profiles: plan.profiles,
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
