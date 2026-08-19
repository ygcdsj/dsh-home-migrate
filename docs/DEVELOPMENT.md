# dsh-migrate 开发文档（MVP）

> 暂定名 `dsh-migrate`（hybrid 形态插件）。发布前必须 `npm view dsh-migrate` 查重，重名则改名。
> 状态：experimental / MVP 设计稿 v1.1（已并入评审修正与决策点确认）
> 本机基线：Windows，`DSH_HOME=C:\Users\<user>\.dsh`（DSH_HOME 可覆盖，测试依赖此特性）

---

## 1. 项目定位

**一句话**：从任意 DSH 安装打包配置 → 在目标机还原为**新建 profile** → 校验 + 回滚。不做云、不做历史、不做跨品牌。

**差异化矩阵**（README 必须写清，避免"又一个备份插件"误判）：

| 项目 | 定位 | 与我们的边界 |
|---|---|---|
| dshmarket（dsh-market）Backup & Restore | 月下载 1.1 万+，覆盖 profile 插件层 | 不碰 `vendor/` link 目录、`.agent-presets`、settings.yaml 凭据处理；我们与它**保持归档格式互通**是 v2 目标 |
| dsh-backup-sync（csiroqa） | 本地快照 + WebDAV 跨机同步 | 备份/同步，不是迁移；我们做"打包→换机还原"完整闭环 |
| dsh-backup（xiaoyuyu6420） | 一键备份 + 定时 + sha256 + 轮转 | 同上 |
| dsh-session-sync | 会话库 git 镜像 | 我们 MVP 明确不做 sessions |
| dsh-movein / DSH-Portable | 导入/便携构建 | 反向或不同形态，不冲突 |

---

## 2. 范围界定（MVP）

### ✅ 要做

| 模块 | 内容 |
|---|---|
| 导出 | 按 §6.1 清单扫描 `~/.dsh`，排除项硬编码；dry-run 预览；生成 manifest |
| 打包 | 单一 zip 产物，内置 manifest + sha256 校验清单 |
| 导入 | 预检（同 OS、dsh 版本 allowlist、磁盘空间）→ **默认新建 profile**（`<name>-migrated`，重名自动递增后缀）→ 写入配置 → `pnpm install` → 验证链 → 失败回滚 |
| link 处理 | `link:` 依赖相对化/按目标机路径重算（核心难点，MVP 必做） |
| 凭据处理 | 硬排除 `.credentials.yaml`/`.env` + settings.yaml/presets **secret 扫描脱敏**，导出报告列出处理明细。**判定策略 v2（2026-08-19 修复漏报）**：① 字段名强信号（apiKey/token/secret/password/credential/privateKey/auth 词边界匹配 + 值非平凡即命中——`sk-xxx` 不再漏报）；② 值形态启发式（base64/hex/字母+数字混合长串）；③ 豁免（*Env 字段、env 名引用值、占位符、纯数字/版本、已知非秘密字段 model/provider 等、可读长标识符）；④ **代码文件（.mjs/.js 等）跳过字段级扫描**（误报率高；凭据集中在配置类文件） |
| UI | 设置页"迁移"入口：导出向导 + 导入向导（hybrid：host 工具 + client 面板） |
| 文档 | README 中英、CHANGELOG、LICENSE、致谢列表 |

### ❌ 不做（明确排除，留给 v2 / 生态）

- 不做会话/存储迁移（`sessions/`、`storages/`）——v2 借鉴 dsh-session-sync git 镜像思路
- 不做 WebDAV/Gist 云同步——dshmarket 已有，v2 只做归档格式互通
- 不做跨品牌导入（Claude Code/Codex → DSH）——dsh-movein 的地盘
- 不做便携化/自包含运行时——DSH-Portable 的地盘
- 不做插件市场搜索安装、不做环境诊断修复——dshmarket / dsh-doctor 的地盘
- 不做凭据管理——只做排除 + 脱敏 + 引导重新配置
- 不做无人值守自动迁移——全程引导式，每个破坏性步骤用户确认
- **不做跨 OS 迁移（MVP 决策）**：只承诺同 OS（win→win / darwin→darwin / linux→linux）；实现按跨 OS 设计（vendor 在 home 内，成本极低），但承诺与预检都按同 OS
- **不做覆盖现有 profile（MVP 决策）**：导入默认新建 profile；覆盖模式不提供，切换/合并是 v2
- 不碰 dsh 核心/loader 内部——纯文件层操作 + 外部命令（pnpm、dsh CLI），降低维护成本

---

## 3. 环境勘察基线（本机实测，2026 实测）

`~/.dsh` 顶层实际结构（导出扫描与排除清单的事实依据）：

```
~/.dsh/
├── .agent-presets/          # 用户 agent 预设（本机：router-standard）→ 导出
├── .pnpm-store/             # pnpm 内容寻址仓库，可能数 GB → 硬排除
├── profiles/
│   ├── node_modules/        # DSH CLI 本体（dsh.cmd → profiles/node_modules/@deepseek-ai/dsh/lib/bin.js）→ 排除（目标机自装 CLI）
│   └── web/                 # 真实 profile，见下
├── sessions/  storages/  usage-stats/  super-injector/   # 运行态数据 → 排除
├── vendor/                  # link: 依赖实体（本机：dsh-super-injector）→ 导出
├── .anonymous-user-id       # 遥测 ID → 排除（目标机重新生成）
├── .credentials.yaml        # 凭据 → 硬排除
└── settings.yaml            # 全局设置 → 导出（含脱敏）
```

`profiles/web/` 实测内容（profile 迁移的完整文件集）：

```
profiles/web/
├── package.json             # dependencies（link: 绝对路径）+ dsh.profile.bundles ← 核心
├── cordis.yml               # loader 运行配置 → 必须导出
├── cordis.patch.yml         # 插件补丁状态（注入器 disabled 等）→ 必须导出
├── pnpm-workspace.yaml      # 注意：在 profile 目录内，不在 ~/.dsh 根（原需求位置有误，已修正）
├── pnpm-lock.yaml           # 目标机 pnpm install 会重生成；导出作参考，不保证可用
├── .dsh-skin-market/        # 运行时缓存 → 排除
└── node_modules/            # 本机实测 173MB（占导出体积 ~99%）→ 排除，目标机重装
```

`package.json` 中 link: 依赖实测形态（link 重写的输入输出基准）：

```json
"@dsh-external/dsh-super-injector": "link:C:/Users/<user>/.dsh/vendor/dsh-super-injector"
```

- 绝对路径、正斜杠、vendor 位于 `~/.dsh/vendor/` 内 → 相对化/重算都很直接
- 另存在 `git+https://` 依赖（skin 类）→ 不打包，目标机 install 时重新拉取（风险见 §12）

---

## 3.5 生态惯例与兼容性基线（调研结论）

本机实装包勘察（`profiles/web/node_modules/`、`~/.dsh/vendor/`、官方 npm 包）得出的形态规范，本项目必须对齐：

| 维度 | 惯例 | 依据（实装实例） |
|---|---|---|
| 发布包名 | 无 scope 的 `dsh-<feature>` kebab 命名 | dshmarket、dsh-better-sidebar、dsh-usage-stats、dsh-context；个人 scope 属个例（@freespace8/dsh-at-file）；`@dsh-external/*` 是本地不发布的组织 scope |
| 仓库组织 | 仓库根目录即包根（package.json 在根）；官方是 monorepo `packages/<dir>` | deepseek-ai/deepseek-harness、dsh-market/dsh-market |
| 构建产物 | `type: module`、`main: lib/index.js`、`exports` 含 `./client` 子路径 | 全部实装包一致 |
| UI 插件字段 | `dsh.bundle.patch`（cordis.patch.yml）+ `dsh.client.inject`（注入目标列表）+ `dsh.client.platform: "web"` | dshmarket、dsh-super-injector |
| 元数据 | `files`（lib/src/README/LICENSE）、license MIT（主流）、peerDependencies 显式声明 | dshmarket MIT、super-injector BSD-3-Clause |
| 文档 | README.md + 英文版（README_EN.md 或 README.en.md 两种写法并存，任选其一） | dsh-usage-stats、dsh-better-sidebar |
| home 路径 | **官方标准 API：`@deepseek-ai/dsh-home-paths`**（`resolveDshHome()`：显式配置 > `$DSH_HOME` > `~/.dsh`；`dshHomePath()` 拼接子路径；`expandHomePath()` 展开 `~`/`~\`；`dshHomeDisplay()` 符号化显示不泄漏绝对路径） | 官方包 0.1.0-rc.7，peerDeps `@deepseek-ai/dsh-invariants` + `@deepseek-ai/cordis` |

**本项目定案**（据此回答目录/包名问题）：
- 包名：`dsh-migrate`——符合社区裸名 `dsh-<feature>` 标准；发布前仍 `npm view dsh-migrate` 查重
- 目录：仓库根即包根（`<repo>/dsh-migrate`），结构与发布结构零迁移
- 依赖：`@deepseek-ai/dsh-home-paths` 进 peerDependencies；**所有 home 路径解析（扫描/重写/导入）一律走官方 API，不手拼路径**；UI 展示路径用 `dshHomeDisplay()`（顺带满足"不泄漏机器路径"的安全要求）

## 3.6 构建链路（本机事实，2026-08）

- 本机**无 Git Bash、无 DSH 源码 checkout**（`~/dsh-harness` 等候选不存在）→ `dev_build_plugin` 不可用（工具要求 bash + `$CHECKOUT/packages`）
- 降级方案已实现：`scripts/build.mjs`（`npm run build`）——junction 官方依赖 → `node typescript/bin/tsc` 编译 host → `npm run build:client`（tsdown）。依赖源探测：`DSH_CHECKOUT` → `~/dsh-harness` 等 → **`_npx` 缓存官方包树**（`AppData/Local/npm-cache/_npx/*/node_modules`，本机实测含全部 `@deepseek-ai/*` 包）
- `scripts/build.sh` 保留（bash 环境 + checkout 的生态惯例入口，`npm run build:bash`）
- 本机注入管线：`npm run build` → `dev_inject_plugin`（不依赖 bash/checkout，junction + loader.create）
- 编译注意事项：tsconfig `lib` 需含 `DOM`（client 骨架用 `document`）；Windows 路径含空格时 spawn 不得走 shell（build.mjs 已处理）


---

## 4. 架构

```
dsh-migrate (hybrid 插件)
├── src/host/           # 核心逻辑，纯 Node，可独立测试
│   ├── scan.ts         # 导出扫描（include/exclude）
│   ├── secret.ts       # 凭据排除 + secret 扫描脱敏
│   ├── manifest.ts     # manifest 生成/解析 + sha256
│   ├── archive.ts      # zip 打包/解包
│   ├── rewrite.ts      # link: 路径重写
│   ├── install.ts      # pnpm install 编排 + build 审批
│   ├── verify.ts       # 验证链（§9）
│   └── rollback.ts     # 快照/恢复（§10）
├── src/client/         # 设置页 UI：导出向导 + 导入向导（调 host 工具）
└── lib/                # 构建产物（dev_build_plugin 产出）
```

原则：
- **逻辑全在 host**，client 只做向导 UI；未来可加 CLI 入口复用同一核心
- 不 import dsh 内部 API；home 路径解析依赖官方 `@deepseek-ai/dsh-home-paths`（§3.5），文件布局约定 + 外部命令（pnpm、dsh CLI）
- 所有破坏性步骤：dry-run 预览 → 用户确认 → 执行 → 结果报告

---

## 5. 归档格式

单一 zip（扩展名 `.dshmig`），结构：

```
migrate-<profile>-<yyyyMMdd-HHmmss>.dshmig
├── manifest.json          # 见下
├── config/
│   ├── settings.yaml                      # 已脱敏
│   └── profiles/<name>/
│       ├── package.json                   # link: 依赖保持原样；重写依据 manifest.links（M3 导入侧重算）
│       ├── cordis.yml
│       ├── cordis.patch.yml
│       └── pnpm-workspace.yaml
├── presets/               # .agent-presets/* 内容
└── vendor/<pkg>/          # vendor 下每个 link 包的完整内容
```

`manifest.json` schema（草案）：

```json
{
  "formatVersion": 1,
  "toolVersion": "0.1.0",
  "createdAt": "ISO8601",
  "source": { "platform": "win32", "arch": "x64", "dshVersion": "x.y.z", "dshHome": "..." },
  "profiles": ["web"],
  "files": [ { "path": "...", "sha256": "...", "size": 123 } ],
  "links": [ { "dep": "@dsh-external/dsh-super-injector", "vendorPath": "vendor/dsh-super-injector" } ],
  "excluded": [ "sessions/", ".pnpm-store/", "..." ],
  "secretReport": { "excludedFiles": [...], "redactedFields": [...], "count": 3 },
  "notes": "MVP 同 OS；跨 OS 拒绝导入"
}
```

- `links` 是 link 重写的权威数据：目标机 install 前按它把 `vendorPath` 重算为 `newHome/vendor/<pkg>` 写回 package.json
- `excluded` 记录硬排除清单（自证 + 审计）

---

## 6. 模块规格

### 6.1 导出（scan.ts）

**扫描规则**（include 白名单 + 硬排除黑名单）：

- 包含：`settings.yaml`（脱敏后）、`profiles/*/{package.json, cordis.yml, cordis.patch.yml, pnpm-workspace.yaml}`、`.agent-presets/**`、`vendor/**`（仅被 link: 引用的包；孤立的 vendor 包跳过并报告）
- 硬排除：`.pnpm-store/`、`profiles/*/node_modules/`、`profiles/node_modules/`、`sessions/`、`storages/`、`usage-stats/`、`super-injector/`、`.anonymous-user-id`、`.credentials.yaml`、`.env*`、`profiles/*/.dsh-skin-market/`、各类 cache/log/tmp
- **dry-run 模式（默认）**：输出文件清单、总大小、排除项、疑似凭据数 → 用户确认后才真正打包

### 6.2 打包（archive.ts + manifest.ts）

- 逐文件 sha256，写入 manifest `files`；打包过程失败即中止（不留半成品产物）
- 产物命名含 profile 名与时间戳；写入临时文件后原子改名

### 6.3 导入（预检 → 还原）

**预检（全部通过才继续）**：
1. 平台匹配：manifest.source.platform/arch 与目标机一致（MVP 同 OS 决策）
2. dsh 版本兼容：manifest 记录 dshVersion，导入端 allowlist（`>= 最低支持版本`，具体值在 M3 实测后固化）
3. **target-freshness（2026-08-19 新增硬门槛）**：目标 DSH 必须是"原生未动"状态才允许导入——vendor/ 无注入包 && profiles 只有 web（或全新空 home）&& 无 `.dshmig-backup/` 迁移历史。任一不满足 → 预检拒绝，防止破坏已有自定义配置。回滚时会清理本次创建的 backup 目录（保持可重试），成功导入后目标机自然变为"非原生"（下次导入被拒）
4. `DSH_HOME` 存在且可写；目标 profile 名 `web-migrated` 冲突时自动递增（`web-migrated-2`）
5. 磁盘空间 ≥ 归档大小 × 3（产物 + 解包 + node_modules 余量）

**还原步骤（引导式，每步确认）**：
1. 解包到临时目录；校验全部 sha256
2. **备份目标机现状**：`settings.yaml`、目标 profile 目录快照 → `~/.dsh/.dshmig-backup/<timestamp>/`（回滚依据）
3. 写入新 profile 目录（`package.json`、`cordis.yml`、`cordis.patch.yml`、`pnpm-workspace.yaml`）+ 恢复 `.agent-presets`（缺失条目合并，不覆盖同名现有 preset）+ 恢复 `vendor/<pkg>`（同名跳过或校验一致，冲突报告给用户）
4. settings.yaml：**显式勾选项（默认勾选）**，MVP 语义为"备份原文件后覆盖导入内容"；合并语义 v2 再做
5. link 重写（见 §7）→ `pnpm install`（见 §8）→ 验证链（见 §9）→ 全部通过才收尾
6. 失败：自动回滚（见 §10）；成功：保留 `.dshmig-backup/` 供用户手动清理（提示，不自动删）

### 6.4 切换

- MVP **不自动切换**默认 profile（切换机制待 M3 勘察 dsh 是否有 switch 命令/配置项）
- 验证通过后 UI 提示"手动切换"指引；若勘察发现标准机制，加一条非破坏性的切换确认步骤（v1.x）

### 6.5 UI 向导（client 面板，M5，完整向导）

设置页"迁移"入口，两个向导，全部步骤只调 host 工具、不重复业务逻辑：

**导出向导**（4 步）：
1. 选择范围：profile 列表（默认全选）+ settings.yaml 勾选项（默认勾选）+ 显示预估大小
2. dry-run 预览：文件清单（树形/分组）、排除项、疑似凭据数（来自 secretReport 预扫描）→ 用户确认
3. 执行：进度条（按文件计数/字节），可中止（中止即删除半成品）
4. 结果：产物路径 + manifest 摘要 + 打开产物目录按钮

**导入向导**（5 步）：
1. 选归档文件（拖拽/浏览）→ 立即校验：zip 完整性 + sha256 + manifest 可解析
2. 预检结果页：平台匹配、dsh 版本 allowlist、磁盘空间、新 profile 名（自动递增预览）→ 逐项 ✓/✗，✗ 阻塞
3. 逐步确认：每个破坏性步骤（写 settings、建新 profile、pnpm install、git 依赖联网提示）单独确认，显示将执行的命令
4. 执行：进度 + 当前步骤说明；失败自动回滚并在结果页展示回滚报告
5. 结果：验证链各级结果（✓/✗/跳过 + 证据）、`.dshmig-backup/` 路径与清理提示、手动切换指引

失败/异常统一进"报告页"（可复制文本），不弹裸 alert。

**渲染契约（2026-08-19 实测踩坑）**：`settings.section` 的 component 必须是 **React 元素工厂**（`() => React.createElement(...)`，见 dsh-cordis-client-runner slot 文档）——返回原生 DOM 对象（`{render()}`）不会渲染（scaffold 的 conversation.view 骨架是原生 DOM 写法，settings.section 契约不同）。实现：react 壳（`h('div', {ref})`）+ 原生 DOM 面板挂载；`label` 用字符串（官方 example 形态）。

---

## 7. link 重写（rewrite.ts，核心难点）

输入：`manifest.links` + 源 package.json 的 `link:` 依赖；输出：目标机 package.json 的 `link:` 依赖。

规则（基于实测形态 `link:C:/Users/<user>/.dsh/vendor/<pkg>`）：
1. 解析依赖值为绝对路径；断言其位于源 `~/.dsh/vendor/` 下（否则报错——不允许导出非 vendor 的 link 目标，防路径逃逸）
2. 归档内保持相对引用（`vendor/<pkg>` 记入 `manifest.links.vendorPath`）
3. 目标机重算：`link:<newHome>/vendor/<pkg>`，正斜杠，与现有 DSH 写入形态一致；**Windows 下 junction 由 pnpm install 自动创建（2026-08 沙箱实测确认，无需自建）**，导入后 `realpath` 验证指向 vendor（L2 实测通过）
4. 重写后必须与 vendor 实体存在性做交叉校验（vendor 缺失 → 导入中止，不进入 install）
5. **bundle 契约（resolveBundleDir 实测结论）**：vendor 包必须含可解析的 `package.json` 且声明 `dsh.bundle.patch` 指向存在的 patch 文件——否则 `dsh --dump-config` 报 "declares no dsh.bundle"。导入已做前置校验（install 前拦截，不回滚兜底）

---

## 8. pnpm install 编排（install.ts）

- 在目标新 profile 目录内执行（`workdir = <newHome>/profiles/<new>-migrated`）
- 目标机若已存在 `pnpm-lock.yaml` 由 pnpm 重新解析；`git+https` 依赖需要网络/凭据（风险 §12）
- **build 审批（M3 勘察项）**：pnpm 9+ 需 approve-builds。勘察 dsh 自身 install 流程（cordis.yml 相关配置 / onlyBuiltDependencies / pnpm config），复用 dshmarket backup 模块与 skin-market 的 pnpm 失败处理经验；勘察结论写入本节并固化实现
- **现成参照（已勘察）**：dshmarket `src/pnpm-compat.ts`（本机 `node_modules/dshmarket/src/` 含源码）——pnpm 9/10/11 行为矩阵（workspace root 需 `-w`；无 pnpm-workspace.yaml 时 `-w` 报错）、失败分类（`PnpmFailure`：adding-to-root/not-a-workspace/hoist-pattern-diff/ignored-builds/git-prepare-not-allowed/fetch-404/transient-network 等 + recoverable 标记）、瞬态网络失败自动重试一次。M3 直接借鉴此模块（保留 LICENSE 署名，§14）
- **标准编排入口**：`dsh plugin <add|remove|...>`（把剩余参数转发到 profile 目录内 pnpm），优先于裸 pnpm
- 失败处理：捕获 pnpm 输出尾部错误、退出码；不吞错，完整日志进导入报告

---

## 9. 验证链（verify.ts）

降级链（前一级失败自动尝试下一级，全部失败 → 回滚）：
1. **链接解析验证**：新 profile `node_modules` 中 link 依赖的 junction/symlink 存在且目标可解析（`fs.realpath` + exists）
2. `dsh --dump-config --profile <name>`（**已勘察确认存在**，2026-08 本机实测）
3. `dsh doctor`（若存在）
4. 最小启动验证（**v1.x**：沙箱完整启动过重；L1-L3 已覆盖核心风险）

**勘察结论（2026-08 本机实测）**：
- `dsh --dump-config` 必须带 `--profile <name>`；**非纯读**——`prepareProfile` 会重写 `cordis.yml`（只读环境实测 EPERM）。导入场景可接受（本来就要写），**dry-run/预览禁用**
- **必须显式传 `DSH_HOME` 环境变量**（dsh CLI 读 env 而非 cwd——沙箱测试发现，已修复；否则会指向真实 home）
- L3 在 bundle 完整时通过（见 §7 bundle 契约）；L1 pnpm install + L2 链接解析 2026-08 沙箱端到端实测通过
- `dsh plugin <add|remove|...>` 存在：转发到 profile 目录内 pnpm（§8 标准入口）
- `dsh --version` 可用（版本兼容检查）；`dsh --profile <name> --help` 可查 app 参数

验证报告写入导入结果：每级通过/失败/跳过 + 证据（链接路径解析结果、命令输出尾部）。

---

## 10. 回滚（rollback.ts，分级承诺）

**诚实分级**（README/UI 措辞用下面的表述，不用"整体回滚"）：

| 层级 | 内容 | 承诺 |
|---|---|---|
| 配置级 | settings.yaml、新 profile 目录、vendor 写入、presets 合并 | **完全回滚**（基于 §6.3 步骤 2 的快照，删除新建内容 + 恢复快照） |
| 依赖级 | node_modules、pnpm-lock.yaml 的 install 副作用 | **尽力恢复**（删除新 profile node_modules 并重跑目标机原状态；lockfile 若有改动以快照恢复） |
| 备份数据 | `.dshmig-backup/` | 回滚成功后保留，提示用户确认后手动清理 |

- 快照在导入步骤 2 创建；回滚入口：导入任一步失败自动触发；用户也可在向导中手动触发"放弃导入"
- 回滚自身失败（磁盘/权限）：报告并保留现场，绝不静默

---

## 11. 测试策略

1. **单元测试**（进 CI）：scan 的 include/exclude 规则、secret 扫描正则与脱敏、link 重写（win/darwin/linux 路径形态）、manifest schema、sha256 校验
2. **端到端（核心）**：利用 `DSH_HOME` 可覆盖特性，CI 用临时 DSH_HOME 构建 fixture（假 profile：package.json 含 link: 依赖 + bundles、cordis.yml、presets、vendor 实体、带假凭据的 settings.yaml）→ 跑「导出 → 校验产物 → 导入到第二个临时 DSH_HOME → 验证链 → 回滚演练」全链路。每次跑完清理临时 DSH_HOME
   - 现有资产：`test/smoke-import.mjs`（层 1：沙箱内可跑，无子进程）+ `test/smoke-install.mjs`（层 2：完整链路含 pnpm install + dump-config，需完整权限）
3. **故障注入**：vendor 缺失、sha256 不匹配、磁盘不足、pnpm 失败、凭据文件出现在异常位置——各自应触发预期路径（报错/跳过/回滚）
4. **手动验收清单**（本机真环境）：导出本机 → 导入为 `web-migrated` → 验证 → 手动清理；记录进 CHANGELOG

---

## 12. 风险登记

| # | 风险 | 影响 | 缓解 |
|---|---|---|---|
| 1 | `git+https://` 依赖（skin 类）目标机重新拉取需网络/凭据 | 离线/受限目标机 install 失败 | 导入预检提示"含 git 依赖，需网络"；v2 考虑 git 依赖 vendor 化 |
| 2 | pnpm build 审批自动化细节未知 | install 卡在审批 | M3 勘察 dsh/skin-market/dshmarket 现成处理，勘察后固化 |
| 3 | 默认 profile 切换机制未知 | 导入后用户不知怎么用 | M3 勘察；MVP 只给手动指引 |
| 4 | `dsh --dump-config` / `dsh doctor` 命令存在性未验证 | 验证链依赖不实 | 验证链降级设计（§9），M3 实测后固化 |
| 5 | cordis.yml / cordis.patch.yml 格式随版本漂移 | 导入后插件状态异常 | manifest 记录 dshVersion + allowlist；patch 文件逐条校验 entry id（复用 dev_fix_patch 的查重思路） |
| 6 | settings.yaml 含未知键/结构变化 | 覆盖导入破坏目标机设置 | 覆盖前必备份；导入报告 diff；合并语义 v2 |
| 7 | 大 vendor 包/多 profile 导致产物膨胀 | 导出/传输慢 | 产物大小写进 dry-run 预览；超阈值（如 500MB）二次确认 |
| 8 | 同 OS 但盘符/路径大小写差异 | link 重算失败 | 重写后交叉校验 vendor 实体存在性（§7 规则 4） |
| 9 | 回滚自身失败 | 现场残留 | §10：报告 + 保留现场，不静默 |

---

## 13. 里程碑

| 里程碑 | 内容 | 验收 | 估时 |
|---|---|---|---|
| M1 骨架 | `dev_scaffold_plugin`（form=hybrid, name=dsh-migrate, dir=`<repo>/dsh-migrate`）→ `dev_build_plugin` → `dev_inject_plugin` | 设置页出现"迁移"入口（占位），host 工具可调用 | 0.5d |
| M2 导出+打包 | scan / secret / manifest / archive + dry-run 预览 | ✅ 完成（2026-08-19 实测：本机导出 20 文件/1.28MB，清单与 §3 基线一致；dry-run 预览 + 真实产物验证通过） | 1d |
| M3 导入+link | 预检 / 还原 / rewrite / install（含 §8 勘察项） | ✅ 完成（2026-08-19 沙箱端到端实测：pnpm install OK → link resolve OK → dsh --dump-config OK；含 DSH_HOME 隔离、bundle 契约前置校验、settings 回滚修复） | 1.5d |
| M4 校验+回滚 | verify 链 + rollback + 故障注入 | ✅ 完成（2026-08-19：fault-injection.mjs 19/19 通过——sha256 篡改/跨 OS/vendor 缺失/bundle 契约/pnpm 失败回滚/凭据排除/归档损坏/staging 清理；修复 staging 空壳残留 bug） | 1d |
| M5 UI 向导 | client 面板：导出/导入向导、进度、报告展示 | ✅ 完成（2026-08-19：settings.section「迁移」入口 + 导出/导入双向导；host HTTP API 4 端点实测通过——export-preview/export/import-dryrun；body 读取用 IncomingMessage 异步迭代，dshmarket 同款） | 1d |
| M6 发布 | README 中英、LICENSE、致谢、CHANGELOG、CI、`dev_release_plugin` | ✅ 完成（2026-08-19：README.md/README_EN.md/LICENSE/CHANGELOG；npm 查重通过（dsh-migrate 未占用）；npm pack 验证 35 文件/145KB；npm test 全绿（6+19 断言）；GitHub 发布与收录申请待仓库就绪后执行） | 1d |

总计约 6 个工作日（含缓冲）。

---

## 14. 开源合规与发布规范

1. 先搜再写：README 差异化矩阵（§1）写清与 dshmarket backup / dsh-backup-sync / dsh-backup 的区别
2. 许可证：本项目 MIT；借鉴 dshmarket / dsh-super-injector / skin-market 代码时保留其 LICENSE 与版权声明（MIT/BSD-3-Clause 复用必须署名），借鉴接口与模式优先于复制实现
3. 致谢：README 参考项目列表（dshmarket、dsh-super-injector、skin-market、dsh-backup-sync、dsh-backup、dsh-session-sync）
4. 发布：npm 包名查重（暂定名 dsh-migrate）→ README 中英 → semver + CHANGELOG → 单测进 CI → GitHub Release 走 `dev_release_plugin` → 申请收录 dshfind / mydsh.dev
5. 安全边界写死：§6.1 硬排除 + §6.2 secret 脱敏，README 声明"本插件不收集、不传输任何凭据"；secretReport 随产物留存可审计
6. 回馈上游：发现 dshmarket 备份格式兼容点 → 提 PR；issue 模板配好
7. 不吹牛：README 只写实测过的能力，标注 experimental 与验证范围（沿用 dsh-router-standard 翻车教训）

---

## 15. 下一步

按 M1 开工：`dev_scaffold_plugin`（form=hybrid，dir 待定）→ `dev_build_plugin` → `dev_inject_plugin` → 设置页出现"迁移"占位入口。M2 前先补一个勘察任务：确认 `dsh --dump-config` / `dsh doctor` / profile switch 的真实命令形态（影响 §8/§9/§6.4 的固化）。
