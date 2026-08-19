# SECURITY_REVIEW.md 核查报告（2026-08）

> 核查对象：`ygcdsj/dsh-home-migrate` @ `1ff095c`（与审查文档同一 commit，主仓库工作树干净）
> 核查方法：逐条对照源码 + 真实 `lib/` 运行时复现（F1 三攻击面、F4 脱敏表、A4/A5 join 语义、基线测试）+ 审查复现材料复核
> 复现脚本：`<审查环境>/.security-verify\verify-f1b.mjs`、`verify-f7.mjs`、`<审查环境>/admzip-test\secret-test.mjs`

## 结论总览

| 编号 | 级别 | 核查结论 | 证据 |
|---|---|---|---|
| F1 | 🔴 Critical | ✅ **确认**（实测复现；一处子论断需修正） | A1/A2/A3 真实写入/读取 |
| F2 | 🟠 High | ✅ 确认（代码级） | routes.ts:43-49/84-116 |
| F3 | 🟠 High | ✅ 确认（设计边界，代码级） | import.ts:264/288 + README/client 文案 |
| F4 | 🟡 Medium | ✅ **确认**（实测复现，与审查表格 100% 吻合） | secret-test.mjs 输出 |
| F5 | 🟡 Medium | ✅ 确认（代码级） | routes.ts:29-40/61-73 + archive.ts:39-42 |
| F6 | ⚪ Low | ✅ 确认（代码级 + 文档矛盾） | manifest.ts:55 / scan.ts:98 / DEVELOPMENT.md:108,113 |
| F7 | ⚪ Low | ✅ 确认（代码级；运行时复现因 Windows symlink 权限 EPERM 跳过） | import.ts:194/259 |
| F8 | ⚪ Low | ✅ 确认（代码级） | index.ts:25-27/36 |
| F9 | ⚪ Low | ✅ 确认（常规注意项） | import.ts:61-67 / export.ts:34 |
| F10 | ⚪ Low | ✅ 确认（代码级） | import.ts:293/311 |
| 做得好的地方 | — | ✅ 全部确认（vendor 断言 / zip-slip / 硬排除 / 回滚 / 原子写 / 无 XSS / 保守默认） | 见下 |

**10/10 项成立，无虚报；仅 F1 表格第三行有一个子论断错误（不影响结论与修复方案）。**

---

## F1（Critical）—— ✅ 确认，一处修正

真实 `lib/import.js` 沙箱复现（`verify-f1b.mjs`，7/7 PASS）：

| 攻击面 | 构造 | 实测结果 |
|---|---|---|
| A1 `manifest.profiles[0]` | `'../../evil'` + 条目 `config/profiles/../../evil/package.json` | `importDsh` 返回 `ok: true`，**profile 写穿到 home 父级** `…/evil-migrated/package.json`（真实 home 下即 `C:\Users\<user>\evil-migrated`，与审查一致） |
| A2 `manifest.links[].vendorPath` | `'vendor/../evil2'` + 条目 `vendor/../evil2/package.json`（含 `dsh.bundle.patch`） | **写穿到 `<home>/evil2/`**；bundle 契约检查被恶意包轻松满足 |
| A3 `manifest.files[].path` | `'../../../../../../../Windows/win.ini'`（`files` 非空） | `sha256 mismatch`——**真实读到了 `C:\Windows\win.ini`**（存在性/哈希 oracle） |
| 校验绕过 | `files: []` | `parseManifest` 仅要求 Array；A1/A2 即用 `files: []` 整体跳过 sha256 后成功写入 |

**修正（F1 表格第三行）**：审查称 "POSIX 下 `join(staging, '/etc/passwd')` 读绝对路径" —— **错误**。实测（A4/A5）：`path.join('C:/x/staging', '/etc/passwd')` → `C:\x\staging\etc\passwd`；盘符形态 `join('C:/x/staging', 'C:\\Windows\\win.ini')` → `C:\x\staging\C:\Windows\win.ini`。**`path.join` 对绝对路径从不重置**，绝对路径/盘符形态无法穿越；只有**相对 `..` 穿越**有效（A3 已证）。审查建议的 `SAFE_REL` 白名单 + `ensureUnder` 落地断言仍然完整覆盖此面，修复方案不变。

其余关键事实全部复核成立：
- zip-slip 已缓解：adm-zip 0.6.0 `utils.js` `canonical()` 用 `posix.normalize("/"+…)` 剥 `..`，`sanitize()` 保证不越 prefix（源码实读确认）。
- manifest 路径与解包落点精确吻合（`config/profiles/../../evil` 经 canonical 落 `staging/evil`，正对 `join(staging,'config','profiles','../../evil')`）。
- UI 确认框（client/index.ts:276）仅列出 profile 与步骤，**无 "归档即代码" 警告**。
- 现有 `test/fault-injection.mjs` 19 项用例确实**无任何路径穿越用例**（已读全文件确认，套件 19/19 通过）。

## F2（High）—— ✅ 确认

- `sameOrigin`（routes.ts:43-49）：**Origin 缺失或为空即放行**（46 行）——非浏览器调用方（curl/node）连伪造都不需要，直接不发 Origin 即可调用全部 4 个 POST 端点。
- 无 CSRF token、无 Host 白名单；`new URL(origin).host === req.headers.host` 两个值均由调用方控制，仅挡"端口不匹配的浏览器导航"（:80/:443 页面打 :3080 的场景），对 DNS rebinding 之外的本机进程/被攻陷应用/局域网设备（若 DSH web 非 loopback 绑定）无效。
- `/import` 支持 `archiveData`（base64 直传）与 `archive`（任意本地路径）→ 与 F1 构成完整远程 RCE 链；`/export` 可打包本机配置。

## F3（High，设计边界）—— ✅ 确认

- `pnpm install`（import.ts:264）无 `--ignore-scripts`；`dsh --dump-config --profile`（288 行）会解析/加载 profile 的 bundle；用户后续启动该 profile 即执行插件代码。
- README.md:52「凭据已排除/脱敏，可放心传输」、README.md:82「本插件不收集、不传输任何凭据」、client/index.ts:178 同款文案——在 F4 成立的背景下**承诺过强**，审查要求改措辞合理。

## F4（Medium）—— ✅ 确认，实测与审查表格逐行一致

`admzip-test/secret-test.mjs`（复刻 src/secret.ts 正则）输出与审查表格**完全一致**：

| 输入 | 审查声称 | 实测 |
|---|---|---|
| `password: "correct horse battery staple"` | ❌ 零命中 | ❌ 零命中，明文 |
| `token: "abc def ghi"` | ❌ | ❌ |
| `auth: "Bearer eyJ…sig"`（JWT） | ❌ | ❌ |
| `password: "sk-1234567890 abcdef"` | ❌ | ❌ |
| `password: \|` 块标量 | ❌ 不扫描 | ❌（首行值 `\|` 长度 1 < 6；后续行无 `field:` 形态不扫描） |
| `apiKey: "sk-abc" # comment` | ✅ | ✅ 脱敏 |
| `apiKey: sk-abc123def456ghi` | ✅ | ✅ |

根因：`FIELD_PATTERN`（secret.ts:58）值捕获 `[^"'\s,;}{]+` 遇空格即断且要求紧邻闭合引号 → 带空格引号值整体不匹配；`redactSecrets`（85-86 行）同款正则。`TEXT_KINDS`（export.ts:30）不含 `vendor` → vendor 包配置不扫描（scan.ts 的 kind 枚举确有 'vendor'）。

## F5（Medium）—— ✅ 确认

- `readBody`（routes.ts:29-40）无流式限长，整个 body 缓冲完才 `JSON.parse`；`MAX_UPLOAD_BYTES`（64MB，55 行）只在 `archiveData` 字符串长度上检查、且发生在 body 读完之后（64 行）。
- `body.archive`（磁盘路径）分支无任何大小限制。
- `extractArchive`（archive.ts:39-42）无条目数/总解压大小/压缩比限制。

## F6（Low）—— ✅ 确认

- `buildManifest` 把 `source.dshHome` 写成 `plan.home` 绝对路径（scan.ts:98 `resolve(...)` → manifest.ts:55 → export.ts:74/97）。
- 导入端 `buildPlan` 确实未使用该字段（代码通读确认）——修复（改 `dshHomeDisplay()` 或仅 profile 名）无破坏风险。
- DEVELOPMENT.md:108 与 :113 声称 `dshHomeDisplay()` "不泄漏绝对路径/机器路径" —— 与 manifest 实际行为矛盾，审查指出属实。

## F7（Low）—— ✅ 确认（代码级）

- import.ts:194：`lstatSync(targetSettings).isFile()` 对符号链接为 false → `hadSettings=false` → **不备份**。
- import.ts:259：`copyFileSync(s, targetSettings)` 跟随符号链接 → **穿透覆盖链接目标**。
- 附加副作用：失败回滚时 `hadSettings=false` 分支执行 `rmSync(targetSettings)`（308 行）会**删掉用户 settings.yaml 的符号链接本身**。
- 运行时复现被 Windows symlink 权限阻断（`symlinkSync` EPERM，本机未开开发者模式/非管理员）；以上为 Node 文档化语义（lstat=链接自身 stats；copyFileSync 跟随链接）。

## F8（Low）—— ✅ 确认

- index.ts:25 描述「dryRun=true（默认安全）」；:27 schema `required: true`；:36 实际 `args?.dryRun === true`——省略即打包写盘，"默认安全"措辞与行为不符。

## F9（Low）—— ✅ 确认

- import.ts:61-67 `run()` 与 export.ts:34 均 `shell: process.platform === 'win32'`；命令串固定、参数走数组（Node 引用），注入面窄；`--profile` 参数随 F1 白名单落地后关闭。常规注意项，无争议。

## F10（Low）—— ✅ 确认

- import.ts:293（成功路径）与 311（回滚路径）均 `rmSync(join(home, '.dshmig-staging'), {recursive, force})` 清**整个根**，另一并发导入的 `staging/<stamp>` 会被误删，触发连锁回滚。修复建议（每导入独立 stamp、只清自己的）成立。

## 做得好的地方 —— ✅ 全部复核成立

- 导出端 vendor 断言（scan.ts:83-94）：`link:` 目标必须 `resolve` 后在 `<home>/vendor` 内，否则 throw——真实存在且逻辑正确。
- zip-slip：adm-zip 0.6.0 `canonical`/`sanitize` 源码确认剥 `..`（utils.js:302-351）。
- 硬排除（`.credentials.yaml`/`.env*`/sessions/storages/node_modules 等，scan.ts:35-39）+ walkDir/copyDir 跳过符号链接（scan.ts:57、import.ts:85）。
- 回滚：反向删除 created 路径 + settings 快照恢复/删除 + staging 清理（import.ts:295-320），fault-injection 套件 19/19 通过覆盖多数失败路径。
- 产物原子写入：tmp + renameSync（archive.ts:24-27）。
- client 无 XSS：全 `textContent`/文本节点，全文件无 `innerHTML`/`outerHTML`/`insertAdjacentHTML`（grep 零命中）。
- 新建 profile + target-freshness 硬门槛 + dry-run 预检，默认行为保守。

---

## 修复优先级建议（与审查一致）

F1（三字段白名单 + ensureUnder 落地断言 + UI 警告文案）+ F4（引号内取值 + 块标量 + vendor 配置扫描 + unscannedFiles）立即；
F2（Host 白名单 + CSRF token + Sec-Fetch-Site）+ F3（--ignore-scripts 默认 + 文案）+ F5（body 限长 + 解压上限）发布前；
F6–F10 随版本修。测试补充：fault-injection 增加恶意 manifest 拒绝用例、secret-cases 脱敏回归表、HTTP 层拒绝用例。

*核查复现材料：`<审查环境>/.security-verify\verify-f1b.mjs`（F1，7/7 PASS）、`verify-f7.mjs`（F7，EPERM 跳过）、`<审查环境>/admzip-test\secret-test.mjs`（F4）。*

---

## 修复实施（0.0.6，2026-08-20）

审查确认后按优先级全部实施，配套测试全绿（`npm test`：smoke ✓ / fault-injection 26 ✓ / freshness ALL PASS / secret-cases 21 ✓ / export-redaction 12 ✓ / http-reject 10 ✓）。

| 编号 | 修复 | 验证 |
|---|---|---|
| F1 | `parseManifest` 三字段白名单（拒绝 `..`/绝对路径/盘符/`\`/空白/空段）+ `ensureUnder` 落地断言（profile/vendor/presets/staging 读写限根内）+ UI 确认框「归档即代码」警告 | `verify-f1-fixed.mjs` 6/6（攻击全部拒绝、零写入）；fault-injection 用例 9-13 |
| F2 | Host 白名单（仅 loopback）+ CSRF token（`GET /session` → `x-dshmig-token`）+ `Sec-Fetch-Site: cross-site` 拒绝 | http-reject.mjs 10/10 |
| F3 | `pnpm install --ignore-scripts` 默认（`allowScripts` 放开）+ README/UI「仅导入信任来源」措辞 | 步骤文案 + 文档 |
| F4 | 值捕获到闭合引号（含空格/转义）；块标量字段名 + base64 内容启发式整块脱敏；vendor 配置文件纳入扫描；`secretReport.unscannedFiles/unscannedTotal` 随包导出 + UI 展示 | secret-cases.mjs 21/21；export-redaction.mjs 12/12（含 PEM 块、vendor 配置、dshHome 显示化） |
| F5 | `readBody` 流式限长 8MB → 413；解包条目 ≤10k / 总未压缩 ≤512MB / manifest ≤16MB；磁盘归档限 512MB | http-reject.mjs 用例 9（413） |
| F6 | `source.dshHome` 改用官方 `dshHomeDisplay()`（`~/.dsh` / `$DSH_HOME`），不再写绝对路径 | export-redaction.mjs（`$DSH_HOME` 断言） |
| F7 | `settings-not-symlink` 预检 + 写入前二次防御（防 copyFileSync 穿透） | 预检用例（fault-injection 链） |
| F8 | `dsh_migrate_export` 省略 dryRun 即预览（`args.dryRun !== false`），描述与行为对齐 | 工具契约 |
| F9 | profile 名经 F1 白名单后进入 `--profile`，注入面关闭（保留 shell:true 常规注意项） | 由 F1 用例覆盖 |
| F10 | staging 清理只删自己的 `staging/<stamp>`（成功 + 回滚路径），根目录非空时保留 | 代码级 |

顺带修复：`scanHome(homeOverride)` 此前只对 settings.yaml 生效、profiles/vendor/presets 仍扫真实 home（与 override 文档语义不符，也导致沙箱测试不可封闭）——现全部基于 override home 拼接，默认 home 行为不变。

### 跟进（R1–R3，提交 `c3fcb9f`）

| 编号 | 问题 | 修复 | 验证 |
|---|---|---|---|
| R1 | F5 重构时 `readBody(req).then(...)` 丢了旧代码的 `.catch`：半请求断开 → `for-await` 抛 aborted → unhandled rejection → Node ≥15 崩溃 DSH web 进程（残缺请求 DoS） | 补 `.catch` 兜底（尽力 500，socket 已断则忽略） | http-reject.mjs 用例 11（无 unhandled rejection + 500） |
| R2 | F4 块标量内容启发式不豁免 `KNOWN_SAFE_FIELDS`：`description:`/`command:` 合法块含 base64/hex 行被整块替换（预设/配置损坏） | 内容启发式仅对非 KNOWN_SAFE 字段生效；secret 字段块仍整块脱敏 | secret-cases.mjs R2 用例（description/command/script 不误伤；certificate/password 仍命中） |
| R3 | F4 残留：裸值捕获遇 `,;}{` 即断，`password: abc,defghi` 零命中明文导出 | 裸值捕获到行尾或 ` #` 注释（顺带修 `#` 前空格） | secret-cases.mjs R3 用例（逗号/分号/注释形态） |
| Nit | `manifest.links[].dep` 未过白名单（进 `node_modules/<dep>` 路径）；README 缺 vendor 原地脱敏说明 | dep 加入白名单；README 双语补说明 | fault-injection 用例 14 |

全量测试（提交后）：smoke ✓ / fault-injection 27 ✓ / freshness ALL PASS / secret-cases 28 ✓ / export-redaction 12 ✓ / http-reject 12 ✓。
