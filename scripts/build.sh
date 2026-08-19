#!/bin/bash
# dsh-migrate build — 两种模式：
#   A. DSH_CHECKOUT 源码 checkout（生态惯例，junction 官方 vendor/packages）
#   B. 降级模式：DSH_NPM_TREE（官方 @deepseek-ai/* npm 包完整安装树，如 npx 缓存 node_modules）
# 探测顺序：DSH_CHECKOUT env → ~/dsh-harness 等常见路径 → DSH_NPM_TREE env → npx 缓存自动探测。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

CHECKOUT="${DSH_CHECKOUT:-}"
if [ -z "$CHECKOUT" ]; then
  for candidate in "$HOME/dsh-harness" "$HOME/dsh" "$HOME/.dsh/dsh-harness"; do
    if [ -d "$candidate/packages" ]; then CHECKOUT="$candidate"; break; fi
  done
fi

NPM_TREE="${DSH_NPM_TREE:-}"
if [ -z "$CHECKOUT" ] && [ -z "$NPM_TREE" ]; then
  for base in "$HOME/AppData/Local/npm-cache/_npx"/*/node_modules; do
    if [ -d "$base/@deepseek-ai/dsh-tools" ]; then NPM_TREE="$base"; break; fi
  done
fi

if [ -n "$CHECKOUT" ]; then
  echo "=== Build mode A: dsh source checkout ($CHECKOUT) ==="
  SRC_CORDIS="$CHECKOUT/vendor/cordis"
  SRC_COSMOKIT="$CHECKOUT/vendor/cosmokit"
  SRC_SCHEMASTERY="$CHECKOUT/vendor/schemastery"
  SRC_DTOOLS="$CHECKOUT/packages/core/tools"
  SRC_HOMEPATHS="$CHECKOUT/packages/util/home-paths"
  SRC_SLOTS="$CHECKOUT/packages/client/ui-slots"
  TSC="$CHECKOUT/node_modules/.bin/tsc"
elif [ -n "$NPM_TREE" ]; then
  echo "=== Build mode B: npm tree fallback ($NPM_TREE) ==="
  SRC_CORDIS="$NPM_TREE/@deepseek-ai/cordis"
  SRC_COSMOKIT="$NPM_TREE/@deepseek-ai/cosmokit"
  SRC_SCHEMASTERY="$NPM_TREE/@deepseek-ai/schemastery"
  SRC_DTOOLS="$NPM_TREE/@deepseek-ai/dsh-tools"
  SRC_HOMEPATHS="$NPM_TREE/@deepseek-ai/dsh-home-paths"
  SRC_SLOTS="$NPM_TREE/@deepseek-ai/dsh-client-ui-slots"
  TSC="$ROOT/node_modules/.bin/tsc"
else
  echo "build: cannot locate dsh checkout (set DSH_CHECKOUT) nor npm tree (set DSH_NPM_TREE)" >&2
  exit 1
fi

for src in "$SRC_CORDIS" "$SRC_COSMOKIT" "$SRC_SCHEMASTERY" "$SRC_DTOOLS" "$SRC_HOMEPATHS" "$SRC_SLOTS"; do
  if [ ! -e "$src" ]; then
    echo "build: dependency target missing: $src" >&2
    exit 1
  fi
done
if [ ! -x "$TSC" ] && [ ! -f "$TSC.cmd" ]; then
  echo "build: tsc not found at $TSC (run npm install first in fallback mode)" >&2
  exit 1
fi

link_pkg() {
  node -e "
    const fs = require('fs');
    const path = require('path');
    const link = path.resolve(process.argv[1]);
    const target = path.resolve(process.argv[2]);
    fs.rmSync(link, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  " "node_modules/$1" "$2"
}

echo "=== Linking build dependencies ==="
mkdir -p node_modules/@deepseek-ai
link_pkg cordis "$SRC_CORDIS"
link_pkg cosmokit "$SRC_COSMOKIT"
link_pkg schemastery "$SRC_SCHEMASTERY"
link_pkg @deepseek-ai/dsh-tools "$SRC_DTOOLS"
link_pkg @deepseek-ai/dsh-home-paths "$SRC_HOMEPATHS"
link_pkg @deepseek-ai/dsh-client-ui-slots "$SRC_SLOTS"

echo "=== Compiling src → lib ==="
"$TSC" -p tsconfig.json
echo "=== Build complete ==="
