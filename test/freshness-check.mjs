// target-used 软门禁沙箱验证：原生通过 + 脏机警告放行（不阻断）+ requireFresh 严格模式拒绝。
import { importDsh } from '../lib/import.js'
import { createArchive } from '../lib/archive.js'
import { buildManifest, hashContent } from '../lib/manifest.js'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'

const sandbox = 'C:/dsh explore/.sandbox-fresh'
rmSync(sandbox, { recursive: true, force: true })
mkdirSync(sandbox + '/home', { recursive: true })
const home = sandbox + '/home'
const archive = sandbox + '/fake.dshmig'

// 造最小归档
const vendorSrc = sandbox + '/src/vendor/fake-pkg'
mkdirSync(vendorSrc + '/lib', { recursive: true })
writeFileSync(vendorSrc + '/lib/index.js', 'export const ok = true\n')
writeFileSync(vendorSrc + '/package.json', JSON.stringify({ name: '@dsh-external/fake', version: '1.0.0', main: 'lib/index.js', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
writeFileSync(vendorSrc + '/cordis.patch.yml', "- insert:\n    - id: fake\n      name: '@dsh-external/fake'\n      config: {}\n")
const pkgJson = JSON.stringify({ name: 'dsh-profile-web', private: true, dependencies: { '@dsh-external/fake': 'link:C:/Users/<user>/.dsh/vendor/fake-pkg' }, dsh: { profile: { bundles: ['@dsh-external/fake'] } } })
const settings = 'ui-theme:\n  preference: system\n'
const files = [
  { path: 'config/profiles/web/package.json', sha256: hashContent(pkgJson), size: Buffer.byteLength(pkgJson) },
  { path: 'config/profiles/web/cordis.yml', sha256: hashContent('[]\n'), size: 3 },
  { path: 'config/settings.yaml', sha256: hashContent(settings), size: Buffer.byteLength(settings) },
  { path: 'vendor/fake-pkg/lib/index.js', sha256: hashContent('export const ok = true\n'), size: 22 },
  { path: 'vendor/fake-pkg/package.json', sha256: hashContent(JSON.stringify({ name: '@dsh-external/fake', version: '1.0.0', main: 'lib/index.js' })), size: 0 },
  { path: 'vendor/fake-pkg/cordis.patch.yml', sha256: hashContent('- insert: []'), size: 0 },
]
const manifest = buildManifest({ platform: process.platform, arch: process.arch, dshVersion: '0.1.0-rc.7', dshHome: 'C:/Users/<user>/.dsh', profiles: ['web'], files, links: [{ dep: '@dsh-external/fake', vendorPath: 'vendor/fake-pkg' }], excluded: [], secretReport: { excludedFiles: [], redactedFields: [] } })
createArchive([
  { path: 'manifest.json', content: JSON.stringify(manifest) },
  { path: 'config/profiles/web/package.json', content: pkgJson },
  { path: 'config/profiles/web/cordis.yml', content: '[]\n' },
  { path: 'config/settings.yaml', content: settings },
  { path: 'vendor/fake-pkg/lib/index.js', absPath: vendorSrc + '/lib/index.js' },
  { path: 'vendor/fake-pkg/package.json', absPath: vendorSrc + '/package.json' },
  { path: 'vendor/fake-pkg/cordis.patch.yml', absPath: vendorSrc + '/cordis.patch.yml' },
], archive)

let all = true
const tc = (label, expect) => {
  const r = importDsh({ archive, home, dryRun: true, ...(expect.opts ?? {}) })
  const c = r.plan?.checks.find((x) => x.name === 'target-used')
  const checkOk = c?.ok === expect.ok && (expect.severity === undefined || c?.severity === expect.severity)
  const overallOk = r.ok === expect.dryRunOk
  const pass = checkOk && overallOk
  if (!pass) all = false
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label} | check: ok=${c?.ok} sev=${c?.severity ?? '-'} | dryRun.ok=${r.ok} | detail: ${c?.detail ?? r.error ?? '-'}`)
  return pass
}

// 1. 原生（空 home）通过、无 warn
tc('1. fresh empty home passes, no warn', { ok: true, severity: undefined, dryRunOk: true })

// 2. 已有非默认 profile → warn 放行（不阻断）
mkdirSync(home + '/profiles/extra', { recursive: true })
writeFileSync(home + '/profiles/extra/package.json', '{}')
tc('2. extra profile -> warn, NOT blocked', { ok: false, severity: 'warn', dryRunOk: true })

// 3. requireFresh 严格模式 + 脏目标 → error 阻断
tc('3. requireFresh + dirty -> blocked', { ok: false, severity: 'error', dryRunOk: false, opts: { requireFresh: true } })
rmSync(home + '/profiles/extra', { recursive: true, force: true })

// 4. vendor 有包 → warn 放行
mkdirSync(home + '/vendor/somepkg', { recursive: true })
tc('4. vendor pkg -> warn, NOT blocked', { ok: false, severity: 'warn', dryRunOk: true })
rmSync(home + '/vendor', { recursive: true, force: true })

// 5. 迁移历史（.dshmig-backup/）→ warn 放行
mkdirSync(home + '/.dshmig-backup', { recursive: true })
tc('5. backup history -> warn, NOT blocked', { ok: false, severity: 'warn', dryRunOk: true })
rmSync(home + '/.dshmig-backup', { recursive: true, force: true })

// 6. requireFresh + 原生 → 仍通过
tc('6. requireFresh + fresh -> passes', { ok: true, severity: undefined, dryRunOk: true, opts: { requireFresh: true } })

rmSync(sandbox, { recursive: true, force: true })
console.log(all ? 'ALL PASS' : 'SOME FAILED')
process.exit(all ? 0 : 1)
