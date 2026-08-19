/**
 * dsh-migrate — DSH 配置迁移工具（hybrid：host 工具 + 设置页向导）。
 * M2：导出链路（scan → secret 脱敏 → manifest → zip + dry-run 预览）。
 * M3：导入链路（预检 → 备份 → 新建 profile → link 重写 → pnpm install → 验证 → 回滚）。
 * M4+：验证链/故障注入完善、UI 向导。规格见 docs/DEVELOPMENT.md。
 */
import type { Context } from 'cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from 'schemastery'
import { exportDsh } from './export.js'
import { importDsh } from './import.js'
import { mountMigrateRoutes } from './routes.js'

export const name = 'dsh-migrate'
export const inject = ['tools']

export interface Config {}

export const Config = z.object({})

export function apply(ctx: Context): void {
  ctx.effect(() => [
    ctx.tools.register(defineTool({
      name: 'dsh_migrate_export',
      description: '导出 DSH 配置迁移归档（.dshmig）。dryRun=true（默认安全）返回预览：文件清单/总大小/排除项/link 依赖/疑似凭据；dryRun=false 打包产物并返回路径与 manifest 摘要。凭据硬排除+脱敏，不随包传输。',
      parameters: {
        dryRun: { type: 'boolean', required: true, description: 'true=仅预览；false=真正打包' },
        outDir: { type: 'string', description: '产物目录（默认 ~/dsh-migrate-exports）' },
      },
      output: {
        schema: { type: 'string' },
        render: (_a: unknown, v: unknown) => [{ type: 'text', text: String(v) }],
      },
      async execute(args: { dryRun?: boolean; outDir?: string }) {
        try {
          return JSON.stringify(exportDsh({ dryRun: args?.dryRun === true, outDir: args?.outDir }), null, 2)
        } catch (e) {
          return JSON.stringify({ ok: false, dryRun: args?.dryRun === true, error: String(e) }, null, 2)
        }
      },
    })),

    ctx.tools.register(defineTool({
      name: 'dsh_migrate_import',
      description: '导入 DSH 配置迁移归档（.dshmig）：预检（同 OS/版本）→ 备份目标机 → 新建 profile（<name>-migrated，重名递增）→ link: 重写 → vendor/presets 还原 → pnpm install → 验证链（链接解析 + dsh --dump-config）。失败自动回滚（配置级完全恢复）。dryRun=true 只预检不写入。',
      parameters: {
        archive: { type: 'string', required: true, description: '.dshmig 归档路径' },
        dryRun: { type: 'boolean', description: 'true=仅预检与计划（不写入）' },
        includeSettings: { type: 'boolean', description: '是否覆盖 settings.yaml（默认 true，先备份）' },
        skipInstall: { type: 'boolean', description: '跳过 pnpm install 与依赖级验证（测试用）' },
      },
      output: {
        schema: { type: 'string' },
        render: (_a: unknown, v: unknown) => [{ type: 'text', text: String(v) }],
      },
      async execute(args: { archive?: string; dryRun?: boolean; includeSettings?: boolean; skipInstall?: boolean }) {
        try {
          if (!args?.archive) return JSON.stringify({ ok: false, dryRun: true, error: 'archive 参数必填' }, null, 2)
          return JSON.stringify(importDsh({
            archive: args.archive,
            dryRun: args.dryRun === true,
            includeSettings: args.includeSettings !== false,
            skipInstall: args.skipInstall === true,
          }), null, 2)
        } catch (e) {
          return JSON.stringify({ ok: false, dryRun: args?.dryRun === true, error: String(e) }, null, 2)
        }
      },
    })),
  ], 'dsh-migrate: tools')

  // HTTP API（设置页向导调用）
  ctx.inject(['webServer'], (hostCtx) => {
    hostCtx.effect(() => mountMigrateRoutes(hostCtx), 'dsh-migrate: http routes')
  })
}
