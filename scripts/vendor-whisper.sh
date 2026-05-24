#!/usr/bin/env bash
# Vendor whisper.cpp into resources/whisper/ so the .app ships with a fully
# self-contained voice-transcription stack — no Homebrew, no Python, no
# downloads on user machines.
#
# Produces:
#   resources/whisper/
#     bin/whisper-server           statically-linked native binary
#     models/ggml-tiny.bin         ~75 MB multilingual transcription model
#     .vendored-version            commit SHA of whisper.cpp used
#
# The Homebrew `whisper-server` binary is NOT usable because it dynamically
# links to /opt/homebrew/opt/ggml/lib/libggml*.dylib — hardcoded absolute
# paths that don't exist on a user machine. We build from source with
# BUILD_SHARED_LIBS=OFF so libwhisper + libggml are statically linked into
# whisper-server and the only remaining dyld refs are macOS system libs
# (libc++, libSystem) which every Mac has.
#
# Idempotent: skips the build if the right whisper.cpp version is already
# vendored. Bump with WHISPER_CPP_REF=<tag/sha> npm run vendor-whisper.
# Force a rebuild with FORCE=1.

set -euo pipefail

WHISPER_CPP_REF="${WHISPER_CPP_REF:-v1.8.3}"
MODEL_NAME="${WHISPER_MODEL:-tiny}"      # 'tiny' (~75MB) | 'base' (~150MB)
MODEL_URL_BASE='https://huggingface.co/ggerganov/whisper.cpp/resolve/main'

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DEST_DIR="$ROOT_DIR/resources/whisper"
INSTALLED_VERSION_FILE="$DEST_DIR/.vendored-version"

# Skip if already at the right version.
if [[ "${FORCE:-0}" != "1" && -f "$INSTALLED_VERSION_FILE" && -x "$DEST_DIR/bin/whisper-server" && -f "$DEST_DIR/models/ggml-${MODEL_NAME}.bin" ]]; then
  CURRENT="$(cat "$INSTALLED_VERSION_FILE")"
  if [[ "$CURRENT" == "$WHISPER_CPP_REF" ]]; then
    echo "vendor-whisper: already vendored ($CURRENT, model=$MODEL_NAME) — nothing to do."
    exit 0
  fi
  echo "vendor-whisper: have $CURRENT, want $WHISPER_CPP_REF — rebuilding."
fi

# Pre-flight: need cmake + a C++ compiler. Most macs have it (Xcode CLT).
if ! command -v cmake >/dev/null 2>&1; then
  echo "vendor-whisper: ERROR — cmake not found. Install with:" >&2
  echo "  brew install cmake" >&2
  echo "  or download from https://cmake.org/download/" >&2
  exit 1
fi

if ! command -v c++ >/dev/null 2>&1 && ! command -v g++ >/dev/null 2>&1; then
  echo "vendor-whisper: ERROR — no C++ compiler. Install Xcode CLT with:" >&2
  echo "  xcode-select --install" >&2
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "vendor-whisper: ERROR — curl not found." >&2
  exit 1
fi

echo "vendor-whisper: building whisper.cpp@$WHISPER_CPP_REF (model=$MODEL_NAME)..."

# ─── Clone whisper.cpp ──────────────────────────────────────────────────
TMP_DIR="$(mktemp -d -t rax-vendor-whisper.XXXXXX)"
trap 'rm -rf "$TMP_DIR"' EXIT

SRC_DIR="$TMP_DIR/whisper.cpp"
# Use tarball (faster than git clone, no .git overhead).
TARBALL_URL="https://github.com/ggml-org/whisper.cpp/archive/refs/tags/$WHISPER_CPP_REF.tar.gz"
echo "vendor-whisper: downloading $TARBALL_URL..."

if ! curl -fsSL -o "$TMP_DIR/src.tgz" "$TARBALL_URL" 2>/dev/null; then
  # Fall back to treating WHISPER_CPP_REF as a commit SHA.
  TARBALL_URL="https://github.com/ggml-org/whisper.cpp/archive/$WHISPER_CPP_REF.tar.gz"
  echo "vendor-whisper: tag not found, trying commit URL $TARBALL_URL..."
  curl -fsSL -o "$TMP_DIR/src.tgz" "$TARBALL_URL"
fi

mkdir -p "$SRC_DIR"
tar -xzf "$TMP_DIR/src.tgz" -C "$SRC_DIR" --strip-components=1

# ─── Build with static linking ──────────────────────────────────────────
BUILD_DIR="$SRC_DIR/build"
mkdir -p "$BUILD_DIR"

# Notes on flags:
#   BUILD_SHARED_LIBS=OFF      — produce static libs; no dylib RPATH headache.
#   WHISPER_BUILD_SERVER=ON    — opt in to the HTTP server target.
#   WHISPER_BUILD_TESTS=OFF    — skip tests, ~30s faster.
#   WHISPER_BUILD_EXAMPLES=OFF — skip benchmark/quantize/etc, smaller bundle.
#   GGML_METAL=ON              — Apple Silicon GPU acceleration (no-op on Intel).
#   CMAKE_BUILD_TYPE=Release   — optimized binary.
echo "vendor-whisper: configuring cmake..."
cmake -S "$SRC_DIR" -B "$BUILD_DIR" \
  -DCMAKE_BUILD_TYPE=Release \
  -DBUILD_SHARED_LIBS=OFF \
  -DWHISPER_BUILD_SERVER=ON \
  -DWHISPER_BUILD_TESTS=OFF \
  -DWHISPER_BUILD_EXAMPLES=ON \
  -DGGML_METAL=ON \
  -DGGML_METAL_EMBED_LIBRARY=ON \
  > "$TMP_DIR/cmake.log" 2>&1

NPROC="$(sysctl -n hw.logicalcpu 2>/dev/null || echo 4)"
echo "vendor-whisper: compiling (-j$NPROC)..."
cmake --build "$BUILD_DIR" --target whisper-server -j "$NPROC" > "$TMP_DIR/build.log" 2>&1 || {
  echo "vendor-whisper: build failed. Last 40 lines of build log:" >&2
  tail -40 "$TMP_DIR/build.log" >&2
  exit 1
}

# ─── Locate the produced binary ─────────────────────────────────────────
SERVER_BIN=""
for candidate in \
  "$BUILD_DIR/bin/whisper-server" \
  "$BUILD_DIR/examples/server/whisper-server" \
  "$BUILD_DIR/server/whisper-server"; do
  if [[ -f "$candidate" ]]; then
    SERVER_BIN="$candidate"
    break
  fi
done

if [[ -z "$SERVER_BIN" ]]; then
  echo "vendor-whisper: ERROR — could not find built whisper-server binary." >&2
  echo "Build dir layout:" >&2
  find "$BUILD_DIR" -name "whisper-server*" -type f 2>/dev/null >&2 || true
  exit 1
fi

# Sanity: confirm the binary doesn't link to /opt/homebrew dylibs.
if otool -L "$SERVER_BIN" 2>/dev/null | grep -q '/opt/homebrew\|/usr/local/opt'; then
  echo "vendor-whisper: ERROR — built binary still links to Homebrew dylibs:" >&2
  otool -L "$SERVER_BIN" | grep -E '/opt/homebrew|/usr/local/opt' >&2
  echo "Try a clean rebuild with FORCE=1, or check that BUILD_SHARED_LIBS=OFF took effect." >&2
  exit 1
fi

# ─── Place binary + model into resources/ ───────────────────────────────
rm -rf "$DEST_DIR"
mkdir -p "$DEST_DIR/bin" "$DEST_DIR/models"

cp "$SERVER_BIN" "$DEST_DIR/bin/whisper-server"
chmod +x "$DEST_DIR/bin/whisper-server"
strip "$DEST_DIR/bin/whisper-server" 2>/dev/null || true

MODEL_FILE="$DEST_DIR/models/ggml-${MODEL_NAME}.bin"
MODEL_URL="${MODEL_URL_BASE}/ggml-${MODEL_NAME}.bin"
echo "vendor-whisper: downloading model ggml-${MODEL_NAME}.bin (this can take a minute)..."
curl -fL --progress-bar -o "$MODEL_FILE" "$MODEL_URL"

# Persist version marker.
printf '%s' "$WHISPER_CPP_REF" > "$INSTALLED_VERSION_FILE"

# Print final summary.
BIN_SIZE="$(du -h "$DEST_DIR/bin/whisper-server" | awk '{print $1}')"
MODEL_SIZE="$(du -h "$MODEL_FILE" | awk '{print $1}')"
echo "vendor-whisper: done"
echo "  binary: $DEST_DIR/bin/whisper-server ($BIN_SIZE, statically linked)"
echo "  model : $MODEL_FILE ($MODEL_SIZE)"
echo "  refs  : $(otool -L "$DEST_DIR/bin/whisper-server" | tail -n +2 | wc -l | tr -d ' ') dyld libs (system only)"
