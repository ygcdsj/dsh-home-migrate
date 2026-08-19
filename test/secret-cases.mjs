// SECURITY_REVIEW F4 回归表：脱敏漏报修复验证（直接测 lib/secret.js）。
// 覆盖：带空格引号值 / Bearer JWT / 引号内 sk-+空格 / YAML 块标量（PEM）/ 行内注释 / 豁免项。
import { detectSecrets, redactSecrets } from '../lib/secret.js'

let pass = 0
let fail = 0
function check(name, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  cond ? pass++ : fail++
}

const FILE = 'test.yaml'

function run(text) {
  const hits = detectSecrets(text, FILE)
  const out = redactSecrets(text, hits)
  return { hits, text: out.text, redacted: out.redacted }
}

// ── 应命中（F4 漏报形态）────────────────────────────────────
{
  const r = run('password: "correct horse battery staple"\n')
  check('带空格引号口令 → 命中', r.hits.length === 1, `hits=${r.hits.length}`)
  check('带空格引号口令 → 脱敏保留引号', r.text.includes('password: "<redacted>"'), JSON.stringify(r.text))
}
{
  const r = run('token: "abc def ghi"\n')
  check('带空格引号 token → 命中', r.hits.length === 1)
}
{
  const r = run('auth: "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig"\n')
  check('Bearer JWT → 命中', r.hits.length === 1)
  check('Bearer JWT → 脱敏保留引号', r.text.includes('auth: "<redacted>"'))
}
{
  const r = run('password: "sk-1234567890 abcdef"\n')
  check('引号内 sk- + 空格 → 命中', r.hits.length === 1)
}
{
  const r = run('token: abc def ghi\n')
  check('裸值含空格 token → 命中', r.hits.length === 1, `hits=${r.hits.length}`)
}
{
  const pem = 'password: |\n  MIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n  MIIBggIBADANBgkqhkiG9w0BAQEFAASC\n'
  const r = run(pem)
  check('块标量 password: | → 命中', r.hits.length === 1, `hits=${r.hits.length}`)
  check('块标量 → 内容行被脱敏', !r.text.includes('MIIEvQIBADAN'), JSON.stringify(r.text))
}
{
  const pem = 'certificate: |\n  MIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n  MIIBggIBADANBgkqhkiG9w0BAQEFAASC\n'
  const r = run(pem)
  check('非 secret 字段块标量 + base64 内容 → 命中（内容启发式）', r.hits.length === 1, `hits=${r.hits.length}`)
}
// ── R2：KNOWN_SAFE 块标量内容启发式豁免（不过度脱敏）────────────
{
  const r = run('description: |\n  dXNlcm5hbWU6cGFzc3dvcmQ=\n  MIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n')
  check('R2 description 块 + base64 内容 → 不命中不脱敏', r.hits.length === 0 && r.text.includes('dXNlcm5hbWU6cGFzc3dvcmQ='), JSON.stringify(r.text))
}
{
  const r = run('command: |\n  abcdef1234567890abcdef12\n')
  check('R2 command 块 + hex 内容 → 不命中不脱敏', r.hits.length === 0 && r.text.includes('abcdef1234567890abcdef12'), JSON.stringify(r.text))
}
{
  const r = run('script: |\n  echo hello\n')
  check('R2 script 块 + 普通文本 → 不命中', r.hits.length === 0)
}
// ── R3：裸值允许逗号/分号/大括号，到行尾或注释 ─────────────────
{
  const r = run('password: abc,defghi\n')
  check('R3 裸值含逗号 → 命中', r.hits.length === 1, `hits=${r.hits.length}`)
}
{
  const r = run('token: abc;def;ghi\n')
  check('R3 裸值含分号 → 命中', r.hits.length === 1)
}
{
  const r = run('password: abc,defghi # note\n')
  check('R3 裸值含逗号 + 行内注释 → 命中且保留注释', r.hits.length === 1 && r.text.includes('password: <redacted> # note'), JSON.stringify(r.text))
}
{
  const r = run('token: abcdef123456 # comment\n')
  check('R3 裸值行内注释 → 脱敏保留 # 前空格', r.text.includes('token: <redacted> # comment'), JSON.stringify(r.text))
}
// ── 原有正确行为不回归 ────────────────────────────────────────
{
  const r = run('apiKey: "sk-abc" # comment\n')
  check('行内注释 → 命中且保留注释', r.hits.length === 1 && r.text.includes('apiKey: "<redacted>" # comment'), JSON.stringify(r.text))
}
{
  const r = run('apiKey: sk-abc123def456ghi\n')
  check('sk- 长 key → 命中', r.hits.length === 1)
}
// ── 豁免：不误报 ─────────────────────────────────────────────
{
  const r = run('model: deepseek-v4-flash\n')
  check('model KNOWN_SAFE → 不命中', r.hits.length === 0)
}
{
  const r = run('url: "https://example.com/path?key=abc&v=1"\n')
  check('url KNOWN_SAFE → 不命中', r.hits.length === 0)
}
{
  const r = run('password: xyz\n')
  check('短值 password → 不命中（宁漏勿误）', r.hits.length === 0)
}
{
  const r = run('secret: <redacted>\n')
  check('已脱敏占位 → 不命中', r.hits.length === 0)
}
{
  const r = run('description: |\n  plain prose text\n  more prose here\n')
  check('非 secret 块标量 + 普通文本 → 不命中', r.hits.length === 0, `hits=${r.hits.length}`)
}
{
  const r = run('apiKeyEnv: XIAOMI_API_KEY\n')
  check('*Env 字段 → 不命中', r.hits.length === 0)
}
// ── 多字段同文件 / 行号 ──────────────────────────────────────
{
  const r = run('apiKey: sk-abc123def456ghi\nmodel: deepseek-v4-flash\npassword: "p a s s"\n')
  check('多字段 → 命中 2 个', r.hits.length === 2, `hits=${r.hits.length}`)
  check('行号正确（1 与 3）', r.hits[0].line === 1 && r.hits[1].line === 3, JSON.stringify(r.hits.map((h) => h.line)))
  check('多字段 → 各行脱敏', r.text.includes('apiKey: <redacted>') && r.text.includes('password: "<redacted>"'))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
