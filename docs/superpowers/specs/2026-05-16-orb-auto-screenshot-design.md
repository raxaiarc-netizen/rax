# Voice-orb auto-attached screenshots

**Status**: design — ready for plan
**Date**: 2026-05-16
**Surfaces**: voice orb (Rax `src/main/orb/*`, `src/renderer/orb/*`)

---

## Problem

The voice orb can already see the user's screen — but only when its agent decides to call the `rax_screenshot` MCP tool. That costs a round-trip: model emits tool-call → MCP shim → screencapture → image returned → model reasons over it. On every voice turn that's actually about something visible on the user's screen ("look at this", "what does that say", "is this right"), the user waits ~2-3s for the tool round-trip on top of whisper + TTS latency.

Goal: when the transcript indicates the user is referring to their screen, **capture the screenshot before the model sees the turn**, attach it as an image content block in the same stream-json `user` message, and let the model answer from pixel-zero with no tool round-trip.

## Non-goals

- Replace `rax_screenshot` as an MCP tool. Follow-up captures (after `rax_control_screen`, or when the user references a different display) still go through the tool.
- Multi-language detection. Regex catalog is English only; the Haiku fallback will pass non-English transcripts through but with degraded accuracy.
- Screen-change diffing / suppression. Anthropic prompt caching already amortizes repeated images across consecutive turns.
- A UI toggle in Settings. Configurable via env var only in v1.
- Telemetry / capture-rate counters.

## High-level pipeline

```
user speaks → Option+R release → whisper transcribes
              │
              ▼
       window.orb.submitTurn(text)  [renderer → main IPC]
              │
              ▼
   ┌──────────────────────────────────────────────────────┐
   │  auto-screenshot pipeline (new, main process)        │
   │                                                       │
   │  ① classifyTranscript(text) → 'high'|'ambiguous'|-   │
   │                                                       │
   │  high    → captureScreenForOrb() ────────────────┐   │
   │                                                   ▼   │
   │  ambig   → captureScreenForOrb()  ─┬─▶ Promise.all   │
   │            haiku.verify(text)     ─┘                  │
   │              ↓                                        │
   │              if no → drop capture, return null        │
   │                                                       │
   │  none    → return null                                │
   └──────────────────────────────────────────────────────┘
              │
              ▼
   OrbSession.submitTurn(text, attachment?)
   stream-json user.message.content =
     [{type:'image', source:{type:'base64', media_type, data}},
      {type:'text', text:'<tabs_block>\n\n<transcript>'}]  when attachment
     [{type:'text', text:'<tabs_block>\n\n<transcript>'}]  otherwise
              │
              ▼
         claude reads pixels from token zero
```

## Architecture decisions

| # | Decision | Choice |
|---|----------|--------|
| 1 | Detection strategy | Hybrid: regex catalog (HIGH / AMBIGUOUS tiers) + Haiku 4.5 ambiguity filter for the AMBIGUOUS tier only |
| 2 | Capture timing | After whisper transcription and after detection fires. No speculative capture. |
| 3 | Phrase scope | All four categories: direct references, action+deictic, visual queries, ambiguous deictic |
| 4 | Display | Cursor-containing display, with the existing red-ring cursor annotation (JXA pipeline) |
| 5 | Feedback | One-shot 280ms rim-pulse on the orb. No earcon. |
| 6 | Content-block order | `image` block first, then `text` (Anthropic recommendation when text refers to the image) |
| 7 | Existing MCP tool | Kept. Used for follow-up captures. Tool description trimmed (no longer suggests it for initial captures). |
| 8 | Voice-tab broadcast | A small "screenshot attached" chip appears on the user message in the pinned read-only voice tab |
| 9 | Config | Env var `RAX_ORB_AUTO_SCREENSHOT` ∈ `enabled` (default) \| `regex-only` \| `disabled`. No Settings UI in v1. |
| 10 | Anthropic SDK | Required for AMBIGUOUS tier. Falls back to "skip capture" when key/SDK missing. |

## File surfaces

### New files

#### `src/main/orb/screen-capture.ts`

Pure capture function lifted out of `OrbRpcServer._screenshot`:

```ts
export interface CaptureResult {
  base64: string
  mimeType: 'image/png'
  bytes: number
  display: number | 'main'
  cursor?: {
    x: number
    y: number
    onCapturedDisplay: boolean
    cursorDisplayIndex: number | null
    capturedDisplayIndex: number | null
  }
}

export async function captureScreenForOrb(opts?: {
  display?: 'cursor' | number
  downscale?: boolean
  annotateCursor?: boolean
}): Promise<CaptureResult>
```

Implementation moves the `screencapture` + JXA cursor-annotate + `sips -Z 1600` chain from `orb-rpc.ts` lines ~336-435 verbatim, with the only behavioral change being a new `display: 'cursor'` mode that resolves to the cursor-containing display before passing `-D <n>` to `screencapture`.

Cursor-display resolution: re-use the same JXA bridge that already computes `cursor_display_index` in the existing `CURSOR_ANNOTATE_JXA` block. Extract that into a small pre-step that returns the display index, then pass it to `screencapture` and the annotator.

#### `src/main/orb/intent-regex.ts`

```ts
export type DetectionTier = 'high' | 'ambiguous' | 'none'

export interface DetectionResult {
  tier: DetectionTier
  hits: string[]      // names of matched patterns (for logging)
  category?: string   // 'visual-verb' | 'screen-mention' | ... (high tier only)
}

export function classifyTranscript(text: string): DetectionResult
```

**HIGH-tier patterns (capture without Haiku):**

```
// (A) Visual verbs + deictic
/\b(look|see|check|watch|peek|glance|view|stare)\s+(at\s+)?(this|that|here|it|these|those|the\s+\w+)\b/i
/\b(check\s+(this|that)\s+out|take\s+a\s+look|have\s+a\s+look)\b/i

// (B) Explicit screen mentions
/\b(my\s+)?(screen|display|monitor|desktop)\b/i
/\bon\s+(?:the\s+)?(screen|display)\b/i
/\bthis\s+(window|tab|app|page|view|panel|sidebar|popup|dialog|modal|toolbar|menu|drawer|notification|toast|banner|hud)\b/i

// (C) Read / recite requests
/\bread\s+(this|that|it|out|aloud|to\s+me)\b/i
/\bwhat\s+does\s+(this|that|it)\s+say\b/i
/\btell\s+me\s+what\s+(this|that|it|the\s+\w+)\s+says\b/i
/\bread\s+(what'?s|whats)\s+(here|on|in|at)\b/i

// (D) Cursor / pointer / element refs
/\bwhere\s+(i'?m|i\s+am)\s+(pointing|hovering)\b/i
/\b(my\s+cursor|the\s+cursor|where\s+the\s+cursor\s+is)\b/i
/\b(this|that|these|those|the)\s+(button|icon|link|field|box|menu|option|row|column|cell|section|item|element|tile|card|chip|tab|pill|toggle|switch|slider|checkbox|radio|dropdown|input|textarea|text|image|chart|graph|diagram|number|date|time|error|message|warning|notification|badge|highlight|selection|tooltip)\b/i

// (E) Action verbs + deictic
/\b(click|tap|press|hit|push|select|hover\s+over|drag)\s+(this|that|here|it|on\s+(this|that)|the\s+\w+)\b/i
/\b(open|close|expand|collapse|minimize|maximize)\s+(this|that)\b/i
/\bscroll\s+(?:down|up|to|over)\s+(?:here|this|that|to\s+(this|that))\b/i

// (F) Visual queries / judgments
/\b(is|does)\s+(this|that|it)\s+(right|correct|wrong|red|green|blue|yellow|orange|purple|pink|black|white|gray|grey|highlighted|selected|enabled|disabled|loading|empty|full|done|finished|broken|working|valid|invalid|visible|hidden|expanded|collapsed)\b/i
/\bdoes\s+(this|that|it)\s+look\s+(right|correct|good|wrong|broken|off|weird|odd)\b/i
/\bwhat\s+(color|font|size|number|value|label|name)\s+is\s+(this|that|it)\b/i
```

**AMBIGUOUS-tier patterns (Haiku verifies before capture):**

```
// (G) Bare ambiguous deictic
/\bwhat'?s\s+(this|that|it)\b/i
/\bwhat\s+is\s+(this|that|it)\b/i
/\bis\s+(this|that|it)\s+\w+ing\b/i
/\b(this|that|it)\s+(isn'?t|is\s+not|doesn'?t|did\s+not|won'?t|wasn'?t)\s+\w+\b/i
/\bwhy\s+(is|isn'?t|doesn'?t)\s+(this|that|it)\b/i
/\b(this|that|it)\s+(broke|broken|crashed|failed|froze|hangs?|stopped|errored)\b/i
/\bdid\s+(this|that|it)\s+(finish|complete|work|load|save|run)\b/i

// (H) Bare location words at clause boundary
/\b(here|right\s+here|over\s+(?:here|there))\s*[?.!]?\s*$/i
```

Classification semantics:
- If **any** HIGH pattern matches → tier `'high'`.
- Else if **any** AMBIGUOUS pattern matches → tier `'ambiguous'`.
- Else → tier `'none'`.

Each pattern carries a stable name (e.g. `'visual-verb-deictic'`, `'screen-mention'`, `'bare-deictic-what-is'`) so logs and tests can assert on hits without depending on the regex text.

#### `src/main/orb/auto-screenshot.ts`

```ts
export interface AutoScreenshotDeps {
  haikuEnabled: boolean
  haikuClient?: HaikuVerifier  // injectable for tests
  capture?: typeof captureScreenForOrb  // injectable for tests
}

export interface AutoCaptureResult {
  attachment: { base64: string; mimeType: 'image/png' } | null
  tier: DetectionTier
  haikuVerdict?: { should_capture: boolean; reason: string }
  hits: string[]
  durationMs: number
}

export async function prepareAutoCapture(
  transcript: string,
  deps: AutoScreenshotDeps,
): Promise<AutoCaptureResult>
```

Behavior:
- `classifyTranscript(transcript)` first.
- `tier === 'none'` → return `{ attachment: null, tier: 'none', ... }`.
- `tier === 'high'` → `await captureScreenForOrb({display:'cursor'})`. On success return attachment; on capture failure return `attachment: null` with logged error.
- `tier === 'ambiguous'` → kick off `captureScreenForOrb` and `haikuClient.verify(transcript)` in parallel via `Promise.allSettled`. Wait up to 800ms for Haiku. Resolution:
  - Haiku says yes + capture succeeded → return attachment.
  - Haiku says yes + capture failed → return `attachment: null`, log.
  - Haiku says no → return `attachment: null`, drop capture buffer.
  - Haiku timed out / errored → return `attachment: null` (conservative).
  - `deps.haikuEnabled === false` (no API key) → ambiguous tier acts like 'none'.

#### `src/main/orb/haiku-verifier.ts`

```ts
export interface HaikuVerifier {
  verify(transcript: string): Promise<{ should_capture: boolean; reason: string }>
}

export function createHaikuVerifier(apiKey: string): HaikuVerifier
export function createNullVerifier(): HaikuVerifier  // always { should_capture: false }
```

`createHaikuVerifier` builds an `Anthropic` client (require `@anthropic-ai/sdk`; add to `package.json` if absent). Single `messages.create` call:

- `model: 'claude-haiku-4-5'`
- `max_tokens: 64`
- System prompt below, with `cache_control: { type: 'ephemeral' }`.
- Parses the response as JSON. Tolerant: if the model wraps it in prose, extract the first `{...}` substring.
- Total budget: 800ms wall-clock. Aborts on timeout.

System prompt (cached):

```
You are a fast classifier for a voice agent that may attach a screenshot
of the user's screen. Decide whether a transcript is referring to
something currently visible on the user's screen — i.e. the agent needs
to SEE the screen to answer.

Return ONLY JSON: {"should_capture": true|false, "reason": "<5 words"}

CAPTURE when the user means something visible right now:
 - "what's this", "what is that" pointing at on-screen UI
 - "is it loading", "did it finish" referring to visible state
 - "this isn't working", "why is that broken" — visible failure
 - "right here", "over there" — pointing at a location

DO NOT capture when:
 - "this" / "it" refers to something earlier in this conversation
   ("I had this idea", "the bug we discussed")
 - General knowledge ("what time is it", "what day is it") UNLESS the
   user explicitly means a clock visible on their screen
 - Abstract reasoning, no on-screen referent

When uncertain, prefer DO NOT capture.
```

User message: `Transcript: "<the transcript>"`.

### Modified files

#### `src/main/orb/orb-rpc.ts`

- `_screenshot` becomes ~10 lines that forward to `captureScreenForOrb` and re-shape the result into the existing RPC response. Behavior unchanged from the model's perspective.

#### `src/main/orb/orb-session.ts`

- `submitTurn(prompt: string)` → `submitTurn(prompt: string, attachment?: { base64: string; mimeType: string })`.
- When `attachment` is present, the `userMessage` content becomes:
  ```ts
  message: {
    role: 'user',
    content: [
      { type: 'image', source: { type: 'base64', media_type: attachment.mimeType, data: attachment.base64 } },
      { type: 'text', text: wrapped },
    ],
  }
  ```
- The `lastSnapshot` / `unchanged` short-circuit for the tabs block is preserved untouched — auto-attachment does not alter the tabs-snapshot diffing logic.
- `emit('event', { type: 'orb_user_turn', text: trimmed })` continues to fire with the user text only (no image base64 — keep IPC payloads small). When `attachment` is present, a separate `{type:'orb_user_attachment', kind:'screenshot', display:number, capturedAt:number}` event is emitted right before `orb_user_turn`. This single event is the source of truth for both the orb-window flash and the read-only voice-tab chip (see consumers below).
- System prompt (`ORB_SYSTEM_PROMPT`) gains a short "AUTO-ATTACHED SCREENSHOTS" section explaining that an attached image is the live screen view and that `rax_screenshot` is for follow-up captures only.
- The existing `rax_screenshot` tool description is trimmed: remove the "Use this whenever they say 'what is this', 'look at this', 'read this for me'" hint, since those phrases now auto-attach.

#### `src/main/index.ts`

- `ORB_SUBMIT_TURN` handler (~line 2225) wraps `orb.submitTurn(cleaned)` with the auto-capture pipeline:
  ```ts
  const result = await prepareAutoCapture(cleaned, autoCaptureDeps)
  await orb.submitTurn(cleaned, result.attachment ?? undefined)
  // OrbSession emits 'orb_user_attachment' internally before 'orb_user_turn'
  // when attachment is present — see orb-session.ts changes above.
  ```
- The existing orb-event fanout already forwards every emitted event both to the orb window (via `orbWindow.webContents.send`) and through `ORB_EVENT_BROADCAST` to the pill/fullscreen voice-tab mirror. Add `'orb_user_attachment'` to the broadcast-allowlist (the same filter that gates `orb_user_turn`, `error`, `orb_session_dead`). One event, two consumers.
- `autoCaptureDeps` is built once at app start. Reads `RAX_ORB_AUTO_SCREENSHOT` env var; selects `createHaikuVerifier` vs `createNullVerifier` based on `ANTHROPIC_API_KEY`.
- On startup, log one line summarising mode: `[OrbAutoSS] mode=hybrid haiku=enabled` / `mode=regex-only haiku=disabled (no ANTHROPIC_API_KEY)` / `mode=disabled (env var)`.

#### `src/preload/orb.ts`

- No new IPC channels. The `screenshot_attached` and `orb_user_attachment` events flow through the existing `onEvent` subscription.

#### `src/renderer/orb/App.tsx`

- New `flashAt` state (number | null). The existing `onEvent` switch gains a `case 'orb_user_attachment'`: `setFlashAt(Date.now())`. After 320ms, reset to null (so subsequent flashes are detectable even when `Date.now()` collides on the same millisecond).
- Pass `flashAt` to `<VoiceOrb>` via prop.

#### `src/renderer/orb/VoiceOrb.tsx`

- New prop: `flashAt?: number | null`.
- Inside the existing canvas render loop, the rim glow gains an extra additive term:
  ```ts
  const flashAge = flashAt ? (now - flashAt) : Infinity
  if (flashAge < 280) {
    const t = flashAge / 280
    const ease = 1 - (2 * t - 1) ** 2   // ease-in-out 0→1→0
    rimBrightness *= (1 + 0.6 * ease)
  }
  ```
- No new canvas layer / no DOM change.

### Voice-tab broadcast (read-only mirror)

`src/shared/types.ts` already exposes `ORB_EVENT_BROADCAST` (the fanout channel that mirrors orb events into the pill + fullscreen voice tabs). The new `'orb_user_attachment'` event must be added to the broadcast allowlist in `src/main/index.ts` (the same filter list as `orb_user_turn`).

In `src/renderer/stores/sessionStore.ts`, `applyOrbEvent` recognises `orb_user_attachment` and tags the most recent `user` message in the orb tab with a `{kind:'screenshot', capturedAt}` attachment marker.

In `src/renderer/components/ConversationView.tsx` and `src/renderer/fullscreen/MessagesPane.tsx`, the orb-variant `UserMessage` / `MessageRow` renders a tiny inline chip (Phosphor `Camera` icon + "screenshot attached") when the attachment marker is present. No image payload is shipped to the renderer — the chip is metadata only.

## Anthropic SDK dependency

`@anthropic-ai/sdk` may or may not already be in `package.json`. The implementation plan must:
1. Check `package.json` for `@anthropic-ai/sdk`. If absent, add as a runtime dep.
2. Pin to the version stream that supports `cache_control` on `system` blocks and `claude-haiku-4-5`.
3. The SDK call MUST use prompt caching on the system prompt (per Anthropic best practices for repeated tasks).

## Error handling matrix

| Failure | Behavior |
|---------|----------|
| `screencapture` non-zero exit | Log, `attachment: null`, no flash, no chip, submit text-only |
| JXA cursor-annotation failed | Submit with unmarked capture (matches existing `_screenshot`) |
| `sips` downscale failed | Submit un-downscaled capture (matches existing `_screenshot`) |
| Haiku API error / timeout >800ms | `attachment: null` (conservative) |
| Haiku returned non-JSON | `attachment: null` |
| `ANTHROPIC_API_KEY` unset at startup | `createNullVerifier()` — AMBIGUOUS tier becomes a no-op. Log once. |
| Anthropic SDK not installed | Build fails. Caught in implementation plan, not runtime. |
| Orb session dead mid-prepare | Discard capture buffer, allow `session-dead` path to proceed |
| `RAX_ORB_AUTO_SCREENSHOT=disabled` | `prepareAutoCapture` short-circuits to `{attachment: null, tier: 'none'}` |
| Screen Recording permission denied | `screencapture` fails → same path as first row. Existing system-prompt guidance on Privacy Settings still applies for any follow-up `rax_screenshot` tool call. |

## Testing plan

### Unit tests

**`intent-regex.test.ts`** — 50+ canonical transcripts:

HIGH expected:
- "look at this"
- "see that error"
- "check this out"
- "take a look at my screen"
- "on my screen there's a button"
- "this window is acting weird"
- "read this for me"
- "what does that say"
- "tell me what the screen says"
- "where I'm pointing"
- "this button doesn't work"
- "click here"
- "scroll down to this section"
- "is this red?"
- "does this look right?"
- "what color is that icon"

AMBIGUOUS expected (Haiku gates):
- "what is this"
- "what's that"
- "is it loading?"
- "this isn't working"
- "did it finish"
- "why is that"
- "it broke"
- "over here"
- "right here?"

NONE expected:
- "what time is it"
- "schedule a meeting tomorrow"
- "I had this idea earlier"
- "remind me about the bug we discussed"
- "open Spotify"
- "tell me a joke"
- "summarize the article"

**`auto-screenshot.test.ts`** — with mocked `captureScreenForOrb` (resolves with fake base64) and mocked `HaikuVerifier`:
- HIGH tier → Haiku NOT called; capture called once; attachment returned.
- AMBIGUOUS + Haiku-yes → both called in parallel (assert `Promise.all`-style wall time = max not sum, using artificial 200ms / 500ms delays); attachment returned.
- AMBIGUOUS + Haiku-no → capture called but result discarded (`attachment === null`).
- AMBIGUOUS + Haiku-timeout → `attachment === null`.
- AMBIGUOUS + Haiku-error → `attachment === null`.
- `haikuEnabled === false` + AMBIGUOUS → capture NOT called (treated as 'none'); attachment null.
- NONE tier → neither called.
- HIGH + capture failure → `attachment === null`, no throw.

### Manual E2E

Run the orb. Walk through these 15 prompts and verify outcomes:

| Prompt | Expected tier | Expected flash | Expected initial `rax_screenshot` tool call by claude? |
|--------|--------------|----------------|--------------------------------------------------------|
| "look at this — what is it?" | HIGH | yes | NO |
| "read what's on my screen" | HIGH | yes | NO |
| "click the blue button" | HIGH | yes | NO |
| "is this code right?" | HIGH | yes | NO |
| "what color is the highlighted row" | HIGH | yes | NO |
| "what is this" (pointing at IDE error) | AMBIGUOUS yes | yes | NO |
| "is it loading?" | AMBIGUOUS yes | yes | NO |
| "it broke again" | AMBIGUOUS yes | yes | NO |
| "what is this idea I had?" | AMBIGUOUS no | no | NO (model has no view) |
| "did it finish?" (referring to a build in orb's own tool history) | AMBIGUOUS — Haiku may say no | maybe | possibly |
| "what time is it" | NONE | no | NO |
| "tell me a joke" | NONE | no | NO |
| "schedule a meeting tomorrow" | NONE | no | NO |
| "remind me to fix the auth bug we talked about" | NONE | no | NO |
| "open Spotify" | NONE | no | NO (unless model decides it needs to see) |

## Performance budget

- Voice-turn p50 added latency: 0ms (NONE tier — no extra work).
- Voice-turn p95 added latency for HIGH-tier turns: ~500-900ms (screencapture + JXA + sips). This is the SAME cost the user pays today when claude calls `rax_screenshot` — we just front-load it and skip the tool round-trip, net saving 1-2s.
- Voice-turn p95 added latency for AMBIGUOUS-tier turns: ~max(500-900ms capture, 150-300ms Haiku) = 500-900ms.
- Anthropic API cost: ~$0.0001-0.0003 per AMBIGUOUS turn (Haiku 4.5 with cached system prompt). Zero on HIGH and NONE turns.
- Memory: capture buffer is ~150-400KB base64 in-flight; discarded after `submitTurn` writes to stdin.

## What's out of scope for v1 (named follow-ups)

1. UI toggle in `SettingsView.tsx` alongside `voiceCaptionsEnabled`. Today it's env-var only.
2. Image lightbox in the voice tab when the user clicks the "screenshot attached" chip.
3. Multi-language regex (Spanish, Japanese, etc.).
4. Smart suppression when consecutive captures of the same display would be byte-identical.
5. Capture-rate telemetry to tune the regex catalog over time.
6. Automatic re-capture during a turn if user mid-speech says "wait, look at THIS instead" — currently the turn is locked to a single attachment.

## Open questions to revisit during implementation

- **Anthropic SDK version**: confirm the version in `package.json` (or to-be-added) supports prompt caching on system blocks with `cache_control: { type: 'ephemeral' }` and the `claude-haiku-4-5` model id.
- **`@anthropic-ai/sdk` bundling**: it's a Node-only module — confirm the existing `electron.vite.config.ts` main-process bundler handles it without externalizing it incorrectly.
- **Cursor-display resolution**: today the JXA bridge runs *after* `screencapture` to annotate. For the auto-capture we need to know the cursor display *before* calling `screencapture` so `-D <n>` targets the right monitor. The cheapest path is a small standalone JXA call that returns just the cursor's `cursor_display_index`, then a second pass for the red-ring annotation. Alternative: capture the cursor display in one JXA call that produces both the index and a temp marker overlay file — saves one osascript spawn but couples the two paths. Decide during implementation; start with the simple two-call version.
