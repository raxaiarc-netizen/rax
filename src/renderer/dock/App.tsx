import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AGENTS } from '../../shared/agents'
import type { DockAPI, DockEventPayload } from '../../preload/dock'
import maxImg from './assets/max.png'
import alexImg from './assets/alex.png'
import lunaImg from './assets/luna.png'
import novaImg from './assets/nova.png'
import zaraImg from './assets/zara.png'

declare global {
  interface Window {
    dock: DockAPI
  }
}

// ─── Agent runtime status ───
type AgentRuntimeStatus = 'idle' | 'running' | 'completed' | 'failed'

interface AgentState {
  status: AgentRuntimeStatus
  activity: string
}

const INITIAL_AGENT_STATES: Record<string, AgentState> = Object.fromEntries(
  AGENTS.map((a) => [a.id, { status: 'idle' as const, activity: '' }]),
)

// Visual constants. Picked so the column fits 5 agents + breathing room
// inside the dock window.
const COLUMN_WIDTH = 80
const ICON_SIZE = 56
const ICON_PITCH = 70
// Top padding inside the glass column before the first icon's center.
const COLUMN_TOP_PAD = 12

// ─── Tilt tuning (NeoDock "Tilt" variant) ───
//
// One effect per icon: it tilts in 3D to "face" the cursor as the cursor
// passes over it. NO macOS-dock magnification (that's the "Scale" variant)
// — icons stay put in their slots, no neighbor pushing. The hovered icon
// gets a strong rotateX/rotateY based on the cursor's position within its
// own bounds, a small scale bump (~5%), and a small forward translateZ.
//
// Each icon is independent: tilt engagement is 1 when the cursor is dead
// center over the icon, falls to 0 at the icon's edge + a small reach
// buffer, and stays at 0 elsewhere. No icon should ever wobble because
// another icon is being tilted.
const TILT_MAX_DEG = 32       // peak rotateX/rotateY when cursor is at edge
const TILT_REACH = 18         // tilt engages a bit outside the icon edge
const HOVER_SCALE = 0.06      // tiny scale bump for "I'm being tilted" feel
const TRANSLATE_Z_MAX = 18    // small Z lift while tilted
const PERSPECTIVE = 280       // smaller → more dramatic 3D tilt

// Spring physics — tuned to feel like Framer Motion's default tilt spring:
// snappy on entry, slight overshoot, settles in ~400ms.
const SPRING_STIFFNESS_TRACK = 0.38
const SPRING_STIFFNESS_DECAY = 0.22
const SPRING_DAMPING = 0.30
// Position + velocity below this → at rest; stop the rAF loop.
const REST_EPSILON = 0.01

const TOAST_TTL_MS = 6500
// Activity-driven presence: when the dock was auto-shown (crew dispatch /
// completion), it tucks itself away this long after the crew goes quiet —
// nothing running, all toasts expired, cursor elsewhere.
const QUIET_GRACE_MS = 5000
// Slide-out duration before acking main's hide request (matches the
// .is-leaving CSS transition, plus a paint of slack).
const LEAVE_ANIM_MS = 260
// Upper bound on the per-turn text buffer used as a fallback when
// task_complete arrives without a `result` field. We keep the HEAD of the
// stream (slice(0, …)) because the recap pulls the first sentence — extra
// chunks past the first paragraph aren't useful for summarization.
const TURN_BUFFER_CAP = 2000
// Hard cap on the toast summary string. CSS line-clamps to 2 visible lines,
// so anything past ~100 chars is hidden anyway — but keeping a little
// headroom means a wider dock layout would show more without re-truncating.
const TOAST_SUMMARY_MAX = 140

interface ToastItem {
  id: string
  agentId: string
  agentName: string
  accent: string
  summary: string
  bornAt: number
}

interface SnapshotShape {
  tabs?: Array<{ id: string; title?: string; hasUnread?: boolean; status?: string }>
  activeTabId?: string
}

const AGENT_IMAGE: Record<string, string> = {
  'agent-max': maxImg,
  'agent-alex': alexImg,
  'agent-luna': lunaImg,
  'agent-nova': novaImg,
  'agent-zara': zaraImg,
}

// Per-icon transform state, kept in a ref Map so the rAF loop can mutate
// without triggering React re-renders. Each animated property (scale, tilt,
// translation) is tracked with its own velocity so we can run a real spring
// integration (not just an exponential lerp) — the difference between a
// dock that floats and one that BOUNCES.
interface IconTilt {
  el: HTMLDivElement
  /** Index of this agent in the AGENTS array. The natural slot center is
   *  computed deterministically from the index — we don't measure
   *  getBoundingClientRect each frame because the live rect reflects the
   *  CURRENT transform (including our own Y push), creating a self-amplifying
   *  feedback loop. */
  agentIndex: number
  scale: number
  scaleVel: number
  rx: number
  rxVel: number
  ry: number
  ryVel: number
  ty: number
  tyVel: number
  tz: number
  tzVel: number
}

// Natural Y center of an agent within the column (no cursor). Mirrors the
// React layout: top padding + i × pitch + half an icon height. Constant
// — never changes once the dock is mounted.
function naturalYForIndex(index: number): number {
  return COLUMN_TOP_PAD + index * ICON_PITCH + ICON_SIZE / 2
}

// Natural X center — every icon sits in the column's horizontal center, so
// the value only depends on column width. Kept as a function for symmetry
// with naturalYForIndex.
function naturalX(columnWidth: number): number {
  return columnWidth / 2
}

// One integration step of a simple critically-damped spring. Returns the
// next [position, velocity] given the current state, target, and tuning.
function spring(
  current: number,
  target: number,
  velocity: number,
  stiffness: number,
  damping: number,
): [number, number] {
  const force = (target - current) * stiffness
  const nextVel = (velocity + force) * (1 - damping)
  const nextCur = current + nextVel
  return [nextCur, nextVel]
}

export default function App() {
  const [agentStates, setAgentStates] = useState(INITIAL_AGENT_STATES)
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null)
  const [hovered, setHovered] = useState<string | null>(null)
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const [isDark, setIsDark] = useState(true)
  // Presence mode pushed by main after every show: autoHide=true means this
  // appearance was activity-driven and the dock should tuck itself away when
  // the crew goes quiet; false means the user pinned it.
  const [autoHide, setAutoHide] = useState(true)
  // Slide-out in progress (CSS class); the window hides when it finishes.
  const [leaving, setLeaving] = useState(false)
  // Cursor over any interactive dock UI — never tuck away under the user.
  const [overUi, setOverUi] = useState(false)

  const dockColumnRef = useRef<HTMLDivElement | null>(null)
  const lastIgnoredRef = useRef<boolean | null>(null)
  const toastListRef = useRef<HTMLDivElement | null>(null)

  // Per-agent turn buffer + completion counter live in refs (not state) for
  // two reasons:
  //   1. StrictMode double-invokes state updaters to catch impurity. If we
  //      called pushToast (→ setToasts) from inside a setAgentStates
  //      updater, the toast would fire twice. Reads/writes against a ref
  //      are not state updates, so they're safe inside the updater AND
  //      can be done plainly outside it.
  //   2. Buffering text in state caused a re-render on every text_chunk
  //      (hundreds per turn) for a value nothing rendered. Refs skip that.
  const turnBufferRef = useRef<Map<string, string>>(new Map())
  const completionSeqRef = useRef<Map<string, number>>(new Map())

  // ─── Cursor tracking + tilt loop ───
  const cursorRef = useRef<{ x: number; y: number; active: boolean }>({
    x: 0,
    y: 0,
    active: false,
  })
  const iconTiltsRef = useRef<Map<string, IconTilt>>(new Map())
  const rafIdRef = useRef<number>(0)
  // Stable callback ref so AgentIcon can register / unregister its tilt
  // wrapper. React calls this with the element on mount and `null` on unmount.
  const registerIconTilt = useCallback((agentId: string, el: HTMLDivElement | null) => {
    const map = iconTiltsRef.current
    if (el) {
      const agentIndex = AGENTS.findIndex((a) => a.id === agentId)
      map.set(agentId, {
        el,
        agentIndex: agentIndex >= 0 ? agentIndex : 0,
        scale: 1, scaleVel: 0,
        rx: 0, rxVel: 0,
        ry: 0, ryVel: 0,
        ty: 0, tyVel: 0,
        tz: 0, tzVel: 0,
      })
    } else {
      map.delete(agentId)
    }
  }, [])

  // ─── Theme bootstrap ───
  useEffect(() => {
    window.dock.getTheme().then(({ isDark: d }) => setIsDark(d)).catch(() => {})
    return window.dock.onThemeChange((d) => setIsDark(d))
  }, [])

  // ─── Presence mode ───
  // The push arrives right after every window show — it both updates the
  // mode AND resets the tucked pose, so a re-shown dock always GLIDES in
  // from the edge (every hide leaves the column tucked, see onSlideOut).
  useEffect(() => {
    return window.dock.onMode((mode) => {
      setAutoHide(mode.autoHide)
      setLeaving(false)
    })
  }, [])

  // ─── Animated hide handshake ───
  // EVERY hide (toggle / tray / rax_set_dock / orb-companion / quiet-grace)
  // arrives here from main: glide the column out, then ack so main hides
  // the now-empty window. The column stays in the tucked pose while hidden,
  // which is exactly the start pose the next show glides in from.
  useEffect(() => {
    return window.dock.onSlideOut(() => {
      setLeaving(true)
      window.setTimeout(() => window.dock.slideOutDone(), LEAVE_ANIM_MS)
    })
  }, [])

  // ─── Quiet-grace auto-tuck ───
  // When the grace elapses we just REQUEST the hide — main routes it back
  // through the slide-out handshake above, same as every other hide path.
  const anyRunning = Object.values(agentStates).some((s) => s.status === 'running')
  useEffect(() => {
    if (!autoHide || leaving) return
    if (anyRunning || toasts.length > 0 || overUi) return
    const t = window.setTimeout(() => window.dock.autoHide(), QUIET_GRACE_MS)
    return () => window.clearTimeout(t)
  }, [autoHide, leaving, anyRunning, toasts.length, overUi])

  // ─── Seed initial state from main's snapshot ───
  useEffect(() => {
    let cancelled = false
    window.dock
      .pullSnapshot()
      .then((snap) => {
        if (cancelled || !snap) return
        const s = snap as SnapshotShape
        if (typeof s.activeTabId === 'string' && INITIAL_AGENT_STATES[s.activeTabId]) {
          setActiveAgentId(s.activeTabId)
        }
        if (Array.isArray(s.tabs)) {
          setAgentStates((prev) => {
            const next = { ...prev }
            for (const t of s.tabs!) {
              if (!next[t.id]) continue
              const runStatus = t.status
              if (runStatus === 'running' || runStatus === 'connecting') {
                next[t.id] = { ...next[t.id], status: 'running' }
              } else if (runStatus === 'failed' || runStatus === 'dead') {
                next[t.id] = { ...next[t.id], status: 'failed' }
              } else if (t.hasUnread) {
                next[t.id] = { ...next[t.id], status: 'completed' }
              } else {
                next[t.id] = { ...next[t.id], status: 'idle' }
              }
            }
            return next
          })
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  // ─── Mirror actions (tab-selected highlights the right agent) ───
  useEffect(() => {
    return window.dock.onMirror((action) => {
      const a = action as { kind?: string; tabId?: string }
      if (a.kind === 'tab-selected' && typeof a.tabId === 'string') {
        if (INITIAL_AGENT_STATES[a.tabId]) {
          setActiveAgentId(a.tabId)
          setAgentStates((prev) => {
            if (!prev[a.tabId!]) return prev
            if (prev[a.tabId!].status !== 'completed') return prev
            return {
              ...prev,
              [a.tabId!]: { ...prev[a.tabId!], status: 'idle' },
            }
          })
        } else {
          setActiveAgentId(null)
        }
      }
    })
  }, [])

  // ─── Streaming events → per-agent status transitions ───
  useEffect(() => {
    return window.dock.onAgentEvent((evt: DockEventPayload) => {
      const agentId = evt.tabId
      if (!INITIAL_AGENT_STATES[agentId]) return
      switch (evt.type) {
        case 'session_init':
        case 'text_chunk': {
          if (evt.type === 'text_chunk') {
            const text = String((evt as { text?: string }).text || '')
            if (text) {
              // Buffer the HEAD of the turn (slice(0, cap)), not the tail —
              // Claude almost always leads with what was done ("Added X.",
              // "Fixed the bug in Y."), so the opening sentence is the
              // recap. Tail bytes are noise (closing pleasantries, next
              // steps). The buffer is a fallback for task_complete events
              // that arrive without a `result`; usually we use evt.result.
              const cur = turnBufferRef.current.get(agentId) || ''
              if (cur.length < TURN_BUFFER_CAP) {
                turnBufferRef.current.set(agentId, (cur + text).slice(0, TURN_BUFFER_CAP))
              }
            }
          }
          setAgentStates((prev) => {
            const cur = prev[agentId]
            // Idempotent transition: if we're already running with no tool
            // label showing, skip the state update so floods of text chunks
            // don't trigger needless re-renders.
            if (cur.status === 'running' && cur.activity === '') return prev
            return { ...prev, [agentId]: { ...cur, status: 'running', activity: '' } }
          })
          break
        }
        case 'tool_call': {
          const toolName = String((evt as { toolName?: string }).toolName || '')
          setAgentStates((prev) => {
            const cur = prev[agentId]
            const friendly = friendlyToolName(toolName)
            return { ...prev, [agentId]: { ...cur, status: 'running', activity: friendly } }
          })
          break
        }
        case 'task_complete': {
          // `result` is the canonical final assistant message from the
          // control plane — prefer it over the streamed buffer. Fall back
          // to the buffer only if `result` is empty (rare; happens on
          // short tool-only turns where the agent didn't reply with text).
          const result = String((evt as { result?: string }).result || '')
          const buffered = turnBufferRef.current.get(agentId) || ''
          const sourceText = result || buffered
          // Clear the buffer for the next turn BEFORE we touch state — the
          // ref read is synchronous so this is safe.
          turnBufferRef.current.delete(agentId)
          // Bump the completion counter. Stored in a ref because it's only
          // used to build a unique toast id; nothing renders it.
          const seq = (completionSeqRef.current.get(agentId) || 0) + 1
          completionSeqRef.current.set(agentId, seq)

          setAgentStates((prev) => {
            const cur = prev[agentId]
            return {
              ...prev,
              [agentId]: {
                ...cur,
                status: agentId === activeAgentId ? 'idle' : 'completed',
                activity: '',
              },
            }
          })
          // Push toast OUTSIDE the setAgentStates updater. StrictMode
          // double-invokes updaters to catch impurities — having setToasts
          // run inside one fires the toast twice. Outside is exactly once.
          pushToast(agentId, sourceText, seq)
          break
        }
        case 'error':
        case 'session_dead': {
          turnBufferRef.current.delete(agentId)
          setAgentStates((prev) => {
            const cur = prev[agentId]
            return {
              ...prev,
              [agentId]: { ...cur, status: 'failed', activity: '' },
            }
          })
          break
        }
        case 'tab_status_change': {
          // Tab-level status transitions from the control plane arrive faster
          // than the first text_chunk on tool-heavy turns. We mirror the same
          // status mapping the snapshot reader uses on mount so the icon
          // flips to 'running' immediately when the user submits a question.
          const next = String((evt as { status?: string }).status || '')
          if (next === 'failed' || next === 'dead') {
            turnBufferRef.current.delete(agentId)
          }
          setAgentStates((prev) => {
            const cur = prev[agentId]
            if (next === 'running' || next === 'connecting') {
              if (cur.status === 'running') return prev
              return { ...prev, [agentId]: { ...cur, status: 'running' } }
            }
            if (next === 'failed' || next === 'dead') {
              return { ...prev, [agentId]: { ...cur, status: 'failed', activity: '' } }
            }
            // 'completed' / 'idle' arrive as task_complete on the firehose,
            // which already covers the toast + completionSeq bump. Don't
            // double-fire from here — just no-op so this branch can't undo
            // an in-flight 'completed' state by flipping back to idle.
            return prev
          })
          break
        }
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeAgentId])

  // Push a "<Agent> finished" toast with a short, readable recap derived
  // from the agent's final assistant message. `sourceText` is whatever the
  // caller decided is canonical — usually task_complete's `result`, with
  // the streamed buffer as a fallback. summarizeForToast strips markdown
  // and pulls the first sentence(s), which is where Claude says what it did.
  const pushToast = useCallback((agentId: string, sourceText: string, seq: number) => {
    const agent = AGENTS.find((a) => a.id === agentId)
    if (!agent) return
    const display = summarizeForToast(sourceText) || 'finished its task.'
    setToasts((tprev) => {
      const next = [
        ...tprev,
        {
          id: `${agentId}-${seq}-${Date.now()}`,
          agentId,
          agentName: agent.name,
          accent: agent.accent,
          summary: display,
          bornAt: Date.now(),
        },
      ]
      return next.length > 4 ? next.slice(next.length - 4) : next
    })
  }, [])

  // ─── Auto-dismiss toasts ───
  useEffect(() => {
    if (toasts.length === 0) return
    const id = window.setInterval(() => {
      const now = Date.now()
      setToasts((prev) => prev.filter((t) => now - t.bornAt < TOAST_TTL_MS))
    }, 500)
    return () => window.clearInterval(id)
  }, [toasts.length])

  // ─── Click-through plumbing ───
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const inColumn = hitTest(dockColumnRef.current, e.clientX, e.clientY)
      const inToasts = hitTest(toastListRef.current, e.clientX, e.clientY)
      const overUI = inColumn || inToasts
      setOverUi(overUI)
      const shouldIgnore = !overUI
      if (shouldIgnore !== lastIgnoredRef.current) {
        lastIgnoredRef.current = shouldIgnore
        if (shouldIgnore) window.dock.setIgnoreMouseEvents(true, { forward: true })
        else window.dock.setIgnoreMouseEvents(false)
      }
    }
    const onLeave = () => {
      setOverUi(false)
      if (lastIgnoredRef.current !== true) {
        lastIgnoredRef.current = true
        window.dock.setIgnoreMouseEvents(true, { forward: true })
      }
    }
    window.dock.setIgnoreMouseEvents(true, { forward: true })
    lastIgnoredRef.current = true
    window.addEventListener('mousemove', onMove)
    document.addEventListener('mouseleave', onLeave)
    return () => {
      window.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseleave', onLeave)
    }
  }, [])

  // ─── 3D tilt rAF loop (per-icon, no spread) ───
  //
  // Mirrors the "Tilt" variant of the NeoDock Framer template:
  //
  //   For each icon, compute the cursor's position INSIDE that icon's local
  //   bounds (normalized −1 .. +1 in both x and y). Use those normalized
  //   coordinates to drive rotateX (pitch) and rotateY (yaw) so the icon
  //   "looks at" the cursor as it passes over.
  //
  //   Tilt engagement falls off with a smooth cubic outside the icon's
  //   bounds + a small TILT_REACH buffer, then snaps to zero. Only the icon
  //   the cursor is actually over (or about to enter) tilts; the others
  //   stay perfectly still in their slots. NO macOS-dock spread.
  //
  // Spring tuning: stiffer + less damping while the cursor is in the dock so
  // motion feels responsive; softer on exit so the icon relaxes back to
  // identity. The loop self-suspends when every icon is at rest.
  useEffect(() => {
    const column = dockColumnRef.current
    if (!column) return

    const update = () => {
      const cursor = cursorRef.current
      const colWidth = column.clientWidth
      const cx0 = naturalX(colWidth)
      const stiffness = cursor.active ? SPRING_STIFFNESS_TRACK : SPRING_STIFFNESS_DECAY
      const damping = SPRING_DAMPING
      let anyMoving = cursor.active

      for (const t of iconTiltsRef.current.values()) {
        const iconCenterY = naturalYForIndex(t.agentIndex)
        const iconCenterX = cx0
        const dy = cursor.active ? cursor.y - iconCenterY : 0
        const dx = cursor.active ? cursor.x - iconCenterX : 0

        // Tilt engagement — 1 at icon center, 0 outside (icon bounds + reach).
        // Cubic falloff (smoothstep-like) so the transition into / out of an
        // icon is gentle rather than a hard cutoff.
        const halfX = ICON_SIZE / 2 + TILT_REACH
        const halfY = ICON_SIZE / 2 + TILT_REACH
        const nx = clamp(-1, 1, dx / halfX)
        const ny = clamp(-1, 1, dy / halfY)
        const inBound = Math.max(Math.abs(nx), Math.abs(ny))
        // Smoothstep falloff: 1 - x^2(3-2x) gives a soft S-curve from 1 → 0.
        const u = inBound
        const engagement = cursor.active ? 1 - u * u * (3 - 2 * u) : 0

        // Tilt angles — the icon rotates so the cursor-facing edge lifts
        // toward the camera. Negative rotateX when cursor is below center
        // (top edge tilts AWAY, bottom edge tilts TOWARD the camera).
        const targetRy = nx * TILT_MAX_DEG * engagement
        const targetRx = -ny * TILT_MAX_DEG * engagement
        const targetScale = 1 + engagement * HOVER_SCALE
        const targetTz = engagement * TRANSLATE_Z_MAX
        // Y/X translation stays at 0 — icons do NOT shift in their slots in
        // this variant. Spring those values back to 0 in case the previous
        // mode (or a stray drag) left them displaced.
        const targetTy = 0

        ;[t.scale, t.scaleVel] = spring(t.scale, targetScale, t.scaleVel, stiffness, damping)
        ;[t.tz, t.tzVel] = spring(t.tz, targetTz, t.tzVel, stiffness, damping)
        ;[t.rx, t.rxVel] = spring(t.rx, targetRx, t.rxVel, stiffness, damping)
        ;[t.ry, t.ryVel] = spring(t.ry, targetRy, t.ryVel, stiffness, damping)
        ;[t.ty, t.tyVel] = spring(t.ty, targetTy, t.tyVel, stiffness, damping)

        // transform-origin is `center center` (default) so rotateX/Y pivot
        // around the icon's middle — gives the "card looking at cursor" look.
        t.el.style.transform =
          `perspective(${PERSPECTIVE}px)` +
          ` translateZ(${t.tz.toFixed(2)}px)` +
          ` rotateX(${t.rx.toFixed(2)}deg)` +
          ` rotateY(${t.ry.toFixed(2)}deg)` +
          ` scale(${t.scale.toFixed(3)})`

        const drift =
          Math.abs(t.scale - 1)
          + Math.abs(t.tz)
          + Math.abs(t.rx)
          + Math.abs(t.ry)
          + Math.abs(t.ty)
        const vel =
          Math.abs(t.scaleVel)
          + Math.abs(t.tzVel)
          + Math.abs(t.rxVel)
          + Math.abs(t.ryVel)
          + Math.abs(t.tyVel)
        if (drift + vel > REST_EPSILON) anyMoving = true
      }

      if (anyMoving) {
        rafIdRef.current = requestAnimationFrame(update)
      } else {
        for (const t of iconTiltsRef.current.values()) {
          t.scale = 1
          t.scaleVel = 0
          t.rx = 0
          t.rxVel = 0
          t.ry = 0
          t.ryVel = 0
          t.ty = 0
          t.tyVel = 0
          t.tz = 0
          t.tzVel = 0
          t.el.style.transform = ''
        }
        rafIdRef.current = 0
      }
    }

    const kickLoop = () => {
      if (!rafIdRef.current) {
        rafIdRef.current = requestAnimationFrame(update)
      }
    }

    const onMove = (e: MouseEvent) => {
      const rect = column.getBoundingClientRect()
      const x = e.clientX - rect.left
      const y = e.clientY - rect.top
      // Tilt window is slightly WIDER than the column so the effect engages
      // as the cursor approaches the edge, not only after it lands on top.
      const reach = 24
      const inside = x >= -reach && x <= rect.width + reach && y >= 0 && y <= rect.height
      cursorRef.current = { x, y, active: inside }
      kickLoop()
    }
    const onLeave = () => {
      cursorRef.current.active = false
      kickLoop()
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseleave', onLeave)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseleave', onLeave)
      if (rafIdRef.current) cancelAnimationFrame(rafIdRef.current)
      rafIdRef.current = 0
    }
  }, [])

  // ─── Drag the dock to reposition ───
  const dragStateRef = useRef<{ startCursorX: number; startCursorY: number; startWindowX: number; startWindowY: number } | null>(null)
  const onColumnMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    dragStateRef.current = {
      startCursorX: e.screenX,
      startCursorY: e.screenY,
      startWindowX: window.screenX,
      startWindowY: window.screenY,
    }
    let rafId: number | null = null
    let pendingX = window.screenX
    let pendingY = window.screenY
    const flush = () => {
      rafId = null
      window.dock.setBounds(pendingX, pendingY)
    }
    const onMove = (m: MouseEvent) => {
      const st = dragStateRef.current
      if (!st) return
      pendingX = st.startWindowX + (m.screenX - st.startCursorX)
      pendingY = st.startWindowY + (m.screenY - st.startCursorY)
      if (rafId === null) rafId = requestAnimationFrame(flush)
    }
    const onUp = () => {
      dragStateRef.current = null
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      if (rafId !== null) {
        cancelAnimationFrame(rafId)
        flush()
      }
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [])

  const handleIconClick = useCallback((agentId: string) => {
    window.dock.selectAgent(agentId)
    setActiveAgentId(agentId)
    setAgentStates((prev) => {
      const cur = prev[agentId]
      if (cur.status !== 'completed') return prev
      return { ...prev, [agentId]: { ...cur, status: 'idle' } }
    })
  }, [])

  const palette = useMemo(() => (isDark ? DARK_PALETTE : LIGHT_PALETTE), [isDark])

  const activeIndex = activeAgentId ? AGENTS.findIndex((a) => a.id === activeAgentId) : -1
  const activePillTop =
    activeIndex >= 0
      ? naturalYForIndex(activeIndex)
      : -100

  return (
    <div className={`dock-root${leaving ? ' is-leaving' : ''}`}>
      <div
        ref={dockColumnRef}
        className="dock-column"
        onMouseDown={onColumnMouseDown}
        style={{
          width: COLUMN_WIDTH,
          background: palette.columnBg,
          borderColor: palette.columnBorder,
        }}
      >
        <span className="dock-column-highlight" aria-hidden />

        <span
          className="dock-active-pill"
          aria-hidden
          style={{
            top: activePillTop,
            opacity: activeAgentId ? 1 : 0,
            background: activeAgentId ? AGENTS.find((a) => a.id === activeAgentId)?.accent : '#fff',
            boxShadow: activeAgentId
              ? `0 0 14px ${AGENTS.find((a) => a.id === activeAgentId)?.accent}`
              : 'none',
          }}
        />

        <div
          className="dock-agents"
          style={{ gap: ICON_PITCH - ICON_SIZE }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {AGENTS.map((agent) => {
            const state = agentStates[agent.id]
            const isActive = activeAgentId === agent.id
            return (
              <AgentIcon
                key={agent.id}
                agent={agent}
                state={state}
                isActive={isActive}
                isHovered={hovered === agent.id}
                onHoverChange={(v) => setHovered(v ? agent.id : null)}
                onClick={() => handleIconClick(agent.id)}
                registerTilt={registerIconTilt}
                palette={palette}
              />
            )
          })}
        </div>
      </div>

      <div className="dock-toast-stack" ref={toastListRef}>
        {toasts.map((t) => (
          <Toast
            key={t.id}
            toast={t}
            palette={palette}
            onClick={() => {
              window.dock.selectAgent(t.agentId)
              setToasts((prev) => prev.filter((x) => x.id !== t.id))
            }}
            onDismiss={() =>
              setToasts((prev) => prev.filter((x) => x.id !== t.id))
            }
          />
        ))}
      </div>
    </div>
  )
}

// ─── Agent icon ───

interface Palette {
  columnBg: string
  columnBorder: string
  columnHighlight: string
  iconBorder: string
  tooltipBg: string
  tooltipBorder: string
  tooltipText: string
  tooltipTagline: string
  toastBg: string
  toastBorder: string
  toastTitle: string
  toastSummary: string
}

const DARK_PALETTE: Palette = {
  columnBg: 'linear-gradient(180deg, rgba(36, 36, 42, 0.74) 0%, rgba(20, 20, 26, 0.88) 100%)',
  columnBorder: 'rgba(255, 255, 255, 0.10)',
  columnHighlight:
    'radial-gradient(120% 60% at 50% -10%, rgba(255, 255, 255, 0.18), transparent 70%)',
  iconBorder: 'rgba(255, 255, 255, 0.10)',
  tooltipBg: 'rgba(20, 20, 24, 0.92)',
  tooltipBorder: 'rgba(255, 255, 255, 0.10)',
  tooltipText: '#ffffff',
  tooltipTagline: 'rgba(255, 255, 255, 0.55)',
  toastBg: 'rgba(22, 22, 26, 0.94)',
  toastBorder: 'rgba(255, 255, 255, 0.10)',
  toastTitle: '#ffffff',
  toastSummary: 'rgba(255, 255, 255, 0.65)',
}

const LIGHT_PALETTE: Palette = {
  columnBg:
    'linear-gradient(180deg, rgba(255, 255, 255, 0.86) 0%, rgba(244, 244, 247, 0.94) 100%)',
  columnBorder: 'rgba(0, 0, 0, 0.08)',
  columnHighlight:
    'radial-gradient(120% 60% at 50% -10%, rgba(255, 255, 255, 0.8), transparent 70%)',
  iconBorder: 'rgba(0, 0, 0, 0.10)',
  tooltipBg: 'rgba(255, 255, 255, 0.96)',
  tooltipBorder: 'rgba(0, 0, 0, 0.08)',
  tooltipText: '#0f172a',
  tooltipTagline: 'rgba(15, 23, 42, 0.55)',
  toastBg: 'rgba(255, 255, 255, 0.96)',
  toastBorder: 'rgba(0, 0, 0, 0.08)',
  toastTitle: '#0f172a',
  toastSummary: 'rgba(15, 23, 42, 0.6)',
}

function AgentIcon({
  agent,
  state,
  isActive,
  isHovered,
  onHoverChange,
  onClick,
  registerTilt,
  palette,
}: {
  agent: (typeof AGENTS)[number]
  state: AgentState
  isActive: boolean
  isHovered: boolean
  onHoverChange: (v: boolean) => void
  onClick: () => void
  registerTilt: (agentId: string, el: HTMLDivElement | null) => void
  palette: Palette
}) {
  const status = state.status
  const isRunning = status === 'running'
  const isCompleted = status === 'completed'
  const isFailed = status === 'failed'
  const img = AGENT_IMAGE[agent.id]

  const accent = isFailed ? '#ff6b6b' : agent.accent

  const haloOpacity = isActive ? 0.7 : isHovered ? 0.5 : isRunning ? 0.6 : isCompleted ? 0.4 : 0

  // Register the tilt-wrapper ref so the App-level rAF loop can write
  // transforms straight to this element each frame.
  const tiltCallbackRef = useCallback(
    (el: HTMLDivElement | null) => registerTilt(agent.id, el),
    [agent.id, registerTilt],
  )

  return (
    <div
      className="dock-icon-slot"
      style={{ width: ICON_SIZE, height: ICON_SIZE }}
      onMouseEnter={() => onHoverChange(true)}
      onMouseLeave={() => onHoverChange(false)}
    >
      <span
        className="dock-icon-halo"
        aria-hidden
        style={{
          background: `radial-gradient(closest-side, ${accent} 0%, transparent 70%)`,
          opacity: haloOpacity,
        }}
      />

      {/* Tilt wrapper — the rAF loop writes perspective + rotateX/rotateY +
          scale here every frame. Keeping it on a separate element means the
          inner button can run its own state-based scale / pulse animations
          via CSS without colliding with the cursor-tracked transform. */}
      <div className="dock-icon-tilt" ref={tiltCallbackRef}>
        <button
          type="button"
          className={`dock-icon${isActive ? ' is-active' : ''}${isCompleted ? ' is-completed' : ''}`}
          onClick={(e) => {
            e.stopPropagation()
            onClick()
          }}
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            width: ICON_SIZE,
            height: ICON_SIZE,
            borderColor: isActive
              ? accent
              : isHovered
                ? `color-mix(in srgb, ${accent} 50%, ${palette.iconBorder})`
                : palette.iconBorder,
            color: accent,
          }}
          aria-label={`${agent.name} — ${agent.tagline}`}
        >
          <img
            className="dock-icon-img"
            src={img}
            alt=""
            draggable={false}
          />

          {isActive && (
            <svg
              className="dock-icon-active-arc"
              viewBox="0 0 56 56"
              width={ICON_SIZE}
              height={ICON_SIZE}
              aria-hidden
            >
              <rect
                x={1}
                y={1}
                width={54}
                height={54}
                rx={16}
                ry={16}
                fill="none"
                stroke={accent}
                strokeWidth={1.5}
                strokeOpacity={0.7}
              />
            </svg>
          )}
        </button>

        {isRunning && (
          <svg
            className="dock-icon-beam"
            viewBox="0 0 56 56"
            width={ICON_SIZE}
            height={ICON_SIZE}
            aria-hidden
            style={{ color: accent }}
          >
            <rect
              className="dock-icon-beam-rail"
              x={0.75}
              y={0.75}
              width={54.5}
              height={54.5}
              rx={17.25}
              ry={17.25}
            />
            <rect
              className="dock-icon-beam-head"
              x={0.75}
              y={0.75}
              width={54.5}
              height={54.5}
              rx={17.25}
              ry={17.25}
              pathLength={100}
            />
          </svg>
        )}
      </div>

      {isHovered && (
        <Tooltip
          palette={palette}
          title={agent.name}
          subtitle={humanizeStatus(state.status, agent.tagline, state.activity)}
          accent={accent}
        />
      )}
    </div>
  )
}

function humanizeStatus(status: AgentRuntimeStatus, tagline: string, activity: string): string {
  switch (status) {
    case 'running':
      return activity ? `running ${activity}…` : 'working on it…'
    case 'completed':
      return 'finished — click to review'
    case 'failed':
      return 'hit a snag'
    case 'idle':
    default:
      return tagline
  }
}

// ─── Tooltip ───

function Tooltip({
  palette,
  title,
  subtitle,
  accent,
}: {
  palette: Palette
  title: string
  subtitle: string
  accent?: string
}) {
  return (
    <div
      className="dock-tooltip"
      style={{
        background: palette.tooltipBg,
        borderColor: palette.tooltipBorder,
        color: palette.tooltipText,
      }}
    >
      <div className="dock-tooltip-name" style={accent ? { color: accent } : undefined}>
        {title}
      </div>
      <div className="dock-tooltip-tagline" style={{ color: palette.tooltipTagline }}>
        {subtitle}
      </div>
      <span
        className="dock-tooltip-arrow"
        aria-hidden
        style={{ borderRightColor: palette.tooltipBg }}
      />
    </div>
  )
}

// ─── Toast ───

function Toast({
  toast,
  palette,
  onClick,
  onDismiss,
}: {
  toast: ToastItem
  palette: Palette
  onClick: () => void
  onDismiss: () => void
}) {
  return (
    <div
      className="dock-toast"
      style={{
        background: palette.toastBg,
        borderColor: palette.toastBorder,
        color: palette.toastTitle,
      }}
      onClick={onClick}
      role="button"
      tabIndex={0}
    >
      <span
        className="dock-toast-accent"
        aria-hidden
        style={{ background: toast.accent, boxShadow: `0 0 14px ${toast.accent}` }}
      />
      <div className="dock-toast-body">
        <div className="dock-toast-title">
          <strong style={{ color: toast.accent }}>{toast.agentName}</strong> finished
        </div>
        <div className="dock-toast-summary" style={{ color: palette.toastSummary }}>
          {toast.summary}
        </div>
      </div>
      <button
        type="button"
        className="dock-toast-dismiss"
        onClick={(e) => {
          e.stopPropagation()
          onDismiss()
        }}
        aria-label="Dismiss"
      >
        ×
      </button>
    </div>
  )
}

// ─── Helpers ───

function hitTest(el: HTMLElement | null, x: number, y: number): boolean {
  if (!el) return false
  const r = el.getBoundingClientRect()
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max - 1).trimEnd() + '…'
}

// Build a short, human-readable recap from the agent's final assistant
// text. The goal is one or two sentences that read like "I added X" or
// "Fixed Y" — Claude leads with what was done, so the first sentence is
// almost always the most informative line of the response. Markdown is
// stripped because the toast renders as flat prose.
function summarizeForToast(raw: string): string {
  if (!raw) return ''
  let s = raw

  // Strip fenced code blocks entirely — they almost never belong in a recap.
  s = s.replace(/```[\s\S]*?```/g, ' ')
  // Inline code: unwrap to its content.
  s = s.replace(/`([^`]+)`/g, '$1')
  // Bold / italic markers.
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1')
  s = s.replace(/\*([^*]+)\*/g, '$1')
  s = s.replace(/__([^_]+)__/g, '$1')
  s = s.replace(/_([^_]+)_/g, '$1')
  // Links: keep the visible text, drop the URL.
  s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
  // Heading / blockquote / bullet markers at line starts.
  s = s.replace(/^[ \t]*[#>\-*+][ \t]+/gm, '')
  // Numbered list markers: "1. " "2) ".
  s = s.replace(/^[ \t]*\d+[.)][ \t]+/gm, '')
  // Collapse all whitespace into single spaces.
  s = s.replace(/\s+/g, ' ').trim()
  if (!s) return ''

  // First sentence — end at . ! ? followed by whitespace or end-of-string.
  const sentenceRe = /^(.+?[.!?])(\s|$)/
  let recap = ''
  const first = s.match(sentenceRe)
  if (first) {
    recap = first[1]
    // If the first sentence is curt ("Done." / "All set!"), pull the next
    // one too so the toast has actual substance.
    if (recap.length < 50) {
      const rest = s.slice(first[0].length).trim()
      const second = rest.match(sentenceRe)
      if (second && recap.length + 1 + second[1].length <= TOAST_SUMMARY_MAX + 20) {
        recap = recap + ' ' + second[1]
      }
    }
  } else {
    // No sentence terminator in the whole message — just use what we have.
    recap = s
  }
  return truncate(recap.trim(), TOAST_SUMMARY_MAX)
}

function friendlyToolName(raw: string): string {
  if (!raw) return ''
  if (raw.startsWith('mcp__rax-orb__')) {
    return raw.replace('mcp__rax-orb__', '').replace(/^rax_/, '').replace(/_/g, ' ')
  }
  return raw.toLowerCase()
}

function clamp(min: number, max: number, v: number): number {
  return v < min ? min : v > max ? max : v
}
