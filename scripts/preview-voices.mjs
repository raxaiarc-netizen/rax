#!/usr/bin/env node
// Generate one WAV per Kokoro voice and a side-by-side HTML preview, then
// open it in the browser. Uses the same silence-trim pipeline the orb's
// local-tts.ts uses, so what you hear here is what the orb will sound
// like in practice.
//
// Run:   node scripts/preview-voices.mjs           (all 28 voices)
//        node scripts/preview-voices.mjs af bf     (filter by id prefix)
//        SAMPLE_TEXT="..." node scripts/preview-voices.mjs

import { KokoroTTS, env } from 'kokoro-js'
import * as transformers from '@huggingface/transformers'
import { mkdirSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { spawn } from 'child_process'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const REPO = resolve(HERE, '..')
const OUT_DIR = join(REPO, 'voice-previews')
const HTML_PATH = join(OUT_DIR, 'index.html')

// Point at the bundled cache if it exists; otherwise transformers.js will
// auto-download (fine for this script — it's a dev tool).
const cacheDir = join(REPO, 'resources', 'kokoro-cache')
try {
  transformers.env.cacheDir = cacheDir
} catch {}

const SAMPLE_TEXT =
  process.env.SAMPLE_TEXT ||
  "Hello, I'm your voice assistant. How can I help you today?"

const prefixFilters = process.argv.slice(2)

// ─── Silence trim (mirrors local-tts.ts) ─────────────────────────────────
function findSpokenRange(samples, sampleRate) {
  const threshold = 0.01
  const cushion = Math.floor(0.030 * sampleRate)
  let s = 0
  while (s < samples.length && Math.abs(samples[s]) < threshold) s++
  s = Math.max(0, s - cushion)
  let e = samples.length - 1
  while (e > s && Math.abs(samples[e]) < threshold) e--
  e = Math.min(samples.length - 1, e + cushion)
  if (e <= s) return { startIdx: 0, endIdx: samples.length - 1 }
  return { startIdx: s, endIdx: e }
}

function encodeWav(samples, sampleRate) {
  const n = samples.length
  const dataBytes = n * 2
  const buf = Buffer.alloc(44 + dataBytes)
  let p = 0
  buf.write('RIFF', p); p += 4
  buf.writeUInt32LE(36 + dataBytes, p); p += 4
  buf.write('WAVE', p); p += 4
  buf.write('fmt ', p); p += 4
  buf.writeUInt32LE(16, p); p += 4
  buf.writeUInt16LE(1, p); p += 2
  buf.writeUInt16LE(1, p); p += 2
  buf.writeUInt32LE(sampleRate, p); p += 4
  buf.writeUInt32LE(sampleRate * 2, p); p += 4
  buf.writeUInt16LE(2, p); p += 2
  buf.writeUInt16LE(16, p); p += 2
  buf.write('data', p); p += 4
  buf.writeUInt32LE(dataBytes, p); p += 4
  for (let i = 0; i < n; i++) {
    let v = samples[i]
    if (v > 1) v = 1
    else if (v < -1) v = -1
    buf.writeInt16LE((v * 32767) | 0, p)
    p += 2
  }
  return buf
}

// ─── Run ───────────────────────────────────────────────────────────────────
mkdirSync(OUT_DIR, { recursive: true })

console.log(`loading kokoro...`)
const t0 = Date.now()
const tts = await KokoroTTS.from_pretrained(
  'onnx-community/Kokoro-82M-v1.0-ONNX',
  { dtype: 'q8', device: 'cpu' },
)
console.log(`  loaded in ${Date.now() - t0}ms`)

const allVoices = Object.entries(tts.voices)
const voices = prefixFilters.length
  ? allVoices.filter(([id]) => prefixFilters.some((p) => id.startsWith(p)))
  : allVoices

console.log(`synthesizing ${voices.length} voices...\n`)

const results = []
for (const [id, info] of voices) {
  const t1 = Date.now()
  try {
    const audio = await tts.generate(SAMPLE_TEXT, { voice: id })
    const { startIdx, endIdx } = findSpokenRange(audio.audio, audio.sampling_rate)
    const trimmed = audio.audio.subarray(startIdx, endIdx + 1)
    const wav = encodeWav(trimmed, audio.sampling_rate)
    const fname = `${id}.wav`
    writeFileSync(join(OUT_DIR, fname), wav)
    const dur = (trimmed.length / audio.sampling_rate).toFixed(2)
    const ms = Date.now() - t1
    console.log(`  ${id.padEnd(16)} ${dur}s  ${ms}ms  (${info.name})`)
    results.push({ id, info, fname, dur })
  } catch (err) {
    console.log(`  ${id.padEnd(16)} FAILED: ${err.message}`)
    results.push({ id, info, error: err.message })
  }
}

// ─── Render HTML preview ───────────────────────────────────────────────────
// Sort by overallGrade (A first), then qual, then id, so the best voices
// surface to the top. Failures sink to the bottom.
const GRADE_ORDER = { 'A+': 0, A: 1, 'A-': 2, 'B+': 3, B: 4, 'B-': 5, 'C+': 6, C: 7, 'C-': 8, 'D+': 9, D: 10, 'D-': 11, 'F+': 12, F: 13 }
function gradeRank(g) { return GRADE_ORDER[g] ?? 999 }

results.sort((a, b) => {
  if (a.error && !b.error) return 1
  if (!a.error && b.error) return -1
  return gradeRank(a.info.overallGrade) - gradeRank(b.info.overallGrade)
})

const cards = results.map((r) => {
  if (r.error) {
    return `<div class="card error"><div class="head">${r.id}</div><div class="err">${r.error}</div></div>`
  }
  const langFlag = r.info.language?.startsWith('en-gb') ? '🇬🇧' : '🇺🇸'
  const genderBadge = r.info.gender === 'Female' ? '♀' : '♂'
  const grade = r.info.overallGrade || '?'
  const gradeClass = grade.startsWith('A') ? 'grade-a' :
                     grade.startsWith('B') ? 'grade-b' :
                     grade.startsWith('C') ? 'grade-c' : 'grade-d'
  return `<div class="card">
    <div class="head">
      <span class="name">${langFlag} ${r.info.name}</span>
      <span class="gender">${genderBadge}</span>
      <span class="grade ${gradeClass}">${grade}</span>
    </div>
    <div class="meta"><code>${r.id}</code> · ${r.dur}s</div>
    <audio controls preload="none" src="${r.fname}"></audio>
    <button class="copy" data-id="${r.id}">copy &nbsp;<code>RAX_TTS_VOICE=${r.id}</code></button>
  </div>`
}).join('\n')

const html = `<!doctype html><meta charset="utf-8">
<title>Kokoro voice preview — ${SAMPLE_TEXT.slice(0, 60)}${SAMPLE_TEXT.length > 60 ? '…' : ''}</title>
<style>
  :root { color-scheme: dark; }
  body { font: 14px/1.5 -apple-system, system-ui, sans-serif; background:#1a1a1d; color:#e8e8ea; margin:0; padding:24px; }
  h1 { font-size: 18px; margin: 0 0 4px; font-weight: 600; }
  .sub { color:#8a8a90; margin-bottom: 24px; font-size: 13px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px; }
  .card { background:#252528; border:1px solid #303035; border-radius:10px; padding:14px; }
  .card.error { opacity: 0.5; }
  .head { display:flex; align-items:center; gap:8px; margin-bottom:4px; }
  .name { font-weight: 600; font-size: 15px; }
  .gender { color:#8a8a90; }
  .grade { margin-left:auto; font-size:11px; padding:2px 7px; border-radius:8px; font-weight:600; letter-spacing:0.5px; }
  .grade-a { background:#1b4332; color:#7df0c0; }
  .grade-b { background:#2a3f5f; color:#86c0e8; }
  .grade-c { background:#3a3a2c; color:#d4c570; }
  .grade-d { background:#3a2828; color:#e89090; }
  .meta { color:#8a8a90; font-size:12px; margin-bottom:8px; }
  code { font:12px/1 ui-monospace, Menlo, monospace; background:#1a1a1d; padding:1px 5px; border-radius:4px; }
  audio { width: 100%; margin-bottom:8px; }
  .copy { font:11px/1 ui-monospace, Menlo, monospace; background:#1a1a1d; color:#8a8a90; border:1px solid #303035; border-radius:6px; padding:6px 8px; cursor:pointer; width:100%; text-align:left; }
  .copy:hover { color:#e8e8ea; border-color:#505058; }
  .copy.copied { color:#7df0c0; border-color:#1b4332; }
  .err { color:#e89090; font-size:12px; }
  .footer { color:#6a6a70; font-size:12px; margin-top:24px; }
</style>
<h1>Kokoro voice preview</h1>
<div class="sub">"${SAMPLE_TEXT}" · sorted by overall grade · ${results.length} voices</div>
<div class="grid">${cards}</div>
<div class="footer">
  Pick one, then in your shell: <code>export RAX_TTS_VOICE=&lt;id&gt;</code> and restart <code>npm run dev</code>.
  Re-run <code>node scripts/preview-voices.mjs</code> any time you want a fresh preview.
</div>
<script>
  document.querySelectorAll('.copy').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id
      try {
        await navigator.clipboard.writeText('export RAX_TTS_VOICE=' + id)
        const orig = btn.innerHTML
        btn.classList.add('copied')
        btn.innerHTML = '✓ copied'
        setTimeout(() => { btn.classList.remove('copied'); btn.innerHTML = orig }, 1200)
      } catch (e) { console.error(e) }
    })
  })
</script>`

writeFileSync(HTML_PATH, html)
console.log(`\nwrote ${results.length} WAVs + index.html to ${OUT_DIR}`)
console.log(`opening preview...`)

spawn('open', [HTML_PATH], { stdio: 'ignore', detached: true }).unref()
