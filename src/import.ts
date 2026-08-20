/**
 * import.ts — 导入编排（docs §6.3/§7/§8/§9/§10）。
 * 预检 → 备份目标机现状 → 还原（默认新建 profile）→ link 重写 → pnpm install → 验证链 → 失败回滚。
 * MVP：单 profile（manifest.profiles 取第一个，多 profile 记录警告）；同 OS。
 * home override（opts.home）用于沙箱测试：所有路径基于 targetHome 拼接，绝不落到真实 home。
 */
import {
  copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync,
  rmSync, rmdirSync, writeFileSync,
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve, sep } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { extractArchive, readZipText } from './archive.js'
import { parseManifest, hashFile, type Manifest } from './manifest.js'
import { ensureUnder } from './safe.js'

export interface ImportOptions {
  archive: string
  home?: string
  includeSettings?: boolean // 默认 true：备份后覆盖目标机 settings.yaml
  skipInstall?: boolean     // 测试/预览：跳过 pnpm install 与依赖级验证
  dryRun?: boolean          // 只做预检与计划，不写任何东西
  allowScripts?: boolean    // 默认 false：pnpm install --ignore-scripts（SECURITY_REVIEW F3）
  requireFresh?: boolean    // 默认 false：目标机已使用（target-used warn）放行；true=严格模式（目标机必须原生未动，否则拒绝）
}

export interface Check {
  name: string
  ok: boolean
  detail?: string
  /** 'warn' = 软门禁：展示但不阻断导入（预检通过）；缺省 'error' = 硬阻断。 */
  severity?: 'error' | 'warn'
}

export interface ImportPlan {
  manifest: Manifest
  targetHome: string
  newProfile: string
  checks: Check[]
  steps: string[]
  warnings: string[]
}

export interface VerifyItem { level: number; name: string; ok: boolean; skipped?: boolean; detail?: string }

export interface ImportResult {
  ok: boolean
  dryRun: boolean
  plan?: ImportPlan
  backupDir?: string
  verify?: VerifyItem[]
  error?: string
  rollback?: string[]
}

const MIN_DSH = '0.1.0-rc.6' // allowlist 下限；dshVersion 无法获取时不硬阻塞

function semverGte(a: string, b: string): boolean {
  const pa = a.replace(/^v/, '').split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x))
  const pb = b.replace(/^v/, '').split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x))
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (typeof x === 'number' && typeof y === 'number') { if (x !== y) return x > y } else if (String(x) !== String(y)) { return String(x) > String(y) }
  }
  return true
}

function run(cmd: string, args: string[], cwd: string, timeoutMs: number, env?: NodeJS.ProcessEnv): { code: number | null; out: string; err: string } {
  const r = spawnSync(cmd, args, {
    cwd, shell: process.platform === 'win32', encoding: 'utf8', timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024,
    env: env ? { ...process.env, ...env } : undefined,
  })
  return { code: r.status, out: (r.stdout ?? '') as string, err: ((r.stderr ?? '') as string) + (r.error ? ` [spawn: ${String(r.error)}]` : '') }
}

function detectDshVersion(): string {
  const r = run('dsh', ['--version'], process.cwd(), 10_000)
  return r.code === 0 ? (r.out.trim().split('\n')[0] ?? 'unknown') : 'unknown'
}

function nextProfileName(home: string, base: string): string {
  let name = base + '-migrated'
  let i = 2
  while (existsSync(join(home, 'profiles', name))) name = `${base}-migrated-${i++}`
  return name
}

/** 目录递归拷贝；跳过符号链接。 */
function copyDir(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true })
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue
    const s = join(src, entry.name)
    const d = join(dest, entry.name)
    if (entry.isDirectory()) copyDir(s, d)
    else if (entry.isFile()) { mkdirSync(dirname(d), { recursive: true }); copyFileSync(s, d) }
  }
}

function buildPlan(archive: string, manifest: Manifest, opts: ImportOptions): ImportPlan {
  const targetHome = resolve(opts.home ?? resolveDshHome())
  const baseProfile = manifest.profiles[0] ?? 'web'
  const newProfile = nextProfileName(targetHome, baseProfile)
  const checks: Check[] = []
  const warnings: string[] = []

  // target-used（软门禁）：报告目标机已使用程度，warn 不阻断导入——导入本身只新建
  // profile（不覆盖现有配置）、settings.yaml 备份后覆盖（可取消勾选）、vendor 冲突只报告，
  // 安全兜底已由这些机制保证。requireFresh=true 时提升为 error（严格模式，恢复"必须原生未动"）。
  {
    const vendorDir = join(targetHome, 'vendor')
    const profilesDir = join(targetHome, 'profiles')
    const vendorHasPkg = existsSync(vendorDir) && readdirSync(vendorDir).some((n) => {
      try { return lstatSync(join(vendorDir, n)).isDirectory() } catch { return false }
    })
    const profiles = existsSync(profilesDir)
      ? readdirSync(profilesDir, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name !== 'node_modules').map((e) => e.name)
      : []
    const hasBackup = existsSync(join(targetHome, '.dshmig-backup'))
    const reasons = [
      vendorHasPkg ? 'vendor/ 有注入包（非原生）' : '',
      profiles.length > 1 || (profiles.length === 1 && profiles[0] !== 'web') ? `已有非默认 profile: ${profiles.filter((p) => p !== 'web').join(', ')}` : '',
      hasBackup ? '存在迁移历史（.dshmig-backup/，本次会另建独立备份）' : '',
    ].filter(Boolean)
    const used = reasons.length > 0
    checks.push({
      name: 'target-used',
      ok: !used,
      severity: used ? (opts.requireFresh === true ? 'error' : 'warn') : undefined,
      detail: used
        ? reasons.join('; ')
        : '目标机未使用（原生未动），可安全迁移',
    })
  }

  checks.push({
    name: 'platform',
    ok: manifest.source.platform === process.platform,
    detail: `source=${manifest.source.platform} target=${process.platform} (MVP 同 OS)`,
  })

  // settings.yaml 为符号链接时拒绝覆盖（SECURITY_REVIEW F7：备份与覆盖都会穿透链接）
  const settingsPath = join(targetHome, 'settings.yaml')
  const settingsSymlink = existsSync(settingsPath) && lstatSync(settingsPath).isSymbolicLink()
  checks.push({
    name: 'settings-not-symlink',
    ok: !settingsSymlink,
    detail: settingsSymlink ? 'settings.yaml is a symlink — refusing to overwrite through it' : 'ok',
  })

  const targetVersion = detectDshVersion()
  const verOk = targetVersion === 'unknown' ? undefined : semverGte(targetVersion, MIN_DSH)
  checks.push({
    name: 'dsh-version',
    ok: verOk !== false,
    detail: `source=${manifest.source.dshVersion} target=${targetVersion} min=${MIN_DSH}${verOk === undefined ? ' (target version unknown — not blocking)' : ''}`,
  })

  if (manifest.profiles.length > 1) warnings.push(`multi-profile archive (${manifest.profiles.join(', ')}): MVP imports only "${baseProfile}"`)

  const steps: string[] = [
    `extract & verify archive (${manifest.files.length} files, sha256)`,
    `backup target settings.yaml → .dshmig-backup/<stamp>/`,
    `create new profile: profiles/${newProfile}`,
    `rewrite ${manifest.links.length} link: deps → vendor/…`,
    `restore vendor/ (${manifest.links.length} packages) & .agent-presets (merge, no overwrite)`,
    ...(opts.includeSettings !== false ? ['overwrite settings.yaml (backup taken above)'] : ['skip settings.yaml']),
    ...(opts.skipInstall ? [] : ['pnpm install in profile (--ignore-scripts default, see allowScripts; network may be required for git:/npm: deps)', 'verify: link resolution → dsh --dump-config']),
  ]

  return { manifest, targetHome, newProfile, checks, steps, warnings }
}

export function importDsh(opts: ImportOptions): ImportResult {
  const created: string[] = [] // 本次新建的路径（回滚时逐个删除，§10 配置级完全回滚）
  let backupDir = ''
  let backupDirCreated = false
  let backupRootExisted = false
  let staging = ''
  let hadSettings = false
  const targetSettings = join(resolve(opts.home ?? resolveDshHome()), 'settings.yaml')
  let verify: VerifyItem[] = []
  try {
    if (!existsSync(opts.archive)) return { ok: false, dryRun: opts.dryRun === true, error: `archive not found: ${opts.archive}` }
    const manifest = parseManifest(readZipText(opts.archive, 'manifest.json'))
    const plan = buildPlan(opts.archive, manifest, opts)
    const fatal = plan.checks.filter((c) => !c.ok && c.severity !== 'warn')
    if (fatal.length > 0) {
      return { ok: false, dryRun: opts.dryRun === true, plan, error: `preflight failed: ${fatal.map((c) => c.name).join(', ')}` }
    }
    if (opts.dryRun) return { ok: true, dryRun: true, plan }

    const home = plan.targetHome
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    backupDir = join(home, '.dshmig-backup', stamp)
    backupRootExisted = existsSync(join(home, '.dshmig-backup'))
    staging = join(home, '.dshmig-staging', stamp)
    mkdirSync(backupDir, { recursive: true })
    backupDirCreated = true
    mkdirSync(staging, { recursive: true })

    // 1. 解包 + sha256 校验
    extractArchive(opts.archive, staging)
    const bad: string[] = []
    for (const f of manifest.files) {
      // 纵深防御：files[].path 已过 parseManifest 白名单，此处再断言不越 staging（F1）
      const abs = ensureUnder(staging, join(staging, f.path), 'staging read')
      if (!existsSync(abs)) { bad.push(`${f.path}: missing`); continue }
      if (hashFile(abs) !== f.sha256) bad.push(`${f.path}: sha256 mismatch`)
    }
    if (bad.length > 0) throw new Error(`archive verification failed:\n${bad.slice(0, 10).join('\n')}`)

    // 2. 备份目标机 settings.yaml（记录覆盖前状态，回滚时恢复或删除）
    //    预检已拦 symlink；此处仍防御（F7：copyFileSync 会穿透链接覆盖目标）
    if (existsSync(targetSettings) && lstatSync(targetSettings).isSymbolicLink()) {
      throw new Error('settings.yaml is a symlink — refusing to overwrite through it')
    }
    hadSettings = existsSync(targetSettings) && lstatSync(targetSettings).isFile()
    if (hadSettings) {
      copyFileSync(targetSettings, join(backupDir, 'settings.yaml'))
    }

    // 3. 新建 profile 目录 + 4. 还原配置（含 link 重写）
    const newProfileDir = ensureUnder(join(home, 'profiles'), join(home, 'profiles', plan.newProfile), 'profile dir')
    mkdirSync(newProfileDir, { recursive: true })
    created.push(newProfileDir)
    const srcProfile = ensureUnder(staging, join(staging, 'config', 'profiles', manifest.profiles[0]), 'staging profile read')
    const pkgPath = join(srcProfile, 'package.json')
    if (!existsSync(pkgPath)) throw new Error('archive missing config/profiles/<name>/package.json')
    for (const f of ['package.json', 'cordis.yml', 'cordis.patch.yml', 'pnpm-workspace.yaml']) {
      const abs = join(srcProfile, f)
      if (existsSync(abs)) copyFileSync(abs, join(newProfileDir, f))
    }
    // link 重写：link:<home>/vendor/<pkg>（正斜杠，与源机写入形态一致）
    const pkg = JSON.parse(readFileSync(join(newProfileDir, 'package.json'), 'utf8')) as Record<string, unknown>
    const deps = (pkg.dependencies ?? {}) as Record<string, unknown>
    for (const l of manifest.links) {
      const spec = deps[l.dep]
      if (typeof spec === 'string' && spec.startsWith('link:')) {
        deps[l.dep] = 'link:' + join(home, 'vendor', l.vendorPath.replace(/^vendor\//, '')).split(sep).join('/')
      }
    }
    writeFileSync(join(newProfileDir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')

    // 5. vendor / presets / settings
    const vendorSrc = ensureUnder(staging, join(staging, 'vendor'), 'staging vendor root')
    for (const l of manifest.links) {
      const rel = l.vendorPath.replace(/^vendor\//, '')
      const src = ensureUnder(staging, join(vendorSrc, rel), 'staging vendor read')
      const dest = ensureUnder(join(home, 'vendor'), join(home, 'vendor', rel), 'vendor dest')
      if (!existsSync(src)) { plan.warnings.push(`vendor/${rel} missing in archive — skipped`); continue }
      // bundle 契约校验（dsh resolveBundleDir 实测结论）：package.json 可解析 + dsh.bundle.patch 指向存在文件
      const vpkgPath = join(src, 'package.json')
      const bundleErr = (() => {
        if (!existsSync(vpkgPath)) return 'missing package.json'
        try {
          const vpkg = JSON.parse(readFileSync(vpkgPath, 'utf8')) as { dsh?: { bundle?: { patch?: string } } }
          const patch = vpkg.dsh?.bundle?.patch
          if (!patch) return 'no dsh.bundle.patch declared'
          if (!existsSync(join(src, patch))) return `dsh.bundle.patch file missing: ${patch}`
          return null
        } catch (e) { return `unparseable package.json (${String(e)})` }
      })()
      if (bundleErr) throw new Error(`vendor/${rel} fails bundle contract: ${bundleErr}`)
      if (existsSync(dest)) {
        plan.warnings.push(`vendor/${rel} already exists on target — skipped (keep target copy)`)
      } else {
        copyDir(src, dest)
        created.push(dest)
      }
    }
    const presetsSrc = join(staging, 'presets')
    if (existsSync(presetsSrc)) {
      for (const entry of readdirSync(presetsSrc, { withFileTypes: true })) {
        const dest = ensureUnder(join(home, '.agent-presets'), join(home, '.agent-presets', entry.name), 'preset dest')
        if (existsSync(dest)) { plan.warnings.push(`preset ${entry.name} already exists — skipped`); continue }
        copyDir(join(presetsSrc, entry.name), dest)
        created.push(dest)
      }
    }
    if (opts.includeSettings !== false) {
      const s = join(staging, 'config', 'settings.yaml')
      if (existsSync(s)) {
        if (existsSync(targetSettings) && lstatSync(targetSettings).isSymbolicLink()) {
          throw new Error('settings.yaml is a symlink — aborting (refusing to overwrite through it)')
        }
        copyFileSync(s, targetSettings)
      }
    }

    // 6. pnpm install（默认开启；默认 --ignore-scripts，防不可信归档的依赖安装脚本执行，F3）
    if (!opts.skipInstall) {
      const inst = run('pnpm', ['install', '--reporter=append-only', ...(opts.allowScripts ? [] : ['--ignore-scripts'])], newProfileDir, 600_000)
      const ok = inst.code === 0
      verify.push({ level: 1, name: 'pnpm install', ok, detail: ok ? 'ok' : `exit=${String(inst.code)} ${(inst.err || inst.out).slice(-500)}` })
      if (!ok) throw new Error(`pnpm install failed (exit=${String(inst.code)}): ${(inst.err || inst.out).slice(-800)}`)

      // 验证链 level 2：链接解析（junction/symlink → vendor）
      for (const l of manifest.links) {
        const depPath = join(newProfileDir, 'node_modules', ...l.dep.split('/'))
        let linkOk = false
        let detail = 'not resolvable'
        try {
          if (existsSync(depPath)) {
            const real = realpathSync(depPath)
            const expected = resolve(join(home, 'vendor', l.vendorPath.replace(/^vendor\//, '')))
            linkOk = real.toLowerCase() === expected.toLowerCase()
            detail = linkOk ? `→ ${real}` : `→ ${real} (expected ${expected})`
          }
        } catch (e) { detail = String(e) }
        verify.push({ level: 2, name: `link resolve: ${l.dep}`, ok: linkOk, detail })
        if (!linkOk) throw new Error(`link resolution failed: ${l.dep} — ${detail}`)
      }

      // 验证链 level 3：dsh --dump-config（非纯读：会写 cordis.yml，导入场景可接受）
      // 注意：dsh CLI 读 DSH_HOME 环境变量而非 cwd——必须显式传入目标 home，防止指向真实 home
      const dc = run('dsh', ['--dump-config', '--profile', plan.newProfile], home, 60_000, { DSH_HOME: home })
      verify.push({ level: 3, name: 'dsh --dump-config', ok: dc.code === 0, detail: dc.code === 0 ? 'ok' : `exit=${String(dc.code)} ${(dc.err || dc.out).slice(-2000)}` })
      if (dc.code !== 0) throw new Error(`dsh --dump-config failed (exit=${String(dc.code)}): ${(dc.err || dc.out).slice(-800)}`)
    }

    // 清理只删自己的 stamp 子目录（F10：并发导入共享 .dshmig-staging 根，勿清整根）
    rmSync(staging, { recursive: true, force: true })
    try { rmdirSync(join(home, '.dshmig-staging')) } catch { /* 根非空（并发导入）或已不存在：忽略 */ }
    return { ok: true, dryRun: false, plan, backupDir, verify }
  } catch (e) {
    // 回滚：配置级完全回滚（删新建 + 恢复快照）+ staging 清理；尽力而为，绝不静默
    const rolled: string[] = []
    try {
      for (const p of [...created].reverse()) rmSync(p, { recursive: true, force: true })
      rolled.push(`removed ${created.length} created path(s)`)
      if (hadSettings) {
        const settingsBackup = backupDir ? join(backupDir, 'settings.yaml') : ''
        if (settingsBackup && existsSync(settingsBackup)) {
          copyFileSync(settingsBackup, targetSettings)
          rolled.push('restored settings.yaml from backup')
        }
      } else {
        rmSync(targetSettings, { force: true })
        rolled.push('removed settings.yaml (created by this import)')
      }
      if (staging) {
        rmSync(staging, { recursive: true, force: true })
        try { rmdirSync(join(resolve(opts.home ?? resolveDshHome()), '.dshmig-staging')) } catch { /* 并发导入仍在用：忽略 */ }
      }
      rolled.push('removed staging')
      // 回滚后本次备份已冗余（settings 已恢复/删除），删除以保持目标机干净状态（重复导入时 target-used 只报告迁移历史，不阻断）
      if (backupDirCreated && backupDir) {
        rmSync(backupDir, { recursive: true, force: true })
        if (!backupRootExisted) rmSync(join(resolve(opts.home ?? resolveDshHome()), '.dshmig-backup'), { recursive: true, force: true })
        rolled.push('removed this import\'s backup dir')
      }
    } catch (re) { rolled.push(`rollback error: ${String(re)}`) }
    return { ok: false, dryRun: opts.dryRun === true, plan: undefined, verify, error: String(e), rollback: rolled }
  }
}
