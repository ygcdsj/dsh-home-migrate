// dsh-migrate build：junction 官方依赖 → tsc 编译 host → tsdown 编译 client。
// 不依赖 bash（本机无 Git Bash 时的标准入口；有 bash 的环境仍可用 scripts/build.sh）。
// 依赖源探测：DSH_CHECKOUT（源码 checkout，生态惯例）→ ~/dsh-harness 等 → _npx 缓存官方包树（npm 形态降级）。
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const NM = join(ROOT, 'node_modules')

function detectSource() {
  const env = process.env.DSH_CHECKOUT
  if (env && existsSync(join(env, 'packages'))) return { kind: 'checkout', root: env }
  for (const c of [join(homedir(), 'dsh-harness'), join(homedir(), 'dsh'), join(homedir(), '.dsh', 'dsh-harness')]) {
    if (existsSync(join(c, 'packages'))) return { kind: 'checkout', root: c }
  }
  const npxRoot = join(homedir(), 'AppData', 'Local', 'npm-cache', '_npx')
  if (existsSync(npxRoot)) {
    for (const d of readdirSync(npxRoot)) {
      const base = join(npxRoot, d, 'node_modules')
      if (existsSync(join(base, '@deepseek-ai', 'dsh-tools'))) return { kind: 'npm', root: base }
    }
  }
  return null
}

const src = detectSource()
if (!src) {
  console.error('build: cannot locate dsh checkout (DSH_CHECKOUT) nor npm tree (_npx cache)')
  process.exit(1)
}
console.log(`=== build: ${src.kind} mode (${src.root}) ===`)

// 依赖名 → [checkout 相对路径, npm 树相对路径]
const DEPS = {
  'cordis': ['vendor/cordis', '@deepseek-ai/cordis'],
  'cosmokit': ['vendor/cosmokit', '@deepseek-ai/cosmokit'],
  'schemastery': ['vendor/schemastery', '@deepseek-ai/schemastery'],
  '@deepseek-ai/dsh-tools': ['packages/core/tools', '@deepseek-ai/dsh-tools'],
  '@deepseek-ai/dsh-home-paths': ['packages/util/home-paths', '@deepseek-ai/dsh-home-paths'],
  '@deepseek-ai/dsh-client-ui-slots': ['packages/client/ui-slots', '@deepseek-ai/dsh-client-ui-slots'],
}

function linkPkg(dep, target) {
  const link = join(NM, dep)
  const absTarget = resolve(target)
  rmSync(link, { recursive: true, force: true })
  mkdirSync(dirname(link), { recursive: true })
  symlinkSync(absTarget, link, process.platform === 'win32' ? 'junction' : 'dir')
}

console.log('=== linking build dependencies ===')
mkdirSync(join(NM, '@deepseek-ai'), { recursive: true })
for (const [dep, rels] of Object.entries(DEPS)) {
  const target = src.kind === 'checkout' ? join(src.root, rels[0]) : join(src.root, rels[1])
  if (!existsSync(target)) {
    console.error(`build: dependency target missing: ${target}`)
    process.exit(1)
  }
  linkPkg(dep, target)
  console.log(`  link ${dep} -> ${target}`)
}

function run(cmd, args, { shell = false } = {}) {
  console.log(`=== ${cmd} ${args.join(' ')}`)
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', shell })
  if (r.status !== 0) process.exit(r.status ?? 1)
}

console.log('=== compiling src → lib (tsc) ===')
const tscJs = join(NM, 'typescript', 'bin', 'tsc')
run(process.execPath, [tscJs, '-p', 'tsconfig.json'])

console.log('=== building client (tsdown) ===')
run('npm', ['run', 'build:client'], { shell: true })

console.log('=== build complete ===')
