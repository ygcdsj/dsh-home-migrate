// M2/M3 冒烟层 1：导出 → dryRun 预检 → 导入（skipInstall）→ 验证重写/还原/递增/故障注入。
// 运行：node test/smoke-import.mjs（沙箱内可跑，无子进程；工作区外无副作用）
import { exportDsh } from '../lib/export.js'
import { importDsh } from '../lib/import.js'
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs'

const sandbox = 'C:/dsh explore/.sandbox'
rmSync(sandbox, { recursive: true, force: true })
mkdirSync(sandbox, { recursive: true })

// 1. 真实导出
const exp = exportDsh({ dryRun: false, outDir: sandbox + '/exports' })
console.log('1. export ok:', exp.ok, '| artifact:', exp.artifactPath)

// 2. dryRun 预检（沙箱 home）
const home = sandbox + '/home'
const plan = importDsh({ archive: exp.artifactPath, home, dryRun: true })
console.log('2. dryRun ok:', plan.ok, '| newProfile:', plan.plan?.newProfile,
  '| checks:', plan.plan?.checks.map((c) => `${c.name}=${c.ok}`).join(','))

// 3. 真实导入（skipInstall）
const imp = importDsh({ archive: exp.artifactPath, home, skipInstall: true })
console.log('3. import ok:', imp.ok, '| profile:', imp.plan?.newProfile, '| backupDir:', imp.backupDir, imp.error ?? '')

// 4. 验证结果
if (imp.ok) {
  const newPkg = JSON.parse(readFileSync(home + '/profiles/web-migrated/package.json', 'utf8'))
  console.log('4. rewritten link:', newPkg.dependencies['@dsh-external/dsh-super-injector'])
  console.log('   vendor lib:', existsSync(home + '/vendor/dsh-super-injector/lib/index.js'))
  console.log('   preset:', existsSync(home + '/.agent-presets/router-standard/preset.yml'))
  console.log('   settings:', existsSync(home + '/settings.yaml'))
  console.log('   cordis.patch:', existsSync(home + '/profiles/web-migrated/cordis.patch.yml'))
}

// 5. 再次导入 → 名字递增
const imp2 = importDsh({ archive: exp.artifactPath, home, skipInstall: true })
console.log('5. second import profile:', imp2.plan?.newProfile, '| ok:', imp2.ok)

// 6. 故障注入：归档不存在
const bad = importDsh({ archive: sandbox + '/nope.dshmig', home })
console.log('6. missing archive → ok:', bad.ok, '| error:', bad.error)
