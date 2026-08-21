#!/usr/bin/env bash
set -euo pipefail

# DSH_CHECKOUT 自动探测（dev_build_plugin 约定）
if [ -z "${DSH_CHECKOUT:-}" ]; then
  if [ -d "/opt/node/lib/node_modules/@deepseek-ai/dsh" ]; then
    DSH_CHECKOUT="/opt/node/lib/node_modules/@deepseek-ai/dsh"
  elif [ -d "$HOME/.dsh/checkout" ]; then
    DSH_CHECKOUT="$HOME/.dsh/checkout"
  fi
fi
if [ -z "${DSH_CHECKOUT:-}" ] || [ ! -d "$DSH_CHECKOUT" ]; then
  echo "ERROR: DSH_CHECKOUT not found" >&2
  exit 1
fi

PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# 编译期类型解析：peer 包 junction 进包内 node_modules（运行时由 loader 内部解析，不影响）
mkdir -p "$PKG_DIR/node_modules/@deepseek-ai"
for pkg in cordis dsh-llm dsh-credentials dsh-launch-environment dsh-settings dsh-timeout schemastery; do
  src="$DSH_CHECKOUT/node_modules/@deepseek-ai/$pkg"
  dst="$PKG_DIR/node_modules/@deepseek-ai/$pkg"
  if [ -d "$src" ] && [ ! -e "$dst" ]; then ln -s "$src" "$dst" 2>/dev/null || true; fi
done

TSC=""
for c in "$PKG_DIR/node_modules/.bin/tsc" "$DSH_CHECKOUT/node_modules/.bin/tsc" "$DSH_CHECKOUT/node_modules/typescript/bin/tsc" "$(command -v tsc || true)"; do
  if [ -n "$c" ] && [ -e "$c" ]; then TSC="$c"; break; fi
done
[ -n "$TSC" ] || { echo "ERROR: tsc not found" >&2; exit 1; }

echo "[build] dsh-cmdgo-provider — tsc host -> lib/"
node "$TSC" -p "$PKG_DIR/tsconfig.json"

# client.js 是手写的 __ModuleLoader__ bundle，不参与 tsc；确保在 lib/
[ -f "$PKG_DIR/lib/client.js" ] || { echo "ERROR: lib/client.js missing" >&2; exit 1; }
echo "[build] done: lib/index.js + lib/client.js"
