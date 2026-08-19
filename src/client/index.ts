/**
 * dsh-migrate — client 面板（settings.section slot）：导出向导 + 导入向导（docs §6.5）。
 * 全部交互通过同源 fetch 调 host API（/dsh-migrate/api/*），不重复业务逻辑。
 * 契约要点（dsh-cordis-client-runner slot 文档实测）：settings.section 的 component
 * 必须是 React 元素工厂——原生 DOM 对象不会被渲染（本面板用 react 壳 + 原生 DOM 挂载）。
 * 双语 label。
 */
import { createElement as h } from 'react'

type SlotsService = {
  inject(slot: string, register: () => unknown): void
  register(meta: Record<string, unknown>, component: () => unknown): unknown
}

type ClientContext = {
  effect(callback: () => unknown, label?: string): void
  slots: SlotsService
}

export const name = 'dsh-migrate'
export const inject = ['slots']

// ── DOM 辅助 ─────────────────────────────────────────────────
function el(tag: string, props: Record<string, unknown> = {}, ...children: (Node | string)[]): HTMLElement {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) {
    if (k === 'style' && typeof v === 'object') Object.assign(node.style, v)
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v as EventListener)
    else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, String(v))
  }
  for (const c of children) node.append(c instanceof Node ? c : document.createTextNode(String(c)))
  return node
}

const row = (label: string, value: string): HTMLElement =>
  el('div', { style: { display: 'flex', gap: '8px', padding: '2px 0' } },
    el('span', { style: { color: '#8b949e', minWidth: '110px' } }, label), el('span', {}, value))

function fmtBytes(n: number): string {
  if (n > 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB'
  if (n > 1024) return (n / 1024).toFixed(1) + ' KB'
  return n + ' B'
}

let csrfToken: string | null = null

async function api(path: string, body?: unknown): Promise<Record<string, unknown>> {
  if (!csrfToken) {
    try {
      const s = await fetch('/dsh-migrate/api/session', { method: 'GET' })
      const d = (await s.json()) as { token?: string }
      csrfToken = d.token ?? null
    } catch { /* token 拿不到则不带（服务端会 403，报错可见） */ }
  }
  const r = await fetch(path, {
    method: 'POST',
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(csrfToken ? { 'x-dshmig-token': csrfToken } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  return r.json() as Promise<Record<string, unknown>>
}

/** File → base64（浏览器文件选择上传用）。 */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '')
    r.onerror = () => reject(r.error ?? new Error('file read failed'))
    r.readAsDataURL(file)
  })
}

const L = (zh: string, en: string): string => (navigator.language?.toLowerCase().startsWith('zh') ? zh : en)

// ── 样式（暗色主题协调，GitHub Dark 色板——与 settings 面板一致；避免浏览器默认按钮突兀）──
function ensureStyles(): void {
  if (document.querySelector('style[data-dshmig]')) return
  const css = `
.dshmig-btn{background:#21262d;color:#e6edf3;border:1px solid #30363d;border-radius:6px;padding:5px 14px;cursor:pointer;font-size:13px;font-family:inherit;line-height:1.4}
.dshmig-btn:hover:not(:disabled){background:#30363d;border-color:#8b949e}
.dshmig-btn:disabled{opacity:.5;cursor:default}
.dshmig-btn-primary{background:#238636;border-color:#2ea043;color:#fff}
.dshmig-btn-primary:hover:not(:disabled){background:#2ea043}
.dshmig-input{background:#0d1117;color:#e6edf3;border:1px solid #30363d;border-radius:6px;font-size:13px;font-family:inherit;padding:5px 8px}
.dshmig-input:focus{outline:1px solid #58a6ff;outline-offset:-1px}
.dshmig-tab{background:transparent;border:1px solid #30363d;border-radius:6px;padding:4px 12px;cursor:pointer;font-size:13px;color:#8b949e;font-family:inherit}
.dshmig-tab-active{background:rgba(63,185,80,.12);border-color:#3fb950;color:#3fb950}
.dshmig-kbd{background:#21262d;border:1px solid #30363d;border-radius:4px;padding:0 5px;font-size:12px;color:#8b949e}
`
  const style = document.createElement('style')
  style.dataset.dshmig = '1'
  style.textContent = css
  document.head.append(style)
}

// ── 面板 ─────────────────────────────────────────────────────
function createPanel(): HTMLElement {
  ensureStyles()
  const root = el('div', { style: { fontFamily: 'system-ui, sans-serif', maxWidth: '720px', padding: '8px 0' } })
  const content = el('div', {})

  const setContent = (node: Node): void => {
    content.textContent = ''
    content.append(node)
  }
  const busy = (text: string): void => setContent(el('div', { style: { color: '#8b949e', padding: '12px 0' } }, text + ' …'))
  const errorBox = (msg: string): HTMLElement => el('div', { style: { color: '#f85149', padding: '8px 0' } }, '✗ ' + msg)
  const okBox = (msg: string): HTMLElement => el('div', { style: { color: '#3fb950', padding: '8px 0' } }, '✓ ' + msg)

  const tabs = el('div', { style: { display: 'flex', gap: '8px', marginBottom: '10px' } })

  // 编号步骤块（①②③ 向导结构）
  const step = (num: string, title: string, body: (HTMLElement | string)[]): HTMLElement =>
    el('div', { style: { margin: '10px 0' } },
      el('div', { style: { fontWeight: 600, marginBottom: '6px', color: '#e6edf3' } }, `${num}  ${title}`),
      ...body.map((b) => (typeof b === 'string' ? el('div', {}, b) : b)),
    )

  // ── 导出向导 ──
  const exportView = (): void => {
    const outDirInput = el('input', {
      type: 'text', class: 'dshmig-input',
      placeholder: L('产物目录（留空 = 默认 ~/dsh-migrate-exports）', 'Output dir (blank = ~/dsh-migrate-exports)'),
      style: { flex: '1' },
    }) as HTMLInputElement
    const browseBtn = el('button', { class: 'dshmig-btn' }, L('📁 浏览…', '📁 Browse…')) as HTMLButtonElement
    const browseError = el('div', { style: { color: '#f85149', fontSize: '12px', minHeight: '16px' } }, '')
    const outDirRow = el('div', { style: { display: 'flex', gap: '8px', margin: '6px 0', alignItems: 'center' } },
      outDirInput, browseBtn, browseError)
    browseBtn.addEventListener('click', () => {
      browseBtn.disabled = true
      browseBtn.textContent = L('选择中…', 'Picking…')
      browseError.textContent = ''
      void api('/dsh-migrate/api/pick-directory').then((d) => {
        browseBtn.disabled = false
        browseBtn.textContent = L('📁 浏览…', '📁 Browse…')
        if (d.ok && typeof d.path === 'string') outDirInput.value = d.path
        else if (d.ok && d.cancelled) { /* 用户取消：无操作 */ }
        else if (d.error) browseError.textContent = '⚠ ' + String(d.error)
      }).catch((e) => {
        browseBtn.disabled = false
        browseBtn.textContent = L('📁 浏览…', '📁 Browse…')
        browseError.textContent = '⚠ ' + String(e)
      })
    })
    setContent(el('div', {},
      el('p', { style: { color: '#8b949e', fontSize: '12px' } }, L('将当前 DSH 配置打包为 .dshmig 迁移归档（凭据尽力排除+脱敏；未扫描文件见报告）。', 'Pack current DSH config into a .dshmig migration archive (credentials best-effort excluded + redacted; unscanned files listed in the report).')),
      step('①', L('选择产物目录', 'Choose output dir'), [outDirRow]),
      step('②', L('预览导出内容', 'Preview export'), [el('button', { class: 'dshmig-btn', 'data-act': 'preview' }, L('预览导出内容', 'Preview export'))]),
    ))
    const btn = content.querySelector('[data-act="preview"]') as HTMLButtonElement
    btn.addEventListener('click', () => {
      btn.disabled = true
      busy(L('扫描 DSH home…', 'Scanning DSH home'))
      void api('/dsh-migrate/api/export-preview').then((data) => {
        if (!data.ok) { setContent(el('div', {}, errorBox(String(data.error ?? 'unknown')))); return }
        const plan = data.plan as { profiles: string[]; files: unknown[]; totalBytes: number; links: unknown[]; excluded: string[]; warnings: string[] }
        const secrets = data.secretReport as { redactedFields: unknown[]; unscannedFiles?: string[]; unscannedTotal?: number }
        const unscannedCount = secrets.unscannedFiles?.length ?? 0
        const unscannedTotal = secrets.unscannedTotal ?? unscannedCount
        setContent(el('div', {},
          el('h4', {}, L('预览', 'Preview')),
          row(L('profile', 'profile'), plan.profiles.join(', ') || '—'),
          row(L('文件数', 'files'), String(plan.files.length)),
          row(L('总大小', 'total'), fmtBytes(plan.totalBytes)),
          row(L('link 依赖', 'link deps'), String(plan.links.length)),
          row(L('排除项', 'excluded'), plan.excluded.join(', ') || '—'),
          row(L('脱敏字段', 'redacted'), String(secrets.redactedFields.length)),
          row(L('未扫描文件', 'unscanned'), unscannedTotal > 0 ? String(unscannedTotal) + (unscannedCount < unscannedTotal ? L('（列表截断）', ' (list truncated)') : '') : '0'),
          ...(unscannedCount > 0 ? [el('div', { style: { color: '#d29922', fontSize: '12px', padding: '2px 0' } }, L('以下文件未做凭据扫描：', 'Files not scanned for secrets: ') + (secrets.unscannedFiles as string[]).slice(0, 5).join(', ') + (unscannedCount > 5 ? ' …' : ''))] : []),
          ...(plan.warnings.length ? [el('div', { style: { color: '#d29922', padding: '4px 0' } }, '⚠ ' + plan.warnings.join('; '))] : []),
          step('③', L('执行导出', 'Run export'), [el('button', { class: 'dshmig-btn dshmig-btn-primary', 'data-act': 'run-export', style: { margin: '4px 0' } }, L('执行导出', 'Run export'))]),
        ))
        const run = content.querySelector('[data-act="run-export"]') as HTMLButtonElement
        run.addEventListener('click', () => {
          if (!window.confirm(L(`确认打包 ${plan.files.length} 个文件（${fmtBytes(plan.totalBytes)}）？`, `Export ${plan.files.length} files (${fmtBytes(plan.totalBytes)})?`))) return
          run.disabled = true
          busy(L('打包中…', 'Packaging'))
          const outDir = outDirInput.value.trim() || undefined // outDirInput 仍在闭包中，值保留
          void api('/dsh-migrate/api/export', { outDir }).then((r2) => {
            if (!r2.ok) { setContent(el('div', {}, errorBox(String(r2.error ?? 'unknown')))); return }
            const m = r2.manifest as { files: unknown[]; links: unknown[] }
            setContent(el('div', {},
              okBox(L('导出完成', 'Export complete')),
              row(L('产物路径', 'artifact path'), String(r2.artifactPath)),
              el('button', { class: 'dshmig-btn', 'data-act': 'copy', style: { margin: '2px 0 10px' } }, L('复制路径', 'Copy path')),
              row(L('文件数', 'files'), String(m.files.length) + L(' 个文件（profile 配置 + settings + 预设 + vendor 包）', ' files (profile config + settings + presets + vendor packages)')),
              row(L('link 依赖', 'links'), String(m.links.length)),
              el('h4', { style: { marginTop: '10px' } }, L('下一步：在目标机还原', 'Next: restore on the target machine')),
              el('ol', { style: { paddingLeft: '20px', lineHeight: '1.7', color: '#e6edf3' } },
                el('li', {}, L('把这个 .dshmig 文件复制到目标机（U 盘 / 网盘 / scp 均可）——凭据已尽力排除或脱敏（请核对上方脱敏/未扫描报告）；归档仅导入你信任的来源', 'Copy this .dshmig file to the target machine (USB / cloud / scp) — credentials are best-effort excluded or redacted (review the redaction/unscanned report above); only import archives from sources you trust')),
                el('li', {}, L('目标机打开 DSH → 设置 → 迁移 → 导入 选项卡', 'On the target machine: DSH → Settings → Migration → Import tab')),
                el('li', {}, L('粘贴文件路径 → ① 预检 → 确认步骤 → ② 执行导入', 'Paste the path → ① Preflight → confirm steps → ② Run import')),
              ),
            ))
            const copyBtn = content.querySelector('[data-act="copy"]') as HTMLButtonElement
            copyBtn.addEventListener('click', () => {
              const path = String(r2.artifactPath)
              const done = (): void => { copyBtn.textContent = L('已复制 ✓', 'Copied ✓') }
              if (navigator.clipboard?.writeText) {
                navigator.clipboard.writeText(path).then(done).catch(() => done())
              } else {
                const ta = document.createElement('textarea')
                ta.value = path
                document.body.append(ta)
                ta.select()
                document.execCommand('copy')
                ta.remove()
                done()
              }
            })
          }).catch((e) => setContent(el('div', {}, errorBox(String(e)))))
        })
      }).catch((e) => setContent(el('div', {}, errorBox(String(e)))))
    })
  }

  // ── 导入向导 ──
  const importView = (): void => {
    const pathInput = el('input', {
      type: 'text', class: 'dshmig-input', placeholder: L('.dshmig 归档路径', '.dshmig archive path'),
      style: { width: '70%' },
    }) as HTMLInputElement
    const fileInput = el('input', { type: 'file', accept: '.dshmig', style: { display: 'none' } }) as HTMLInputElement
    let selectedFile: File | null = null
    let selectedData: string | null = null // base64（预检时算好，执行复用）
    const fileLabel = el('span', { style: { color: '#8b949e', fontSize: '12px' } }, '')
    const chooseBtn = el('button', { class: 'dshmig-btn' }, L('📁 选择文件…', '📁 Choose file…'))
    chooseBtn.addEventListener('click', () => fileInput.click())
    fileInput.addEventListener('change', () => {
      selectedFile = fileInput.files?.[0] ?? null
      selectedData = null
      fileLabel.textContent = selectedFile
        ? L('已选择：', 'Selected: ') + selectedFile.name
        : ''
    })
    const bodyFor = (): Record<string, unknown> => (selectedData ? { archiveData: selectedData } : { archive: pathInput.value.trim() })
    const view = el('div', {},
      el('p', { style: { color: '#8b949e', fontSize: '12px' } }, L('导入为新建 profile（<name>-migrated），失败自动回滚。', 'Imports into a NEW profile (<name>-migrated); automatic rollback on failure.')),
      step('①', L('选择 .dshmig 文件', 'Choose the .dshmig file'), [
        el('div', { style: { display: 'flex', gap: '8px', margin: '2px 0', alignItems: 'center' } }, fileInput, chooseBtn, fileLabel),
        el('div', { style: { display: 'flex', gap: '8px', margin: '6px 0', alignItems: 'center' } },
          pathInput, el('span', { style: { color: '#8b949e', fontSize: '12px' } }, L('或直接粘贴路径', 'or paste a path'))),
      ]),
      step('②', L('预检', 'Preflight'), [el('button', { class: 'dshmig-btn', 'data-act': 'preflight' }, L('预检归档', 'Preflight archive'))]),
    )
    setContent(view)
    const btn = view.querySelector('[data-act="preflight"]') as HTMLButtonElement
    btn.addEventListener('click', async () => {
      const archive = pathInput.value.trim()
      if (!selectedFile && !archive) return
      btn.disabled = true
      busy(L('预检归档…', 'Preflighting'))
      try {
        if (selectedFile && !selectedData) selectedData = await fileToBase64(selectedFile)
        const data = await api('/dsh-migrate/api/import-dryrun', bodyFor())
        const plan = data.plan as { newProfile: string; checks: { name: string; ok: boolean; detail?: string }[]; steps: string[]; warnings: string[] } | undefined
        // 预检失败但 plan 存在（checks 明细可展示）→ 显示错误行 + 逐项明细；plan 缺失才用纯错误页
        if (!plan) {
          setContent(el('div', {}, errorBox(String(data.error ?? 'unknown')), el('button', { class: 'dshmig-btn', 'data-act': 'back', style: { marginTop: '8px' } }, L('返回', 'Back'))))
          content.querySelector('[data-act="back"]')!.addEventListener('click', importView)
          return
        }
        const allOk = plan.checks.every((c) => c.ok)
        const fatal = plan.checks.filter((c) => !c.ok)
        const sr = data.secretReport as { redactedFields?: unknown[]; unscannedFiles?: string[]; unscannedTotal?: number } | undefined
        const unscannedCount = sr?.unscannedFiles?.length ?? 0
        const unscannedTotal = sr?.unscannedTotal ?? unscannedCount
        setContent(el('div', {},
          el('h4', {}, L('预检结果', 'Preflight')),
          ...(fatal.length > 0
            ? [el('div', { style: { color: '#f85149', padding: '6px 0', fontWeight: 600 } }, L('✗ 预检未通过：', '✗ Preflight failed: ') + fatal.map((c) => c.name).join(', '))]
            : []),
          row(L('新 profile', 'new profile'), plan.newProfile),
          ...plan.checks.map((c) => el('div', { style: { color: c.ok ? '#3fb950' : '#f85149', padding: '2px 0' } },
            `${c.ok ? '✓' : '✗'} ${c.name}${c.detail ? ' — ' + c.detail : ''}`)),
          ...(sr && unscannedTotal > 0 ? [row(L('未扫描文件', 'unscanned'), String(unscannedTotal) + (unscannedCount < unscannedTotal ? L('（列表截断）', ' (truncated)') : ''))] : []),
          ...(plan.warnings.length ? [el('div', { style: { color: '#d29922', padding: '4px 0' } }, '⚠ ' + plan.warnings.join('; '))] : []),
          ...(allOk ? [
            el('h4', { style: { marginTop: '10px' } }, L('将执行的步骤', 'Steps')),
            ...plan.steps.map((s) => el('div', { style: { padding: '1px 0', color: '#8b949e' } }, '· ' + s)),
            step('③', L('执行导入', 'Run import'), [el('button', { class: 'dshmig-btn dshmig-btn-primary', 'data-act': 'run-import', style: { margin: '4px 0' } }, L('执行导入', 'Run import'))]),
          ] : [
            el('div', { style: { margin: '10px 0' } }, el('button', { class: 'dshmig-btn', 'data-act': 'back2', style: { marginRight: '8px' } }, L('返回', 'Back'))),
          ]),
        ))
        const back2 = content.querySelector('[data-act="back2"]')
        if (back2) back2.addEventListener('click', importView)
        const run = content.querySelector('[data-act="run-import"]') as HTMLButtonElement | null
        if (!run) return
        run.addEventListener('click', () => {
          const stepsText = plan.steps.map((s) => '· ' + s).join('\n')
          if (!window.confirm(L(
            `⚠ 导入归档 = 执行其中的插件代码与安装脚本（pnpm 默认 --ignore-scripts，但 bundle 插件仍会被解析/加载）。仅导入你信任的来源！\n\n将导入到新 profile「${plan.newProfile}」并执行：\n${stepsText}\n\n继续？`,
            `⚠ Importing an archive EXECUTES the plugin code and install scripts it contains (pnpm uses --ignore-scripts by default, but bundle plugins are still parsed/loaded). Only import archives from sources you trust!\n\nImport into new profile "${plan.newProfile}":\n${stepsText}\n\nProceed?`))) return
          run.disabled = true
          busy(L('导入中（含 pnpm install，可能较久）…', 'Importing (pnpm install may take a while)'))
          void api('/dsh-migrate/api/import', bodyFor()).then((r2) => {
            const result = el('div', {}, el('h4', {}, L('导入结果', 'Result')))
            if (!r2.ok) {
              result.append(errorBox(String(r2.error ?? 'unknown')))
              if (Array.isArray(r2.rollback)) result.append(el('div', { style: { color: '#8b949e', padding: '4px 0' } }, L('回滚：', 'Rollback: ') + (r2.rollback as string[]).join('; ')))
            } else {
              result.append(okBox(L('导入完成', 'Import complete')))
              result.append(row(L('新 profile', 'new profile'), String((r2.plan as { newProfile: string }).newProfile)))
              result.append(row(L('备份目录', 'backup'), String(r2.backupDir)))
              const verify = r2.verify as { level: number; name: string; ok: boolean; skipped?: boolean; detail?: string }[]
              for (const v of verify) {
                result.append(el('div', { style: { color: v.ok ? '#3fb950' : '#f85149', padding: '2px 0' } },
                  `${v.ok ? '✓' : v.skipped ? '○' : '✗'} L${v.level} ${v.name}${v.detail ? ' — ' + v.detail : ''}`))
              }
              result.append(el('p', { style: { color: '#8b949e', fontSize: '12px', paddingTop: '6px' } },
                L('验证通过后可手动切换默认 profile 使用；备份目录确认无误后可手动清理。', 'Switch the default profile manually after verification; clean up the backup dir once confirmed.')))
            }
            setContent(result)
          }).catch((e) => setContent(el('div', {}, errorBox(String(e)))))
        })
      } catch (e) {
        setContent(el('div', {}, errorBox(String(e))))
      }
    })
  }

  const switchTab = (active: 'export' | 'import'): void => {
    tabs.textContent = ''
    for (const [id, label] of [['export', L('导出', 'Export')], ['import', L('导入', 'Import')]] as const) {
      const t = el('button', { class: 'dshmig-tab' + (active === id ? ' dshmig-tab-active' : '') }, label)
      t.addEventListener('click', () => { if (id !== active) switchTab(id) })
      tabs.append(t)
    }
    if (active === 'export') { exportView() } else { importView() }
  }

  root.append(tabs, content)
  switchTab('export')
  return root
}

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.slots.inject('settings.section', () =>
    ctx.slots.register({
      name: 'settings.section',
      id: 'migrate',
      order: 50,
      label: L('迁移', 'Migration'),
    }, () => h('div', {
      style: { width: '100%' },
      ref: (el: HTMLDivElement | null) => {
        // react 壳：把原生 DOM 面板挂进 react 元素（契约要求 component 为 react 元素工厂）
        if (el && !el.dataset.dshMigrate) {
          el.dataset.dshMigrate = '1'
          el.appendChild(createPanel())
        }
      },
    })),
  ), 'dsh-migrate: settings section')
}
