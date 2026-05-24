#!/usr/bin/env bash
# Vendor the @anthropic-ai/claude-code npm package into resources/claude-cli/
# so the .app ships with its own isolated Claude Code CLI.
#
# Idempotent: skips the download if the right version is already present.
# Re-run to bump: `CLAUDE_CLI_VERSION=2.1.140 npm run vendor-claude`.
#
# After this completes, `resources/claude-cli/` contains:
#   package.json          (the published package manifest)
#   <bin/cli.js>          (the JS entry the bin field points at)
#   entry.json            (cached path to the entry relative to claude-cli/)
#   ...plus any runtime deps the entry requires
#
# Read at runtime by src/main/claude/claude-instance.ts.

set -euo pipefail

PKG_NAME='@anthropic-ai/claude-code'
PKG_VERSION="${CLAUDE_CLI_VERSION:-latest}"
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DEST_DIR="$ROOT_DIR/resources/claude-cli"
INSTALLED_VERSION_FILE="$DEST_DIR/.vendored-version"

# Skip download if already at the right version (and not forced).
if [[ "${FORCE:-0}" != "1" && -f "$INSTALLED_VERSION_FILE" ]]; then
  CURRENT="$(cat "$INSTALLED_VERSION_FILE")"
  if [[ "$PKG_VERSION" == "latest" ]]; then
    # If user asked for latest and we have *some* version vendored, keep it
    # (avoid network on every install). Force with FORCE=1 to refresh.
    echo "vendor-claude: already vendored (version $CURRENT). Set FORCE=1 to refresh."
    exit 0
  fi
  if [[ "$CURRENT" == "$PKG_VERSION" ]]; then
    echo "vendor-claude: already at $CURRENT, nothing to do."
    exit 0
  fi
fi

# Resolve target version + tarball URL from npm registry.
echo "vendor-claude: resolving $PKG_NAME@$PKG_VERSION from npm…"
RESOLVED_JSON="$(npm view "$PKG_NAME@$PKG_VERSION" version dist.tarball --json 2>/dev/null || true)"
if [[ -z "$RESOLVED_JSON" ]]; then
  echo "vendor-claude: ERROR — could not fetch package metadata. Are you online? Is npm installed?" >&2
  exit 1
fi

RESOLVED_VERSION="$(printf '%s' "$RESOLVED_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.version||j[0]?.version||"")})')"
TARBALL_URL="$(printf '%s' "$RESOLVED_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j["dist.tarball"]||j[0]?.["dist.tarball"]||"")})')"

if [[ -z "$RESOLVED_VERSION" || -z "$TARBALL_URL" ]]; then
  echo "vendor-claude: ERROR — could not resolve version/tarball for $PKG_NAME@$PKG_VERSION." >&2
  exit 1
fi

echo "vendor-claude: resolved → $RESOLVED_VERSION ($TARBALL_URL)"

# Fresh extract.
rm -rf "$DEST_DIR"
mkdir -p "$DEST_DIR"

TMP_DIR="$(mktemp -d -t rax-vendor-claude.XXXXXX)"
trap 'rm -rf "$TMP_DIR"' EXIT

echo "vendor-claude: downloading tarball…"
curl -fsSL -o "$TMP_DIR/pkg.tgz" "$TARBALL_URL"

echo "vendor-claude: extracting…"
tar -xzf "$TMP_DIR/pkg.tgz" -C "$TMP_DIR"

# npm tarballs extract into a "package/" subdirectory.
if [[ ! -d "$TMP_DIR/package" ]]; then
  echo "vendor-claude: ERROR — unexpected tarball layout (no 'package/' dir)." >&2
  exit 1
fi

# Move contents into DEST_DIR.
cp -R "$TMP_DIR/package/." "$DEST_DIR/"

# Install runtime deps for the vendored CLI (some Claude Code builds have a
# tiny dep tree; some are fully self-contained). --omit=dev keeps the bundle
# small. If there's no package-lock the install is best-effort.
if [[ -f "$DEST_DIR/package.json" ]]; then
  if grep -q '"dependencies"' "$DEST_DIR/package.json"; then
    echo "vendor-claude: installing runtime deps…"
    ( cd "$DEST_DIR" && npm install --omit=dev --no-audit --no-fund --silent ) || \
      echo "vendor-claude: WARN — npm install in vendored dir failed (continuing)."
  fi
fi

# Resolve the entry the bin field points at and pin it in entry.json.
ENTRY_REL="$(node -e '
  const pkg = require("'"$DEST_DIR"'/package.json");
  let bin = pkg.bin;
  let entry = null;
  if (typeof bin === "string") entry = bin;
  else if (bin && typeof bin === "object") entry = bin.claude || bin["claude-code"] || Object.values(bin)[0];
  if (!entry) {
    console.error("vendor-claude: ERROR — package.json has no resolvable bin field"); process.exit(1);
  }
  console.log(entry);
')"

if [[ ! -f "$DEST_DIR/$ENTRY_REL" ]]; then
  echo "vendor-claude: ERROR — bin entry $ENTRY_REL not found in vendored package." >&2
  exit 1
fi

printf '{"entry":"%s"}\n' "$ENTRY_REL" > "$DEST_DIR/entry.json"
printf '%s' "$RESOLVED_VERSION" > "$INSTALLED_VERSION_FILE"

# Strip backing copies that double the DMG size.
#
# The npm wrapper installs a platform-specific package (e.g. claude-code-darwin-arm64)
# whose `claude` binary is hardlinked into bin/claude.exe by the wrapper's
# install.cjs. On disk these are one inode (no waste), but electron-builder
# follows hardlinks when copying into the DMG, so the binary would appear
# twice and double the download size (~400 MB instead of ~200 MB).
#
# We've already cached the bin/ path in entry.json, so the wrapper scripts +
# node_modules are dead weight at runtime.
rm -rf "$DEST_DIR/node_modules" "$DEST_DIR/cli-wrapper.cjs" "$DEST_DIR/install.cjs" "$DEST_DIR/package-lock.json"

# Remove the `prepare` script that blocks any future `npm install` inside the
# vendored dir with the "Direct publishing is not allowed" error.
node -e '
  const fs = require("fs");
  const p = "'"$DEST_DIR"'/package.json";
  const pkg = JSON.parse(fs.readFileSync(p, "utf-8"));
  if (pkg.scripts) {
    delete pkg.scripts.prepare;
    delete pkg.scripts.postinstall;
  }
  fs.writeFileSync(p, JSON.stringify(pkg, null, 2) + "\n");
'

BIN_SIZE="$(du -h "$DEST_DIR/$ENTRY_REL" | awk '{print $1}')"
echo "vendor-claude: done — claude-code@$RESOLVED_VERSION vendored at $DEST_DIR"
echo "  entry: $ENTRY_REL ($BIN_SIZE)"
