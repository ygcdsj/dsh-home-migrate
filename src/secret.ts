/**
 * secret.ts — 凭据排除 + secret 扫描脱敏。
 * 原则（docs §6.1）：硬排除文件名级凭据；settings.yaml / presets 等文本内容做字段级
 * 扫描，命中即脱敏（值替换 <redacted>）并记入 secretReport——迁移不搬运凭据。
 *
 * 判定策略（2026-08-19 修复漏报 F4）：
 * 1. 字段名强信号：apiKey/token/secret/password/credential/privateKey/auth 等字段出现，
 *    值非平凡（非 env 引用/占位符/纯数字/短值）即命中——sk-xxx 这类真实 key 不再漏报；
 * 2. 无字段名信号时用值形态启发式（base64/hex/长混合串）；
 * 3. 豁免：*Env 字段、值本身是环境变量名引用、占位符、布尔/空值、版本号形态。
 *
 * 值捕获（2026-08-19 修复）：
 * - 引号值捕获到闭合引号为止（允许空格/转义）——`password: "correct horse battery staple"`、
 *   `auth: "Bearer eyJ…"`、`password: "sk-xxx abcdef"` 不再漏报；
 * - 块标量（`field: |` / `field: >`）：字段名是 secret 类或内容行命中 base64/hex/长混合串
 *   启发式时整块脱敏（PEM 私钥典型形态）；
 * - 裸值（无引号）到行尾 / ` #` 注释为止。
 */

export interface SecretHit {
  file: string
  field: string
  line: number
  /** 'block' = 块标量命中（line 为起始行，blockEnd 为内容结束行不含）；缺省 'value' = 单行字段。 */
  mode?: 'value' | 'block'
  blockEnd?: number
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

/** 字段名是否为 secret 类（块标量用；不看值）。 */
function isSecretField(field: string): boolean {
  if (!KEY_FIELD.test(field)) return false
  if (ENV_REF_FIELD.test(field)) return false
  return true
}

/**
 * 字段名 + 分隔符 + 值。
 * 组 1=字段前引号 组 2=字段名 组 3=字段后引号 组 4=分隔符(: =) 组 5=完整值（引号值含引号）
 * 值支持三种形态：
 *  - 双引号串（可含空格/转义）："(?:[^"\\]|\\.)*"
 *  - 单引号串（可含空格）：'(?:[^'\\]|\\.)*'
 *  - 裸值（无引号）：首个字符非引号/#/空白/,;}{，随后到 ` #` 注释或行尾
 */
const FIELD_PATTERN = /("?'?)([A-Za-z0-9_.-]+)("?'?)(\s*[:=]\s*)((?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^"'#\s,;}{][^#,;}{]*))/gi

// 块标量起始：field: | / field: >（可带折叠/缩进指示符与行注释）
const BLOCK_START = /^([A-Za-z0-9_.-]+):\s*[|>][+-]?\d*\s*(?:#.*)?$/

/** 从 FIELD_PATTERN 匹配中提取"净值"（去引号、去尾空白）。 */
function rawValue(m: RegExpExecArray): string {
  const full = m[5]
  const q = full[0]
  if (q === '"' || q === "'") return full.slice(1, -1) // 引号值：去首尾引号
  return full.trimEnd() // 裸值：去尾空白
}

/** 扫描文本中的疑似凭据字段。 */
export function detectSecrets(text: string, file: string): SecretHit[] {
  const hits: SecretHit[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // 块标量：起始行 + 后续缩进行（内容）整体判定
    const bm = BLOCK_START.exec(line)
    if (bm) {
      const field = bm[1]
      let j = i + 1
      while (j < lines.length && /^[ \t]/.test(lines[j])) j++
      const content = lines.slice(i + 1, j)
      const fieldHit = isSecretField(field)
      const contentHit = content.some((l) => {
        const t = l.trim()
        return t !== '' && (B64.test(t) || HEX.test(t) || MIXED.test(t))
      })
      if (fieldHit || contentHit) {
        hits.push({ file, field, line: i + 1, mode: 'block', blockEnd: j })
        i = j - 1
        continue
      }
    }

    // 普通 field:value
    FIELD_PATTERN.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = FIELD_PATTERN.exec(line)) !== null) {
      const field = m[2]
      const value = rawValue(m)
      if (looksSecretValue(field, value)) hits.push({ file, field, line: i + 1 })
    }
  }
  return hits
}

/** 单行内把指定字段的值替换为 <redacted>（保留引号与分隔符）；未匹配返回 null。 */
function redactLine(line: string, field: string): string | null {
  FIELD_PATTERN.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = FIELD_PATTERN.exec(line)) !== null) {
    if (m[2] !== field) continue
    const full = m[5]
    const q = full[0] === '"' || full[0] === "'" ? full[0] : ''
    const repl = `${m[1]}${m[2]}${m[3]}${m[4]}${q}<redacted>${q}`
    return line.slice(0, m.index) + repl + line.slice(m.index + m[0].length)
  }
  return null
}

/** 把命中行的值替换为 <redacted>；返回脱敏文本与脱敏明细。 */
export function redactSecrets(text: string, hits: SecretHit[]): { text: string; redacted: { file: string; field: string; line: number }[] } {
  if (hits.length === 0) return { text, redacted: [] }
  const lines = text.split('\n')
  const redacted: { file: string; field: string; line: number }[] = []
  for (const hit of hits) {
    const idx = hit.line - 1
    if (idx < 0 || idx >= lines.length) continue
    if (hit.mode === 'block') {
      // 块标量：起始行值替换，内容行替换为 <redacted>（空行保留）
      lines[idx] = lines[idx].replace(BLOCK_START, (all, field: string) => `${field}: <redacted>`)
      const end = Math.min(hit.blockEnd ?? idx + 1, lines.length)
      for (let k = idx + 1; k < end; k++) {
        if (lines[k].trim() !== '') lines[k] = '<redacted>'
      }
      redacted.push({ file: hit.file, field: hit.field, line: hit.line })
      continue
    }
    const next = redactLine(lines[idx], hit.field)
    if (next !== null) {
      lines[idx] = next
      redacted.push({ file: hit.file, field: hit.field, line: hit.line })
    }
  }
  return { text: lines.join('\n'), redacted }
}
