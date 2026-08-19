# dsh-migrate

> **experimental** — DSH 配置迁移工具：导出/打包 → 换机还原 → 校验 + 回滚。

[English](./README_EN.md)

[![npm version](https://img.shields.io/npm/v/dsh-migrate)](https://www.npmjs.com/package/dsh-migrate)
[![npm downloads](https://img.shields.io/npm/dm/dsh-migrate)](https://www.npmjs.com/package/dsh-migrate)
[![license](https://img.shields.io/npm/l/dsh-migrate)](https://github.com/ygcdsj/dsh-home-migrate/blob/main/LICENSE)

从任意 DSH 安装打包配置，在目标机还原为**新建 profile**，全程校验、失败自动回滚。不做云、不做历史、不做跨品牌。

## 工作流程

![dsh-migrate 迁移流程总览](https://raw.githubusercontent.com/ygcdsj/dsh-home-migrate/main/assets/migration-flow.svg)

## 与现有项目的区别

| 项目 | 定位 | dsh-migrate 的边界 |
|---|---|---|
| dshmarket（dsh-market）Backup & Restore | 市场内 profile 插件层备份/恢复 | 我们不碰插件市场；dsh-migrate 覆盖 `vendor/` link 目录、`.agent-presets`、settings.yaml、凭据脱敏——**归档格式互通是 v2 目标** |
| [dsh-backup-sync](https://github.com/csiroqa/dsh-backup-sync) | 本地快照 + WebDAV 跨机同步 | 备份/同步 ≠ 迁移；我们做"打包 → 换机还原"完整闭环 |
| [dsh-backup](https://github.com/xiaoyuyu6420/dsh-backup) | 一键备份 + 定时 + sha256 + 轮转 | 同上 |
| [dsh-session-sync](https://www.npmjs.com/package/dsh-session-sync) | 会话库 git 镜像 | 我们 MVP 明确不做 sessions |
| [dsh-movein](https://github.com/sjh9714/dsh-movein) / [DSH-Portable](https://github.com/WSL043/DSH-Portable) | 导入（Claude Code → DSH）/ 便携构建 | 反向或不同形态，不冲突 |

## 功能（MVP）

- **导出**：扫描 `~/.dsh`（profiles 配置、settings.yaml、`.agent-presets`、`vendor/` link 目录）；硬排除 `.credentials.yaml`/`.env`/`.pnpm-store`/`sessions`/`storages`/`node_modules` 等；settings/presets 做字段级**凭据扫描 + 脱敏**，处理明细进 manifest（`secretReport`）
- **打包**：单一 `.dshmig`（zip），内置 manifest（版本、平台、文件清单、sha256 校验和、link 映射）
- **导入**：预检（同 OS、dsh 版本、磁盘）→ 备份目标机 → **默认新建 profile**（`<name>-migrated`，重名自动递增）→ `link:` 路径重算 → vendor/presets/settings 还原 → `pnpm install` → 验证链（链接解析 → `dsh --dump-config`）→ 失败自动回滚
- **验证链**：L1 pnpm install / L2 link 解析（junction realpath）/ L3 `dsh --dump-config`
- **界面**：设置页「迁移」入口（导出向导 + 导入向导）；host 工具 `dsh_migrate_export` / `dsh_migrate_import` 可被 agent 直接调用

### MVP 明确不做（v2 或生态）

sessions/storages 迁移、WebDAV/Gist 云同步、跨品牌导入、便携化、跨 OS 迁移、覆盖现有 profile、无人值守自动迁移、凭据管理（只排除 + 脱敏 + 引导重配）。

## 安装

发布到 npm 后：

```bash
# 在 profile 目录内
dsh plugin --profile web add dsh-migrate
```

本地开发/注入（需要 [dsh-super-injector](https://github.com/dsh-external/dsh-super-injector)）：

```bash
npm install --legacy-peer-deps --no-audit --no-fund
npm run build          # 构建（无 bash/无源码 checkout 时自动降级 _npx 缓存官方包树）
# 注入器环境内：
dev_inject_plugin <本目录>
```

## 完整迁移流程（第一次使用）

1. **源机导出**：设置 → 迁移 → 导出 → ① 预览导出内容 → ② 执行导出
2. **拿到产物**：`.dshmig` 文件生成在 `~/dsh-migrate-exports/dsh-migrate-<profile>-<时间戳>.dshmig`——一个 zip，内含 manifest（校验清单）、profile 配置、settings.yaml（已脱敏）、`.agent-presets`、`vendor/` link 包；**凭据尽力排除/脱敏**（`secretReport` 含 `unscannedFiles` 未扫描清单，传输前请核对）
3. **传输**：U 盘 / 网盘 / scp 均可（脱敏尽力而为，请以 secretReport 为准）
4. **目标机导入**：目标机 DSH → 设置 → 迁移 → 导入 → 粘贴 `.dshmig` 路径 → ① 预检（逐项 ✓/✗）→ 确认步骤清单 → ② 执行导入
5. **等待验证**：自动执行 pnpm install + 验证链（L1 安装 / L2 链接解析 / L3 `dsh --dump-config`），全部通过才收尾
6. **切换使用**：导入为**新建 profile**（`<name>-migrated`），验证通过后手动切换默认 profile；确认无误后清理 `~/.dsh/.dshmig-backup/`

> **启动迁移后的 profile（重要）**：`dsh web` 是 `dsh --profile web` 的别名，永远启动原生的 `web` profile——迁移成果在新建的 `<name>-migrated` profile 里，必须显式指定：
>
> ```bash
> dsh --profile web-migrated     # 启动迁移后的 profile（GUI）
> ```
>
> 用 `dsh web` 打开的是未迁移的原生环境，自然看不到迁移过来的插件/皮肤/设置，这不是故障。确认迁移无误后，可停用旧 profile 并将 `<name>-migrated` 重命名为 `web`，或设置 `DSH_PROFILE` 环境变量，让 `dsh web` 直接指向迁移后的环境。

> 导入全程不覆盖你现有的 profile；任何一步失败自动回滚。

## 用法

### 设置页向导（推荐）

1. **导出**：设置 → 迁移 → 预览导出内容（文件清单/大小/排除项/疑似凭据）→ 执行导出 → 产物在 `~/dsh-migrate-exports/*.dshmig`
2. **导入**：目标机设置 → 迁移 → 输入 `.dshmig` 路径 → 预检（逐项 ✓/✗）→ 确认步骤清单 → 执行 → 查看验证链结果与备份目录
3. 验证通过后手动切换默认 profile 使用；`.dshmig-backup/` 确认无误后可手动清理

### Host 工具

`dsh_migrate_export { dryRun: true }`（预览）/ `{ dryRun: false, outDir }`（打包）；`dsh_migrate_import { archive, dryRun: true }`（预检）/ `{ archive }`（导入，失败自动回滚）。

## 安全边界

![dsh-migrate 导入安全门禁](https://raw.githubusercontent.com/ygcdsj/dsh-home-migrate/main/assets/security-gates.svg)

- **凭据尽力排除/脱敏，非绝对保证**：`.credentials.yaml`、`.env*` 硬排除；settings/presets/vendor 配置文件内疑似凭据字段自动脱敏（`<redacted>`）并记录于 `secretReport`；**未扫描文件清单（`unscannedFiles`）随报告导出，请核对后再传输**
- **vendor 包配置文件内的凭据会原地脱敏**：迁移不搬运凭据的必然代价——迁移后的 vendor 包若依赖被脱敏的值（如 API token），需要在目标机重新配置；README/导出报告会提示
- **导入 = 执行归档中的代码**：导入会 `pnpm install`（默认 `--ignore-scripts`）并解析 bundle 插件，之后启动该 profile 会执行其中插件——**仅导入你信任的来源**（UI 确认框有醒目警告）
- 导出产物只在本机生成；上传/传输由用户自行负责
- `link:` 目标断言在 `<home>/vendor` 内（防路径逃逸）；manifest 路径字段（files/links/profiles）白名单校验 + 落地断言（防穿越写盘）
- HTTP API 仅本机回环（Host 白名单）+ CSRF token + Origin 同源 + `Sec-Fetch-Site` 校验；**将 DSH web 暴露到局域网 = 任何人可导入任意归档（RCE 面）**
- settings.yaml 为符号链接时拒绝覆盖（防穿透写目标）
- 并发导入各自独立 staging 子目录，互不清理

## FAQ

**导入会覆盖我现在的配置吗？** 不会。MVP 只新建 profile（`<name>-migrated`）；settings.yaml 在备份后覆盖（可在导入前取消勾选）。

**为什么 `dsh web` 看不到迁移的插件？** `dsh web` 只是 `dsh --profile web` 的别名，启动的是原生的 `web` profile；迁移工具**不覆盖现有 profile**，成果都在新建的 `<name>-migrated` 里。请用 `dsh --profile <name>-migrated` 启动。确认迁移无误后，可停用旧 profile 并把 `<name>-migrated` 重命名为 `web`（或设置 `DSH_PROFILE` 环境变量），让 `dsh web` 直接指向迁移后的环境。

**跨 OS 可以迁移吗？** MVP 限定同 OS；跨 OS 会在预检阶段明确拒绝。

**git: 依赖（skin 类）怎么办？** 不打包，目标机 `pnpm install` 时重新拉取（需网络/凭据），预检会提示。

**导入安全吗？** 导入会执行归档内的代码（pnpm install 安装脚本 + bundle 插件解析，之后启动 profile 还会执行插件），所以**只导入你信任的来源**。默认 `--ignore-scripts` 禁止依赖安装脚本；路径字段白名单 + 落地断言防穿越；HTTP API 仅回环 + token 可调。

**导入失败了会怎样？** 配置级完全回滚（删除新建内容 + 恢复快照），依赖级尽力恢复；`.dshmig-backup/` 保留现场，绝不静默。

## 开发与测试

```bash
npm test             # 冒烟（导出→导入→重写/还原/递增/故障注入），沙箱内可跑
npm run test:install # 完整链路（pnpm install + dump-config，需完整权限）
```

规格与设计决策见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)（本机实测基线、生态惯例、勘察结论、风险登记）。

安全审查与修复记录：原始审查报告见 [docs/SECURITY_REVIEW.md](docs/SECURITY_REVIEW.md)，核查与修复验证见 [docs/VERIFICATION.md](docs/VERIFICATION.md)。

## 路线图（v2）

- sessions/storages 迁移（借鉴 dsh-session-sync git 镜像思路）
- 与 dshmarket 备份格式互通
- WebDAV/Gist 同步
- 跨 OS（实现已按跨 OS 设计，仅承诺保守）

## 许可证

MIT © 2026 dsh-migrate contributors

## 致谢

- [dshmarket](https://github.com/dsh-market/dsh-market) — 路由/HTTP 模式、pnpm 兼容层、备份模块参照
- [dsh-super-injector](https://github.com/dsh-external/dsh-super-injector) — 插件形态与构建管线参照
- [dsh-skin-market](https://github.com/kingOfSoySauce/dsh-skin-market) — pnpm 失败处理参照
- [dsh-backup-sync](https://github.com/csiroqa/dsh-backup-sync)、[dsh-backup](https://github.com/xiaoyuyu6420/dsh-backup)、[dsh-session-sync](https://www.npmjs.com/package/dsh-session-sync) — 生态定位对照
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — 官方平台与 `@deepseek-ai/dsh-home-paths` 等标准包
