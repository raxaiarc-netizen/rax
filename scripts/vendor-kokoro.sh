#!/usr/bin/env bash
# Vendor the Kokoro-82M ONNX model into resources/kokoro-cache/ so the
# packaged DMG can speak offline on first launch with no HuggingFace
# network round-trip.
#
# Produces:
#   resources/kokoro-cache/
#     onnx-community/
#       Kokoro-82M-v1.0-ONNX/
#         tokenizer_config.json
#         config.json
#         tokenizer.json
#         onnx/
#           model_quantized.onnx        (~83 MB at q8)
#     .vendored-version                 marker file
#
# Runtime behavior:
#   - The orb's `local-tts.ts` points transformers.js's `env.cacheDir` at
#     `process.resourcesPath/kokoro-cache` in production (or the in-repo
#     copy in dev) and sets `env.allowRemoteModels = false` for packaged
#     builds. So if this script didn't run, packaged orb stays silent —
#     which is why electron-builder's `predist` hook chains us in.
#
# Idempotent: skips if marker matches model/dtype. Force a re-fetch with
# FORCE=1.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CACHE_DIR="$ROOT_DIR/resources/kokoro-cache"
MARKER="$CACHE_DIR/.vendored-version"

MODEL_ID="${VENDOR_KOKORO_MODEL:-onnx-community/Kokoro-82M-v1.0-ONNX}"
# q8 = ~83 MB and sounds indistinguishable from fp32 for orb-length
# utterances. Override if you want to ship the fp16 model (~165 MB) for
# slightly higher quality at higher bundle cost.
DTYPE="${VENDOR_KOKORO_DTYPE:-q8}"

MARKER_CONTENT="$MODEL_ID|$DTYPE"

# ─── Skip-if-already-vendored fast path ───────────────────────────────────
if [[ "${FORCE:-0}" != "1" && -f "$MARKER" ]]; then
  CURRENT="$(cat "$MARKER")"
  if [[ "$CURRENT" == "$MARKER_CONTENT" ]]; then
    SIZE="$(du -sh "$CACHE_DIR" 2>/dev/null | awk '{print $1}')"
    echo "vendor-kokoro: already vendored ($MODEL_ID @ $DTYPE, $SIZE) — nothing to do."
    exit 0
  fi
  echo "vendor-kokoro: marker mismatch (have='$CURRENT', want='$MARKER_CONTENT') — re-vendoring."
fi

# ─── Pre-flight ───────────────────────────────────────────────────────────
if ! command -v node >/dev/null 2>&1; then
  echo "vendor-kokoro: ERROR — node not found." >&2
  exit 1
fi

# kokoro-js + @huggingface/transformers come from the repo's node_modules.
# `postinstall` (in package.json) runs us after `npm install`, so the deps
# are already on disk. Refuse to run if they aren't — easier to diagnose
# than a cryptic Node import error.
if [[ ! -d "$ROOT_DIR/node_modules/kokoro-js" ]]; then
  echo "vendor-kokoro: ERROR — node_modules/kokoro-js missing. Run \`npm install\` first." >&2
  exit 1
fi
if [[ ! -d "$ROOT_DIR/node_modules/@huggingface/transformers" ]]; then
  echo "vendor-kokoro: ERROR — node_modules/@huggingface/transformers missing." >&2
  exit 1
fi

mkdir -p "$CACHE_DIR"
echo "vendor-kokoro: fetching $MODEL_ID @ $DTYPE into $CACHE_DIR ..."

# ─── Drive kokoro-js's loader with our cacheDir override ──────────────────
# Running this populates `$CACHE_DIR/onnx-community/Kokoro-82M-v1.0-ONNX/`
# with everything `from_pretrained` needs at runtime — tokenizer, config,
# and the chosen ONNX model variant. transformers.js downloads what
# `from_pretrained` requests; no extra fetching needed.
cd "$ROOT_DIR"
TARGET_DIR="$CACHE_DIR" MODEL_ID="$MODEL_ID" DTYPE="$DTYPE" node --no-warnings --input-type=module -e "
import { KokoroTTS } from 'kokoro-js'
import * as transformers from '@huggingface/transformers'

transformers.env.cacheDir = process.env.TARGET_DIR
transformers.env.allowRemoteModels = true
transformers.env.useFSCache = true

const t0 = Date.now()
const tts = await KokoroTTS.from_pretrained(process.env.MODEL_ID, {
  dtype: process.env.DTYPE,
  device: 'cpu',
})
console.log(\`vendor-kokoro:   loaded \${Object.keys(tts.voices).length} voices in \${Date.now() - t0} ms\`)
" 2>&1 | tail -40

# ─── Sanity-check the cache layout ────────────────────────────────────────
EXPECTED_DIR="$CACHE_DIR/onnx-community/Kokoro-82M-v1.0-ONNX"
if [[ ! -d "$EXPECTED_DIR" ]]; then
  echo "vendor-kokoro: ERROR — cache directory $EXPECTED_DIR was not created." >&2
  exit 1
fi
ONNX_FILE="$(find "$EXPECTED_DIR/onnx" -name "*.onnx" 2>/dev/null | head -1)"
if [[ -z "$ONNX_FILE" || ! -f "$ONNX_FILE" ]]; then
  echo "vendor-kokoro: ERROR — no .onnx file produced under $EXPECTED_DIR/onnx." >&2
  exit 1
fi

# Smoke test: one synth pass at the bundled cache (with remote loads now
# disabled, so a missing file would error loudly).
echo "vendor-kokoro: smoke-testing offline load + synth ..."
TARGET_DIR="$CACHE_DIR" MODEL_ID="$MODEL_ID" DTYPE="$DTYPE" node --no-warnings --input-type=module -e "
import { KokoroTTS } from 'kokoro-js'
import * as transformers from '@huggingface/transformers'

transformers.env.cacheDir = process.env.TARGET_DIR
transformers.env.allowRemoteModels = false

const tts = await KokoroTTS.from_pretrained(process.env.MODEL_ID, {
  dtype: process.env.DTYPE,
  device: 'cpu',
})
const audio = await tts.generate('Vendor cache works.', { voice: 'af_heart' })
console.log(\`vendor-kokoro:   synth ok — \${audio.audio.length} samples @ \${audio.sampling_rate} Hz\`)
" 2>&1 | tail -10

# ─── Persist marker + summary ─────────────────────────────────────────────
printf '%s' "$MARKER_CONTENT" > "$MARKER"

CACHE_SIZE="$(du -sh "$CACHE_DIR" | awk '{print $1}')"
ONNX_SIZE="$(du -h "$ONNX_FILE" | awk '{print $1}')"
echo "vendor-kokoro: done"
echo "  cache : $CACHE_DIR ($CACHE_SIZE)"
echo "  model : $ONNX_FILE ($ONNX_SIZE)"
echo "  marker: $MARKER ($MARKER_CONTENT)"
