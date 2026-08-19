# Changelog

## 0.0.6 (2026-08-20)

安全审查（SECURITY_REVIEW.md F1–F10）修复：路径穿越、HTTP API 认证、导入代码执行边界、脱敏漏报、膨胀限制、信息泄漏与并发清理。

### 🔴 修复（Critical）

- **F1 导入链 manifest 路径穿越 → 任意目录写入**（实测复现）：`manifest.profiles[0]` / `links[].vendorPath` / `files[].path` 此前无校验直接进 `path.join()`，`../../evil` 可把 profile/vendor 写到 `<home>` 外、sha256 校验可被 `files: []` 整体跳过。修复：`parseManifest` 白名单校验三字段（拒绝 `..`/绝对路径/盘符/`\`/空白/空段）+ `ensureUnder` 落地断言（profile/vendor/presets/staging 读写均限根内，纵深防御）。新增故障注入用例 9–13（`test/fault-injection.mjs`，26 项全过）；修复前漏洞复现脚本见核查记录。

### 🟠 修复（High）

- **F2 HTTP API 无认证**：Host 白名单（仅 `127.0.0.1`/`localhost`/`[::1]`）+ CSRF token（先 `GET /dsh-migrate/api/session` 领取，写请求头 `x-dshmig-token`）+ `Sec-Fetch-Site: cross-site` 拒绝；新增 `test/http-reject.mjs`（10 项全过）。
- **F3 导入 = 执行不可信代码**：`pnpm install` 默认 `--ignore-scripts`（`allowScripts: true` 显式放开）；UI 导入确认框加「归档即代码，仅导入信任来源」警告；README/UI「可放心传输」措辞改为「尽力脱敏，请核对 secretReport（含 unscannedFiles）」。

### 🟡 修复（Medium）

- **F4 凭据脱敏漏报**（实测复现）：带空格引号值（`password: "correct horse battery staple"`）、`Bearer ` 前缀 token、YAML 块标量（PEM 私钥）此前零命中明文导出。修复：值捕获到闭合引号为止（允许空格/转义）；块标量按字段名 + base64/hex 内容启发式整体脱敏；vendor 配置文件（yaml/json/toml/ini/env）纳入扫描；`secretReport` 增加 `unscannedFiles`/`unscannedTotal` 随包导出，UI 展示。新增 `test/secret-cases.mjs` 回归表（21 项全过）。
- **F5 上传/解压无膨胀限制**：`readBody` 流式限长（8MB，超限 413 并断开）；解包预检条目数 ≤10k、总未压缩 ≤512MB、manifest 条目 ≤16MB；磁盘归档文件本体限 512MB。

### ⚪ 修复（Low）

- **F6** manifest `source.dshHome` 不再写绝对路径，改用官方 `dshHomeDisplay()`（`~/.dsh` / `$DSH_HOME`）。
- **F7** `settings.yaml` 为符号链接时预检拒绝（防备份/覆盖穿透写目标）。
- **F8** `dsh_migrate_export` dryRun 语义对齐描述：省略即预览（`args.dryRun !== false`）。
- **F10** staging 清理只删自己的 `staging/<stamp>` 子目录，不再清整根（并发导入互不干扰）。

### 测试

- `test/fault-injection.mjs` 19 → 26 项（新增恶意 manifest 拒绝 5 项）；`test/secret-cases.mjs`（21 项）；`test/http-reject.mjs`（10 项）；`npm test` 全量通过。

### 跟进修复（R1–R3，同版本）

- **R1（F5 引入的回归，Medium）** `readBody` promise 无 `.catch`：客户端发半请求后断开（`for-await` 抛 `aborted`）→ unhandled rejection → Node ≥15 崩溃整个 DSH web 进程（任意本机/局域网进程一个残缺请求即 DoS）。已补 `.catch` 兜底（尽力 500，socket 已断则忽略）；`test/http-reject.mjs` 新增"半请求断开"用例（无 unhandled rejection + 500）。
- **R2（F4 引入的过度脱敏，Medium-Low）** 块标量内容启发式不豁免 `KNOWN_SAFE_FIELDS`：`description:`/`command:` 等合法块恰含 base64/hex 单行时整块被替换，迁移后预设/配置损坏。已豁免：内容启发式仅对非豁免字段生效，字段名是 secret 类（password/privateKey 等）仍整块脱敏。
- **R3（F4 家族残留，Low）** 裸值捕获遇 `,;}{` 即断：`password: abc,defghi`（YAML 合法裸标量）零命中明文导出。已改裸值捕获到行尾或 ` #` 注释（顺带修 `#` 前空格丢失：`token: <redacted> # comment`）。
- **Nit** `manifest.links[].dep` 加入路径白名单（进入 `node_modules/<dep>` 路径，拒绝穿越）；README 补充"vendor 配置原地脱敏 → 迁移后需重配"说明。

- 测试增量：`test/secret-cases.mjs` 21 → 28（R2/R3 用例）；`test/fault-injection.mjs` 26 → 27（dep 白名单）；`test/http-reject.mjs` 10 → 12（R1 用例）。

## 0.0.5 (2026-08-19)

### 修复

- **package.json 混入 UTF-8 BOM**（0.0.4 发布时带出）：DSH `dsh plugin` 解析 bundle manifest 时 `JSON.parse` 崩溃（`Unexpected token '﻿'`）。已剥离 BOM 并全仓库复查无残留。

## 0.0.4 (2026-08-19)

### 改进

- **导入失败诊断**：`pnpm install` / `dsh --dump-config` 失败时，错误信息现在附带底层命令的 stderr/stdout 尾部（此前只报 `exit=1`，无法定位根因——测试机暴露）。

## 0.0.3 (2026-08-19)

### 修复

- **运行时依赖解析崩溃**（0.0.2 引入的装配后暴露）：`schemastery`/`@deepseek-ai/dsh-tools`/`@deepseek-ai/dsh-home-paths` 原声明为 peerDependencies，pnpm 隔离 node_modules 下宿主不保证提供 → DSH 启动即崩（`Cannot find package 'schemastery'`）。已移入 `dependencies` 由 pnpm 装入插件依赖树；顺带修正 `dsh-home-paths` 错误版本范围（`>=0.1.0-rc` 解析不到 `0.0.1-rc.3`）。

## 0.0.2 (2026-08-19)

### 修复

- **bundle 装配缺失**：声明 `dsh.bundle.patch`（`cordis.patch.yml`）并加入 files——此前 `dsh plugin add` 安装后只作为普通依赖、不激活为 profile 层（本机开发走注入器未暴露，npm 正式安装暴露）。0.0.2 起插件可被 DSH 正常装配加载。

## 0.0.1 (2026-08-19)

MVP — 首个可用版本（experimental）。

### 新增

- **导出**：`~/.dsh` 扫描（profiles 配置 / settings.yaml / `.agent-presets` / `vendor/` link 目录）；硬排除凭据与运行态数据；settings/presets 字段级凭据扫描 + 脱敏（`secretReport` 审计）
- **打包**：`.dshmig`（zip）单文件产物，manifest 含 sha256 校验清单、link 映射、排除清单
- **导入**：预检（同 OS / dsh 版本 allowlist / 磁盘提示）→ 备份目标机 → 默认新建 profile（重名递增）→ `link:` 路径重算（断言 vendor 内，防路径逃逸）→ vendor/presets/settings 还原 → `pnpm install` → 验证链（链接解析 → `dsh --dump-config`）→ 失败自动回滚（配置级完全恢复）
- **bundle 契约前置校验**：vendor 包须含 `package.json` 与 `dsh.bundle.patch`（`resolveBundleDir` 实测结论）
- **UI**：设置页「迁移」入口——导出向导（预览 → 执行）+ 导入向导（预检 → 步骤确认 → 执行 → 验证报告）；host HTTP API 4 端点（同源保护）
- **Host 工具**：`dsh_migrate_export` / `dsh_migrate_import`（dryRun 安全模式）
- **测试**：`test/smoke-import.mjs`（沙箱层）、`test/smoke-install.mjs`（完整链路）、`test/fault-injection.mjs`（19 项故障断言）

### 已知边界（MVP）

- 同 OS 迁移；跨 OS 预检拒绝
- 多 profile 归档只导入第一个（警告）
- `git+https://` 依赖目标机重新拉取（需网络）
- 验证链 L4（最小启动验证）v1.x

### 生态对齐

- 包名 `dsh-migrate`（npm 查重通过）、MIT、双语 README、`@deepseek-ai/dsh-home-paths` 官方路径 API
- 构建：`scripts/build.mjs`（无 bash/无 checkout 降级 `_npx` 官方包树）；`scripts/build.sh` 保留（bash + checkout 生态惯例入口）
