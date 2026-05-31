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
  const cliDir = path.join(appOutDir, `${productName}.app`, 'Contents', 'Resources', 'claude-cli')

  if (!fs.existsSync(cliDir)) {
    throw new Error(`[verify-bundled-cli] claude-cli/ missing from packed app at ${cliDir}. Run "npm run vendor-claude" before building.`)
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
