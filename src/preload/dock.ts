// Preload for the agent dock window. The dock subscribes to the same status /
// task-complete stream the pill + fullscreen renderers consume so it can
// mirror agent state, plus a small set of dock-specific channels (hide,
// select-agent, position-save). Snapshot pull is reused from the main API
// so the dock can paint correct initial state before the first event arrives.
import { contextBridge, ipcRenderer } from 'electron'

// Channel constants are inlined so this preload bundles to a single
// self-contained file (sandboxed preloads can't resolve relative imports at
// runtime). Keep these strings in sync with src/shared/types.ts.
//
// Note: main broadcasts every per-tab claude event through a SINGLE firehose
// channel (`rax:normalized-event`) plus a tab-level status channel
// (`rax:tab-status-change`). Earlier versions of this preload subscribed to
// per-type channels (rax:text-chunk, rax:tool-call, …) that main no longer
// emits — those listeners would never fire, leaving the dock stuck on the
// initial idle state. Anything you add here must match a channel actually
// broadcast by `broadcast()` in src/main/index.ts.
const CHANNELS = {
  DOCK_HIDE: 'rax:dock-hide',
  DOCK_SELECT_AGENT: 'rax:dock-select-agent',
  DOCK_SET_POSITION: 'rax:dock-set-position',
  STATE_SNAPSHOT_PULL: 'rax:state-snapshot-pull',
  STATE_MIRROR_SUBSCRIBE: 'rax:state-mirror-subscribe',
  NORMALIZED_EVENT: 'rax:normalized-event',
  TAB_STATUS_CHANGE: 'rax:tab-status-change',
  SET_IGNORE_MOUSE_EVENTS: 'rax:set-ignore-mouse-events',
  GET_THEME: 'rax:get-theme',
  THEME_CHANGED: 'rax:theme-changed',
  ORB_TOGGLE: 'rax:orb-toggle',
} as const

export interface DockEventPayload {
  tabId: string
  type: string
  [k: string]: unknown
}

export interface DockAPI {
  /** Pull the most recent session snapshot from main. Lets the dock paint
   *  the correct active-agent indicator + per-agent status on mount. */
  pullSnapshot(): Promise<unknown>
  /** Subscribe to optimistic mirror actions (tab-selected is the one we
   *  care about — it changes which agent is highlighted). */
  onMirror(callback: (action: unknown) => void): () => void
  /** Subscribe to streaming control-plane events. We collapse them into a
   *  single firehose: each event carries `tabId` + `type` so the dock can
   *  pick the ones that match a known agent id. */
  onAgentEvent(callback: (payload: DockEventPayload) => void): () => void
  /** User clicked an agent icon. Main forwards a tab-selected mirror to the
   *  pill / fullscreen and surfaces the closest chat surface. */
  selectAgent(agentId: string): void
  /** Hide the dock window (tray-equivalent action from the dock itself). */
  hide(): Promise<void>
  /** Window-level click-through plumbing — same pattern the orb uses. */
  setIgnoreMouseEvents(ignore: boolean, options?: { forward?: boolean }): void
  /** Persist a new dock position (rAF-throttled drag from the renderer). */
  setBounds(x: number, y: number): void
  /** Current OS theme (light/dark) + subscription so the dock can flip palettes. */
  getTheme(): Promise<{ isDark: boolean }>
  onThemeChange(callback: (isDark: boolean) => void): () => void
  /** Toggle the voice orb window — called from the dock's voice cap so the
   *  user can summon Orb without leaving the dock surface. Idempotent. */
  toggleOrb(): Promise<{ ok: boolean }>
}

function wrap<T>(channel: string, callback: (payload: T) => void) {
  const handler = (_e: Electron.IpcRendererEvent, payload: T) => callback(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const api: DockAPI = {
  pullSnapshot: () => ipcRenderer.invoke(CHANNELS.STATE_SNAPSHOT_PULL),
  onMirror: (callback) => wrap(CHANNELS.STATE_MIRROR_SUBSCRIBE, callback),
  onAgentEvent: (callback) => {
    // Main broadcasts every per-tab claude event through one firehose channel:
    //   ipcRenderer.on('rax:normalized-event', (e, tabId, event) => …)
    // where `event` is `{ type: 'text_chunk' | 'tool_call' | … , …rest }`.
    // We also subscribe to the tab-level status channel so the dock can flip
    // an icon to 'running' the instant a tab starts, instead of waiting for
    // the first text_chunk to land (which can take a couple of seconds on a
    // tool-heavy turn).
    const offs: Array<() => void> = []

    const onNormalized = (
      _e: Electron.IpcRendererEvent,
      tabId: string,
      event: ({ type?: string } & Record<string, unknown>) | null | undefined,
    ) => {
      if (!tabId || !event || typeof event !== 'object') return
      const type = typeof event.type === 'string' ? event.type : ''
      if (!type) return
      callback({ ...event, tabId, type } as DockEventPayload)
    }
    ipcRenderer.on(CHANNELS.NORMALIZED_EVENT, onNormalized)
    offs.push(() => ipcRenderer.removeListener(CHANNELS.NORMALIZED_EVENT, onNormalized))

    const onTabStatus = (
      _e: Electron.IpcRendererEvent,
      tabId: string,
      newStatus: string,
    ) => {
      if (!tabId || typeof newStatus !== 'string') return
      callback({ tabId, type: 'tab_status_change', status: newStatus } as DockEventPayload)
    }
    ipcRenderer.on(CHANNELS.TAB_STATUS_CHANGE, onTabStatus)
    offs.push(() => ipcRenderer.removeListener(CHANNELS.TAB_STATUS_CHANGE, onTabStatus))

    return () => {
      for (const off of offs) off()
    }
  },
  selectAgent: (agentId) => {
    void ipcRenderer.invoke(CHANNELS.DOCK_SELECT_AGENT, agentId)
  },
  hide: () => ipcRenderer.invoke(CHANNELS.DOCK_HIDE).then(() => undefined),
  setIgnoreMouseEvents: (ignore, options) =>
    ipcRenderer.send(CHANNELS.SET_IGNORE_MOUSE_EVENTS, ignore, options || {}),
  setBounds: (x, y) => ipcRenderer.send(CHANNELS.DOCK_SET_POSITION, x, y),
  getTheme: () => ipcRenderer.invoke(CHANNELS.GET_THEME),
  onThemeChange: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, isDark: boolean) => callback(isDark)
    ipcRenderer.on(CHANNELS.THEME_CHANGED, handler)
    return () => ipcRenderer.removeListener(CHANNELS.THEME_CHANGED, handler)
  },
  toggleOrb: () => ipcRenderer.invoke(CHANNELS.ORB_TOGGLE),
}

contextBridge.exposeInMainWorld('dock', api)
