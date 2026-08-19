// target-freshness 沙箱验证：原生（空 home）通过 + 脏机拒绝。
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

const freshness = (label, expectPass) => {
  const r = importDsh({ archive, home, dryRun: true })
  const c = r.plan?.checks.find((x) => x.name === 'target-freshness')
  const ok = c?.ok === expectPass
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label} | detail: ${c?.detail ?? r.error}`)
  return ok
}

let all = true
all = freshness('1. fresh empty home passes', true) && all
mkdirSync(home + '/profiles/extra', { recursive: true })
writeFileSync(home + '/profiles/extra/package.json', '{}')
all = freshness('2. extra profile rejected', false) && all
rmSync(home + '/profiles/extra', { recursive: true, force: true })
mkdirSync(home + '/vendor/somepkg', { recursive: true })
all = freshness('3. vendor pkg rejected', false) && all
rmSync(home + '/vendor', { recursive: true, force: true })
mkdirSync(home + '/.dshmig-backup', { recursive: true })
all = freshness('4. backup history rejected', false) && all

rmSync(sandbox, { recursive: true, force: true })
console.log(all ? 'ALL PASS' : 'SOME FAILED')
process.exit(all ? 0 : 1)
