/**
 * scan.ts — 导出扫描：include 白名单 + 硬排除黑名单，产出 ExportPlan。
 * 事实基线见 docs/DEVELOPMENT.md §3（本机 ~/.dsh 实测布局）。
 * home 路径一律走官方 @deepseek-ai/dsh-home-paths，不手拼路径。
 */
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

export type FileKind = 'settings' | 'profile' | 'preset' | 'vendor'

export interface ScannedFile {
  relPath: string      // 归档内相对路径（正斜杠）
  absPath: string
  size: number
  kind: FileKind
}

export interface LinkDep {
  dep: string          // package.json dependencies 里的依赖名
  vendorRelPath: string // 归档内 vendor 相对路径，如 vendor/dsh-super-injector
  absPath: string      // 源机绝对路径（断言在 <home>/vendor 下）
}

export interface ExportPlan {
  home: string
  profiles: string[]
  files: ScannedFile[]
  links: LinkDep[]
  excluded: string[]
  warnings: string[]
  totalBytes: number
}

const EXCLUDED_DIRS = new Set(['.pnpm-store', 'sessions', 'storages', 'usage-stats', 'super-injector', '.git'])
const EXCLUDED_NAMES = new Set(['node_modules', '.dsh-skin-market', '.dsh-market'])
const EXCLUDED_FILES = new Set(['.anonymous-user-id', '.credentials.yaml'])
const ENV_FILE = /^\.env(\.\w+)?$/
const CACHE_LOG = /(^|[\\/])(cache|logs?|tmp|temp)([\\/]|$)/i

const PROFILE_FILES = ['package.json', 'cordis.yml', 'cordis.patch.yml', 'pnpm-workspace.yaml']

function isExcludedName(name: string): boolean {
  return EXCLUDED_NAMES.has(name) || EXCLUDED_FILES.has(name) || ENV_FILE.test(name)
}

/** 递归收集文件；跳过符号链接、排除名、cache/log 模式。 */
function walkDir(absDir: string, relPrefix: string, kind: FileKind, files: ScannedFile[], warnings: string[]): void {
  let entries: import('node:fs').Dirent[]
  try {
    entries = readdirSync(absDir, { withFileTypes: true })
  } catch (e) {
    warnings.push(`unreadable dir: ${absDir} (${String(e)})`)
    return
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue // junction/symlink 不打包（node_modules 类链接）
    if (isExcludedName(entry.name)) continue
    if (CACHE_LOG.test(relPrefix + entry.name)) continue
    const abs = join(absDir, entry.name)
    const rel = (relPrefix + entry.name).split(sep).join('/')
    if (entry.isDirectory()) {
      walkDir(abs, rel + '/', kind, files, warnings)
    } else if (entry.isFile()) {
      let size = 0
      try { size = statSync(abs).size } catch { /* 不可读则跳过 */ }
      files.push({ relPath: rel, absPath: abs, size, kind })
    }
  }
}

/** 解析 profile package.json 的 link: 依赖；断言目标在 <home>/vendor 下（防路径逃逸，§7）。 */
function collectLinks(profileDir: string, home: string, plan: ExportPlan): void {
  const manifestPath = join(profileDir, 'package.json')
  if (!existsSync(manifestPath)) return
  let pkg: Record<string, unknown>
  try { pkg = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown> } catch {
    plan.warnings.push(`unparseable package.json: ${manifestPath}`)
    return
  }
  const deps = pkg.dependencies
  if (deps === null || typeof deps !== 'object' || Array.isArray(deps)) return
  const vendorRoot = resolve(join(home, 'vendor')).toLowerCase()
  for (const [dep, spec] of Object.entries(deps as Record<string, unknown>)) {
    if (typeof spec !== 'string' || !spec.startsWith('link:')) continue
    const target = resolve(spec.slice(5))
    const targetLower = target.toLowerCase()
    if (!targetLower.startsWith(vendorRoot + sep) && targetLower !== vendorRoot) {
      throw new Error(`unsafe link target rejected (outside <home>/vendor): ${dep} -> ${target}`)
    }
    const vendorRel = relative(resolve(join(home, 'vendor')), target).split(sep).join('/')
    plan.links.push({ dep, vendorRelPath: 'vendor/' + vendorRel, absPath: target })
  }
}

/** 扫描 DSH home，产出导出计划。 */
export function scanHome(homeOverride?: string): ExportPlan {
  const home = resolve(homeOverride ?? resolveDshHome())
  const plan: ExportPlan = { home, profiles: [], files: [], links: [], excluded: [], warnings: [], totalBytes: 0 }

  const push = (f: ScannedFile): void => { plan.files.push(f); plan.totalBytes += f.size }

  // settings.yaml（含脱敏前原始内容，secret 处理在 export 编排层）
  const settingsPath = join(home, 'settings.yaml')
  if (existsSync(settingsPath) && lstatSync(settingsPath).isFile()) {
    push({ relPath: 'config/settings.yaml', absPath: settingsPath, size: statSync(settingsPath).size, kind: 'settings' })
  } else {
    plan.warnings.push('settings.yaml missing — nothing to migrate for global settings')
  }

  // profiles：目录 + 固定文件集；profiles/node_modules（DSH CLI 本体）排除
  // home override（沙箱测试）时一律基于 override home 拼接（与 import 侧 targetHome 语义一致）
  const profilesRoot = join(home, 'profiles')
  if (existsSync(profilesRoot)) {
    for (const entry of readdirSync(profilesRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'node_modules' || isExcludedName(entry.name)) {
        if (entry.isDirectory()) plan.excluded.push('profiles/' + entry.name + '/')
        continue
      }
      const profileDir = join(profilesRoot, entry.name)
      plan.profiles.push(entry.name)
      collectLinks(profileDir, home, plan)
      for (const f of PROFILE_FILES) {
        const abs = join(profileDir, f)
        if (existsSync(abs) && lstatSync(abs).isFile()) {
          push({ relPath: `config/profiles/${entry.name}/${f}`, absPath: abs, size: statSync(abs).size, kind: 'profile' })
        }
      }
    }
  }

  // vendor：仅打包被 link: 引用的包（§6.1）
  for (const link of plan.links) {
    if (existsSync(link.absPath)) {
      walkDir(link.absPath, link.vendorRelPath + '/', 'vendor', plan.files, plan.warnings)
    } else {
      plan.warnings.push(`vendor link target missing: ${link.dep} -> ${link.absPath}`)
    }
  }

  // .agent-presets
  const presetsRoot = join(home, '.agent-presets')
  if (existsSync(presetsRoot)) {
    walkDir(presetsRoot, 'presets/', 'preset', plan.files, plan.warnings)
  }

  // 顶层硬排除（存在则记录，自证 + 审计）
  for (const name of ['sessions', 'storages', 'usage-stats', 'super-injector', '.pnpm-store', '.anonymous-user-id', '.credentials.yaml', '.env']) {
    if (existsSync(join(home, name))) plan.excluded.push(name + (lstatSync(join(home, name)).isDirectory() ? '/' : ''))
  }

  plan.totalBytes = plan.files.reduce((sum, f) => sum + f.size, 0)
  return plan
}
