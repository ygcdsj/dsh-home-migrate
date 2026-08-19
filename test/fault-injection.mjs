// M4 故障注入套件（docs §11.3）：每个用例构造坏输入，断言导入走预期路径（报错/拦截/回滚），
// 并断言回滚后 home 无残留。用例 6（pnpm 失败）在沙箱内走 spawn EPERM 路径，授权下走真实 404 路径——两者都验证回滚。
// 2026-08-19 增（SECURITY_REVIEW F1）：用例 9-13 恶意 manifest 路径（.. / 绝对路径 / 盘符）解析即拒绝、零写入。
import { createArchive } from '../lib/archive.js'
import { importDsh } from '../lib/import.js'
import { exportDsh } from '../lib/export.js'
import { buildManifest, hashContent } from '../lib/manifest.js'
import AdmZip from 'adm-zip'
import { mkdirSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs'

const sandbox = 'C:/dsh explore/.sandbox-fi'
rmSync(sandbox, { recursive: true, force: true })
mkdirSync(sandbox, { recursive: true })
const home = sandbox + '/home'

let pass = 0
let fail = 0
function check(name, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  cond ? pass++ : fail++
}

// ── fake 归档构造 ──────────────────────────────────────────────
const fakeContent = 'export const ok = true\n'
const fakePatch = '- insert:\n    - id: fake\n      name: \'@dsh-external/fake\'\n      config: {}\n'
const settingsYaml = 'ui-theme:\n  preference: system\n'

function makeFakeArchive(opts = {}) {
  const { platform = process.platform, vendorPatch = true, corruptSha = false, extraDeps = {}, omitVendorEntry = false } = opts
  const vendor = sandbox + '/src/vendor/fake-pkg'
  mkdirSync(vendor + '/lib', { recursive: true })
  writeFileSync(vendor + '/lib/index.js', fakeContent)
  const pkgJson = JSON.stringify({
    name: '@dsh-external/fake', version: '1.0.0', main: 'lib/index.js',
    ...(vendorPatch ? { dsh: { bundle: { patch: './cordis.patch.yml' } } } : {}),
  }, null, 2)
  writeFileSync(vendor + '/package.json', pkgJson)
  writeFileSync(vendor + '/cordis.patch.yml', fakePatch)
  const profileJson = JSON.stringify({
    name: 'dsh-profile-web', private: true,
    dependencies: { '@dsh-external/fake': 'link:C:/Users/<user>/.dsh/vendor/fake-pkg', ...extraDeps },
    dsh: { profile: { bundles: ['@dsh-external/fake'] } },
  }, null, 2)
  const cordisYaml = '[]\n'
  const files = [
    { path: 'config/profiles/web/package.json', sha256: hashContent(profileJson), size: Buffer.byteLength(profileJson) },
    { path: 'config/profiles/web/cordis.yml', sha256: hashContent(cordisYaml), size: Buffer.byteLength(cordisYaml) },
    { path: 'config/settings.yaml', sha256: hashContent(settingsYaml), size: Buffer.byteLength(settingsYaml) },
    { path: 'vendor/fake-pkg/lib/index.js', sha256: hashContent(fakeContent), size: Buffer.byteLength(fakeContent) },
    { path: 'vendor/fake-pkg/package.json', sha256: hashContent(pkgJson), size: Buffer.byteLength(pkgJson) },
    { path: 'vendor/fake-pkg/cordis.patch.yml', sha256: hashContent(fakePatch), size: Buffer.byteLength(fakePatch) },
  ]
  const manifest = buildManifest({
    platform, arch: process.arch, dshVersion: '0.1.0-rc.7', dshHome: 'C:/Users/<user>/.dsh',
    profiles: ['web'], files, links: [{ dep: '@dsh-external/fake', vendorPath: 'vendor/fake-pkg' }],
    excluded: [], secretReport: { excludedFiles: [], redactedFields: [] },
  })
  if (corruptSha) manifest.files[0].sha256 = '0'.repeat(64)
  const archive = sandbox + '/fake.dshmig'
  const entries = [
    { path: 'manifest.json', content: JSON.stringify(manifest, null, 2) },
    { path: 'config/profiles/web/package.json', content: profileJson },
    { path: 'config/profiles/web/cordis.yml', content: cordisYaml },
    { path: 'config/settings.yaml', content: settingsYaml },
    { path: 'vendor/fake-pkg/lib/index.js', absPath: vendor + '/lib/index.js' },
    { path: 'vendor/fake-pkg/package.json', absPath: vendor + '/package.json' },
  ]
  if (!omitVendorEntry) entries.push({ path: 'vendor/fake-pkg/cordis.patch.yml', absPath: vendor + '/cordis.patch.yml' })
  createArchive(entries, archive)
  return archive
}

// ── 用例 ────────────────────────────────────────────────────────
// 1. sha256 篡改 → 校验失败，不写入
{
  const a = makeFakeArchive({ corruptSha: true })
  const r = importDsh({ archive: a, home })
  check('1 sha256 篡改 → 失败', !r.ok && /sha256 mismatch/.test(r.error ?? ''), r.error ?? '')
  check('1 不写入 profile', !existsSync(home + '/profiles/web-migrated'))
}

// 2. platform 不匹配 → 预检失败
{
  const a = makeFakeArchive({ platform: 'linux' })
  const r = importDsh({ archive: a, home })
  check('2 跨 OS 预检拦截', !r.ok && /preflight failed: platform/.test(r.error ?? ''), r.error ?? '')
}

// 3. 归档损坏 → 解析失败
{
  const bad = sandbox + '/garbage.dshmig'
  writeFileSync(bad, 'this is not a zip archive')
  const r = importDsh({ archive: bad, home })
  check('3 垃圾归档 → 失败', !r.ok, r.error ?? '')
}

// 4. vendor 条目缺失 → sha256 missing → 失败不写入
{
  const a = makeFakeArchive({ omitVendorEntry: true })
  const r = importDsh({ archive: a, home })
  check('4 vendor 缺失 → 失败', !r.ok && /missing/.test(r.error ?? ''), r.error ?? '')
  check('4 不写入 vendor', !existsSync(home + '/vendor/fake-pkg'))
}

// 5. bundle 契约失败 → 前置拦截 + 回滚
{
  const a = makeFakeArchive({ vendorPatch: false })
  const r = importDsh({ archive: a, home })
  check('5 bundle 契约拦截', !r.ok && /bundle contract/.test(r.error ?? ''), r.error ?? '')
  check('5 回滚删除 profile', !existsSync(home + '/profiles/web-migrated'))
  check('5 回滚删除 vendor', !existsSync(home + '/vendor/fake-pkg'))
}

// 6. pnpm 失败 → L1 FAIL → 回滚（沙箱内 EPERM / 授权下 404，路径相同）
{
  const a = makeFakeArchive({ extraDeps: { 'dsh-nonexistent-pkg-xyz': '^9.9.9' } })
  const r = importDsh({ archive: a, home, skipInstall: false })
  const l1 = r.verify?.find((v) => v.level === 1)
  check('6 pnpm install 失败', !r.ok && l1 && !l1.ok, l1?.detail?.slice(-120) ?? r.error ?? '')
  check('6 回滚删除 profile', !existsSync(home + '/profiles/web-migrated'))
  check('6 回滚删除 vendor', !existsSync(home + '/vendor/fake-pkg'))
  check('6 回滚清理 staging', !existsSync(home + '/.dshmig-staging'))
}

// 7. 凭据排除断言（真实导出）
{
  const exp = exportDsh({ dryRun: false, outDir: sandbox + '/exports' })
  const zip = new AdmZip(exp.artifactPath)
  const names = zip.getEntries().map((e) => e.entryName)
  check('7 导出不含 .credentials.yaml', !names.some((n) => /credentials\.yaml/.test(n)))
  check('7 导出不含 .env', !names.some((n) => /(^|\/)\.env(\.|$)/.test(n)))
  check('7 导出不含 node_modules', !names.some((n) => /node_modules/.test(n)))
  check('7 导出含 manifest', names.includes('manifest.json'))
}

// 8. 回滚后 home 干净（无 staging 残留；backup 按设计保留；空壳目录 profiles/vendor 无害——导入 mkdir 连带创建，真实 home 中为既有目录）
{
  const top = readdirSync(home).filter((n) => !n.startsWith('.dshmig-backup'))
  const leftovers = top.filter((n) => n !== 'profiles' && n !== 'vendor')
  check('8 home 顶层无残留', leftovers.length === 0, leftovers.join(','))
  check('8 无 staging', !existsSync(home + '/.dshmig-staging'))
}

// ── SECURITY_REVIEW F1：恶意 manifest 路径解析即拒绝、零写入 ──
function maliciousArchive(overrides) {
  const manifest = buildManifest({
    platform: process.platform, arch: process.arch, dshVersion: '0.1.0-rc.7', dshHome: 'C:/Users/<user>/.dsh',
    profiles: ['web'], files: [], links: [], excluded: [], secretReport: { excludedFiles: [], redactedFields: [], unscannedFiles: [], unscannedTotal: 0 },
    ...overrides,
  })
  const archive = sandbox + '/malicious.dshmig'
  createArchive([{ path: 'manifest.json', content: JSON.stringify(manifest, null, 2) }], archive)
  return archive
}

// 9. profiles[0] 路径穿越 → 拒绝
{
  const a = maliciousArchive({ profiles: ['../../evil'] })
  const r = importDsh({ archive: a, home })
  check('9 profiles[0]="../../evil" → 拒绝', !r.ok && /unsafe profiles/.test(r.error ?? ''), r.error ?? '')
  check('9 零写入（无 evil-migrated）', !existsSync(home + '/evil-migrated') && !existsSync(home + '/profiles/evil-migrated'))
}

// 10. links[].vendorPath 穿越 → 拒绝
{
  const a = maliciousArchive({ links: [{ dep: 'x', vendorPath: 'vendor/../evil' }] })
  const r = importDsh({ archive: a, home })
  check('10 vendorPath="vendor/../evil" → 拒绝', !r.ok && /unsafe links/.test(r.error ?? ''), r.error ?? '')
  check('10 零写入（无 home/evil）', !existsSync(home + '/evil'))
}

// 11. files[].path 反斜杠穿越 → 拒绝
{
  const a = maliciousArchive({ files: [{ path: '..\\..\\x', sha256: '0'.repeat(64), size: 0 }] })
  const r = importDsh({ archive: a, home })
  check('11 files[].path="..\\\\..\\\\x" → 拒绝', !r.ok && /unsafe files/.test(r.error ?? ''), r.error ?? '')
}

// 12. files[].path 绝对路径/盘符 → 拒绝
{
  const a = maliciousArchive({ files: [{ path: 'C:\\Windows\\win.ini', sha256: '0'.repeat(64), size: 0 }] })
  const r = importDsh({ archive: a, home })
  check('12 files[].path="C:\\\\Windows\\\\win.ini" → 拒绝', !r.ok && /unsafe files/.test(r.error ?? ''), r.error ?? '')
}

// 13. 合法路径不受影响（files:[] + 正常 profile 名仍可过预检到 freshness 阶段）
{
  const a = maliciousArchive({ profiles: ['web'] })
  const r = importDsh({ archive: a, home, dryRun: true })
  check('13 合法 manifest 不被误伤（dryRun 可生成 plan）', r.ok === true && r.plan !== undefined, r.error ?? '')
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
