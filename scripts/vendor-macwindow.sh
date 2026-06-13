#!/usr/bin/env bash
# Build the mac window-behavior N-API addon into resources/native/ so the
# notch / dock / caption pill can opt into NSWindowCollectionBehaviorStationary
# — the collection-behavior flag that keeps an overlay on screen DURING
# Mission Control (Electron's own API only offers transient, which hides it).
#
# Produces:
#   resources/native/mac-window-behavior.node   universal arm64 + x86_64
#
# No node-gyp: the addon is a single ObjC++ file against the stable Node-API
# C surface (node-api-headers devDependency), so one clang invocation with
# `-undefined dynamic_lookup` builds a .node that loads in any Electron/Node.
#
# Idempotent: skips when the output is newer than the source. Force with
# FORCE=1.

set -euo pipefail

if [[ "$(uname)" != "Darwin" ]]; then
  echo "vendor-macwindow: not macOS, skipping"
  exit 0
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/native/mac-window-behavior.mm"
OUT_DIR="$ROOT/resources/native"
OUT="$OUT_DIR/mac-window-behavior.node"
HEADERS="$ROOT/node_modules/node-api-headers/include"

if [[ ! -f "$HEADERS/node_api.h" ]]; then
  echo "vendor-macwindow: node-api-headers not installed (npm install first)" >&2
  exit 1
fi

if [[ "${FORCE:-0}" != "1" && -f "$OUT" && "$OUT" -nt "$SRC" ]]; then
  echo "vendor-macwindow: $OUT up to date"
  exit 0
fi

mkdir -p "$OUT_DIR"

clang++ -x objective-c++ -std=c++17 -fobjc-arc \
  -arch arm64 -arch x86_64 \
  -I"$HEADERS" \
  -bundle -undefined dynamic_lookup \
  -framework AppKit \
  -o "$OUT" "$SRC"

echo "vendor-macwindow: built $OUT ($(lipo -archs "$OUT"))"
