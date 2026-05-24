#!/usr/bin/env node
// Recompute size + sha512 for every file referenced by release/latest-mac.yml.
//
// Why this exists: electron-builder writes the manifest BEFORE we run
// `xcrun stapler staple` on the DMGs. Stapling embeds the notarization
// ticket into the file, which changes its bytes — so the published manifest
// would otherwise list stale hashes/sizes for the DMGs. Auto-updater downloads
// the .zip (not .dmg), but a wrong DMG hash on the release page is still a
// bad look, and electron-updater verifies hashes when checking too.
//
// Run from repo root after `npm run dist` + stapling, before `gh release create`.

import { createHash } from 'node:crypto'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const RELEASE_DIR = join(process.cwd(), 'release')
const MANIFEST = join(RELEASE_DIR, 'latest-mac.yml')

function sha512Base64(path) {
  const hash = createHash('sha512')
  hash.update(readFileSync(path))
  return hash.digest('base64')
}

const raw = readFileSync(MANIFEST, 'utf8')
const lines = raw.split('\n')

// The manifest is small + well-formed; do a line-by-line rewrite rather than
// pulling in a YAML dep. Each file block looks like:
//   - url: Rax-1.0.0-arm64.dmg
//     sha512: <base64>
//     size: <int>
// and there's also a top-level `path:` + `sha512:` for the primary file.

let currentFile = null
let changed = []

for (let i = 0; i < lines.length; i++) {
  const line = lines[i]
  const urlMatch = line.match(/^(\s*-?\s*)url:\s*(.+?)\s*$/)
  const pathMatch = line.match(/^(\s*)path:\s*(.+?)\s*$/)
  if (urlMatch || pathMatch) {
    currentFile = (urlMatch ?? pathMatch)[2]
    continue
  }
  const sha512Match = line.match(/^(\s*)sha512:\s*.+$/)
  const sizeMatch = line.match(/^(\s*)size:\s*\d+\s*$/)
  if ((sha512Match || sizeMatch) && currentFile) {
    const fullPath = join(RELEASE_DIR, currentFile)
    try {
      statSync(fullPath)
    } catch {
      continue
    }
    if (sha512Match) {
      const hash = sha512Base64(fullPath)
      const newLine = `${sha512Match[1]}sha512: ${hash}`
      if (newLine !== line) changed.push(`  sha512 ${currentFile}`)
      lines[i] = newLine
    } else if (sizeMatch) {
      const size = statSync(fullPath).size
      const newLine = `${sizeMatch[1]}size: ${size}`
      if (newLine !== line) changed.push(`  size   ${currentFile}: ${size}`)
      lines[i] = newLine
    }
  }
}

writeFileSync(MANIFEST, lines.join('\n'))
console.log(`Updated ${changed.length} field(s) in ${MANIFEST}`)
for (const c of changed) console.log(c)
