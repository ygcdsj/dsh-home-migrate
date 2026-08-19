// SECURITY_REVIEW F4/F6 导出端到端：沙箱 home → exportDsh → 归档内 settings.yaml 已脱敏、
// secretReport 含 unscannedFiles、vendor 配置被扫描、manifest source.dshHome 不泄漏绝对路径。
import { exportDsh } from '../lib/export.js'
import AdmZip from 'adm-zip'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const sandbox = 'C:/dsh explore/.sandbox-redact'
rmSync(sandbox, { recursive: true, force: true })
const home = join(sandbox, 'home')

let pass = 0
let fail = 0
function check(name, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  cond ? pass++ : fail++
}

// ── 构造带凭据的沙箱 home ─────────────────────────────────────
const pem = [
  '-----BEGIN PRIVATE KEY-----',
  'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC',
  'MIIBggIBADANBgkqhkiG9w0BAQEFAASC',
  '-----END PRIVATE KEY-----',
].join('\n')

const settingsYaml = [
  'ui-theme:',
  '  preference: system',
  'password: "correct horse battery staple"',
  'apiKey: sk-abc123def456ghi',
  'auth: "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig"',
  'model: deepseek-v4-flash',
  'privateKey: |',
  ...pem.split('\n').map((l) => '  ' + l),
  '',
].join('\n')

mkdirSync(join(home, 'profiles', 'web'), { recursive: true })
mkdirSync(join(home, 'vendor', 'fake-pkg', 'lib'), { recursive: true })
mkdirSync(join(home, '.agent-presets'), { recursive: true })
writeFileSync(join(home, 'settings.yaml'), settingsYaml)
writeFileSync(join(home, 'profiles', 'web', 'package.json'), JSON.stringify({
  name: 'dsh-profile-web', private: true,
  dependencies: { '@dsh-external/fake': 'link:' + join(home, 'vendor', 'fake-pkg').replace(/\\/g, '/') },
}))
writeFileSync(join(home, 'vendor', 'fake-pkg', 'package.json'), JSON.stringify({
  name: '@dsh-external/fake', version: '1.0.0', main: 'lib/index.js',
  dsh: { bundle: { patch: './cordis.patch.yml' } },
}))
writeFileSync(join(home, 'vendor', 'fake-pkg', 'cordis.patch.yml'), '- insert:\n    - id: fake\n      name: \'@dsh-external/fake\'\n      config: {}\n')
writeFileSync(join(home, 'vendor', 'fake-pkg', 'lib', 'index.js'), 'export const ok = true\n')
// vendor 配置文件含凭据（F4 新增扫描范围）
writeFileSync(join(home, 'vendor', 'fake-pkg', 'config.yaml'), 'token: "abc def ghi"\n')
writeFileSync(join(home, '.agent-presets', 'dev.yaml'), 'description: plain text\n')

// ── 导出 ──────────────────────────────────────────────────────
const exp = exportDsh({ home, dryRun: false, outDir: join(sandbox, 'exports') })
check('导出成功', exp.ok === true, exp.error ?? '')
if (!exp.ok) { console.log(`\n${pass} passed, ${fail} failed`); process.exit(1) }

const zip = new AdmZip(exp.artifactPath)
const readEntry = (name) => zip.getEntry(name)?.getData().toString('utf8')
const manifest = JSON.parse(readEntry('manifest.json'))
const settingsOut = readEntry('config/settings.yaml')

// ── F4 断言 ───────────────────────────────────────────────────
check('settings.yaml 中带空格口令已脱敏', settingsOut.includes('password: "<redacted>"'), JSON.stringify(settingsOut.split('\n').find((l) => l.includes('password'))))
check('settings.yaml 中 apiKey 已脱敏', settingsOut.includes('apiKey: <redacted>'))
check('settings.yaml 中 Bearer JWT 已脱敏', settingsOut.includes('auth: "<redacted>"'))
check('settings.yaml 中 PEM 块已脱敏（无 base64 行）', !settingsOut.includes('MIIEvQIBADAN'), JSON.stringify(settingsOut.split('\n').filter((l) => l.includes('MII'))))
check('settings.yaml 中 KNOWN_SAFE model 不被误伤', settingsOut.includes('model: deepseek-v4-flash'))
check('vendor 配置文件 token 已脱敏', readEntry('vendor/fake-pkg/config.yaml').includes('token: "<redacted>"'))
check('secretReport.redactedFields ≥ 5', manifest.secretReport.redactedFields.length >= 5, `n=${manifest.secretReport.redactedFields.length}`)
check('secretReport.unscannedTotal > 0（vendor 代码文件未扫描）', manifest.secretReport.unscannedTotal > 0, `n=${manifest.secretReport.unscannedTotal}`)
check('unscannedFiles 含 vendor 代码文件', manifest.secretReport.unscannedFiles.some((f) => f.includes('lib/index.js')), JSON.stringify(manifest.secretReport.unscannedFiles.slice(0, 3)))

// ── F6 断言：source.dshHome 不泄漏绝对路径 ────────────────────
check('manifest.source.dshHome 不含沙箱绝对路径', typeof manifest.source.dshHome === 'string' && !manifest.source.dshHome.includes(sandbox), JSON.stringify(manifest.source.dshHome))
check('dshHome 为显示形态（~/.dsh 或 $DSH_HOME）', /^(~\/\.dsh|\$DSH_HOME)$/.test(manifest.source.dshHome), JSON.stringify(manifest.source.dshHome))

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
