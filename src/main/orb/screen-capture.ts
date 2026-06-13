import { spawn } from 'child_process'
import { readFileSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomBytes } from 'crypto'
import { log as _log } from '../logger'

function log(msg: string): void {
  _log('OrbScreenCapture', msg)
}

export interface CaptureCursorMeta {
  x: number
  y: number
  onCapturedDisplay: boolean
  cursorDisplayIndex: number | null
  capturedDisplayIndex: number | null
}

/**
 * Everything a downstream consumer needs to map an image-pixel coordinate
 * back to a global display-point coordinate (for CGEventPost). Captured at
 * the moment the screenshot was rendered so subsequent clicks land at the
 * right place even if the user rearranges displays mid-conversation.
 */
export interface CaptureCalibration {
  /** 1-based NSScreen index that was captured. */
  capturedDisplayIndex: number
  /** Source raster dimensions in pixels (before sips/JXA downscale). */
  sourcePxWidth: number
  sourcePxHeight: number
  /** Output image dimensions in pixels (what the model actually sees). */
  imageOutWidth: number
  imageOutHeight: number
  /** Captured display dimensions in points (= source_px / backingScaleFactor). */
  displayPointWidth: number
  displayPointHeight: number
  /** Captured display origin in global points, top-left convention (CGEvent space). */
  displayOriginX: number
  displayOriginY: number
  /** Backing scale factor of the captured display (1 on non-Retina, 2 on Retina). */
  backingScaleFactor: number
}

export interface CaptureResult {
  base64: string
  mimeType: 'image/png' | 'image/jpeg'
  bytes: number
  display: number | 'main'
  cursorMarker: boolean
  cursor?: CaptureCursorMeta
  /** Calibration for image-pixel → global-point conversion. Present whenever
   *  the JXA annotation pipeline succeeded (i.e. cursor info is also present). */
  calibration?: CaptureCalibration
}

export interface CaptureFailure {
  error: 'screencapture_failed' | 'read_failed'
  message: string
}

export interface CaptureOptions {
  /**
   * Display selection.
   *   - 'cursor' — capture the display containing the mouse cursor (resolved
   *      via a fast JXA AppKit query before screencapture is invoked).
   *   - number  — 1-based display index (matches `screencapture -D`).
   *   - 'main'  — primary display (default).
   */
  display?: 'cursor' | 'main' | number
  /** Downscale longest edge to 1600px via `sips -Z`. Default true. */
  downscale?: boolean
  /** Draw the red-ring cursor marker via JXA. Default true. */
  annotateCursor?: boolean
  /**
   * Per-call override for the downscale's max-edge in pixels. Wins over the
   * `RAX_ORB_SHOT_MAX` env default. Only honoured when `downscale !== false`.
   * Used by the orb's direct-API path to request a 1280px capture so the
   * resulting PNG fits Anthropic's 5MB-per-image cap without JPEG conversion
   * (JPEG artifacts on small UI text hurt the model's click accuracy).
   */
  maxEdge?: number
  /**
   * Output encoding. 'png' (default) for tool screenshots the model reads
   * fine detail from; 'jpg' for continuous streams (Gemini screen share)
   * where a ~10× smaller payload per frame matters more than text crispness.
   * Only honoured when the annotation pipeline runs — the raw-source
   * fallback is whatever `screencapture` produced (PNG).
   */
  format?: 'png' | 'jpg'
}

interface CursorAnnotation {
  cursor_pt: [number, number]
  cursor_px: [number, number]
  scale: number
  bsf?: number
  image_px: [number, number]
  out_px: [number, number]
  display_pt?: [number, number]
  /** Captured display origin in GLOBAL POINTS with TOP-LEFT origin
   *  (CGEvent coordinate space). Computed from NSScreen primary frame so
   *  multi-display setups click on the right monitor. */
  display_origin_pt?: [number, number]
  cursor_display_index?: number
  captured_display_index?: number
  marked: boolean
  resized: boolean
}

/**
 * One-shot JXA pipeline: open the source PNG, find the cursor's display,
 * downscale the image to a max edge of RAX_SHOT_MAX (default 1600px), draw
 * a red ring + white dot at the cursor position, and write the result as PNG
 * to $RAX_SHOT_DST.
 *
 * Implementation note: the obvious approach (alloc an NSBitmapImageRep at the
 * target pixel size and call NSGraphicsContext.setCurrentContext to draw into
 * it) does not actually paint into the bitmap when invoked from JXA — the
 * resulting PNG comes out empty. The reliable pattern is to lockFocus on a
 * fresh NSImage sized in *points* (output pixels ÷ backing scale). The Retina
 * backing-scale upsample then produces a bitmap of exactly the target pixel
 * dimensions. We compensate for the 1/bsf scaling of geometry by dividing
 * line widths and ring radii by bsf so they render at the intended pixel
 * size in the output.
 *
 * Inputs (env):
 *   RAX_SHOT_SRC      — path to source PNG (from screencapture)
 *   RAX_SHOT_DST      — output PNG path
 *   RAX_SHOT_DISPLAY  — 1-based display index (0 = main)
 *   RAX_SHOT_MAX      — max-edge px clamp (string, default "1600"; "0" disables)
 *   RAX_SHOT_ANNOTATE — "1" to draw ring/dot, anything else skips
 *   RAX_SHOT_FORMAT   — "jpg" for JPEG output (quality 0.72), anything else PNG
 */
const CURSOR_ANNOTATE_JXA = [
  "ObjC.import('AppKit');",
  "ObjC.import('Foundation');",
  '(function () {',
  '  var env = $.NSProcessInfo.processInfo.environment;',
  "  var src = ObjC.unwrap(env.objectForKey('RAX_SHOT_SRC'));",
  "  var dst = ObjC.unwrap(env.objectForKey('RAX_SHOT_DST'));",
  "  var targetDisplay = parseInt(ObjC.unwrap(env.objectForKey('RAX_SHOT_DISPLAY')) || '0', 10);",
  "  var maxEdge = parseInt(ObjC.unwrap(env.objectForKey('RAX_SHOT_MAX')) || '1600', 10);",
  "  var annotateFlag = (ObjC.unwrap(env.objectForKey('RAX_SHOT_ANNOTATE')) || '1') === '1';",
  // ── Resolve cursor + captured display ─────────────────────────────────
  '  var screens = $.NSScreen.screens;',
  '  var screenCount = screens.count;',
  '  var loc = $.NSEvent.mouseLocation;',
  '  var cursorScreenIdx = 0;',
  '  for (var i = 0; i < screenCount; i++) {',
  '    var f = screens.objectAtIndex(i).frame;',
  '    if (loc.x >= f.origin.x && loc.x <= f.origin.x + f.size.width &&',
  '        loc.y >= f.origin.y && loc.y <= f.origin.y + f.size.height) {',
  '      cursorScreenIdx = i;',
  '      break;',
  '    }',
  '  }',
  '  var capturedIdx = (targetDisplay <= 1 ? 0 : (targetDisplay - 1));',
  '  if (capturedIdx >= screenCount) capturedIdx = 0;',
  '  var captured = screens.objectAtIndex(capturedIdx);',
  '  var cFrame = captured.frame;',
  '  var scale = captured.backingScaleFactor;',
  '  var cx_pt = loc.x - cFrame.origin.x;',
  '  var cy_top_pt = (cFrame.origin.y + cFrame.size.height) - loc.y;',
  // ── Captured display origin in TOP-LEFT global points (CGEvent space) ─
  // NSScreen frames are bottom-left origin; CGEvent expects top-left.
  // Flip Y using the PRIMARY display's height (NSScreen[0] is the primary).
  '  var primary = screens.objectAtIndex(0);',
  '  var pFrame = primary.frame;',
  '  var primaryHeight_pt = pFrame.size.height;',
  '  var captured_origin_x_pt = cFrame.origin.x;',
  '  var captured_origin_y_top_pt = primaryHeight_pt - (cFrame.origin.y + cFrame.size.height);',
  // ── Load source PNG, read its pixel dimensions ────────────────────────
  '  var img = $.NSImage.alloc.initWithContentsOfFile(src);',
  '  if (img.isNil()) { return JSON.stringify({ error: "load_failed" }); }',
  '  var reps = img.representations;',
  '  var pw, ph;',
  '  if (reps.count > 0) {',
  '    var rep0 = reps.objectAtIndex(0);',
  '    pw = rep0.pixelsWide; ph = rep0.pixelsHigh;',
  '  } else {',
  '    pw = Math.floor(img.size.width); ph = Math.floor(img.size.height);',
  '  }',
  // ── Output pixel dimensions: clamp longest edge to maxEdge ────────────
  '  var ow = pw, oh = ph, sx = 1.0;',
  '  if (maxEdge > 0 && Math.max(pw, ph) > maxEdge) {',
  '    sx = maxEdge / Math.max(pw, ph);',
  '    ow = Math.round(pw * sx);',
  '    oh = Math.round(ph * sx);',
  '  }',
  '  var resized = (ow !== pw || oh !== ph);',
  // ── Cursor coords in source-pixel space ───────────────────────────────
  '  var mx_src = cx_pt * scale;',
  '  var my_top_src = cy_top_pt * scale;',
  '  var on_captured = (cursorScreenIdx === capturedIdx) && (mx_src >= 0 && mx_src <= pw) && (my_top_src >= 0 && my_top_src <= ph);',
  // ── Render: lockFocus on an NSImage sized in POINTS = pixels/bsf ──────
  // lockFocus's Retina backing-scale upsample then gives us a bitmap of
  // exactly (ow, oh) pixels. Geometry is expressed in points (divide pixel
  // measurements by bsf) so the rendered ring/dot lands at the right place
  // at the right size.
  '  var bsf = $.NSScreen.mainScreen.backingScaleFactor;',
  '  if (!bsf || bsf <= 0) bsf = 1.0;',
  '  var nw = Math.max(1, Math.round(ow / bsf));',
  '  var nh = Math.max(1, Math.round(oh / bsf));',
  '  var out = $.NSImage.alloc.initWithSize($.NSMakeSize(nw, nh));',
  '  out.lockFocus;',
  '  img.drawInRect($.NSMakeRect(0, 0, nw, nh));',
  '  if (annotateFlag && on_captured) {',
  // Cursor center in output-pixel space:
  '    var mx_out_px = mx_src * sx;',
  '    var my_bottom_out_px = (ph - my_top_src) * sx;',
  // Convert to points for the bezier path; ring radius/line width also in points.
  '    var cx_pts = mx_out_px / bsf;',
  '    var cy_pts = my_bottom_out_px / bsf;',
  '    var ringR_pts = 26 / bsf;',
  '    var dotR_pts = 7 / bsf;',
  '    $.NSColor.colorWithCalibratedRedGreenBlueAlpha(1.0, 0.22, 0.22, 0.95).set;',
  '    var ring = $.NSBezierPath.bezierPathWithOvalInRect($.NSMakeRect(cx_pts - ringR_pts, cy_pts - ringR_pts, ringR_pts * 2, ringR_pts * 2));',
  '    ring.lineWidth = 7 / bsf;',
  '    ring.stroke;',
  '    $.NSColor.colorWithCalibratedRedGreenBlueAlpha(1.0, 1.0, 1.0, 0.95).set;',
  '    $.NSBezierPath.bezierPathWithOvalInRect($.NSMakeRect(cx_pts - dotR_pts, cy_pts - dotR_pts, dotR_pts * 2, dotR_pts * 2)).fill;',
  '  }',
  '  out.unlockFocus;',
  '  var tiff = out.TIFFRepresentation;',
  '  var rep2 = $.NSBitmapImageRep.imageRepWithData(tiff);',
  "  var wantJpg = (ObjC.unwrap(env.objectForKey('RAX_SHOT_FORMAT')) || 'png') === 'jpg';",
  // NSBitmapImageFileType: 3 = JPEG, 4 = PNG.
  '  var outData = wantJpg',
  "    ? rep2.representationUsingTypeProperties(3, $.NSDictionary.dictionaryWithObjectForKey($(0.72), $('NSImageCompressionFactor')))",
  '    : rep2.representationUsingTypeProperties(4, $());',
  '  outData.writeToFileAtomically(dst, true);',
  '  return JSON.stringify({',
  '    cursor_pt: [Math.floor(cx_pt), Math.floor(cy_top_pt)],',
  '    cursor_px: [Math.floor(mx_src), Math.floor(my_top_src)],',
  '    scale: Number(scale),',
  '    bsf: Number(bsf),',
  '    image_px: [Number(pw), Number(ph)],',
  '    out_px: [Number(rep2.pixelsWide), Number(rep2.pixelsHigh)],',
  '    display_pt: [Number(cFrame.size.width), Number(cFrame.size.height)],',
  '    display_origin_pt: [Number(captured_origin_x_pt), Number(captured_origin_y_top_pt)],',
  '    cursor_display_index: cursorScreenIdx + 1,',
  '    captured_display_index: capturedIdx + 1,',
  '    marked: annotateFlag && on_captured,',
  '    resized: resized,',
  '  });',
  '})();',
].join('\n')

// 1-based index of the display under the cursor, or 1 if the AppKit query
// fails. Used to point `screencapture -D` at the right monitor when the
// caller asks for `display: 'cursor'`.
const CURSOR_DISPLAY_INDEX_JXA = [
  "ObjC.import('AppKit');",
  '(function () {',
  '  var screens = $.NSScreen.screens;',
  '  var loc = $.NSEvent.mouseLocation;',
  '  for (var i = 0; i < screens.count; i++) {',
  '    var f = screens.objectAtIndex(i).frame;',
  '    if (loc.x >= f.origin.x && loc.x <= f.origin.x + f.size.width &&',
  '        loc.y >= f.origin.y && loc.y <= f.origin.y + f.size.height) {',
  '      return (i + 1).toString();',
  '    }',
  '  }',
  '  return "1";',
  '})();',
].join('\n')

async function resolveCursorDisplayIndex(): Promise<number> {
  try {
    const out = await runCmd('/usr/bin/osascript', ['-l', 'JavaScript', '-e', CURSOR_DISPLAY_INDEX_JXA], 3000)
    const n = Number.parseInt(out.trim(), 10)
    return Number.isFinite(n) && n >= 1 && n <= 16 ? n : 1
  } catch {
    return 1
  }
}

// Max edge in pixels for the output PNG. The model handles larger images,
// but at ~1600px most UI text is still legible while base64 payloads stay
// manageable. Set to 0 (via RAX_ORB_SHOT_MAX=0) to disable downscale.
const DEFAULT_MAX_EDGE = (() => {
  const raw = Number.parseInt(process.env.RAX_ORB_SHOT_MAX || '1600', 10)
  return Number.isFinite(raw) && raw >= 0 ? raw : 1600
})()

/**
 * Target PNG ceiling. Anthropic's hard cap on per-image data is 5MB; we aim
 * for 4MB so cumulative messages (system prompt, history, prior tool
 * results) leave headroom in the API request total.
 */
const IMAGE_SAFE_BYTES = 4_000_000

/**
 * Build a descending ladder of maxEdge values starting from the caller's
 * request and shrinking by ~25% each step until we reach 640px. The first
 * value is always honoured; later values are only tried if the previous
 * pass produced a PNG over IMAGE_SAFE_BYTES. Including a small floor (640)
 * guarantees termination even on the heaviest captures.
 */
function buildMaxEdgeLadder(start: number): number[] {
  if (!start || start <= 0) return [0]
  const ladder: number[] = []
  let cur = Math.max(640, Math.trunc(start))
  ladder.push(cur)
  while (cur > 720) {
    cur = Math.max(640, Math.floor(cur * 0.75))
    if (ladder[ladder.length - 1] === cur) break
    ladder.push(cur)
  }
  return ladder
}

/**
 * Capture the screen as a base64 PNG. Pipeline:
 *   1. `screencapture -x [-D N]` → raw source PNG
 *   2. ONE `osascript -l JavaScript` invocation that resolves the cursor's
 *      display, downscales the image to a max edge of 1600px, and draws the
 *      red-ring cursor marker if the cursor sits on the captured display.
 *
 * Previously step 2 was three sequential spawns (annotate JXA + sips downscale +
 * file copy fallback). Collapsing them saves a process spawn and a full
 * decode/encode roundtrip — typically 300-400ms off every capture. Pure, no
 * global state, no IPC; safe to call from any code path.
 */
export async function captureScreenForOrb(
  opts: CaptureOptions = {},
): Promise<CaptureResult | CaptureFailure> {
  const downscale = opts.downscale !== false
  const annotate = opts.annotateCursor !== false

  let display = 0
  if (typeof opts.display === 'number') {
    display = Math.max(0, Math.min(16, Math.trunc(opts.display)))
  } else if (opts.display === 'cursor') {
    const idx = await resolveCursorDisplayIndex()
    // When the cursor is on display 1 (the main display), normalise to 0 so
    // we invoke `screencapture` with no `-D` flag — exactly matching the
    // MCP tool's default invocation. Skipping `-D 1` avoids a subtle macOS
    // behaviour difference where indexed vs. default capture can pick up
    // slightly different framebuffers. For secondary displays we still
    // pass the index so we capture the right monitor.
    display = idx <= 1 ? 0 : idx
  }
  // display === 0 → 'main' (let screencapture pick primary).

  const format: 'png' | 'jpg' = opts.format === 'jpg' ? 'jpg' : 'png'
  const tmpPath = join(tmpdir(), `rax-orb-shot-${randomBytes(6).toString('hex')}.png`)
  const dstPath = join(tmpdir(), `rax-orb-shot-${randomBytes(6).toString('hex')}-final.${format}`)
  const captureArgs = ['-x']
  if (display > 0) captureArgs.push('-D', String(display))
  captureArgs.push(tmpPath)

  try {
    await runCmd('/usr/sbin/screencapture', captureArgs, 8000)
  } catch (err) {
    return { error: 'screencapture_failed', message: (err as Error).message }
  }

  const cleanup: string[] = [tmpPath, dstPath]
  let outputPath = tmpPath
  let cursorMeta: CursorAnnotation | null = null

  // Adaptive maxEdge: start at the caller's request (or the default), and
  // shrink progressively if the resulting PNG would blow Anthropic's 5MB
  // per-image cap. Each pass re-runs the JXA step against the ORIGINAL
  // screencapture tmpPath — the screen grab itself is not repeated — so the
  // overhead per retry is one ~100ms JXA spawn, not a fresh capture. The
  // calibration is recomputed every pass, so click coordinates always match
  // whatever pixel size the model ends up seeing.
  //
  // Trying first at the largest reasonable size matches CLI behavior (it
  // sends large PNGs whenever they fit) and falls back gracefully on
  // multi-monitor / detail-heavy captures that would otherwise 5MB-error.
  const requestedMax =
    downscale
      ? (typeof opts.maxEdge === 'number' && opts.maxEdge > 0 ? Math.trunc(opts.maxEdge) : DEFAULT_MAX_EDGE)
      : 0
  const ladder = downscale ? buildMaxEdgeLadder(requestedMax) : [0]

  let base64 = ''
  let bytes = 0
  let readErr: Error | null = null

  for (let i = 0; i < ladder.length; i++) {
    const tryMax = ladder[i]
    cursorMeta = null
    outputPath = tmpPath
    try {
      const out = await runCmd(
        '/usr/bin/osascript',
        ['-l', 'JavaScript', '-e', CURSOR_ANNOTATE_JXA],
        8000,
        {
          RAX_SHOT_SRC: tmpPath,
          RAX_SHOT_DST: dstPath,
          RAX_SHOT_DISPLAY: String(display),
          RAX_SHOT_MAX: String(tryMax),
          RAX_SHOT_ANNOTATE: annotate ? '1' : '0',
          RAX_SHOT_FORMAT: format,
        },
      )
      const lastLine = out.trim().split('\n').pop() || '{}'
      const parsed = JSON.parse(lastLine) as CursorAnnotation & { error?: string }
      if (!parsed.error) {
        cursorMeta = parsed
        outputPath = dstPath
      } else {
        log(`Cursor annotation skipped: ${parsed.error} — using raw source`)
      }
    } catch (err) {
      log(`Annotation pipeline failed (maxEdge=${tryMax}): ${(err as Error).message}`)
    }

    try {
      const buf = readFileSync(outputPath)
      base64 = buf.toString('base64')
      bytes = buf.length
      readErr = null
    } catch (err) {
      readErr = err as Error
      continue
    }

    if (bytes <= IMAGE_SAFE_BYTES || i === ladder.length - 1) {
      if (i > 0) log(`Shrank capture maxEdge=${ladder[0]}→${tryMax} (${bytes} bytes)`)
      break
    }
    log(`PNG ${bytes} bytes exceeds ${IMAGE_SAFE_BYTES} at maxEdge=${tryMax} — retrying smaller`)
  }

  for (const p of cleanup) {
    try { unlinkSync(p) } catch {}
  }
  if (readErr) {
    return { error: 'read_failed', message: readErr.message }
  }

  const result: CaptureResult = {
    base64,
    // JPEG only comes out of the annotation pipeline (dstPath); when that
    // failed we fell back to the raw screencapture output, which is PNG.
    mimeType: format === 'jpg' && outputPath === dstPath ? 'image/jpeg' : 'image/png',
    bytes,
    display: display || 'main',
    cursorMarker: !!(cursorMeta && cursorMeta.marked),
  }
  if (cursorMeta) {
    // Surface cursor in IMAGE-PIXEL space (= what the model sees in the
    // screenshot it just got). Previously this returned points, which made
    // the model's "click at cursor" reasoning consistently wrong on Retina
    // or whenever a downscale was applied.
    const sourceW = cursorMeta.image_px[0] || 1
    const sourceH = cursorMeta.image_px[1] || 1
    const outW = cursorMeta.out_px[0] || sourceW
    const outH = cursorMeta.out_px[1] || sourceH
    const sxX = outW / sourceW
    const sxY = outH / sourceH
    const cursorImageX = Math.floor(cursorMeta.cursor_px[0] * sxX)
    const cursorImageY = Math.floor(cursorMeta.cursor_px[1] * sxY)
    result.cursor = {
      x: cursorImageX,
      y: cursorImageY,
      onCapturedDisplay: !!cursorMeta.marked,
      cursorDisplayIndex: cursorMeta.cursor_display_index ?? null,
      capturedDisplayIndex: cursorMeta.captured_display_index ?? null,
    }
    if (cursorMeta.display_pt && cursorMeta.display_origin_pt) {
      result.calibration = {
        capturedDisplayIndex: cursorMeta.captured_display_index ?? 1,
        sourcePxWidth: sourceW,
        sourcePxHeight: sourceH,
        imageOutWidth: outW,
        imageOutHeight: outH,
        displayPointWidth: cursorMeta.display_pt[0],
        displayPointHeight: cursorMeta.display_pt[1],
        displayOriginX: cursorMeta.display_origin_pt[0],
        displayOriginY: cursorMeta.display_origin_pt[1],
        backingScaleFactor: cursorMeta.bsf ?? (sourceW / (cursorMeta.display_pt[0] || sourceW)),
      }
    }
  }
  return result
}

export function isCaptureFailure(r: CaptureResult | CaptureFailure): r is CaptureFailure {
  return (r as CaptureFailure).error !== undefined
}

function runCmd(
  cmd: string,
  args: string[],
  timeoutMs: number,
  extraEnv?: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(extraEnv ? { env: { ...process.env, ...extraEnv } } : {}),
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { child.kill('SIGKILL') } catch {}
      reject(new Error(`${cmd} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString('utf-8') })
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString('utf-8') })
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code !== 0) {
        reject(new Error(`${cmd} exited ${code}: ${stderr.trim().slice(0, 200) || stdout.trim().slice(0, 200)}`))
      } else {
        resolve(stdout)
      }
    })
  })
}
