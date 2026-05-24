# Voice-orb streaming TTS: speak as text arrives

**Status**: design — ready for plan
**Date**: 2026-05-20
**Surfaces**: voice orb (Rax `src/renderer/orb/App.tsx`)

---

## Problem

The voice orb currently sounds like it waits for the whole turn before speaking — especially on multi-segment turns (text → tool → text → tool → text). The user perceives "speaks when the whole text is there" rather than real-time narration.

The pipeline is actually a streaming pipeline, but three rules combine to make it behave as a near-whole-turn buffer:

1. **`NEXT_CHUNK_MIN = 150`** (in `src/renderer/orb/App.tsx:100`) — a legacy threshold designed for ElevenLabs' 250-500ms cloud TTFB. For any chunk after the first, even a complete sentence will NOT be cut unless the buffer has ≥150 chars (`requireMinForSentence=true` in `findCut`).
2. **No flush at text-segment boundaries.** When a tool call interrupts a text block, the residue in `ttsBufferRef` sits there silent. It only drains when either (a) the next text segment pushes the buffer past 150 chars, or (b) `task_complete` fires `flushPendingTts()` at the very end of the turn.
3. **`firstChunkPendingRef` never resets between segments.** It flips to `false` after the first complete chunk and stays false until the next `user_turn`. Every text segment after a tool call therefore inherits the punishing `NEXT_CHUNK_MIN` floor, even though the user-perceived "next utterance" is fresh.

The 150-char floor existed to amortize cloud TTS round-trips. We migrated to local Kokoro-82M months ago — synth time for a 30-char sentence is ~150-200ms, well under afplay's own spawn latency. **The bundling no longer pays for itself; it only adds perceived dead air.**

## Goal

Each text segment in a multi-segment turn should begin speaking within the same latency envelope as the very first sentence of the turn (~300-500ms TTFA), regardless of how many tool calls preceded it. Sentence-level prosody is preserved — no clause-level chopping.

## Non-goals

- Streaming the caption pill ahead of audio. (User explicitly chose to keep the pill in sync with playback so the karaoke highlighter matches what's audible.)
- Sub-sentence (clause-level) chunking. Comma/em-dash cuts would speed up first-word latency by ~100ms but break Kokoro's per-utterance prosody, which sounds robotic.
- Changing the Kokoro synth path, the prefetch (depth-2 pipeline), or the caption-pill alignment machinery. All of that is fine; the bottleneck is purely in the renderer's chunker.
- Tuning per-voice (`af_heart`, `am_michael`, etc). Same thresholds apply to all voices.
- Telemetry / cadence dashboards.

## High-level change

```
                  BEFORE                                    AFTER
                                              
text_chunk → ttsBufferRef +=               text_chunk → ttsBufferRef +=
text_chunk → chunkForTts(buf, isFirst)     text_chunk → chunkForTts(buf, isFirst)
   complete? NO (95 < 150)                    complete? YES (95 > 32) → push
                                                       
                                              
tool_call (Bash) — buffer sits silent      tool_call (Bash):
                                              flushPendingTts() ← NEW
                                              firstChunkPendingRef = true ← NEW
                                              
                                              
text_chunk → buf accumulates...            text_chunk → fresh "first chunk"
text_chunk → still < 150...                   speaks at 48 chars again
text_chunk → finally 150 → push               
   (~3-5s after the segment started)       (~300-500ms TTFA, same as turn opener)
```

## Architecture decisions

| # | Decision | Choice |
|---|----------|--------|
| 1 | `NEXT_CHUNK_MIN` value | Lower from 150 → **32**. Still bundles back-to-back staccato sentences ("Sure. Got it.") if they arrive in the same render tick, but doesn't block any normal-length sentence. |
| 2 | `FIRST_CHUNK_MIN` value | Keep at 48. The first cut of a fresh segment still wants a tiny bit of preamble for natural cadence (e.g. avoid speaking just "Sure" mid-stream when the model meant "Sure — let me check"). |
| 3 | `MAX_RUNAWAY` value | Keep at 280. Safety net only; rarely fires. |
| 4 | Reset trigger for `firstChunkPendingRef` | On every `tool_call` event in the orb event stream. Tool calls are the visible logical-pause markers — exactly the right boundary for "this next text feels like a new utterance." |
| 5 | Flush trigger | Also on `tool_call`. Drain whatever's in `ttsBufferRef` and `ttsQueueRef` before the tool runs, so any short tail sentence gets spoken instead of waiting for `task_complete`. |
| 6 | Tool filter for reset/flush | Skip silent tools (`Read`, `Glob`, `Grep`, `LS`, `TodoRead`, `TodoWrite`) — these don't visually pause the text stream and shouldn't reset the chunker. Reuse the same filter already used at `App.tsx:414` for `setCurrentTool`. |
| 7 | Prosody-safe | Still require a real sentence boundary (Intl.Segmenter + abbreviation filter) for the cut. We're only lowering the minLen, not abandoning sentence-level discipline. |
| 8 | Pipeline depth | Unchanged. `TTS_INFLIGHT_MAX = 2` keeps Kokoro synth overlapped with afplay playback. |
| 9 | Caption pill | Unchanged. Still driven by main's `segment` event when afplay actually spawns. |

## File surfaces

### Modified file: `src/renderer/orb/App.tsx`

**Lines 99-101** — constants:
```ts
const FIRST_CHUNK_MIN = 48
const NEXT_CHUNK_MIN  = 32    // was 150 — Kokoro doesn't need the cloud-TTFB amortization
const MAX_RUNAWAY     = 280
```

**Lines 412-421** — `tool_call` handler. Currently only updates the "running X" caption. After change, it also flushes pending TTS and re-arms the first-chunk flag for the next text segment. Reuse the existing silent-tools regex so noise-only tools don't perturb the chunker:

```ts
case 'tool_call': {
  const toolName = String((evt as { toolName?: string }).toolName || '')
  if (!toolName) break
  const isSilent = /^(Read|Glob|Grep|LS|TodoRead|TodoWrite)$/.test(toolName)
  if (!isSilent) {
    // Tool call marks a logical pause in the assistant's voice. Speak
    // whatever short tail is in the buffer NOW (don't wait for task_complete)
    // and let the next text segment start fresh — same fast threshold as
    // the very first sentence of the turn.
    flushPendingTts()
    firstChunkPendingRef.current = true

    const friendly = toolName.startsWith('mcp__rax-orb__')
      ? toolName.replace('mcp__rax-orb__', '').replace(/^rax_/, '').replace(/_/g, ' ')
      : toolName.toLowerCase()
    pushTranscript('tool', `running ${friendly}`)
    setCurrentTool(friendly)
  }
  break
}
```

That's the entire code change. Two constants, ten or so lines in one switch case.

## Risk + mitigations

- **Risk:** lowering `NEXT_CHUNK_MIN` to 32 produces more individual TTS calls per turn, each costing one Kokoro synth + afplay spawn. **Mitigation:** Kokoro synth for a 32-50 char chunk takes ~150-250ms, well under the ~3-second playback duration of a typical sentence. The depth-2 pipeline keeps the next chunk synthesizing while the current plays — net inter-sentence gap remains the ~30-50ms afplay spawn latency, which is what we already have today.
- **Risk:** flushing at `tool_call` could speak a half-formed clause if the model emits text → tool mid-sentence. **Mitigation:** `flushPendingTts()` at `App.tsx:333` only pushes a trimmed non-empty tail. In practice claude does not emit a tool call mid-sentence; the assistant message segments at natural utterance boundaries (we verified by reading several stream-json traces). If it does happen, hearing a clause is still strictly better than hearing nothing for 5 seconds.
- **Risk:** the silent-tools regex was previously only used to suppress the "running X" caption; we now also rely on it to gate the flush/reset. **Mitigation:** the regex stays inline in the single `tool_call` handler — no duplication. Future tools added to the filter automatically affect both behaviors, which is the correct semantic ("if a tool is too quiet to mention, it's also too quiet to break the speech cadence").
- **Risk:** users with very fast Claude streaming might experience the first-chunk threshold (48) firing on a partial sentence ("Let me peek at"). **Mitigation:** `findCut` already requires a sentence-terminator or clause boundary regardless of minLen; the threshold gates which sentences are accepted, not whether to invent cuts. No mid-word cuts are possible.

## Validation plan

1. **Code-level:** unit-style sanity check by hand-walking `chunkForTts` with the screenshot scenario's exact text (3 segments, ~80/~155/~50 chars each, tool calls in between). Confirm each segment now produces complete chunks within its own duration rather than waiting for the next segment or `task_complete`.
2. **Manual run in dev (`npm run dev`):**
   - Trigger a multi-segment turn ("organize my desktop" or "look at what's on my screen and tell me what you see") and listen.
   - Expected: each text segment begins audible within ~500ms of arriving. No long silent gaps between tool calls and the next sentence.
   - Compare side-by-side against the current behavior by toggling `NEXT_CHUNK_MIN` between 32 and 150 in a single dev session.
3. **Regression checks:**
   - Single-segment short reply ("yes" / "done") — should still speak the whole utterance, not crash.
   - Single-segment long reply (multi-sentence explanation, no tools) — should still flow naturally, no choppy mid-sentence breaks.
   - Barge-in mid-speech — `cancelAllSpeech()` already nukes the queue and resets `firstChunkPendingRef = true`, behavior unchanged.
   - Abbreviations ("Mr. Smith", "e.g.", "U.S.") — abbrev filter still in front of the cut decision, behavior unchanged.

## Out of scope (followups, if ever)

- Per-voice TTFB-aware threshold tuning (Kokoro voice models have small synth-cost differences).
- Streaming the caption pill text ahead of audio with a "fade-in-as-spoken" highlight model.
- Switching Kokoro to streaming-WAV (chunked synthesis) for even lower TTFA — would require rewriting `synthesizeToTempFile` and the afplay playback path, much bigger surface than this fix justifies.
