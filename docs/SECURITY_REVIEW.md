# dsh-migrate 安全审查报告（2026-08 修订版）

> 审查对象：`ygcdsj/dsh-home-migrate` @ `1ff095c`
> 审查方法：全量源码阅读 + 关键疑点实测（adm-zip 0.6.0 解包行为 / 脱敏正则边界 / 路径穿越数学验证）
> 本文档为修复工作单：每项含位置、问题、验证、修复建议、验收标准。
> **状态（2026-08）**：所列问题均已修复并验证（提交 8de5e3d + c3fcb9f），核查与修复记录见 docs/VERIFICATION.md。本文档保留为原始审查记录。

---

## 结论摘要

| 级别 | 编号 | 问题 | 状态 |
|---|---|---|---|
| 🔴 Critical | F1 | 导入链 manifest 路径穿越 → 任意目录写入 + 代码执行 | ☐ 待修 |
| 🟠 High | F2 | HTTP API 无认证（同源校验可被非浏览器调用方绕过） | ☐ 待修 |
| 🟠 High | F3 | 导入 = 执行不可信代码（pnpm install 脚本 + bundle 加载），无来源认证 | ☐ 待修 |
| 🟡 Medium | F4 | 凭据脱敏漏报：带空格引号值 / Bearer / 块标量明文导出（实测复现） | ☐ 待修 |
| 🟡 Medium | F5 | 上传/解压无膨胀限制（内存 + 磁盘 DoS） | ☐ 待修 |
| ⚪ Low | F6 | manifest 泄漏源机绝对路径（`dshHome`） | ☐ 待修 |
| ⚪ Low | F7 | settings.yaml 为符号链接时穿透覆盖 | ☐ 待修 |
| ⚪ Low | F8 | `dsh_migrate_export` 描述与行为不符（dryRun 默认实际为真打包） | ☐ 待修 |
| ⚪ Low | F9 | `dsh`/`pnpm` 走 PATH + shell:true（常规注意项） | ☐ 待修 |
| ⚪ Low | F10 | 并发导入共享 `.dshmig-staging` 根，互相清理 | ☐ 待修 |

**修复优先级**：F1 + F4 立即；F2 + F3 + F5 发布前；F6–F10 随版本修。

---

## 🔴 F1（Critical）：导入链 manifest 路径穿越 → 任意目录写入 + 代码执行

### 位置

- `src/import.ts:93-96`（`buildPlan`：`baseProfile = manifest.profiles[0]`）
- `src/import.ts:200-219`（新建 profile 目录 + 从 staging 拷贝 + link 重写）
- `src/import.ts:223-247`（vendor 还原：`dest = join(home, 'vendor', rel)`）
- `src/import.ts:250-256`（presets 还原：`dest = join(home, '.agent-presets', entry.name)`）
- `src/import.ts:186-191`（sha256 校验只覆盖 `manifest.files` 列出项）
- `src/manifest.ts:65-74`（`parseManifest` 无路径校验）

### 问题

`manifest.json` 完全由归档作者控制，其中三个字段被无校验地直接喂给 `path.join()`：

| 字段 | 代码路径 | 攻击效果（已实测验证） |
|---|---|---|
| `manifest.profiles[0]` | `newProfileDir = join(home, 'profiles', name + '-migrated')`；`srcProfile = join(staging, 'config', 'profiles', p0)` | `'../../evil'` → profile 写到 `C:\Users\<user>\evil-migrated`（profiles/ 之外）；`'../../../evil'` → 盘符根 |
| `manifest.links[].vendorPath` | `dest = join(home, 'vendor', rel)`；`src = join(staging, 'vendor', rel)`（`rel = vendorPath.replace(/^vendor\//, '')`） | `'vendor/../evil'` → 攻击者内容写到 `<home>/evil`（vendor/ 之外） |
| `manifest.files[].path` | `abs = join(staging, f.path)` 做 sha256 校验 | 穿越/绝对路径读取（存在性 oracle；POSIX 下 `join(staging, '/etc/passwd')` 读绝对路径） |

### 关键事实（实测确认）

1. **zip 条目名本身是安全的**：adm-zip 0.6.0 `extractAllTo` 走 `sanitize(targetPath, canonical(entryName))`，`..` 被剥掉（见 `adm-zip/util/utils.js` canonical/sanitize）。**zip-slip 已缓解，不能作为漏洞，但也不兜底 manifest 路径。**
2. **manifest 路径不经过任何规范化**，直接进 `join()`，且 zip 条目经 canonical 后恰好落在读取点：
   - 条目 `config/profiles/../evil/package.json` → 解包到 `staging/config/evil/package.json` → 与 `srcProfile = join(staging, 'config', 'profiles', '../evil')` 精确吻合；
   - 条目 `vendor/../evil/package.json` → 解包到 `staging/evil/package.json` → 与 `src = join(staging, 'vendor', '../evil')` 精确吻合。
3. **sha256 校验可整体跳过**：只校验 `manifest.files` 列出项，攻击者置 `files: []` 即零校验。
4. **bundle 契约检查可满足**：只要求"package.json 可解析 + 声明 dsh.bundle.patch + patch 文件存在"，任何恶意包都满足。
5. **target-freshness / 同 OS 预检与攻击无关**。

### 后果链

- 恶意 `package.json`（任意 dependencies / `pnpm.onlyBuiltDependencies`）→ `pnpm install`（import.ts:264）在攻击者自选目录执行 → pnpm 9 默认跑依赖 install 脚本；pnpm 10 可被 `pnpm-workspace.yaml` 的 `onlyBuiltDependencies` 放开 → **RCE**；
- 恶意 `cordis.patch.yml` + bundle 包 → profile 被 `dsh --profile <name>` 启动时加载恶意插件 → **RCE**（`dsh --dump-config` 阶段至少解析 bundle，import 模块即执行顶层代码）；
- 即使不算代码执行，**任意目录写入**本身（home 外 / 用户目录 / 盘符根）就是高危原语。

### 触发面

- UI 导入需人工确认（有缓解，但确认框未警告"归档即代码"）；
- host 工具 `dsh_migrate_import` 接受任意 archive 路径（agent 被 prompt injection 诱导时直接触发）；
- HTTP API `/dsh-migrate/api/import`（配合 F2 可远程触发）。

### 修复建议

```ts
// 1) parseManifest 后统一校验（三个字段都要）
const SAFE_REL = /^[A-Za-z0-9@._-]+(\/[A-Za-z0-9@._-]+)*$/ // 拒绝 ..、绝对路径、盘符、空段、\ 、空白
function assertSafeRel(p: string, what: string): void {
  if (!SAFE_REL.test(p)) throw new Error(`unsafe ${what} in manifest: ${JSON.stringify(p)}`)
}
for (const f of manifest.files)   assertSafeRel(f.path, 'files[].path')
for (const l of manifest.links)   assertSafeRel(l.vendorPath.replace(/^vendor\//, ''), 'links[].vendorPath')
assertSafeRel(manifest.profiles[0], 'profiles[0]')
```

```ts
// 2) 落地断言（纵深防御，写之前）
function ensureUnder(root: string, p: string, what: string): string {
  const r = resolve(root), d = resolve(p)
  if (d !== r && !d.toLowerCase().startsWith(r.toLowerCase() + sep))
    throw new Error(`unsafe ${what} escapes ${root}: ${p}`)
  return d
}
// vendor:   ensureUnder(join(home, 'vendor'), dest, 'vendor dest')
// profile:  ensureUnder(join(home, 'profiles'), newProfileDir, 'profile dir')
// presets:  ensureUnder(join(home, '.agent-presets'), dest, 'preset dest')
// staging:  ensureUnder(staging, join(staging, f.path), 'staging read')
```

```ts
// 3) UI 导入确认框追加醒目警告（client/index.ts importView run 的 confirm 文案）
// 「⚠ 导入归档 = 执行其中的插件代码与安装脚本。仅导入你信任的来源！」
```

### 验收标准

- [ ] 构造 `manifest.profiles[0] = '../../evil'`、`links[].vendorPath = 'vendor/../evil'`、`files[].path = '..\\..\\x'`、绝对路径、盘符形态的归档，导入全部拒绝且不产生任何写入；
- [ ] 上述用例进入 `test/fault-injection.mjs`（现有 19 项测试完全没有路径穿越用例）；
- [ ] 合法归档（正常 vendor/../ 形态之外的正规路径）导入不受影响。

---

## 🟠 F2（High）：HTTP API 无认证，同源校验可被非浏览器调用方绕过

### 位置

- `src/routes.ts:43-49`（`sameOrigin`）
- `src/routes.ts:84-116`（4 个 POST 端点，无令牌）

### 问题

- 比较逻辑：`new URL(origin).host === req.headers.host`。**对端口敏感**：浏览器页面在 :80/:443 时 Origin 无端口，与 `host:3080` 不匹配 → 经典 DNS rebinding 被挡住（比裸 Origin 检查好，保留）；
- 但任何**本机进程 / 浏览器扩展 / 被攻陷本地应用**，以及 **DSH web 绑定非 loopback（0.0.0.0/局域网）时的任意设备**，可直接伪造 `Origin: http://127.0.0.1:3080` + `Host: 127.0.0.1:3080` 调用全部接口；
- `/dsh-migrate/api/import` 接受 `archive`（任意本地路径）或 `archiveData`（**base64 直传，无需本地文件**）→ 远程调用方 = F1 完整 RCE 链；
- `/dsh-migrate/api/export` 可被用来打包本机配置（信息收集）。

### 修复建议

1. **Host 白名单**：仅放行 `127.0.0.1[:port]` / `localhost[:port]` / `[::1][:port]`；
2. **CSRF token**：UI 先 GET `/dsh-migrate/api/session` 领取随机 token（内存态），写操作请求头携带，服务端比对；token 每次导入/导出前可刷新；
3. 检查 `Sec-Fetch-Site` 头（`same-origin` / `none` 放行，`cross-site` 拒绝）——低成本纵深；
4. 确认 DSH web 服务端是否可配置仅 loopback 绑定；文档写明"暴露到局域网 = 任何人可导入任意归档（RCE）"。

### 验收标准

- [ ] 伪造 Origin/Host 的非浏览器请求（node 直接 POST）被拒；
- [ ] 无 token 的写请求被拒；UI 正常流程不受影响；
- [ ] `Sec-Fetch-Site: cross-site` 被拒。

---

## 🟠 F3（High，设计边界）：导入 = 执行不可信代码，无来源认证

### 位置

- `src/import.ts:263-290`（pnpm install + dump-config 验证链）
- README「凭据已排除/脱敏，可放心传输」的承诺表述

### 问题

即使修好 F1，导入本身：① `pnpm install` 执行依赖 install 脚本（pnpm 9 默认；pnpm 10 攻击者可用 `pnpm-workspace.yaml` / `package.json` 的 `onlyBuiltDependencies` 放开）；② `dsh --dump-config` 加载/解析 profile 的 bundle 插件；③ 用户之后启动该 profile 即执行其中插件。manifest sha256 只保证"归档内文件与清单一致"，**不提供来源可信性**（无签名、无密钥、无可信来源记录）。

### 修复建议

1. `pnpm install` 增加 `--ignore-scripts` 选项（默认开），需要构建脚本的包走显式 approve 列表（UI 展示、用户确认）；
2. UI/README 措辞修改：「凭据已排除或脱敏，可放心传输」→「尽力脱敏，请核对 secretReport；**归档仅导入你信任的来源**」；
3. v2：归档签名（age / sigstore / minisign），导入时校验签名者公钥。

### 验收标准

- [ ] 默认安装不执行任何依赖 install 脚本；approve 列表在 UI 可见；
- [ ] README 与 UI 文案更新。

---

## 🟡 F4（Medium）：凭据脱敏漏报 → 凭据明文随包导出（实测复现）

### 位置

- `src/secret.ts:58`（`FIELD_PATTERN` 值捕获 `[^"'\s,;}{]+`，遇空格即断）
- `src/secret.ts:78-93`（`redactSecrets` 同款正则）
- `src/export.ts:30`（`TEXT_KINDS` 不含 `vendor` → vendor 包整体跳过扫描）

### 实测结果（node 复现，与仓库逻辑一致）

| 输入 | 命中 | 导出内容 |
|---|---|---|
| `password: "correct horse battery staple"` | ❌ 零命中 | **明文完整导出** |
| `token: "abc def ghi"` | ❌ | **明文导出** |
| `auth: "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig"` | ❌ | **JWT 明文导出** |
| `password: "sk-1234567890 abcdef"` | ❌ | **明文导出** |
| `password: \|` + 多行（**PEM 私钥典型形态**） | ❌ 块标量不扫描 | **私钥明文导出** |
| `apiKey: "sk-abc" # comment` | ✅ | 正常脱敏 |
| `apiKey: sk-abc123def456ghi` | ✅ | 正常脱敏 |

带空格的口令、`Bearer ` 前缀 token、PEM 块正是真实凭据的高频形态 → README「凭据硬排除+脱敏，不随包传输」承诺不成立。

### 修复建议

1. 值捕获改为**到闭合引号为止**（允许空格）：`("?'?)((?:(?!\2).)*)\2` 或对每行先做引号配对再取值；
2. **块标量**：`field: |` / `field: >` 起始行 → 后续缩进行整体纳入该字段扫描（PEM 等 base64 块会被 B64 命中）；
3. `TEXT_KINDS` 增加 `vendor` 的配置文件（`*.yaml`/`*.yml`/`*.json`/`*.toml`/`*.ini`/`*.env*` 白名单扩展名），代码文件继续跳过；
4. secretReport 增加 `unscannedFiles` 列表，UI 展示"以下文件未做凭据扫描"；
5. 修完用上表 + PEM 块做回归测试。

### 验收标准

- [ ] 上表全部形态：命中并脱敏（含块标量多行）；
- [ ] 合法长值（model/url 等 KNOWN_SAFE_FIELDS）不误报；
- [ ] 新增 `test/secret-cases.mjs`（或并入现有测试）覆盖上表。

---

## 🟡 F5（Medium）：上传/解压无膨胀限制（DoS）

### 位置

- `src/routes.ts:29-40`（`readBody` 无限缓冲，64MB 上限在 body 读完并解析后才检查）
- `src/routes.ts:61-73`（`archiveData` base64 → 解包无大小/条目数/压缩比限制）

### 问题

- `readBody` 无流式限长 → 大 body 直接打满内存；
- 64MB base64 ≈ 48MB zip，zip bomb 解压后可达数 GB → 写盘 DoS。

### 修复建议

1. `readBody` 流式计数，超过上限（如 8MB）即 413 并断开；
2. 解包前检查 zip 条目数上限（如 10k）与总解压大小上限（如 512MB，读 central directory 的 uncompressedSize 求和）；可选压缩比上限。

### 验收标准

- [ ] >8MB body 被拒（413），不缓冲完整 body；
- [ ] 构造 100k 条目 / 高压缩比归档被预检拒绝。

---

## ⚪ F6（Low）：manifest 泄漏源机绝对路径

- `src/manifest.ts:22`（`source.dshHome` 写入 `plan.home` 绝对路径，如 `C:\Users\<user>`）随 U 盘/网盘流转；
- 文档（DEVELOPMENT.md §3.5）声称 UI 用 `dshHomeDisplay()` "不泄漏机器路径"，但 manifest 没做到；
- 修复：`dshHomeDisplay()`（官方 `@deepseek-ai/dsh-home-paths`）或仅记录 profile 名；导入端不依赖该字段（已确认 buildPlan 未用）。

## ⚪ F7（Low）：settings.yaml 为符号链接时穿透覆盖

- `src/import.ts:194-197`：`lstatSync().isFile()` 对 symlink 为 false → 不备份；
- `src/import.ts:257-260`：`copyFileSync(s, targetSettings)` 穿透 symlink 写入目标；
- 修复：备份与覆盖前 `realpathSync` 校验（symlink 存在则拒绝或先解链再备份）。

## ⚪ F8（Low）：`dsh_migrate_export` 描述与行为不符

- `src/index.ts:25` 描述"dryRun=true（默认安全）"，`src/index.ts:36` 实际 `args?.dryRun === true` → 省略 dryRun 时**真打包写盘**；
- 修复：参数 schema 给 dryRun 默认 `true`，或 execute 中 `args.dryRun !== false`（语义对齐描述）。

## ⚪ F9（Low）：`dsh`/`pnpm` 走 PATH + shell:true

- `src/import.ts:61-67`、`src/export.ts:32-40`：命令固定、Node 对参数有引用，注入风险低；
- profile 名进入 `--profile` 参数——随 F1 加白名单后此面关闭；
- 常规注意项：PATH 优先位被劫持的风险存在（本地攻击者已有更高权限面）。

## ⚪ F10（Low）：并发导入共享 staging 根

- `src/import.ts:293, 311`：`rmSync(join(home, '.dshmig-staging'), ...)` 清整个根，另一个并发导入的 staging 被删 → 失败回滚连锁；
- 修复：每导入独立根（现有 `stamp` 子目录即可，清理只删自己的 `staging/<stamp>`）。

---

## 做得好的地方（确认有效，勿在修复时破坏）

- **导出端 vendor 断言**（`src/scan.ts:83-94`）：`link:` 目标必须位于 `<home>/vendor` 内否则拒绝；
- **zip-slip**：adm-zip 0.6.0 `canonical`/`sanitize` 实测剥 `..`，解包本身安全；
- **硬排除清单**（`.credentials.yaml`/`.env*`/`sessions`/`storages`/`node_modules`）+ 符号链接跳过（walkDir/copyDir）；
- **回滚**：反向删除 + settings 快照恢复 + staging 清理，故障注入覆盖多数失败路径；
- **产物原子写入**（tmp + rename）；
- **客户端无 XSS**：全部 textContent/text node，无 innerHTML 注入点；
- **默认新建 profile + target-freshness 硬门槛 + dry-run 预检**，整体偏保守。

---

## 修复顺序与测试补充

1. **F1**：manifest 三字段白名单 + `ensureUnder` 落地断言 + UI 警告文案；
2. **F4**：值捕获含空格 + 块标量 + vendor 配置扫描 + `unscannedFiles` 报告；
3. **F2**：Host 白名单 + CSRF token + `Sec-Fetch-Site`；
4. **F3**：`--ignore-scripts` 默认 + README/UI 措辞；
5. **F5**：body 限长 + 解压上限；
6. **F6–F10**：随版本修；
7. **测试**：`test/fault-injection.mjs` 增加恶意 manifest（`..` / 绝对路径 / 盘符 / `files: []` + 恶意 vendorPath）拒绝用例；新增脱敏回归表；`test/` 补 HTTP 层拒绝用例。

---

*审查复现材料：`<审查环境>/admzip-test\secret-test.mjs`（脱敏边界复现）、`admzip-test\package\util\utils.js`（adm-zip sanitize 源码）、路径穿越数学验证见报告 F1 节。*
