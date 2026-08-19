// 第二层测试：构造最小归档（1 npm 依赖 + 1 link: 假 vendor 包）→ 完整导入（pnpm install + 验证链）。
// 需要授权（pnpm 网络 + 子进程捕获 + 沙箱写入）。
import { createArchive } from '../lib/archive.js'
import { importDsh } from '../lib/import.js'
import { buildManifest, hashContent } from '../lib/manifest.js'
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'

const sandbox = 'C:/dsh explore/.sandbox2'
rmSync(sandbox, { recursive: true, force: true })
mkdirSync(sandbox, { recursive: true })
const home = sandbox + '/home'
mkdirSync(home + '/profiles/web', { recursive: true })

// 构造 fake vendor 包（必须含 package.json：dsh 的 resolveBundleDir 靠它解析 main）
const fakeVendor = 'vendor/fake-pkg/lib/index.js'
const fakeContent = 'export const ok = true\n'
const fakePkgJson = JSON.stringify({ name: '@dsh-external/fake', version: '1.0.0', main: 'lib/index.js', dsh: { bundle: { patch: './cordis.patch.yml' } } }, null, 2)
const fakePatch = '- insert:\n    - id: fake\n      name: \'@dsh-external/fake\'\n      config: {}\n'
mkdirSync(sandbox + '/src/vendor/fake-pkg/lib', { recursive: true })
writeFileSync(sandbox + '/src/vendor/fake-pkg/lib/index.js', fakeContent)
writeFileSync(sandbox + '/src/vendor/fake-pkg/package.json', fakePkgJson)
writeFileSync(sandbox + '/src/vendor/fake-pkg/cordis.patch.yml', fakePatch)

const pkgJson = JSON.stringify({
  name: 'dsh-profile-web', private: true,
  dependencies: {
    '@dsh-external/fake': 'link:C:/Users/<user>/.dsh/vendor/fake-pkg',
    'adm-zip': '^0.5.16',
  },
  dsh: { profile: { bundles: ['@dsh-external/fake'] } },
}, null, 2)

const settingsYaml = 'ui-theme:\n  preference: system\n'
const cordisYaml = '[]\n'
const manifest = buildManifest({
  platform: process.platform, arch: process.arch, dshVersion: '0.1.0-rc.7', dshHome: 'C:/Users/<user>/.dsh',
  profiles: ['web'],
  files: [
    { path: 'config/profiles/web/package.json', sha256: hashContent(pkgJson), size: Buffer.byteLength(pkgJson) },
    { path: 'config/profiles/web/cordis.yml', sha256: hashContent(cordisYaml), size: Buffer.byteLength(cordisYaml) },
    { path: 'config/settings.yaml', sha256: hashContent(settingsYaml), size: Buffer.byteLength(settingsYaml) },
    { path: fakeVendor, sha256: hashContent(fakeContent), size: Buffer.byteLength(fakeContent) },
    { path: 'vendor/fake-pkg/package.json', sha256: hashContent(fakePkgJson), size: Buffer.byteLength(fakePkgJson) },
    { path: 'vendor/fake-pkg/cordis.patch.yml', sha256: hashContent(fakePatch), size: Buffer.byteLength(fakePatch) },
  ],
  links: [{ dep: '@dsh-external/fake', vendorPath: 'vendor/fake-pkg' }],
  excluded: [],
  secretReport: { excludedFiles: [], redactedFields: [] },
})

const archive = sandbox + '/fake.dshmig'
createArchive([
  { path: 'manifest.json', content: JSON.stringify(manifest, null, 2) },
  { path: 'config/profiles/web/package.json', content: pkgJson },
  { path: 'config/profiles/web/cordis.yml', content: cordisYaml },
  { path: 'config/settings.yaml', content: settingsYaml },
  { path: fakeVendor, absPath: sandbox + '/src/vendor/fake-pkg/lib/index.js' },
  { path: 'vendor/fake-pkg/package.json', absPath: sandbox + '/src/vendor/fake-pkg/package.json' },
  { path: 'vendor/fake-pkg/cordis.patch.yml', absPath: sandbox + '/src/vendor/fake-pkg/cordis.patch.yml' },
], archive)
console.log('archive:', archive)

const imp = importDsh({ archive, home, skipInstall: false })
console.log('import ok:', imp.ok)
console.log('profile:', imp.plan?.newProfile)
if (imp.verify) for (const v of imp.verify) console.log(`verify L${v.level} ${v.name}: ${v.ok ? 'OK' : 'FAIL'} ${v.detail ?? ''}`)
if (!imp.ok) console.log('error:', imp.error, '\nrollback:', imp.rollback)
