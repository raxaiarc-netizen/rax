# Voice-orb tool narration: speak what each tool is doing

**Status**: design — ready for plan
**Date**: 2026-05-20
**Surfaces**: voice orb (Rax `src/main/orb/*`, `src/preload/orb.ts`, `src/renderer/orb/App.tsx`)

---

## Problem

When the orb runs a tool, the audio stream goes silent for the duration of the tool (Bash, Edit, screenshot, click, etc — anywhere from 200ms to several seconds). Today the user sees "running bash" appear in the orb transcript but hears nothing. On multi-tool turns the orb can be silent for 5-10 seconds straight, even though the model is actively working. The previous fix (faster streaming after tool calls) helps text segments speak sooner, but it can't fill silence that exists *during* the tool run.

The user wants the orb to verbally announce each tool as it fires, so the experience matches how a person would narrate their work in real time ("let me check… one sec… making the edit…").

## Goal

For every non-silent tool call, the orb emits a short (1-5 word) natural phrase describing what the tool is doing. Phrasing is LLM-generated per call (so the same tool firing twice in a row gets different phrasings) but stays *generic to the tool action* — it does not narrate specific arguments ("running ls -la ~/Desktop"). When the LLM is unavailable (offline / no API key), a hardcoded fallback catalog still narrates so the feature doesn't go dark.

## Non-goals

- Argument-specific narration ("listing your Desktop folder", "editing auth.ts"). User explicitly chose "generic per tool" — adding arg-parsing logic is a separate v2.
- Narrating silent tools. The existing filter (`Read`, `Glob`, `Grep`, `LS`, `TodoRead`, `TodoWrite`) is reused; these tools run too fast and too often to narrate without sounding chatty.
- Suppressing narration when claude's own text is verbose. A potential refinement, but the user explicitly wants narration "for each tool" — we trust that to be the desired behavior.
- Tool-completion narration ("done", "got it"). Only fires at `tool_call`, not on tool result arrival.
- Streaming the narration text into the caption pill ahead of audio (same decision as previous spec — pill stays in sync with playback).
- Settings UI. Behavior on by default; can be disabled by missing API key.

## High-level pipeline

```
tool_call event arrives in renderer
       │
       ▼
  ┌──────────────────────────────────────────────────────────┐
  │ tool_call handler (renderer, App.tsx)                    │
  │                                                           │
  │ 1. flushPendingTts()                       ← existing    │
  │ 2. firstChunkPendingRef.current = true     ← existing    │
  │ 3. window.orb.narrateTool(toolName)        ← NEW         │
  │      → Promise<{phrase: string | null}>                  │
  │ 4. on resolve, if phrase truthy:                          │
  │      ttsQueueRef.current.push(phrase)                    │
  │      pumpTts()                                            │
  └──────────────────────────────────────────────────────────┘
       │
       ▼  (IPC: ORB_NARRATE_TOOL)
  ┌──────────────────────────────────────────────────────────┐
  │ main process: ToolNarrator                                │
  │                                                           │
  │ - hasApiKey? → Anthropic Haiku 4.5 call                  │
  │   system: "you narrate tools, output 1-5 word phrase"    │
  │   user:   `Tool: ${toolName}`                            │
  │   max_tokens: 16, ~150-300ms typical                     │
  │ - else → pickFromCatalog(toolName) ← hardcoded fallback  │
  │ - 700ms timeout → fallback to catalog                     │
  │ - on error → fallback to catalog                          │
  │ - on cancel/abort (barge-in) → return {phrase: null}      │
  └──────────────────────────────────────────────────────────┘
       │
       ▼
  phrase enters TTS queue → Kokoro synth → afplay → audible
```

## Architecture decisions

| # | Decision | Choice |
|---|----------|--------|
| 1 | LLM model | `claude-haiku-4-5` (same model the existing screenshot verifier uses; already in the project). |
| 2 | Prompt input | Tool name only. No tool arguments, no recent transcript, no conversation context. User picked "Generic per tool". |
| 3 | Prompt format | System prompt with examples + cache_control; user prompt is just `"Tool: <name>"`. After the first call, the system block is cache-hit (cheaper + faster). |
| 4 | Output constraint | `max_tokens: 16`. Phrases longer than ~5 words get truncated; we then trim to a sentence-safe boundary. |
| 5 | Timeout | 700ms hard timeout. If Haiku is slower, we fall back to the catalog rather than make the user wait. |
| 6 | Fallback catalog | Hardcoded per-tool phrase pool in `tool-narrator.ts`. Used when no API key, on timeout, or on any error. Also seeds the prompt examples. |
| 7 | When to narrate | On every non-silent `tool_call` event (same filter as the existing label-setter: `^(Read|Glob|Grep|LS|TodoRead|TodoWrite)$` skipped). |
| 8 | Queue placement | Phrase pushed directly to `ttsQueueRef` (bypasses chunker — it's already a complete utterance). Order: flush tail → narration → (later) next text segment. |
| 9 | Barge-in | `cancelAllSpeech()` already nukes the queue and aborts in-flight synth. The narration request also takes an AbortSignal so the Haiku HTTP request gets cancelled on barge-in. |
| 10 | Stale narration | No race-detection in v1. If the tool completes very fast and claude's result text arrives first, the narration will still play right before the result text. Acceptable; the user said narrate every tool. |
| 11 | API key source | Reuse the same `ANTHROPIC_API_KEY` env var the screenshot verifier already reads. Null path = catalog-only. |
| 12 | Friendly tool name | Reuse the existing `mcp__rax-orb__rax_screenshot → "screenshot"` transform so the Haiku prompt and catalog keys both work off the same surface. |

## File surfaces

### New file: `src/main/orb/tool-narrator.ts` (~110 lines)

Modeled on `haiku-verifier.ts`. Public interface:

```ts
export interface ToolNarrator {
  /** Generate a 1-5 word natural phrase describing what `toolName` is doing.
   *  Returns null on cancel/abort/missing-toolname so the caller can no-op. */
  narrate(toolName: string, signal?: AbortSignal): Promise<string | null>
  /** True when a live Anthropic key is configured; false means catalog-only. */
  readonly enabled: boolean
}

export function createToolNarrator(apiKey: string | null | undefined): ToolNarrator
```

Internal structure:
- `class AnthropicToolNarrator implements ToolNarrator`: Anthropic client + 700ms timeout race. On success: trim, sanitize (strip quotes, trailing punctuation, length cap 60 chars), return. On timeout/error: `return pickFromCatalog(toolName)`.
- `class NullToolNarrator implements ToolNarrator`: always `pickFromCatalog(toolName)`.
- `pickFromCatalog(toolName)`: looks up the catalog, returns a random phrase, biased to not repeat the most recent phrase for that same tool (small in-instance memory).
- `CATALOG`: const map below.

Catalog:
```ts
const CATALOG: Record<string, string[]> = {
  bash:        ['running that', 'checking', 'on it', 'one sec'],
  edit:        ['editing now', 'making the change', 'updating that'],
  write:       ['saving that', 'writing it out'],
  multiedit:   ['making the edits', 'updating that'],
  webfetch:    ['fetching that', 'looking it up'],
  websearch:   ['searching', 'looking it up'],
  task:        ['kicking that off', 'starting that'],
  // orb MCP tools (post-friendly-name)
  screenshot:        ['taking a look', 'checking the screen', 'let me see'],
  click:             ['clicking', 'tapping there'],
  type:              ['typing', 'typing that in'],
  scroll:            ['scrolling'],
  keypress:          ['pressing'],
  'control screen':  ['working on the screen', 'on it'],
  'open tab':        ['opening a tab'],
  'close tab':       ['closing it'],
  'switch tab':      ['switching'],
  send:              ['sending'],
}
const FALLBACK = ['working on it', 'one moment', 'on it']
```

System prompt for Haiku:
```
You narrate, out loud, what a friendly voice assistant is doing while
it runs a tool. Output ONLY a single short natural phrase (1-5 words)
— no quotes, no punctuation other than the phrase itself, no
explanation, no tool name verbatim. Calm, casual tone.

Examples:
- Bash → "running that" / "checking now" / "one sec"
- Edit → "making the edit" / "updating that"
- Write → "saving it" / "writing that out"
- screenshot → "taking a look" / "checking the screen"
- click → "clicking" / "tapping there"
- WebSearch → "searching" / "looking it up"

Vary your phrasing across calls so back-to-back tools don't sound
repetitive.
```

User prompt: `Tool: ${friendlyToolName}`.

### Modified file: `src/main/orb/index.ts` (~3 lines added)

Export `createToolNarrator` so `src/main/index.ts` can instantiate it alongside the screenshot verifier (both read the same env var).

### Modified file: `src/main/index.ts` (~30 lines added)

- Instantiate `const narrator = createToolNarrator(process.env.ANTHROPIC_API_KEY ?? null)` once at startup.
- Add IPC handler for `ORB_NARRATE_TOOL`:
  ```ts
  ipcMain.handle(CHANNELS.ORB_NARRATE_TOOL, async (_e, toolName: string) => {
    try {
      const phrase = await narrator.narrate(toolName)
      return { phrase }
    } catch (err) {
      return { phrase: null }
    }
  })
  ```

### Modified file: `src/preload/orb.ts` (~5 lines added)

- Add channel constant `ORB_NARRATE_TOOL: 'rax:orb-narrate-tool'`.
- Add `narrateTool(toolName: string): Promise<{phrase: string | null}>` to `OrbAPI`.
- Wire it up: `narrateTool: (toolName) => ipcRenderer.invoke(CHANNELS.ORB_NARRATE_TOOL, toolName)`.

### Modified file: `src/renderer/orb/App.tsx` (~12 lines added)

The `tool_call` handler (currently around line 411 after my previous edit) gains the narration call:

```ts
case 'tool_call': {
  const toolName = String((evt as { toolName?: string }).toolName || '')
  if (!toolName || /^(Read|Glob|Grep|LS|TodoRead|TodoWrite)$/.test(toolName)) break

  flushPendingTts()
  firstChunkPendingRef.current = true

  const friendly = toolName.startsWith('mcp__rax-orb__')
    ? toolName.replace('mcp__rax-orb__', '').replace(/^rax_/, '').replace(/_/g, ' ')
    : toolName.toLowerCase()

  // NEW: kick off LLM-narration; speak the result as soon as it arrives.
  // We use the renderer's TTS queue so it sits in the same playback pipeline
  // as claude's own utterances and respects barge-in via cancelAllSpeech.
  void window.orb.narrateTool(friendly).then(({ phrase }) => {
    if (!phrase) return
    ttsQueueRef.current.push(phrase)
    pumpTts()
  })

  pushTranscript('tool', `running ${friendly}`)
  setCurrentTool(friendly)
  break
}
```

## Risk + mitigations

- **Haiku call adds 150-300ms before narration audio begins.** With Kokoro synth (~200ms) on top, the user hears narration ~400-500ms after the tool fires. Mitigation: tool durations are typically 1-5s, so narration still arrives during the silence it's meant to fill. For the rare sub-200ms tool, the narration lands right after — slight order swap, but each narration phrase is short enough (1-5 words) that this feels like a brief comment rather than a stale announcement.
- **API rate-limits / spend on heavy-tool turns.** Max 1 Haiku call per tool call. `max_tokens: 16` keeps each call to ~30 tokens output + cached system. For a 10-tool turn, total cost is well under a cent. Mitigation: cache_control on system prompt; rely on existing API budget management; fall back to catalog on 429.
- **Haiku produces awkward output ("Tool: bash", a quoted phrase, multiline text).** Sanitize aggressively: strip surrounding quotes/backticks, take first line only, cap at 60 chars, reject if it contains the literal tool name (would suggest the model echoed the input).
- **No API key configured.** `NullToolNarrator` returns catalog phrases. Feature still works, just static.
- **Same tool fires 3× in a row → same phrase 3×.** Mitigation: catalog rotation avoids immediate-repeat (tracks the last phrase per tool). Haiku rotation relies on the system-prompt instruction to vary; the model's natural temperature handles this in practice.
- **Pull-in of unknown tools.** Any non-silent tool not in the catalog falls through to `FALLBACK` (["working on it", "one moment", "on it"]). The Haiku path always works since it operates off the tool name string.
- **Race with text_chunk: narration fires for a tool that completes before the LLM responds.** Narration arrives slightly late; queued behind/after any text that arrived in the meantime. Acceptable per Decision 10. If this becomes a complaint we can add request-id race detection.
- **Race with barge-in mid-narration.** `cancelAllSpeech()` already nukes the queue. The IPC request's AbortSignal also cancels the Haiku HTTP call so we don't waste tokens on an aborted turn.

## Validation plan

1. **Code-level checks:**
   - `npx tsc --noEmit` — no new errors in `src/main/orb/`, `src/preload/`, `src/renderer/orb/`.
   - Hand-trace the screenshot scenario: orb fires `screenshot` MCP tool → narrator returns "checking the screen" → enters queue → speaks while screencap runs.
2. **Manual run in dev (`npm run dev`):**
   - Trigger a multi-tool turn ("organize my desktop", "what's on my screen and click the dock"). Verify each tool emits a phrase, phrases vary, audio fills the gaps.
   - Unplug network or unset `ANTHROPIC_API_KEY` → confirm catalog fallback still narrates.
   - Barge-in during narration → narration stops cleanly, no orphaned audio.
3. **Regression checks:**
   - Single-segment short reply with no tools → unchanged behavior.
   - Silent tools (Read, Grep) → still no narration, no transcript noise.
   - Previous fix still holds: post-tool text segment speaks at FIRST_CHUNK_MIN threshold.
4. **Quality spot-checks:**
   - Confirm Haiku outputs 1-5 word phrases with sanitization applied.
   - Confirm cached system prompt — observe 2nd+ call latency < first call.

## Out of scope (followups)

- Argument-aware narration ("editing auth.ts", "listing your Desktop"). Would extend the prompt with `args` field; nontrivial because of safety (don't speak secrets, paths, etc.).
- Tool-result narration ("done", "got it"). Would key off a `tool_result` event the orb stream doesn't currently expose.
- Dynamic context (recent transcript) in the Haiku prompt for context-aware narration.
- A Settings toggle to turn narration off without unsetting the API key.
- Per-tool tone customization (e.g. "polite" vs "playful").
