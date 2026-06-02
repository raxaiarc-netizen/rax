/**
 * electron-builder afterPack hook — hard gate against shipping a binary-less
 * Claude Code bundle.
 *
 * v1.1.0 shipped with resources/claude-cli/ present but bin/claude.exe missing
 * (the vendor step was skipped on a stale .vendored-version), so every install
 * threw "Bundled Claude Code not found". This hook makes that failure mode
 * impossible: it inspects the freshly-packed .app, resolves the CLI entry the
 * same way the runtime does (entry.json → package.json bin), and throws if the
 * file is absent or implausibly small — which aborts the whole build/publish.
 *
 * Wired via package.json build.afterPack.
 */
const fs = require('fs')
const path = require('path')

// Anything smaller than this clearly isn't the real ~200MB CLI binary.
const MIN_ENTRY_BYTES = 1_000_000

module.exports = async function afterPack(context) {
  const { appOutDir, packager } = context
  const productName = packager.appInfo.productFilename
  const resourcesDir = path.join(appOutDir, `${productName}.app`, 'Contents', 'Resources')
  const cliDir = path.join(resourcesDir, 'claude-cli')

  if (!fs.existsSync(cliDir)) {
    throw new Error(`[verify-bundled-cli] claude-cli/ missing from packed app at ${cliDir}. Run "npm run vendor-claude" before building.`)
  }

  // ── Vendored model assets that ship as big gitignored files. Each has bitten
  //    us: a stale .vendored-version with the real weights missing ships a
  //    bundle that looks complete but can't run. Walk each tree and require at
  //    least one file over a size floor so an empty/metadata-only dir fails the
  //    build (claude-cli verified separately below via its entry binary).
  const heavyAssets = [
    { dir: 'kokoro-cache', ext: '.onnx', minBytes: 5_000_000, fix: 'FORCE=1 npm run vendor-kokoro' },
    { dir: 'whisper',      ext: '.bin',  minBytes: 5_000_000, fix: 'FORCE=1 npm run vendor-whisper' },
  ]
  for (const asset of heavyAssets) {
    const root = path.join(resourcesDir, asset.dir)
    if (!fs.existsSync(root)) {
      throw new Error(`[verify-bundled-cli] ${asset.dir}/ missing from packed app. Run "${asset.fix}".`)
    }
    const big = walkFindBig(root, asset.ext, asset.minBytes)
    if (!big) {
      throw new Error(`[verify-bundled-cli] no ${asset.ext} weights ≥${asset.minBytes} bytes found under ${asset.dir}/ — the bundle would ship without working ${asset.dir === 'kokoro-cache' ? 'voice (TTS)' : 'transcription (STT)'}. Run "${asset.fix}" and rebuild.`)
    }
    console.log(`[verify-bundled-cli] OK — ${asset.dir} weights present (${(big.bytes / 1024 / 1024).toFixed(0)} MB: ${path.basename(big.file)})`)
  }

  // Resolve the entry the runtime will look for: entry.json wins, then bin field.
  let entryRel = null
  const entryJson = path.join(cliDir, 'entry.json')
  if (fs.existsSync(entryJson)) {
    try {
      entryRel = JSON.parse(fs.readFileSync(entryJson, 'utf-8')).entry
    } catch (e) {
      throw new Error(`[verify-bundled-cli] entry.json unreadable: ${e.message}`)
    }
  }
  if (!entryRel) {
    const pkgPath = path.join(cliDir, 'package.json')
    if (fs.existsSync(pkgPath)) {
      const bin = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')).bin
      entryRel = typeof bin === 'string' ? bin : (bin && (bin.claude || bin['claude-code']))
    }
  }
  if (!entryRel) {
    throw new Error(`[verify-bundled-cli] no resolvable CLI entry in ${cliDir} (no entry.json or bin field).`)
  }

  const entryPath = path.join(cliDir, entryRel)
  if (!fs.existsSync(entryPath)) {
    throw new Error(`[verify-bundled-cli] CLI entry "${entryRel}" is missing from the packed app. The bundle would throw "Bundled Claude Code not found" on every launch. Re-run "FORCE=1 npm run vendor-claude" and rebuild.`)
  }
  const bytes = fs.statSync(entryPath).size
  if (bytes < MIN_ENTRY_BYTES) {
    throw new Error(`[verify-bundled-cli] CLI entry "${entryRel}" is only ${bytes} bytes — looks truncated/placeholder. Re-vendor and rebuild.`)
  }

  console.log(`[verify-bundled-cli] OK — ${entryRel} present (${(bytes / 1024 / 1024).toFixed(0)} MB) in ${productName}.app`)
}

// Recursively find the first file under `root` with `ext` and size ≥ minBytes.
// Returns { file, bytes } or null. Bounded depth to stay cheap on big trees.
function walkFindBig(root, ext, minBytes, depth = 0) {
  if (depth > 6) return null
  let entries
  try { entries = fs.readdirSync(root, { withFileTypes: true }) } catch { return null }
  for (const e of entries) {
    const full = path.join(root, e.name)
    if (e.isDirectory()) {
      const hit = walkFindBig(full, ext, minBytes, depth + 1)
      if (hit) return hit
    } else if (e.name.endsWith(ext)) {
      const bytes = fs.statSync(full).size
      if (bytes >= minBytes) return { file: full, bytes }
    }
  }
  return null
}
