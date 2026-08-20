// 自携带（0.0.9）：导出时自动把 dsh-migrate 自身附加到归档 profile（dependencies + dsh.profile.bundles），
// 目标机导入后自带迁移工具。断言：预览警告 → 归档内容/校验和一致 → 导入后 profile 含工具 → 幂等（已含不重复）。
import { exportDsh } from '../lib/export.js'
import { importDsh } from '../lib/import.js'
import AdmZip from 'adm-zip'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const OWN = require('../package.json')
const TOOL_NAME = OWN.name
const TOOL_VERSION = OWN.version

const sandbox = 'C:/dsh explore/.sandbox-carry'
rmSync(sandbox, { recursive: true, force: true })
const src = join(sandbox, 'src')
const dst = join(sandbox, 'dst')
mkdirSync(join(src, 'profiles', 'web'), { recursive: true })
mkdirSync(join(src, 'vendor', 'fake-pkg'), { recursive: true })
writeFileSync(join(src, 'settings.yaml'), 'ui-theme:\n  preference: system\n')
writeFileSync(join(src, 'profiles', 'web', 'package.json'), JSON.stringify({
  name: 'dsh-profile-web', private: true,
  dependencies: { '@dsh-external/fake': 'link:' + join(src, 'vendor', 'fake-pkg').replace(/\\/g, '/') },
  dsh: { profile: { bundles: ['@dsh-external/fake'] } },
}, null, 2))
writeFileSync(join(src, 'profiles', 'web', 'cordis.yml'), 'plugins:\n  - id: fake\n')
writeFileSync(join(src, 'vendor', 'fake-pkg', 'package.json'), JSON.stringify({
  name: '@dsh-external/fake', version: '1.0.0', main: 'lib/index.js',
  dsh: { bundle: { patch: './cordis.patch.yml' } },
}))
writeFileSync(join(src, 'vendor', 'fake-pkg', 'cordis.patch.yml'), '- insert:\n    - id: fake\n')

let pass = 0
let fail = 0
function check(name, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  cond ? pass++ : fail++
}
const countTool = (pkg) => (JSON.stringify(pkg).match(new RegExp(TOOL_NAME, 'g')) || []).length

// ── dryRun 预览应提示自动附加，且不写产物 ─────────────────────
const prev = exportDsh({ home: src, dryRun: true })
check('dryRun 预览含自动附加警告', prev.ok === true && prev.plan?.warnings.some((w) => w.includes(TOOL_NAME)), JSON.stringify(prev.plan?.warnings))
check('dryRun 不打包（无 artifactPath）', prev.artifactPath === undefined)

// ── 真实导出：归档内 profile 应已附加本工具 ───────────────────
const exp = exportDsh({ home: src, dryRun: false, outDir: join(sandbox, 'exports') })
check('导出成功', exp.ok === true, exp.error ?? '')
const zip = new AdmZip(exp.artifactPath)
const readEntry = (name) => zip.getEntry(name)?.getData().toString('utf8')
const manifest = JSON.parse(readEntry('manifest.json'))
const outPkg = JSON.parse(readEntry('config/profiles/web/package.json'))
check('归档 package.json 含本工具依赖', outPkg.dependencies?.[TOOL_NAME] === '^' + TOOL_VERSION, JSON.stringify(outPkg.dependencies))
check('归档 package.json bundles 含本工具', outPkg.dsh?.profile?.bundles?.includes(TOOL_NAME), JSON.stringify(outPkg.dsh?.profile?.bundles))
check('归档内本工具只出现 2 次（dep + bundle，无重复）', countTool(outPkg) === 2, `n=${countTool(outPkg)}`)
const expectedHash = createHash('sha256').update(JSON.stringify(outPkg, null, 2) + '\n').digest('hex')
const mf = manifest.files.find((f) => f.path === 'config/profiles/web/package.json')
check('manifest sha256 与重写后内容一致', mf !== undefined && mf.sha256 === expectedHash, `mf=${mf?.sha256.slice(0, 12)} expected=${expectedHash.slice(0, 12)}`)
check('源机 profile package.json 未被修改（导出只读）', !JSON.parse(readFileSync(join(src, 'profiles', 'web', 'package.json'), 'utf8')).dependencies?.[TOOL_NAME])

// ── 导入（skipInstall）：目标机新 profile 应自带本工具 ─────────
const imp = importDsh({ archive: exp.artifactPath, home: dst, skipInstall: true })
check('导入成功', imp.ok === true, imp.error ?? '')
const newPkg = JSON.parse(readFileSync(join(dst, 'profiles', imp.plan?.newProfile ?? '', 'package.json'), 'utf8'))
check('导入后 profile 依赖含本工具', newPkg.dependencies?.[TOOL_NAME] === '^' + TOOL_VERSION, JSON.stringify(newPkg.dependencies))
check('导入后 profile bundles 含本工具', newPkg.dsh?.profile?.bundles?.includes(TOOL_NAME), JSON.stringify(newPkg.dsh?.profile?.bundles))

// ── 幂等：已含本工具的 profile 再导出，不重复附加 ─────────────
const exp2 = exportDsh({ home: dst, dryRun: false, outDir: join(sandbox, 'exports2') })
check('二次导出成功', exp2.ok === true, exp2.error ?? '')
const zip2 = new AdmZip(exp2.artifactPath)
const pkg2 = JSON.parse(zip2.getEntry(`config/profiles/${imp.plan?.newProfile}/package.json`)?.getData().toString('utf8'))
check('幂等：已含时不重复附加（仍 2 次）', countTool(pkg2) === 2, `n=${countTool(pkg2)}`)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
