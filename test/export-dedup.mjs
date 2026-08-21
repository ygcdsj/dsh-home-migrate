// 导出去重（0.0.10）：多个 profile 共享同一 vendor 包时，links 与 vendor 文件只应出现一次
// （此前每个 profile 各扫一遍 → 归档重复 N 倍、导入警告/验证重复）。导入（skipInstall）仍正常且无重复警告。
import { exportDsh } from '../lib/export.js'
import { importDsh } from '../lib/import.js'
import AdmZip from 'adm-zip'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const sandbox = 'C:/dsh explore/.sandbox-dedup'
rmSync(sandbox, { recursive: true, force: true })
const src = join(sandbox, 'src')
const dst = join(sandbox, 'dst')

// 两个 profile（web / tui）共享同一个 vendor 包 @dsh-external/shared
for (const prof of ['web', 'tui']) {
  mkdirSync(join(src, 'profiles', prof), { recursive: true })
  writeFileSync(join(src, 'profiles', prof, 'package.json'), JSON.stringify({
    name: 'dsh-profile-' + prof, private: true,
    dependencies: { '@dsh-external/shared': 'link:' + join(src, 'vendor', 'shared').replace(/\\/g, '/') },
  }, null, 2))
  writeFileSync(join(src, 'profiles', prof, 'cordis.yml'), 'plugins:\n  - id: x\n')
}
mkdirSync(join(src, 'vendor', 'shared'), { recursive: true })
writeFileSync(join(src, 'vendor', 'shared', 'package.json'), JSON.stringify({
  name: '@dsh-external/shared', version: '1.0.0', main: 'lib.js',
  dsh: { bundle: { patch: './cordis.patch.yml' } },
}))
writeFileSync(join(src, 'vendor', 'shared', 'cordis.patch.yml'), '- insert:\n    - id: x\n')
writeFileSync(join(src, 'vendor', 'shared', 'lib.js'), 'export const ok = true\n')
writeFileSync(join(src, 'settings.yaml'), 'ui-theme:\n  preference: system\n')

let pass = 0
let fail = 0
function check(name, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  cond ? pass++ : fail++
}

const exp = exportDsh({ home: src, dryRun: false, outDir: join(sandbox, 'exports') })
check('导出成功', exp.ok === true, exp.error ?? '')

// ── plan 层去重 ────────────────────────────────────────────────
const sharedLinks = exp.plan?.links.filter((l) => l.dep === '@dsh-external/shared') ?? []
check('plan.links 中 shared 只有 1 条', sharedLinks.length === 1, `n=${sharedLinks.length}`)
const vendorRels = (exp.plan?.files ?? []).filter((f) => f.relPath.startsWith('vendor/shared/')).map((f) => f.relPath)
check('plan 中 vendor 文件无重复 relPath', new Set(vendorRels).size === vendorRels.length, `total=${vendorRels.length} unique=${new Set(vendorRels).size}`)
check('vendor/shared/lib.js 只出现 1 次', vendorRels.filter((r) => r === 'vendor/shared/lib.js').length === 1)
check('vendor/shared/package.json 只出现 1 次', vendorRels.filter((r) => r === 'vendor/shared/package.json').length === 1)

// ── manifest 层去重 ────────────────────────────────────────────
const zip = new AdmZip(exp.artifactPath)
const manifest = JSON.parse(zip.getEntry('manifest.json').getData().toString('utf8'))
const mPaths = manifest.files.map((f) => f.path)
check('manifest.files 无重复 path', new Set(mPaths).size === mPaths.length)
check('manifest.links 中 shared 只有 1 条', manifest.links.filter((l) => l.dep === '@dsh-external/shared').length === 1)
check('归档内 vendor/shared/lib.js 恰好 1 份', zip.getEntries().filter((e) => e.entryName === 'vendor/shared/lib.js').length === 1)

// ── 导入仍正常，无重复 vendor 跳过警告 ─────────────────────────
const imp = importDsh({ archive: exp.artifactPath, home: dst, skipInstall: true })
check('导入成功', imp.ok === true, imp.error ?? '')
check('无重复 "already exists" 警告', !(imp.plan?.warnings ?? []).some((w) => w.includes('already exists')), JSON.stringify(imp.plan?.warnings))

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
