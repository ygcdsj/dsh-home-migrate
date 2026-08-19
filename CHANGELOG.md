# Changelog

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
