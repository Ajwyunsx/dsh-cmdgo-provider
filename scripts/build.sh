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
# Windows 的 Git Bash 上 ln -s 可能不生效，此时退化为复制（npx/npm 布局下同理）。
mkdir -p "$PKG_DIR/node_modules/@deepseek-ai"
link_dir() {
  src="$1"; dst="$2"
  [ -d "$src" ] || return 0
  [ -e "$dst" ] && return 0
  if ln -s "$src" "$dst" 2>/dev/null && [ -e "$dst" ]; then return 0; fi
  cp -r "$src" "$dst" 2>/dev/null || true
}
for pkg in cordis dsh-llm dsh-credentials dsh-launch-environment dsh-settings dsh-util-values dsh-timeout schemastery; do
  link_dir "$DSH_CHECKOUT/node_modules/@deepseek-ai/$pkg" "$PKG_DIR/node_modules/@deepseek-ai/$pkg"
done
# typescript + @types/node 用来编译：优先包内，其次 checkout / 全局 node_modules（npx 布局）。
for root in "$PKG_DIR/node_modules" "$DSH_CHECKOUT/node_modules" "$HOME/node_modules"; do
  link_dir "$root/typescript" "$PKG_DIR/node_modules/typescript"
  mkdir -p "$PKG_DIR/node_modules/@types"
  link_dir "$root/@types/node" "$PKG_DIR/node_modules/@types/node"
done

# 真正的 tsc 入口必须是「能被 node 执行的 JS」。npm 全局 shim（Windows 上是 shell
# 脚本）用 node 跑会直接语法报错，所以逐个候选实测 `--version` 再采用。
TSC=""
for c in \
  "$PKG_DIR/node_modules/typescript/bin/tsc" \
  "$DSH_CHECKOUT/node_modules/typescript/bin/tsc" \
  "$HOME/node_modules/typescript/bin/tsc" \
  "$PKG_DIR/node_modules/.bin/tsc" \
  "$DSH_CHECKOUT/node_modules/.bin/tsc" \
  "$(command -v tsc || true)"
do
  if [ -n "$c" ] && [ -f "$c" ] && node "$c" --version >/dev/null 2>&1; then TSC="$c"; break; fi
done
[ -n "$TSC" ] || { echo "ERROR: tsc not found（装一个 typescript 到 node_modules，或设 DSH_CHECKOUT 指向含 typescript 的目录）" >&2; exit 1; }

echo "[build] dsh-cmdgo-provider — tsc host -> lib/"
node "$TSC" -p "$PKG_DIR/tsconfig.json"

# client.js 是手写的 __ModuleLoader__ bundle，不参与 tsc；确保在 lib/
[ -f "$PKG_DIR/lib/client.js" ] || { echo "ERROR: lib/client.js missing" >&2; exit 1; }
echo "[build] done: lib/index.js + lib/client.js"
