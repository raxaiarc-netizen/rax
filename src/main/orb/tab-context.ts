import { EventEmitter } from 'events'
import type { NormalizedEvent, MirrorAction } from '../../shared/types'
import { AGENTS, getAgent, isAgentId } from '../../shared/agents'

/**
 * Snapshot of one tab as the voice orb sees it.
 *
 * Built up incrementally from ControlPlane events (status, assistant text, tool calls,
 * task completion) and from MirrorActions published by renderers (user messages, tab
 * title, working directory). The orb agent reads this via the MCP `rax_list_tabs`
 * and `rax_read_tab` tools — so it always has the latest, non-stale picture of what
 * each tab is doing.
 *
 * Note: the five dock agents (Max/Alex/Luna/Nova/Zara) ARE tabs under the hood —
 * `tabId === 'agent-<name>'`. The snapshot formatter surfaces the agent identity
 * up-front so the voice orb addresses them by name instead of by index.
 */
export interface TabContextSnapshot {
  tabId: string
  title: string
  workingDirectory: string
  status: string
  claudeSessionId: string | null
  /** Index of this tab in the active renderer's tab strip (1-based for human-friendly addressing). */
  positionHint: number | null
  lastUserMessage: string | null
  lastUserMessageAt: number | null
  lastAssistantMessage: string | null
  lastAssistantMessageAt: number | null
  lastToolName: string | null
  lastToolAt: number | null
  lastErrorMessage: string | null
  lastActivityAt: number
  /** Recent message log — ring-buffered. Used by rax_read_tab(lastN). */
  recentMessages: TabContextMessage[]
}

export interface TabContextMessage {
  role: 'user' | 'assistant' | 'tool' | 'system'
  text: string
  toolName?: string
  timestamp: number
}

const MAX_RING = 40
const TRIM_MAX_USER = 800
const TRIM_MAX_AI = 1200
const TRIM_MAX_TOOL = 400

function clip(s: string, n: number): string {
  if (!s) return ''
  return s.length > n ? s.substring(0, n) + '…' : s
}

/**
 * Tracks per-tab context for the orb. Single source of truth in main.
 *
 * Sources of truth for each field:
 *  - `status`, `claudeSessionId` ← ControlPlane tab registry / status events
 *  - `lastAssistantMessage`, `lastToolName`, `lastErrorMessage` ← ControlPlane normalized events
 *  - `lastUserMessage`, `title`, `workingDirectory`, positionHint ← MirrorActions from renderers
 */
export class TabContextRegistry extends EventEmitter {
  private tabs = new Map<string, TabContextSnapshot>()
  /** Buffered assistant text, flushed into lastAssistantMessage on task_complete. */
  private assistantBuffers = new Map<string, string>()
  /** Tab order from the most recent renderer snapshot — used to derive positionHint. */
  private orderedTabIds: string[] = []

  // ─── Lifecycle ───

  ensureTab(tabId: string): TabContextSnapshot {
    let snap = this.tabs.get(tabId)
    if (!snap) {
      snap = {
        tabId,
        title: 'Untitled',
        workingDirectory: '',
        status: 'idle',
        claudeSessionId: null,
        positionHint: null,
        lastUserMessage: null,
        lastUserMessageAt: null,
        lastAssistantMessage: null,
        lastAssistantMessageAt: null,
        lastToolName: null,
        lastToolAt: null,
        lastErrorMessage: null,
        lastActivityAt: Date.now(),
        recentMessages: [],
      }
      this.tabs.set(tabId, snap)
      this.emit('tab-added', tabId)
    }
    return snap
  }

  removeTab(tabId: string): void {
    if (this.tabs.delete(tabId)) {
      this.assistantBuffers.delete(tabId)
      this.orderedTabIds = this.orderedTabIds.filter((id) => id !== tabId)
      this.emit('tab-removed', tabId)
    }
  }

  // ─── Read-side ───

  list(): TabContextSnapshot[] {
    // Order by orderedTabIds first (those the renderer reported), then any extras.
    const known = new Set(this.orderedTabIds)
    const ordered: TabContextSnapshot[] = []
    for (const id of this.orderedTabIds) {
      const t = this.tabs.get(id)
      if (t) ordered.push(t)
    }
    for (const [id, t] of this.tabs) {
      if (!known.has(id)) ordered.push(t)
    }
    return ordered
  }

  get(tabId: string): TabContextSnapshot | undefined {
    return this.tabs.get(tabId)
  }

  /**
   * Resolve a possibly-fuzzy reference. Tried in order:
   *   1. Exact tabId (UUID or `agent-<name>`).
   *   2. Agent NAME ("Max", "alex", "LUNA") → its reserved agent tab.
   *   3. Numeric 1-based index ("2").
   *   4. UUID prefix.
   *   5. Title substring (case-insensitive).
   *
   * The orb addresses the crew by name, so name lookup wins over title
   * substring — that way "send to Max" never accidentally picks up another
   * tab whose title happens to contain those letters.
   */
  resolve(reference: string): TabContextSnapshot | null {
    if (!reference) return null
    const trimmed = reference.trim()
    if (!trimmed) return null

    // Exact tabId (covers both UUID tabs and the reserved 'agent-*' ids)
    const exact = this.tabs.get(trimmed)
    if (exact) return exact

    // Agent name match (case-insensitive) — e.g. "Max" → tab 'agent-max'
    const lower = trimmed.toLowerCase()
    for (const a of AGENTS) {
      if (a.name.toLowerCase() === lower) {
        const snap = this.tabs.get(a.id)
        if (snap) return snap
      }
    }

    // Numeric index (1-based)
    const asInt = Number.parseInt(trimmed, 10)
    if (Number.isFinite(asInt) && asInt >= 1) {
      const list = this.list()
      if (asInt <= list.length) return list[asInt - 1]
    }

    // UUID prefix
    if (/^[0-9a-f]{4,}/i.test(trimmed)) {
      for (const t of this.tabs.values()) {
        if (t.tabId.toLowerCase().startsWith(lower)) return t
      }
    }

    // Title substring (case-insensitive) — last resort
    for (const t of this.tabs.values()) {
      if (t.title.toLowerCase().includes(lower)) return t
    }

    return null
  }

  // ─── Write-side: ControlPlane events ───

  applyStatusChange(tabId: string, newStatus: string): void {
    const snap = this.ensureTab(tabId)
    snap.status = newStatus
    snap.lastActivityAt = Date.now()
  }

  applyEvent(tabId: string, event: NormalizedEvent): void {
    const snap = this.ensureTab(tabId)
    snap.lastActivityAt = Date.now()

    switch (event.type) {
      case 'session_init':
        snap.claudeSessionId = event.sessionId
        break

      case 'text_chunk': {
        const buf = (this.assistantBuffers.get(tabId) || '') + event.text
        this.assistantBuffers.set(tabId, buf)
        break
      }

      case 'tool_call': {
        snap.lastToolName = event.toolName
        snap.lastToolAt = Date.now()
        this._pushMessage(snap, {
          role: 'tool',
          text: '',
          toolName: event.toolName,
          timestamp: Date.now(),
        })
        break
      }

      case 'task_complete': {
        const buffered = this.assistantBuffers.get(tabId) || ''
        const final = buffered.trim() || event.result.trim()
        if (final) {
          snap.lastAssistantMessage = clip(final, TRIM_MAX_AI)
          snap.lastAssistantMessageAt = Date.now()
          this._pushMessage(snap, {
            role: 'assistant',
            text: clip(final, TRIM_MAX_AI),
            timestamp: Date.now(),
          })
        }
        this.assistantBuffers.delete(tabId)
        break
      }

      case 'error': {
        snap.lastErrorMessage = clip(event.message, TRIM_MAX_TOOL)
        break
      }
    }
  }

  // ─── Write-side: MirrorActions from renderers ───

  applyMirrorAction(action: MirrorAction): void {
    switch (action.kind) {
      case 'tab-created': {
        const snap = this.ensureTab(action.tabId)
        if (action.workingDirectory) snap.workingDirectory = action.workingDirectory
        break
      }
      case 'tab-closed':
        this.removeTab(action.tabId)
        break
      case 'tab-title': {
        const snap = this.ensureTab(action.tabId)
        snap.title = action.title || 'Untitled'
        break
      }
      case 'directory-set': {
        const snap = this.ensureTab(action.tabId)
        snap.workingDirectory = action.directory
        break
      }
      case 'user-message': {
        const snap = this.ensureTab(action.tabId)
        const text = clip(action.content, TRIM_MAX_USER)
        snap.lastUserMessage = text
        snap.lastUserMessageAt = action.timestamp
        snap.lastActivityAt = action.timestamp
        this._pushMessage(snap, {
          role: 'user',
          text,
          timestamp: action.timestamp,
        })
        break
      }
      case 'system-message': {
        const snap = this.ensureTab(action.tabId)
        this._pushMessage(snap, {
          role: 'system',
          text: clip(action.content, TRIM_MAX_TOOL),
          timestamp: action.timestamp,
        })
        break
      }
    }
  }

  // ─── Write-side: full snapshot from a renderer ───

  applySessionSnapshot(snapshot: { tabs: Array<{ id: string; title: string; workingDirectory: string; status: string; claudeSessionId: string | null }> }): void {
    if (!snapshot || !Array.isArray(snapshot.tabs)) return
    const seen = new Set<string>()
    const order: string[] = []
    for (const t of snapshot.tabs) {
      if (!t.id) continue
      seen.add(t.id)
      order.push(t.id)
      const snap = this.ensureTab(t.id)
      if (t.title) snap.title = t.title
      if (t.workingDirectory) snap.workingDirectory = t.workingDirectory
      if (t.status) snap.status = t.status
      if (t.claudeSessionId) snap.claudeSessionId = t.claudeSessionId
    }
    this.orderedTabIds = order
    // Drop tabs the renderer no longer knows about.
    for (const id of Array.from(this.tabs.keys())) {
      if (!seen.has(id)) this.removeTab(id)
    }
  }

  setOrder(tabIds: string[]): void {
    this.orderedTabIds = [...tabIds]
  }

  // ─── Internals ───

  private _pushMessage(snap: TabContextSnapshot, msg: TabContextMessage): void {
    snap.recentMessages.push(msg)
    if (snap.recentMessages.length > MAX_RING) {
      snap.recentMessages.splice(0, snap.recentMessages.length - MAX_RING)
    }
  }
}

/**
 * Project a snapshot down to a compact JSON shape for the orb's MCP responses.
 * Keep it small — every byte ends up in the orb's context window.
 */
export function projectSnapshot(s: TabContextSnapshot, index: number): Record<string, unknown> {
  const agent = getAgent(s.tabId)
  return {
    tabId: s.tabId,
    index: index + 1,
    agent: agent ? { name: agent.name, tagline: agent.tagline } : null,
    title: s.title,
    workingDirectory: s.workingDirectory || null,
    status: s.status,
    claudeSessionId: s.claudeSessionId,
    lastUserMessage: s.lastUserMessage,
    lastAssistantMessage: s.lastAssistantMessage,
    lastTool: s.lastToolName,
    lastError: s.lastErrorMessage,
    lastActivityAtIso: s.lastActivityAt ? new Date(s.lastActivityAt).toISOString() : null,
  }
}

const SNAPSHOT_TITLE_CLIP = 50
const SNAPSHOT_MSG_CLIP = 120

/**
 * One-line-per-tab snapshot prepended to every orb voice turn so the model
 * grounds for free instead of paying a rax_list_tabs round-trip. Keep it
 * terse — every byte rides along on every single turn.
 *
 * For the five dock agents we lead with `<Name> (<tagline>)` instead of the
 * generic title, so the orb's turn-by-turn context reinforces that it is
 * talking ABOUT people, not numbered tabs.
 */
export function formatTabsSnapshot(snapshots: TabContextSnapshot[]): string {
  if (snapshots.length === 0) return '(crew idle)'
  return snapshots
    .map((s, i) => {
      const agent = getAgent(s.tabId)
      const parts: string[] = [`[${i + 1}]`]
      if (agent) {
        parts.push(`${agent.name} (${agent.tagline})`)
      } else {
        parts.push(JSON.stringify(clip(s.title || 'Untitled', SNAPSHOT_TITLE_CLIP)))
      }
      parts.push(s.status)
      if (s.lastToolName) parts.push(`tool=${s.lastToolName}`)
      if (s.lastUserMessage) {
        const msg = clip(s.lastUserMessage.replace(/\s+/g, ' ').trim(), SNAPSHOT_MSG_CLIP)
        parts.push(`msg=${JSON.stringify(msg)}`)
      }
      return parts.join(' ')
    })
    .join('\n')
}

/** Re-export so callers don't have to know where it lives. */
export { isAgentId }
