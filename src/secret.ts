/**
 * secret.ts — 凭据排除 + secret 扫描脱敏。
 * 原则（docs §6.1）：硬排除文件名级凭据；settings.yaml / presets 等文本内容做字段级
 * 扫描，命中即脱敏（值替换 <redacted>）并记入 secretReport——迁移不搬运凭据。
 * 借鉴 dshmarket SECRET_FILE_HINTS 的思路但更进一步（它只警告不脱敏，我们迁移
 * 场景必须脱敏）。
 *
 * 判定策略（2026-08-19 修复漏报）：
 * 1. 字段名强信号：apiKey/token/secret/password/credential/privateKey/auth 等字段出现，
 *    值非平凡（非 env 引用/占位符/纯数字/短值）即命中——sk-xxx 这类真实 key 不再漏报；
 * 2. 无字段名信号时用值形态启发式（base64/hex/长混合串）；
 * 3. 豁免：*Env 字段、值本身是环境变量名引用、占位符、布尔/空值、版本号形态。
 */

export interface SecretHit {
  file: string
  field: string
  line: number
}

// 字段名强信号
const KEY_FIELD = /(?:api[_-]?key|apikey|token|secret|passw(?:ord|d)|credential|private[_-]?key|auth)/i
// *Env 字段（如 apiKeyEnv）= 环境变量名引用，不是秘密本身
const ENV_REF_FIELD = /env$/i
// 值本身是环境变量名引用形态（如 XIAOMI_API_KEY）
const ENV_VALUE = /^[A-Z][A-Z0-9_]{2,}$/
// 占位符 / 平凡值
const PLACEHOLDER = /^(<redacted>|[*xX]+|your[_ -]?[a-z]+|example[a-z]*)$/i
const TRIVIAL = /^(true|false|null|undefined|none|nil|n\/a|na)$/i
// 纯数字/版本号形态（弱密码与版本号无法可靠区分——豁免，宁漏勿误）
const NUMBERISH = /^\d[\d.:]*$/
// 值形态启发式（无字段名信号时）
const B64 = /^[A-Za-z0-9+/]{12,}={0,2}$/
const HEX = /^[0-9a-fA-F]{16,}$/
// 长混合串：必须字母+数字同时出现（纯字母的可读标识符如 provider-managed 不是凭据）
const MIXED = /^(?=.*[A-Za-z])(?=.*\d)[A-Za-z0-9_\-]{16,}$/
// 已知非秘密字段：即使值碰巧匹配长串形态也豁免（model: deepseek-v4-flash、provider: … 等）
const KNOWN_SAFE_FIELDS = /^(model|name|id|version|urls?|host|hostname|path|file|dir|folder|env|mode|role|type|kind|format|size|status|provider|engine|runtime|language|prefix|suffix|title|label|description|comment|note|maxdepth|depth|maxsteps|maxtokens|mintokens|temperature|toolname|tool|plugin|script|command|args?|timeout|interval|retry|backoff|seed|top_p|topk|maxlen|numresults|results)$/i

function looksSecretValue(field: string, value: string): boolean {
  // 字段名强信号：key 类字段 + 非平凡值 = 命中
  if (KEY_FIELD.test(field)) {
    if (ENV_REF_FIELD.test(field)) return false
    if (ENV_VALUE.test(value)) return false
    if (PLACEHOLDER.test(value) || TRIVIAL.test(value) || NUMBERISH.test(value)) return false
    return value.length >= 6
  }
  // 已知非秘密字段：豁免
  if (KNOWN_SAFE_FIELDS.test(field)) return false
  // 无字段名信号：值形态启发式
  if (B64.test(value)) return true
  if (HEX.test(value)) return true
  if (MIXED.test(value)) return true
  return false
}

// 字段名 + 分隔符 + 值（支持引号）
const FIELD_PATTERN = /"?'?([A-Za-z0-9_.-]+)"?'?\s*[:=]\s*("?'?)([^"'\s,;}{]+)\2/gi

/** 扫描文本中的疑似凭据字段。 */
export function detectSecrets(text: string, file: string): SecretHit[] {
  const hits: SecretHit[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    FIELD_PATTERN.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = FIELD_PATTERN.exec(line)) !== null) {
      const field = m[1]
      const value = m[3]
      if (looksSecretValue(field, value)) hits.push({ file, field, line: i + 1 })
    }
  }
  return hits
}

/** 把命中行的值替换为 <redacted>；返回脱敏文本与脱敏明细。 */
export function redactSecrets(text: string, hits: SecretHit[]): { text: string; redacted: { file: string; field: string; line: number }[] } {
  if (hits.length === 0) return { text, redacted: [] }
  const lines = text.split('\n')
  const redacted: { file: string; field: string; line: number }[] = []
  for (const hit of hits) {
    const idx = hit.line - 1
    if (idx < 0 || idx >= lines.length) continue
    const re = new RegExp(`("?'?${escapeRe(hit.field)}"?'?\\s*[:=]\\s*("?'?))([^"'\\s,;}{]+)(\\2)`, 'i')
    const next = lines[idx].replace(re, (_all, pre: string, _q1: string, _val: string, q2: string) => `${pre}<redacted>${q2}`)
    if (next !== lines[idx]) {
      lines[idx] = next
      redacted.push({ file: hit.file, field: hit.field, line: hit.line })
    }
  }
  return { text: lines.join('\n'), redacted }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
