import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { randomBytes, randomUUID } from 'crypto'
import { homedir } from 'os'
import { spawn } from 'child_process'
import type { ControlPlane } from '../claude/control-plane'
import type { MirrorAction } from '../../shared/types'
import { TabContextRegistry, projectSnapshot } from './tab-context'
import { captureScreenForOrb, isCaptureFailure, type CaptureCalibration } from './screen-capture'
import { log as _log } from '../logger'

function log(msg: string): void {
  _log('OrbRPC', msg)
}

/**
 * RPC bridge that exposes tab tools to the orb's claude session.
 *
 * Listens on 127.0.0.1 only, with a per-launch secret token in the
 * `Authorization` header. The MCP stdio shim is the only intended caller —
 * it forwards every `tools/call` here, then returns the result to claude
 * over stdio.
 *
 * Tools (all POST, JSON body):
 *   /list_tabs                       → { tabs: TabSummary[] }
 *   /read_tab    { tab, lastN? }     → { tab: TabDetail }
 *   /open_tab    { cwd?, prompt? }   → { tabId }
 *   /send_to_tab { tab, prompt }     → { tabId }
 *   /focus_tab   { tab }             → { tabId }
 *   /describe_self                   → { ... orb self-context }
 */
export interface OrbRpcDeps {
  tabContext: TabContextRegistry
  controlPlane: ControlPlane
  broadcastMirror: (action: MirrorAction) => void
  showPillWindow: () => void
  /** Resolves the working directory the orb itself should treat as "the project". */
  getProjectPath: () => string
  /**
   * Wait until a specific tab's run finishes, then resolve with its final
   * assistant text. Used by `rax_send_to_tab_and_wait`. The caller should
   * forward an AbortSignal so the listener pair is torn down if the
   * underlying HTTP request from the MCP shim disconnects (e.g. orb's
   * claude was interrupted by the user).
   */
  awaitTabIdle: (tabId: string, timeoutMs: number, signal?: AbortSignal) => Promise<{ text: string; timedOut: boolean }>
  /**
   * Show / hide / toggle the agents dock window (undefined toggles).
   * Returns the resulting visibility. 'user' cause = explicit, sticky
   * intent (backs `/set_dock`); 'auto' = activity-driven surfacing that the
   * dock will tuck away itself when the crew goes quiet.
   */
  setDockVisible: (visible?: boolean, cause?: 'user' | 'auto') => boolean
}

export interface OrbRpcInfo {
  port: number
  secret: string
  url: string
}

export class OrbRpcServer {
  private server: Server | null = null
  private secret = ''
  private port = 0
  private readonly deps: OrbRpcDeps
  /**
   * Last screenshot's calibration data. Click/double_click/etc consume this
   * to translate image-pixel coordinates the model is reasoning over into
   * the global display-point space CGEvent expects. Without this, every
   * Retina + downscaled screenshot causes clicks to land at the wrong spot.
   */
  private lastCalibration: CaptureCalibration | null = null
  /**
   * Calibration of the most recent screen-share STREAM frame (pushed by the
   * Gemini session per frame). Kept separate from lastCalibration on
   * purpose: pixel coordinates always resolve against the screenshot the
   * model read them from, while `unit:"norm1000"` coordinates (scale-free,
   * read off the live stream) resolve against the latest streamed frame —
   * mixing the two caches would mis-scale clicks whenever a stream frame
   * landed between a screenshot and its click.
   */
  private streamCalibration: CaptureCalibration | null = null

  constructor(deps: OrbRpcDeps) {
    this.deps = deps
  }

  /** Live screen-share frames register their geometry here (null on stop). */
  setStreamCalibration(cal: CaptureCalibration | null): void {
    this.streamCalibration = cal
  }

  async start(): Promise<OrbRpcInfo> {
    if (this.server) return { port: this.port, secret: this.secret, url: `http://127.0.0.1:${this.port}` }

    this.secret = randomBytes(24).toString('hex')

    return new Promise<OrbRpcInfo>((resolve, reject) => {
      const server = createServer((req, res) => this._handle(req, res))
      server.on('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address()
        if (!addr || typeof addr === 'string') {
          server.close()
          reject(new Error('Failed to determine RPC port'))
          return
        }
        this.server = server
        this.port = addr.port
        log(`Listening on 127.0.0.1:${this.port}`)
        resolve({ port: this.port, secret: this.secret, url: `http://127.0.0.1:${this.port}` })
      })
    })
  }

  stop(): void {
    if (this.server) {
      this.server.close()
      this.server = null
      log('Stopped')
    }
  }

  // ─── HTTP plumbing ───

  private async _handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const send = (status: number, body: unknown): void => {
      const json = JSON.stringify(body)
      try {
        res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(json) })
        res.end(json)
      } catch {
        // Client may have hung up while we were processing — discard.
      }
    }

    if (req.method !== 'POST') {
      send(405, { error: 'method_not_allowed' })
      return
    }

    const auth = req.headers['authorization'] || ''
    if (auth !== `Bearer ${this.secret}`) {
      send(401, { error: 'unauthorized' })
      return
    }

    const url = req.url || '/'
    const path = url.split('?')[0]

    let body = ''
    try {
      body = await readBody(req, 256 * 1024)
    } catch (err) {
      send(413, { error: 'request_too_large', detail: (err as Error).message })
      return
    }

    let payload: Record<string, unknown> = {}
    if (body.trim()) {
      try {
        payload = JSON.parse(body)
      } catch {
        send(400, { error: 'invalid_json' })
        return
      }
    }

    // Build an abort signal scoped to THIS request so tools that wait for
    // external events (rax_send_to_tab_and_wait) can tear down their
    // listeners as soon as the MCP shim disconnects (e.g. the orb's claude
    // was interrupted). Without this, every cancelled wait would leak two
    // ControlPlane listeners and stall a turn worth of orb context for the
    // 10-minute default.
    const abortCtl = new AbortController()
    const onClose = () => abortCtl.abort()
    res.once('close', onClose)
    req.once('close', onClose)

    try {
      switch (path) {
        case '/list_tabs':
          send(200, this._listTabs())
          return
        case '/read_tab':
          send(200, this._readTab(payload))
          return
        case '/open_tab':
          send(200, await this._openTab(payload))
          return
        case '/send_to_tab':
          send(200, await this._sendToTab(payload))
          return
        case '/send_to_tab_and_wait':
          send(200, await this._sendToTabAndWait(payload, abortCtl.signal))
          return
        case '/focus_tab':
          send(200, this._focusTab(payload))
          return
        case '/describe_self':
          send(200, this._describeSelf())
          return
        case '/set_dock':
          send(200, this._setDock(payload))
          return
        case '/screenshot':
          send(200, await this._screenshot(payload))
          return
        case '/control_screen':
          send(200, await this._controlScreen(payload))
          return
        default:
          send(404, { error: 'unknown_tool', tool: path })
      }
    } catch (err) {
      log(`Tool error on ${path}: ${(err as Error).message}`)
      send(500, { error: 'tool_error', message: (err as Error).message })
    } finally {
      res.removeListener('close', onClose)
      req.removeListener('close', onClose)
    }
  }

  // ─── Tools ───

  private _listTabs(): Record<string, unknown> {
    const list = this.deps.tabContext.list()
    return {
      tabs: list.map((t, i) => projectSnapshot(t, i)),
      total: list.length,
    }
  }

  private _readTab(args: Record<string, unknown>): Record<string, unknown> {
    const ref = String(args.tab ?? args.tabId ?? '').trim()
    const lastN = clampInt(args.lastN, 1, 40, 12)
    const snap = this.deps.tabContext.resolve(ref)
    if (!snap) return { error: 'tab_not_found', reference: ref }

    const index = this.deps.tabContext.list().findIndex((t) => t.tabId === snap.tabId)
    const messages = snap.recentMessages.slice(-lastN).map((m) => ({
      role: m.role,
      ...(m.toolName ? { toolName: m.toolName } : {}),
      ...(m.text ? { text: m.text } : {}),
      atIso: new Date(m.timestamp).toISOString(),
    }))

    return {
      tab: {
        ...projectSnapshot(snap, Math.max(0, index)),
        recentMessages: messages,
      },
    }
  }

  private async _openTab(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const cwdRaw = typeof args.workingDirectory === 'string' ? args.workingDirectory : (typeof args.cwd === 'string' ? args.cwd : '')
    const promptRaw = typeof args.prompt === 'string' ? args.prompt : (typeof args.initialPrompt === 'string' ? args.initialPrompt : '')

    const cwd = expandHomeAlias(cwdRaw) || this.deps.getProjectPath()

    // Orb-opened tabs run in bypass permission mode by default. The orb is
    // summoned explicitly by voice and already runs with bypassPermissions —
    // any tab it spawns inherits that trust so the agent can actually do the
    // work it was asked to do without stalling on permission cards no one is
    // looking at.
    this.deps.controlPlane.setPermissionMode('bypass')
    this.deps.broadcastMirror({ kind: 'permission-mode', mode: 'bypass' })

    const tabId = this.deps.controlPlane.createTab()

    // Mirror to renderers so the new tab appears in the pill / fullscreen UI.
    this.deps.broadcastMirror({ kind: 'tab-created', tabId, workingDirectory: cwd })
    this.deps.broadcastMirror({ kind: 'tab-selected', tabId })

    // Make the pill visible — the orb just spawned a tab, the user should see it.
    this.deps.showPillWindow()

    if (promptRaw && promptRaw.trim()) {
      const trimmed = promptRaw.trim()
      const messageId = randomUUID()
      this.deps.broadcastMirror({
        kind: 'user-message',
        tabId,
        messageId,
        content: trimmed,
        timestamp: Date.now(),
      })
      const requestId = randomUUID()
      // Don't await — the orb just wants to fire and forget.
      this.deps.controlPlane
        .submitPrompt(tabId, requestId, { prompt: trimmed, projectPath: cwd })
        .catch((err) => log(`open_tab submitPrompt error: ${(err as Error).message}`))
    }

    return { tabId, workingDirectory: cwd, sentPrompt: !!(promptRaw && promptRaw.trim()), permissionMode: 'bypass' }
  }

  private async _sendToTab(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const ref = String(args.tab ?? args.tabId ?? '').trim()
    const rawPrompt = String(args.prompt ?? '').trim()
    if (!rawPrompt) return { error: 'missing_prompt' }

    const snap = this.deps.tabContext.resolve(ref)
    if (!snap) return { error: 'tab_not_found', reference: ref }

    const cwd = snap.workingDirectory || this.deps.getProjectPath()
    const prompt = wrapOrbDispatch(rawPrompt, cwd)

    // Mirror the UNwrapped prompt — the dock transcript, <rax_crew> snapshots
    // and agent-update recaps all quote it; the <orb_dispatch> envelope is for
    // the agent only.
    const messageId = randomUUID()
    this.deps.broadcastMirror({
      kind: 'user-message',
      tabId: snap.tabId,
      messageId,
      content: rawPrompt,
      timestamp: Date.now(),
    })

    const requestId = randomUUID()
    this.deps.controlPlane
      .submitPrompt(snap.tabId, requestId, { prompt, projectPath: cwd })
      .catch((err) => log(`send_to_tab submitPrompt error: ${(err as Error).message}`))

    // Crew got work — surface the dock so the user can watch the agent run.
    // 'auto' cause: the dock earns its screen space for the episode, then
    // tucks itself away once the crew goes quiet.
    this.deps.setDockVisible(true, 'auto')

    return { tabId: snap.tabId, sent: true }
  }

  private async _sendToTabAndWait(args: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const ref = String(args.tab ?? args.tabId ?? '').trim()
    const rawPrompt = String(args.prompt ?? '').trim()
    if (!rawPrompt) return { error: 'missing_prompt' }

    const snap = this.deps.tabContext.resolve(ref)
    if (!snap) return { error: 'tab_not_found', reference: ref }

    const cwd = snap.workingDirectory || this.deps.getProjectPath()
    const prompt = wrapOrbDispatch(rawPrompt, cwd)

    // Mirror the UNwrapped prompt (see _sendToTab).
    const messageId = randomUUID()
    this.deps.broadcastMirror({
      kind: 'user-message',
      tabId: snap.tabId,
      messageId,
      content: rawPrompt,
      timestamp: Date.now(),
    })

    const requestId = randomUUID()
    this.deps.controlPlane
      .submitPrompt(snap.tabId, requestId, { prompt, projectPath: cwd })
      .catch((err) => log(`send_to_tab_and_wait submitPrompt error: ${(err as Error).message}`))

    // Crew got work — surface the dock so the user can watch the agent run.
    this.deps.setDockVisible(true, 'auto')

    const result = await this.deps.awaitTabIdle(snap.tabId, 0, signal)
    return {
      tabId: snap.tabId,
      finalAssistantText: result.text,
      timedOut: result.timedOut,
    }
  }

  private _focusTab(args: Record<string, unknown>): Record<string, unknown> {
    const ref = String(args.tab ?? args.tabId ?? '').trim()
    const snap = this.deps.tabContext.resolve(ref)
    if (!snap) return { error: 'tab_not_found', reference: ref }
    this.deps.broadcastMirror({ kind: 'tab-selected', tabId: snap.tabId })
    this.deps.showPillWindow()
    return { tabId: snap.tabId }
  }

  private async _screenshot(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const display = clampInt(args.display, 1, 8, 0) // 0 = unspecified → main
    const downscale = args.downscale === false ? false : true
    const annotate = args.annotateCursor === false ? false : true
    // Optional max-edge override (in pixels). The direct-API orb passes 1280
    // so the resulting PNG fits Anthropic's 5MB cap natively without JPEG
    // re-encoding (which would degrade click accuracy on small UI text).
    const maxEdge = clampInt(args.maxEdge, 256, 4096, 0)

    // Capture pipeline lives in `screen-capture.ts` so it can be reused by the
    // pre-turn auto-attach path (`prepareAutoCapture`). This MCP tool stays
    // available for follow-up captures — e.g. verifying a control_screen
    // action took effect, or hitting a non-cursor display.
    const result = await captureScreenForOrb({
      display: display > 0 ? display : 'main',
      downscale,
      annotateCursor: annotate,
      maxEdge: maxEdge > 0 ? maxEdge : undefined,
    })

    if (isCaptureFailure(result)) {
      return { error: result.error, message: result.message }
    }

    // Cache calibration so the next rax_control_screen click can translate
    // image-pixel coords → display-point coords. The cache key is implicit:
    // whichever display was just captured.
    if (result.calibration) {
      this.lastCalibration = result.calibration
    }

    const payload: Record<string, unknown> = {
      mimeType: result.mimeType,
      base64: result.base64,
      bytes: result.bytes,
      display: result.display,
      cursorMarker: result.cursorMarker,
    }
    if (result.cursor) {
      payload.cursor = {
        x: result.cursor.x,
        y: result.cursor.y,
        onCapturedDisplay: result.cursor.onCapturedDisplay,
        cursorDisplayIndex: result.cursor.cursorDisplayIndex,
        capturedDisplayIndex: result.cursor.capturedDisplayIndex,
      }
    }
    if (result.calibration) {
      payload.imageSize = {
        width: result.calibration.imageOutWidth,
        height: result.calibration.imageOutHeight,
      }
    }
    return payload
  }

  private async _controlScreen(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const action = String(args.action ?? '').trim()
    if (!action) return { error: 'missing_action' }

    // Pre-flight Accessibility permission check for the actions that need it.
    // `osascript … System Events … click/keystroke/key code` silently no-ops
    // when AX permission is missing, leaving the agent to wonder why nothing
    // happened. We probe AXIsProcessTrusted up front and return a structured
    // error so the model can verbally guide the user to grant permission.
    const NEEDS_AX = action === 'click' || action === 'double_click' || action === 'type' || action === 'key' || action === 'scroll'
    if (NEEDS_AX) {
      const trusted = await isAccessibilityTrusted()
      if (!trusted) {
        return {
          error: 'accessibility_denied',
          message:
            'macOS has not granted Accessibility permission to this app. ' +
            'Tell the user to open System Settings → Privacy & Security → Accessibility, ' +
            'enable the Rax entry, then retry. The action was not performed.',
        }
      }
    }

    try {
      switch (action) {
        case 'click': {
          const target = this._resolveClickTarget(args)
          if ('error' in target) return target
          const button = args.button === 'right' ? 'right' : 'left'
          await runMouseEvent({ kind: 'click', x: target.pt.x, y: target.pt.y, button, clicks: 1 })
          return {
            ok: true,
            action: 'click',
            x: target.x,
            y: target.y,
            unit: target.unit,
            button,
            globalPoint: { x: target.pt.x, y: target.pt.y },
            calibrated: target.pt.calibrated,
          }
        }
        case 'double_click': {
          const target = this._resolveClickTarget(args)
          if ('error' in target) return target
          await runMouseEvent({ kind: 'click', x: target.pt.x, y: target.pt.y, button: 'left', clicks: 2 })
          return {
            ok: true,
            action: 'double_click',
            x: target.x,
            y: target.y,
            unit: target.unit,
            globalPoint: { x: target.pt.x, y: target.pt.y },
            calibrated: target.pt.calibrated,
          }
        }
        case 'type': {
          const text = String(args.text ?? '')
          if (!text) return { error: 'missing_text' }
          // Long runs and non-ASCII (emoji, accents): clipboard paste path is
          // both fast and unicode-correct. Short ASCII: AppleScript keystroke
          // — fine for plain characters, doesn't depend on the AX layer for
          // anything more than activating the focused text field.
          if (text.length >= 24 || /[^\x20-\x7E]/.test(text)) {
            const ok = await typeViaPaste(text)
            if (ok) return { ok: true, action: 'type', length: text.length, mode: 'paste' }
            // Fall through to keystroke if paste failed.
          }
          await runKeyEvent({ kind: 'ascii', text })
          return { ok: true, action: 'type', length: text.length, mode: 'keystroke' }
        }
        case 'key': {
          const key = String(args.key ?? '').trim()
          if (!key) return { error: 'missing_key' }
          const modifiers = Array.isArray(args.modifiers) ? args.modifiers as string[] : []
          const keyCode = resolveKeyCode(key)
          if (keyCode === null) {
            // Single-char key with no virtual key code — route through the
            // ASCII keystroke path so modifiers still apply (e.g. Cmd+s).
            if (key.length === 1) {
              await runKeyEvent({ kind: 'ascii', text: key, modifiers })
              return { ok: true, action: 'key', key, modifiers, mode: 'keystroke' }
            }
            return { error: 'unknown_key', key }
          }
          await runKeyEvent({ kind: 'keycode', keyCode, modifiers })
          return { ok: true, action: 'key', key, modifiers, keyCode, mode: 'cgevent' }
        }
        case 'scroll': {
          const dy = clampInt(args.dy, -10_000, 10_000, 0)
          const dx = clampInt(args.dx, -10_000, 10_000, 0)
          if (dy === 0 && dx === 0) return { error: 'missing_delta' }
          // Real scroll-wheel event via the CoreGraphics event system. Arrow
          // keys (the previous implementation) move text caret / selection in
          // most apps and do not actually scroll the view. CG scroll events
          // are how the trackpad / mouse wheel deliver scroll, so they work
          // uniformly in browsers, Mail, Finder, IDEs, etc. Pixel units —
          // positive dy scrolls content down (page moves up), matching the
          // tool's documented contract.
          const jxa = SCROLL_JXA
          await runCmd('/usr/bin/osascript', ['-l', 'JavaScript', '-e', jxa], 5000, {
            RAX_SCROLL_DX: String(dx),
            RAX_SCROLL_DY: String(dy),
          })
          return { ok: true, action: 'scroll', dx, dy }
        }
        case 'cursor_position': {
          // Cursor coords in screen-pixels with top-left origin so they match
          // the screenshot we hand the model. JXA + AppKit ship with every
          // macOS — no Python or extra deps required (stock macOS no longer
          // ships PyObjC and a clean install doesn't even have python3).
          const jxa = [
            "ObjC.import('AppKit');",
            '(function(){',
            '  var primary = $.NSScreen.screens.objectAtIndex(0);',
            '  var f = primary.frame;',
            '  var loc = $.NSEvent.mouseLocation;',
            '  var cx_pt = loc.x - f.origin.x;',
            '  var cy_top_pt = (f.origin.y + f.size.height) - loc.y;',
            '  var scale = primary.backingScaleFactor;',
            '  return Math.floor(cx_pt * scale) + " " + Math.floor(cy_top_pt * scale);',
            '})();',
          ].join('\n')
          const out = await runCmd('/usr/bin/osascript', ['-l', 'JavaScript', '-e', jxa], 5000)
          const [xs, ys] = out.trim().split(/\s+/)
          return { ok: true, x: Number(xs) || 0, y: Number(ys) || 0, origin: 'top-left', units: 'pixels' }
        }
        default:
          return { error: 'unknown_action', action }
      }
    } catch (err) {
      // The action threw — most likely osascript failed or CGEvent was rejected.
      // AX trust can be the underlying cause (e.g. user revoked it between turns),
      // so invalidate the cache so the next attempt re-probes and returns a
      // clean accessibility_denied if that's really what happened.
      invalidateAxTrustCache()
      return { error: 'control_failed', message: (err as Error).message }
    }
  }

  /**
   * Resolve click/double_click x,y into a global point, honoring the
   * coordinate unit:
   *   - 'px' (default): image-pixel coords of the most recent rax_screenshot
   *     — the classic flow, translated via lastCalibration.
   *   - 'norm1000': scale-free 0-1000 proportions of the latest screen-share
   *     STREAM frame (Gemini share mode reads targets off live frames whose
   *     exact pixel size the model never learns). Resolved against
   *     streamCalibration, falling back to the screenshot calibration.
   *
   * An explicit `calibration` object in the args (injected by the realtime
   * sessions' grounded-click path, never by the model) pins the mapping to
   * the EXACT capture the coordinates were read from — immune to the shared
   * caches being overwritten by a concurrent stream frame or going stale
   * across backend switches.
   */
  private _resolveClickTarget(
    args: Record<string, unknown>,
  ): { x: number; y: number; unit: 'px' | 'norm1000'; pt: { x: number; y: number; calibrated: boolean } } | { error: string; message?: string } {
    const unit = args.unit === 'norm1000' ? 'norm1000' : 'px'
    const calOverride = parseCalibration(args.calibration)
    if (unit === 'norm1000') {
      const nx = clampInt(args.x, 0, 1000, -1)
      const ny = clampInt(args.y, 0, 1000, -1)
      if (nx < 0 || ny < 0) return { error: 'missing_coords' }
      const cal = calOverride ?? this.streamCalibration ?? this.lastCalibration
      if (!cal) {
        return {
          error: 'no_calibration',
          message:
            'No screen frame has been captured yet — norm1000 coordinates need a live screen-share frame or a rax_screenshot first.',
        }
      }
      const px = Math.round((nx / 1000) * cal.imageOutWidth)
      const py = Math.round((ny / 1000) * cal.imageOutHeight)
      return { x: nx, y: ny, unit, pt: this._imagePxToGlobalPt(px, py, cal) }
    }
    const x = clampInt(args.x, 0, 100_000, -1)
    const y = clampInt(args.y, 0, 100_000, -1)
    if (x < 0 || y < 0) return { error: 'missing_coords' }
    return { x, y, unit, pt: this._imagePxToGlobalPt(x, y, calOverride ?? this.lastCalibration) }
  }

  /**
   * Translate an image-pixel coordinate from a capture's calibration into
   * a global display-point coordinate suitable for CGEventPost.
   *
   * When there is no cached calibration (no screenshot has been taken in this
   * session yet), fall through to interpreting the coordinates as global
   * points directly — which preserves the old behavior for the single-display
   * non-Retina-no-downscale case. Mark `calibrated=false` so the caller can
   * surface this to the model in the response.
   */
  private _imagePxToGlobalPt(
    x: number,
    y: number,
    cal: CaptureCalibration | null = this.lastCalibration,
  ): { x: number; y: number; calibrated: boolean } {
    if (!cal) return { x, y, calibrated: false }
    const sxX = cal.displayPointWidth / cal.imageOutWidth
    const sxY = cal.displayPointHeight / cal.imageOutHeight
    const gx = cal.displayOriginX + x * sxX
    const gy = cal.displayOriginY + y * sxY
    return { x: gx, y: gy, calibrated: true }
  }

  private _setDock(payload: Record<string, unknown>): Record<string, unknown> {
    // Explicit boolean sets the state; anything else toggles. 'user' cause:
    // the model only calls this on behalf of an explicit ask, so the choice
    // is sticky (no auto-tuck for a dock the user asked to see).
    const requested = typeof payload.visible === 'boolean' ? payload.visible : undefined
    const visible = this.deps.setDockVisible(requested, 'user')
    return {
      ok: true,
      visible,
      message: visible
        ? 'Agents dock is now on screen.'
        : 'Agents dock is now hidden.',
    }
  }

  private _describeSelf(): Record<string, unknown> {
    return {
      productName: 'Rax',
      role: 'voice orb — conductor of a five-agent crew',
      crew: [
        { name: 'Max', tagline: 'the heavy lifter' },
        { name: 'Alex', tagline: 'the architect' },
        { name: 'Luna', tagline: 'the night owl' },
        { name: 'Nova', tagline: 'the spark' },
        { name: 'Zara', tagline: 'the closer' },
      ],
      capabilities: [
        'full Claude Code toolbelt (Bash, Read, Edit, Write, WebSearch, WebFetch, etc.) on the user\'s machine',
        'see the live state of every crew member (status, working directory, recent messages, last tool, last error)',
        'dispatch work to any of the five crew members by name (rax_send_to_tab / rax_send_to_tab_and_wait) and pull them up on screen (rax_focus_tab)',
        'see the user\'s screen (rax_screenshot) and drive the cursor / keyboard (rax_control_screen)',
      ],
      hostUser: process.env.USER || null,
      home: homedir(),
      defaultProjectPath: this.deps.getProjectPath(),
      platform: process.platform,
    }
  }
}

// ─── Helpers ───

function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let total = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > maxBytes) {
        reject(new Error(`Body exceeds ${maxBytes} bytes`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', reject)
  })
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' ? v : Number.parseInt(String(v ?? ''), 10)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(n)))
}

/**
 * Validate a caller-supplied CaptureCalibration (the grounded-click paths
 * forward the calibration of the exact screenshot they searched). Returns
 * null unless every geometric field is a usable finite number — a malformed
 * object must fall back to the caches, not produce NaN click coordinates.
 */
function parseCalibration(v: unknown): CaptureCalibration | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const nums = [
    'sourcePxWidth', 'sourcePxHeight', 'imageOutWidth', 'imageOutHeight',
    'displayPointWidth', 'displayPointHeight', 'displayOriginX', 'displayOriginY',
  ] as const
  for (const k of nums) {
    const n = o[k]
    if (typeof n !== 'number' || !Number.isFinite(n)) return null
  }
  if ((o.imageOutWidth as number) <= 0 || (o.imageOutHeight as number) <= 0) return null
  if ((o.displayPointWidth as number) <= 0 || (o.displayPointHeight as number) <= 0) return null
  return {
    capturedDisplayIndex: typeof o.capturedDisplayIndex === 'number' ? o.capturedDisplayIndex : 1,
    sourcePxWidth: o.sourcePxWidth as number,
    sourcePxHeight: o.sourcePxHeight as number,
    imageOutWidth: o.imageOutWidth as number,
    imageOutHeight: o.imageOutHeight as number,
    displayPointWidth: o.displayPointWidth as number,
    displayPointHeight: o.displayPointHeight as number,
    displayOriginX: o.displayOriginX as number,
    displayOriginY: o.displayOriginY as number,
    backingScaleFactor: typeof o.backingScaleFactor === 'number' && Number.isFinite(o.backingScaleFactor)
      ? o.backingScaleFactor
      : 1,
  }
}

/**
 * CGEventScrollWheel via JXA. Pixel-grained, two-axis. Real scroll, not the
 * arrow-key approximation we were using before — that approximation moved the
 * text caret in most apps instead of scrolling the view.
 *
 * The scroll event is posted at HID-level so it reaches whatever window is
 * currently under the pointer or focused, matching mouse-wheel semantics.
 *
 * Inputs (env): RAX_SCROLL_DX, RAX_SCROLL_DY (signed ints, screen pixels).
 * dy>0 = content scrolls down (page moves up), matching tool contract.
 */
const SCROLL_JXA = [
  "ObjC.import('CoreGraphics');",
  '(function () {',
  '  var env = $.NSProcessInfo.processInfo.environment;',
  "  var dx = parseInt(ObjC.unwrap(env.objectForKey('RAX_SCROLL_DX')) || '0', 10) | 0;",
  "  var dy = parseInt(ObjC.unwrap(env.objectForKey('RAX_SCROLL_DY')) || '0', 10) | 0;",
  // Negate dy: kCGScrollEventUnitPixel uses upward-positive convention, but
  // our public contract is "positive dy = content scrolls DOWN" (i.e. wheel
  // rolls toward user). Flip here so the JXA call site stays the source of
  // truth for the convention.
  '  var wheel1 = -dy;',
  '  var wheel2 = -dx;',
  // Break large deltas into ~80px chunks so apps with momentum scrolling
  // don't see one giant impulse and overscroll.
  '  var step = 80;',
  '  function postOnce(d1, d2) {',
  '    var ev = $.CGEventCreateScrollWheelEvent2($(), 0 /* kCGScrollEventUnitPixel */, 2, d1, d2, 0);',
  '    if (!ev || ev.isNil && ev.isNil()) return;',
  '    $.CGEventPost(0 /* kCGHIDEventTap */, ev);',
  '  }',
  '  function chunk(total) {',
  '    var sign = total < 0 ? -1 : 1;',
  '    var rem = Math.abs(total);',
  '    var pieces = [];',
  '    while (rem > 0) {',
  '      var take = rem > step ? step : rem;',
  '      pieces.push(sign * take);',
  '      rem -= take;',
  '    }',
  '    return pieces;',
  '  }',
  '  var ys = chunk(wheel1);',
  '  var xs = chunk(wheel2);',
  '  var n = Math.max(ys.length, xs.length, 1);',
  '  for (var i = 0; i < n; i++) {',
  '    postOnce(ys[i] || 0, xs[i] || 0);',
  '  }',
  '  return "ok";',
  '})();',
].join('\n')

/**
 * Save the user's clipboard, write `text` to it, send Cmd+V, then restore
 * the clipboard. ~5–20× faster than per-char keystroke for long runs and
 * handles non-ASCII (emoji, accents) which `keystroke` cannot.
 *
 * Returns true on success, false if anything went wrong (in which case the
 * caller falls back to keystroke).
 */
async function typeViaPaste(text: string): Promise<boolean> {
  // 1. Snapshot existing clipboard via pbpaste.
  let saved = ''
  let savedOk = true
  try {
    saved = await runCmd('/usr/bin/pbpaste', [], 3000)
  } catch {
    savedOk = false
  }
  // 2. Push payload to clipboard.
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn('/usr/bin/pbcopy', [], { stdio: ['pipe', 'ignore', 'pipe'] })
      let err = ''
      child.stderr.on('data', (c: Buffer) => { err += c.toString() })
      child.on('error', reject)
      child.on('close', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`pbcopy exited ${code}: ${err.slice(0, 200)}`))
      })
      child.stdin.write(text)
      child.stdin.end()
    })
  } catch {
    return false
  }
  // 3. Paste via Cmd+V (use System Events keystroke v with command down —
  //    matches what the user would do manually and is honoured by every Mac
  //    text input field).
  try {
    await runCmd(
      '/usr/bin/osascript',
      ['-e', 'tell application "System Events" to keystroke "v" using {command down}'],
      5000,
    )
  } catch {
    // Even if paste failed, try to restore the clipboard so we don't trash
    // the user's saved data.
    if (savedOk) await restoreClipboard(saved)
    return false
  }
  // 4. Restore clipboard. Brief delay so the destination has time to
  //    actually consume the paste before we overwrite the data — pasting is
  //    synchronous in most apps but the system pasteboard write is racy.
  if (savedOk) {
    await new Promise((r) => setTimeout(r, 80))
    await restoreClipboard(saved)
  }
  return true
}

async function restoreClipboard(text: string): Promise<void> {
  try {
    await new Promise<void>((resolve) => {
      const child = spawn('/usr/bin/pbcopy', [], { stdio: ['pipe', 'ignore', 'ignore'] })
      child.on('error', () => resolve())
      child.on('close', () => resolve())
      child.stdin.write(text)
      child.stdin.end()
    })
  } catch {}
}

/** Run a child process and return stdout. Rejects on non-zero exit or timeout. */
function runCmd(cmd: string, args: string[], timeoutMs: number, extraEnv?: NodeJS.ProcessEnv): Promise<string> {
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

// ─── CGEvent-based input driver ──────────────────────────────────────────
//
// AppleScript's `tell application "System Events" to click at {x, y}` goes
// through the Accessibility hierarchy. That layer is unreliable in browsers,
// Electron apps, and any app with custom hit testing — clicks can silently
// land on the wrong element, the wrong window, or be dropped entirely. The
// trackpad/mouse don't have this problem because they post events directly
// at the HID level via CGEventPost, which goes below AX. The orb's existing
// scroll path proves this works (CGEventCreateScrollWheelEvent2). These
// driver functions extend the same approach to clicks and keystrokes.
//
// Everything below runs JXA — same `osascript -l JavaScript` mechanism used
// elsewhere in this file — so no extra runtime is required.

interface MouseEventSpec {
  kind: 'click'
  x: number
  y: number
  button: 'left' | 'right'
  clicks: 1 | 2
}

const MOUSE_EVENT_JXA = [
  "ObjC.import('CoreGraphics');",
  '(function () {',
  '  var env = $.NSProcessInfo.processInfo.environment;',
  "  var x = parseFloat(ObjC.unwrap(env.objectForKey('RAX_MX')) || '0');",
  "  var y = parseFloat(ObjC.unwrap(env.objectForKey('RAX_MY')) || '0');",
  "  var button = ObjC.unwrap(env.objectForKey('RAX_MBUTTON')) || 'left';",
  "  var clicks = parseInt(ObjC.unwrap(env.objectForKey('RAX_MCLICKS')) || '1', 10);",
  '  var pt = $.CGPointMake(x, y);',
  // kCGEventSourceStateCombinedSessionState = 0 — combine our synth state with the live HID state.
  '  var source = $.CGEventSourceCreate(0);',
  // Move cursor first so hover-sensitive controls (links, buttons with hover
  // tints) update before the click lands. Some apps drop the first click
  // entirely if no recent MouseMoved arrived at that location.
  '  var move = $.CGEventCreateMouseEvent(source, 5 /* kCGEventMouseMoved */, pt, 0);',
  '  $.CGEventPost(0 /* kCGHIDEventTap */, move);',
  // Tiny settle so the AppKit run-loop has a chance to redraw hover state.
  '  delay(0.012);',
  '  var isRight = (button === "right");',
  '  var downType = isRight ? 3 /* kCGEventRightMouseDown */ : 1 /* kCGEventLeftMouseDown */;',
  '  var upType   = isRight ? 4 /* kCGEventRightMouseUp */   : 2 /* kCGEventLeftMouseUp */;',
  '  var cgBtn    = isRight ? 1 /* kCGMouseButtonRight */    : 0 /* kCGMouseButtonLeft */;',
  '  for (var i = 1; i <= clicks; i++) {',
  '    var down = $.CGEventCreateMouseEvent(source, downType, pt, cgBtn);',
  '    var up   = $.CGEventCreateMouseEvent(source, upType,   pt, cgBtn);',
  // kCGMouseEventClickState = 1 → tells the app this is the Nth click in a
  // sequence (1 = single, 2 = double, 3 = triple). Required for double-click
  // to register as a double-click instead of two singles.
  '    $.CGEventSetIntegerValueField(down, 1, i);',
  '    $.CGEventSetIntegerValueField(up,   1, i);',
  '    $.CGEventPost(0, down);',
  '    $.CGEventPost(0, up);',
  '    if (i < clicks) delay(0.04);',
  '  }',
  '  return "ok";',
  '})();',
].join('\n')

/**
 * Post a CGEvent mouse event at the given GLOBAL display-point coordinates.
 * Caller is responsible for translating image-pixel coordinates into points
 * (use `OrbRpcServer._imagePxToGlobalPt`).
 */
async function runMouseEvent(spec: MouseEventSpec): Promise<void> {
  await runCmd(
    '/usr/bin/osascript',
    ['-l', 'JavaScript', '-e', MOUSE_EVENT_JXA],
    5000,
    {
      RAX_MX: String(spec.x),
      RAX_MY: String(spec.y),
      RAX_MBUTTON: spec.button,
      RAX_MCLICKS: String(spec.clicks),
    },
  )
}

type KeyEventSpec =
  | { kind: 'keycode'; keyCode: number; modifiers: string[] }
  | { kind: 'ascii'; text: string; modifiers?: string[] }

/**
 * AppleScript key codes — same numbers CGEventCreateKeyboardEvent expects.
 * Layout-independent (these are HID-style virtual keys, not character codes).
 */
const KEY_CODES: Record<string, number> = {
  'return': 36, 'enter': 36, 'tab': 48, 'space': 49, 'delete': 51, 'backspace': 51,
  'escape': 53, 'esc': 53, 'left': 123, 'right': 124, 'down': 125, 'up': 126,
  'home': 115, 'end': 119, 'pageup': 116, 'pagedown': 121,
  'forwarddelete': 117, 'fwddelete': 117, 'fn-delete': 117,
  'f1': 122, 'f2': 120, 'f3': 99, 'f4': 118, 'f5': 96, 'f6': 97, 'f7': 98,
  'f8': 100, 'f9': 101, 'f10': 109, 'f11': 103, 'f12': 111,
}

export function resolveKeyCode(key: string): number | null {
  const code = KEY_CODES[key.toLowerCase()]
  return typeof code === 'number' ? code : null
}

/**
 * CGEventFlags bitfield values for modifier keys (CoreGraphics).
 * Used by CGEventSetFlags to attach modifiers to key/click events.
 *   kCGEventFlagMaskShift     = 1 << 17
 *   kCGEventFlagMaskControl   = 1 << 18
 *   kCGEventFlagMaskAlternate = 1 << 19
 *   kCGEventFlagMaskCommand   = 1 << 20
 */
function modifiersToFlags(modifiers: string[]): number {
  let flags = 0
  for (const m of modifiers) {
    switch (m.toLowerCase()) {
      case 'shift':                              flags |= 1 << 17; break
      case 'ctrl': case 'control':               flags |= 1 << 18; break
      case 'alt': case 'option': case 'opt':     flags |= 1 << 19; break
      case 'cmd': case 'command': case 'meta':   flags |= 1 << 20; break
    }
  }
  return flags
}

// CGEvent driver for virtual-key keystrokes (Return, Tab, F1, arrow keys,
// Cmd+S, etc.). Named keys with virtual key codes are what fail most often
// in AppleScript keystroke — CGEvent posts them at HID level and they
// "always work" in every app the user can interact with.
//
// For typing actual character runs we don't try to do CGEvent Unicode
// injection — JXA can't easily allocate the UniChar buffer the function
// requires. Instead, long/non-ASCII typing goes through the pbcopy + Cmd+V
// path (`typeViaPaste`), and the rare short-ASCII fallback uses AppleScript
// keystroke (which is reliable for plain ASCII even when full keystroke
// commands are flaky for complex input).
const KEYCODE_EVENT_JXA = [
  "ObjC.import('CoreGraphics');",
  '(function () {',
  '  var env = $.NSProcessInfo.processInfo.environment;',
  "  var kc = parseInt(ObjC.unwrap(env.objectForKey('RAX_KCODE')) || '0', 10);",
  "  var flags = parseInt(ObjC.unwrap(env.objectForKey('RAX_KFLAGS')) || '0', 10);",
  '  var source = $.CGEventSourceCreate(0);',
  '  var down = $.CGEventCreateKeyboardEvent(source, kc, true);',
  '  var up   = $.CGEventCreateKeyboardEvent(source, kc, false);',
  '  if (flags) { $.CGEventSetFlags(down, flags); $.CGEventSetFlags(up, flags); }',
  '  $.CGEventPost(0 /* kCGHIDEventTap */, down);',
  // Tiny gap so AppKit's run-loop has a chance to dispatch the down event
  // before the up arrives — some apps coalesce them otherwise.
  '  delay(0.008);',
  '  $.CGEventPost(0, up);',
  '  return "ok";',
  '})();',
].join('\n')

async function runKeyEvent(spec: KeyEventSpec): Promise<void> {
  if (spec.kind === 'keycode') {
    await runCmd(
      '/usr/bin/osascript',
      ['-l', 'JavaScript', '-e', KEYCODE_EVENT_JXA],
      5000,
      {
        RAX_KCODE: String(spec.keyCode),
        RAX_KFLAGS: String(modifiersToFlags(spec.modifiers)),
      },
    )
    return
  }
  // Short ASCII fallback — single key with no virtual key code (e.g. /key x
  // with no modifier mapping), or the type-action fallback when paste failed.
  // AppleScript keystroke is reliable for short ASCII; the CGEvent unicode
  // path requires raw UInt16 buffer allocation JXA can't easily express.
  const safe = spec.text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  const mods = spec.modifiers && spec.modifiers.length
    ? ' using {' + spec.modifiers.map(modifierToAppleScript).filter(Boolean).join(', ') + '}'
    : ''
  await runCmd(
    '/usr/bin/osascript',
    ['-e', `tell application "System Events" to keystroke "${safe}"${mods}`],
    10_000,
  )
}

function modifierToAppleScript(m: string): string {
  switch (m.toLowerCase()) {
    case 'cmd': case 'command': case 'meta': return 'command down'
    case 'shift': return 'shift down'
    case 'alt': case 'option': case 'opt': return 'option down'
    case 'ctrl': case 'control': return 'control down'
    default: return ''
  }
}

/**
 * Tag a crew dispatch as coming from the voice orb. Every orb backend (CLI
 * MCP, direct API, Grok, Gemini) funnels through /send_to_tab — and direct
 * user messages never do — so this is the one reliable place to mark the
 * sender. The crew agents' system prompt (see buildCrewAgentHint in
 * run-manager.ts) teaches them: <orb_dispatch> = the user's voice assistant
 * speaking on the user's behalf, anything else = the user typing directly.
 *
 * Also the backstop for the project-path guarantee: the direct backends
 * stamp the directory in withCrewHandoff (orb-direct-tools.ts), but the CLI
 * orb's MCP path sends a bare prompt — if no "Project directory:" line made
 * it in upstream, stamp the target tab's cwd here so every dispatch names
 * the project it belongs to.
 */
function wrapOrbDispatch(prompt: string, projectDir: string): string {
  if (prompt.startsWith('<orb_dispatch>')) return prompt
  const stamped = !projectDir || prompt.includes('Project directory:')
    ? prompt
    : `${prompt}\n\n(Project directory: ${projectDir} — this is the project we're working on; resolve paths against it unless the task says otherwise.)`
  return `<orb_dispatch>\n${stamped}\n</orb_dispatch>`
}

function expandHomeAlias(p: string): string {
  if (!p) return ''
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return homedir() + p.slice(1)
  return p
}

/**
 * AXIsProcessTrusted probe — returns true when this process can post synthetic
 * events through System Events. Briefly cached so we don't shell out 6× on a
 * single turn, but short enough that a freshly-granted permission becomes
 * visible within seconds. Always cache `false` results for less time than
 * `true` — granting permission is the case where the user is actively waiting
 * for the next action to succeed. We pass `kAXTrustedCheckOptionPrompt=false`
 * (no system dialog) since the agent asks the user verbally instead.
 */
let axTrustCache: { value: boolean; checkedAt: number } | null = null
const AX_CACHE_TTL_TRUSTED_MS = 5000
const AX_CACHE_TTL_DENIED_MS = 1500

function invalidateAxTrustCache(): void {
  axTrustCache = null
}

async function isAccessibilityTrusted(): Promise<boolean> {
  const now = Date.now()
  if (axTrustCache) {
    const ttl = axTrustCache.value ? AX_CACHE_TTL_TRUSTED_MS : AX_CACHE_TTL_DENIED_MS
    if (now - axTrustCache.checkedAt < ttl) {
      return axTrustCache.value
    }
  }
  let trusted = false
  try {
    const out = await runCmd(
      '/usr/bin/osascript',
      [
        '-l',
        'JavaScript',
        '-e',
        "ObjC.import('AppKit'); ObjC.import('ApplicationServices'); var opts = $.NSDictionary.dictionaryWithObjectForKey(false, 'AXTrustedCheckOptionPrompt'); $.AXIsProcessTrustedWithOptions(opts) ? 'yes' : 'no'",
      ],
      4000,
    )
    trusted = /yes/i.test(out.trim())
  } catch {
    // If the probe itself fails (sandbox denial, unusual host), assume the
    // platform layer will surface its own error — don't block the action.
    trusted = true
  }
  axTrustCache = { value: trusted, checkedAt: now }
  return trusted
}
