import { create } from 'zustand'
import type { TabStatus, NormalizedEvent, EnrichedError, Message, TabState, Attachment, CatalogPlugin, PluginStatus, CodeModeState, MirrorAction, SessionSnapshot } from '../../shared/types'
import { ORB_TAB_ID, DEFAULT_MODEL_ID } from '../../shared/types'
import { AGENTS, DEFAULT_AGENT_ID, getAgent, isAgentId } from '../../shared/agents'
import { useThemeStore } from '../theme'
import notificationSrc from '../../../resources/notification.mp3'

// Mirror suppression — when applying an inbound MirrorAction we set this so
// the receiving setter doesn't re-publish it back to other renderers.
let suppressMirror = false
function publishMirror(action: MirrorAction): void {
  if (suppressMirror) return
  try { window.rax.publishMirror(action) } catch {}
}

// ─── Known models ───

export const AVAILABLE_MODELS = [
  { id: DEFAULT_MODEL_ID, label: 'Opus 4.7' },
  { id: 'claude-opus-4-6', label: 'Opus 4.6' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
  // Rax Default — wire id is still `kimi-k2.6` (the Moonshot model the proxy
  // forwards to server-side). The UI label is genericized so users see this
  // as a first-class Rax model rather than as a third-party brand.
  { id: 'kimi-k2.6', label: 'Rax Default' },
] as const

function normalizeModelId(modelId: string): string {
  // Claude sometimes appends context window hints like "[1m]" to model IDs.
  return modelId.replace(/\[[^\]]+\]/g, '').trim()
}

const PREFERRED_MODEL_STORAGE_KEY = 'rax:preferredModel'

// One-time migration: users who launched the app before 4.7 became default
// have 'claude-opus-4-6' persisted as their preferred model. Upgrade them to
// the new default so the orb, status bar, and spawn args all line up. They can
// still pick 4.6 again from the model menu if they want it.
const LEGACY_DEFAULT_MODEL_ID = 'claude-opus-4-6'

function loadPersistedPreferredModel(): string {
  try {
    const stored = localStorage.getItem(PREFERRED_MODEL_STORAGE_KEY)
    if (stored === LEGACY_DEFAULT_MODEL_ID) {
      localStorage.setItem(PREFERRED_MODEL_STORAGE_KEY, DEFAULT_MODEL_ID)
      return DEFAULT_MODEL_ID
    }
    if (stored && AVAILABLE_MODELS.some((m) => m.id === stored)) return stored
  } catch {}
  return DEFAULT_MODEL_ID
}

// localStorage.setItem is synchronous IO and can block the main thread for a
// few ms on some platforms. The model rarely changes, but a user toggling
// through the menu could fire 5+ writes in a row — coalesce them.
let persistPreferredModelTimer: ReturnType<typeof setTimeout> | null = null
let persistPreferredModelPending: string | null | undefined
function persistPreferredModel(model: string | null): void {
  persistPreferredModelPending = model
  if (persistPreferredModelTimer) return
  persistPreferredModelTimer = setTimeout(() => {
    persistPreferredModelTimer = null
    const value = persistPreferredModelPending
    persistPreferredModelPending = undefined
    try {
      if (value) localStorage.setItem(PREFERRED_MODEL_STORAGE_KEY, value)
      else localStorage.removeItem(PREFERRED_MODEL_STORAGE_KEY)
    } catch {}
  }, 300)
}

export function getModelDisplayLabel(modelId: string): string {
  const normalizedId = normalizeModelId(modelId)
  const has1MContext = /\[\s*1m\s*\]/i.test(modelId)

  const known = AVAILABLE_MODELS.find((m) => m.id === normalizedId)
  if (known) {
    return has1MContext ? `${known.label} (1M)` : known.label
  }

  // Fallback for future model IDs not yet listed in AVAILABLE_MODELS.
  const compact = normalizedId
    .replace(/^claude-/, '')
    .replace(/-\d{8}$/, '')
  const familyMatch = compact.match(/^(opus|sonnet|haiku)-(\d+)-(\d+)$/i)
  if (familyMatch) {
    const family = familyMatch[1][0].toUpperCase() + familyMatch[1].slice(1).toLowerCase()
    const label = `${family} ${familyMatch[2]}.${familyMatch[3]}`
    return has1MContext ? `${label} (1M)` : label
  }

  return has1MContext ? `${normalizedId} (1M)` : normalizedId
}

// ─── Store ───

interface StaticInfo {
  version: string
  email: string | null
  subscriptionType: string | null
  projectPath: string
  homePath: string
}

interface State {
  tabs: TabState[]
  activeTabId: string
  /** Global expand/collapse — user-controlled, not per-tab */
  isExpanded: boolean
  /** Global info fetched on startup (not per-session) */
  staticInfo: StaticInfo | null
  /** User's preferred model override (null = use default) */
  preferredModel: string | null
  /** Global permission mode: 'ask' shows cards, 'auto' auto-approves all tool calls, 'bypass' skips all permission checks (dangerous) */
  permissionMode: 'ask' | 'auto' | 'bypass'

  // Marketplace state
  marketplaceOpen: boolean
  marketplaceCatalog: CatalogPlugin[]
  marketplaceLoading: boolean
  marketplaceError: string | null
  marketplaceInstalledNames: string[]
  marketplacePluginStates: Record<string, PluginStatus>
  marketplaceSearch: string
  marketplaceFilter: string

  // Code Mode state (single shared dev preview, mirrors main process)
  codeMode: CodeModeState

  // Actions
  initStaticInfo: () => Promise<void>
  setPreferredModel: (model: string | null) => void
  setPermissionMode: (mode: 'ask' | 'auto' | 'bypass') => void
  createTab: () => Promise<string>
  selectTab: (tabId: string) => void
  closeTab: (tabId: string) => void
  /** Clear messages from a tab. Defaults to the active tab if no id given —
   *  preserves the original single-arg API used by the input bar. */
  clearTab: (tabId?: string) => void
  toggleExpanded: () => void
  toggleMarketplace: () => void
  closeMarketplace: () => void
  loadMarketplace: (forceRefresh?: boolean) => Promise<void>
  setMarketplaceSearch: (query: string) => void
  setMarketplaceFilter: (filter: string) => void
  installMarketplacePlugin: (plugin: CatalogPlugin) => Promise<void>
  uninstallMarketplacePlugin: (plugin: CatalogPlugin) => Promise<void>
  buildYourOwn: () => void
  resumeSession: (sessionId: string, title?: string, projectPath?: string) => Promise<string>
  addSystemMessage: (content: string) => void
  sendMessage: (prompt: string, projectPath?: string) => void
  respondPermission: (tabId: string, questionId: string, optionId: string) => void
  addDirectory: (dir: string) => void
  removeDirectory: (dir: string) => void
  setBaseDirectory: (dir: string) => void
  addAttachments: (attachments: Attachment[]) => void
  removeAttachment: (attachmentId: string) => void
  clearAttachments: () => void
  handleNormalizedEvent: (tabId: string, event: NormalizedEvent) => void
  handleStatusChange: (tabId: string, newStatus: string, oldStatus: string) => void
  handleError: (tabId: string, error: EnrichedError) => void

  // Code Mode
  toggleCodeMode: () => Promise<void>
  setCodeModeState: (state: CodeModeState) => void

  // Voice orb tab — append events streamed from main into the pinned tab.
  applyOrbEvent: (event: { type: string; [k: string]: unknown }) => void
  /** Wipe the Voice tab's messages locally. Triggered by main's
   *  ORB_RESET_BROADCAST so every renderer clears in lockstep. */
  applyOrbReset: () => void

  // Cross-renderer mirroring
  applyMirror: (action: MirrorAction) => void
  exportSnapshot: () => SessionSnapshot
  seedFromSnapshot: (snapshot: SessionSnapshot) => void
}

let msgCounter = 0
const nextMsgId = () => `msg-${++msgCounter}`

function friendlyToolName(raw: string): string {
  if (raw.startsWith('mcp__rax-orb__')) {
    return raw.replace('mcp__rax-orb__', '').replace(/^rax_/, '').replace(/_/g, ' ')
  }
  return raw
}

// ─── Notification sound (plays when task completes while window is hidden) ───
// Lazy-construct on first use so module evaluation doesn't block on Audio()
// decoding (saves ~tens-of-ms during fullscreen window cold-start).
let notificationAudio: HTMLAudioElement | null = null
function getNotificationAudio(): HTMLAudioElement {
  if (!notificationAudio) {
    notificationAudio = new Audio(notificationSrc)
    notificationAudio.volume = 1.0
  }
  return notificationAudio
}

async function playNotificationIfHidden(): Promise<void> {
  if (!useThemeStore.getState().soundEnabled) return
  try {
    const visible = await window.rax.isVisible()
    if (!visible) {
      const a = getNotificationAudio()
      a.currentTime = 0
      a.play().catch(() => {})
    }
  } catch {}
}

function makeLocalTab(): TabState {
  return {
    id: crypto.randomUUID(),
    claudeSessionId: null,
    status: 'idle',
    activeRequestId: null,
    hasUnread: false,
    currentActivity: '',
    permissionQueue: [],
    permissionDenied: null,
    attachments: [],
    messages: [],
    title: 'New Tab',
    lastResult: null,
    sessionModel: null,
    sessionTools: [],
    sessionMcpServers: [],
    sessionSkills: [],
    sessionVersion: null,
    queuedPrompts: [],
    workingDirectory: '~',
    hasChosenDirectory: false,
    additionalDirs: [],
  }
}

// Pinned voice-orb tab. Read-only history view of every orb conversation.
// Never has a claude session — its messages are appended directly from the
// orb event stream forwarded by main.
function makeOrbTab(): TabState {
  return {
    ...makeLocalTab(),
    id: ORB_TAB_ID,
    title: 'Voice',
    isOrbTab: true,
    hasChosenDirectory: true,
  }
}

// ─── Agent tabs ───
//
// The five-agent dock binds each agent identity to one tab. The tab's `id`
// is the agent's stable id (see src/shared/agents.ts), which is also what
// main's ControlPlane registers for the claude subprocess — so the dock,
// renderer store, and main process all address the same thing by the same
// string. The agent identity itself never changes; what changes is the
// tab's runtime state (status, messages, ...).
function makeAgentTab(agentId: string): TabState {
  const agent = getAgent(agentId)
  return {
    ...makeLocalTab(),
    id: agentId,
    title: agent ? agent.name : 'Agent',
    agentId,
    // Agent tabs are dormant in the pill strip until the dock surfaces them.
    // The session + claude registration are real — only the visual chip is
    // suppressed — so an agent can still receive prompts (e.g. dispatched by
    // the orb) and show its result on the dock without ever appearing in the
    // pill.
    hidden: true,
  }
}

const initialOrbTab = makeOrbTab()
const initialAgentTabs: TabState[] = AGENTS.map((a) => makeAgentTab(a.id))
// A regular free-form chat tab — this is what the user sees in the pill on a
// fresh launch. App.tsx replaces its local id with a server-registered tab id
// once `window.rax.createTab()` resolves. Keeps the "open Rax, type, press
// enter" flow identical to the pre-multi-agent build.
const initialDefaultTab: TabState = (() => {
  const base = makeLocalTab()
  base.title = 'New Tab'
  return base
})()

export const useSessionStore = create<State>((set, get) => ({
  tabs: [initialOrbTab, initialDefaultTab, ...initialAgentTabs],
  activeTabId: initialDefaultTab.id,
  isExpanded: false,
  staticInfo: null,
  preferredModel: loadPersistedPreferredModel(),
  permissionMode: 'bypass',

  // Marketplace
  marketplaceOpen: false,
  marketplaceCatalog: [],
  marketplaceLoading: false,
  marketplaceError: null,
  marketplaceInstalledNames: [],
  marketplacePluginStates: {},
  marketplaceSearch: '',
  marketplaceFilter: 'All',

  // Code Mode (initial — actual state pushed from main when toggled)
  codeMode: {
    status: 'idle',
    projectPath: null,
    project: null,
    url: null,
    error: null,
    device: 'desktop',
    inspecting: false,
  },

  initStaticInfo: async () => {
    try {
      const result = await window.rax.start()
      set({
        staticInfo: {
          version: result.version || 'unknown',
          email: result.auth?.email || null,
          subscriptionType: result.auth?.subscriptionType || null,
          projectPath: result.projectPath || '~',
          homePath: result.homePath || '~',
        },
      })
      // Push the renderer's current permission mode to the backend so a
      // dev hot-reload (which resets renderer state but not the main
      // process) doesn't leave the two out of sync. No-op in the common
      // case where both default to 'bypass'.
      try { window.rax.setPermissionMode(get().permissionMode) } catch {}
    } catch {}
  },

  setPreferredModel: (model) => {
    set({ preferredModel: model })
    persistPreferredModel(model)
    publishMirror({ kind: 'preferred-model', model })
    // Keep the voice orb's model aligned with the picker. The orb runs as a
    // separate session and historically used a hardcoded default — the
    // picker only affected tab spawns. Pushing the new id over IPC means
    // the orb's next turn (and any respawn) uses the same model the user
    // sees in the picker label.
    const orbModel = model || DEFAULT_MODEL_ID
    try { void window.rax.setOrbModel(orbModel) } catch {}
  },

  setPermissionMode: (mode) => {
    set({ permissionMode: mode })
    window.rax.setPermissionMode(mode)
    publishMirror({ kind: 'permission-mode', mode })
  },

  setCodeModeState: (state: CodeModeState) => {
    set({ codeMode: state })
  },

  // ─── Voice orb tab — read-only history of every orb conversation ───
  //
  // Main forwards every NormalizedEvent the orb session emits to all
  // renderers as ORB_EVENT_BROADCAST. We map the streaming events to
  // Message entries on the pinned orb tab. This tab has no claude session;
  // status is just a visual indicator while the orb is responding.
  applyOrbEvent: (event) => {
    const evt = event as {
      type: string
      text?: string
      toolName?: string
      message?: string
      exitCode?: number | null
    }

    set((s) => ({
      tabs: s.tabs.map((tab) => {
        if (!tab.isOrbTab) return tab
        const updated = { ...tab, messages: [...tab.messages] }

        switch (evt.type) {
          case 'orb_user_turn': {
            const text = String(evt.text || '').trim()
            if (!text) break
            updated.messages.push({
              id: nextMsgId(),
              role: 'user',
              content: text,
              timestamp: Date.now(),
            })
            updated.messages.push({
              id: nextMsgId(),
              role: 'assistant',
              content: '',
              timestamp: Date.now(),
            })
            updated.status = 'running'
            updated.currentActivity = 'Listening...'
            break
          }

          case 'orb_user_attachment': {
            // Auto-screenshot ride-along event — fires right after the
            // matching orb_user_turn. Tag the most recent user message so the
            // chip renders inline with the bubble. We don't ship pixel bytes
            // across IPC; this is metadata only.
            for (let i = updated.messages.length - 1; i >= 0; i--) {
              const m = updated.messages[i]
              if (m.role === 'user') {
                updated.messages[i] = { ...m, hasAutoScreenshot: true }
                break
              }
            }
            break
          }

          case 'text_chunk': {
            const text = String(evt.text || '')
            if (!text) break
            updated.currentActivity = 'Speaking...'
            const last = updated.messages[updated.messages.length - 1]
            if (last && last.role === 'assistant' && !last.toolName) {
              updated.messages[updated.messages.length - 1] = {
                ...last,
                content: last.content + text,
              }
            } else {
              updated.messages.push({
                id: nextMsgId(),
                role: 'assistant',
                content: text,
                timestamp: Date.now(),
              })
            }
            break
          }

          case 'tool_call': {
            const toolName = String(evt.toolName || '')
            if (!toolName) break
            if (/^(Read|Glob|Grep|LS|TodoRead|TodoWrite)$/.test(toolName)) break
            updated.currentActivity = `Running ${friendlyToolName(toolName)}`
            updated.messages.push({
              id: nextMsgId(),
              role: 'tool',
              content: '',
              toolName: friendlyToolName(toolName),
              toolStatus: 'running',
              timestamp: Date.now(),
            })
            break
          }

          case 'tool_call_complete': {
            for (let i = updated.messages.length - 1; i >= 0; i--) {
              const m = updated.messages[i]
              if (m.role === 'tool' && m.toolStatus === 'running') {
                updated.messages[i] = { ...m, toolStatus: 'completed' }
                break
              }
            }
            break
          }

          case 'task_complete': {
            updated.status = 'completed'
            updated.currentActivity = ''
            if (s.activeTabId !== tab.id || !s.isExpanded) {
              updated.hasUnread = true
            }
            const last = updated.messages[updated.messages.length - 1]
            if (last && last.role === 'assistant' && !last.content && !last.toolName) {
              updated.messages.pop()
            }
            break
          }

          case 'error':
          case 'orb_session_dead': {
            updated.status = 'failed'
            updated.currentActivity = ''
            updated.messages.push({
              id: nextMsgId(),
              role: 'system',
              content: evt.type === 'orb_session_dead'
                ? `Voice agent session ended (exit ${evt.exitCode ?? '—'})`
                : `Error: ${String(evt.message || 'unknown')}`,
              timestamp: Date.now(),
            })
            break
          }
        }

        return updated
      }),
    }))
  },

  applyOrbReset: () => {
    set((s) => ({
      tabs: s.tabs.map((tab) =>
        tab.isOrbTab
          ? {
              ...tab,
              status: 'idle',
              currentActivity: '',
              hasUnread: false,
              messages: [],
              lastResult: null,
              permissionQueue: [],
              permissionDenied: null,
              queuedPrompts: [],
            }
          : tab
      ),
    }))
  },

  toggleCodeMode: async () => {
    const { codeMode, tabs, activeTabId, staticInfo } = get()
    const isOn = codeMode.status === 'ready' || codeMode.status === 'starting' || codeMode.status === 'detecting'
    if (isOn) {
      // Optimistic — main will broadcast the final 'idle' state shortly.
      set({ codeMode: { ...codeMode, status: 'stopping' } })
      try {
        await window.rax.stopCodeMode()
      } catch {}
      return
    }

    const tab = tabs.find((t) => t.id === activeTabId)
    const homePath = staticInfo?.homePath || '~'
    const projectPath = tab?.hasChosenDirectory ? tab.workingDirectory : homePath
    if (!projectPath || projectPath === '~') {
      set({
        codeMode: {
          ...codeMode,
          status: 'error',
          error: 'Pick a folder for this tab first — Code Mode needs a project directory.',
        },
      })
      return
    }
    set({ codeMode: { ...codeMode, status: 'detecting', error: null, projectPath } })
    try {
      const result = await window.rax.startCodeMode(projectPath)
      if (result.state) set({ codeMode: result.state })
    } catch (err) {
      set({
        codeMode: {
          ...codeMode,
          status: 'error',
          error: (err as Error).message || 'Failed to start code mode',
        },
      })
    }
  },

  createTab: async () => {
    // Free-form tab creation — same behavior as the pre-multi-agent build.
    // The five agent tabs are managed separately (registered on app boot via
    // App.tsx + dock click un-hide); this path is only ever hit by the pill's
    // `+` button and the fullscreen sidebar's "New chat" row.
    const homeDir = get().staticInfo?.homePath || '~'
    try {
      const { tabId } = await window.rax.createTab()
      const tab: TabState = {
        ...makeLocalTab(),
        id: tabId,
        workingDirectory: homeDir,
      }
      set((s) => ({
        tabs: [...s.tabs, tab],
        activeTabId: tab.id,
      }))
      publishMirror({ kind: 'tab-created', tabId, workingDirectory: homeDir })
      publishMirror({ kind: 'tab-selected', tabId })
      return tabId
    } catch {
      const tab = makeLocalTab()
      tab.workingDirectory = homeDir
      set((s) => ({
        tabs: [...s.tabs, tab],
        activeTabId: tab.id,
      }))
      publishMirror({ kind: 'tab-created', tabId: tab.id, workingDirectory: homeDir })
      publishMirror({ kind: 'tab-selected', tabId: tab.id })
      return tab.id
    }
  },

  selectTab: (tabId) => {
    const s = get()
    if (tabId === s.activeTabId) {
      // Clicking the already-active tab: toggle global expand/collapse
      const willExpand = !s.isExpanded
      set((prev) => ({
        isExpanded: willExpand,
        marketplaceOpen: false,
        // Expanding = reading: clear unread flag
        tabs: willExpand
          ? prev.tabs.map((t) => t.id === tabId ? { ...t, hasUnread: false } : t)
          : prev.tabs,
      }))
    } else {
      // Switching to a different tab: mark as read AND un-hide it. Selecting
      // a hidden agent tab (via the dock or fullscreen sidebar) needs to also
      // surface its chip in the pill strip — otherwise the active tab would
      // be unreachable from the existing tab UI.
      set((prev) => ({
        activeTabId: tabId,
        marketplaceOpen: false,
        tabs: prev.tabs.map((t) =>
          t.id === tabId ? { ...t, hasUnread: false, hidden: false } : t
        ),
      }))
      publishMirror({ kind: 'tab-selected', tabId })
    }
  },

  toggleExpanded: () => {
    const { activeTabId, isExpanded } = get()
    const willExpand = !isExpanded
    set((s) => ({
      isExpanded: willExpand,
      marketplaceOpen: false,
      // Expanding = reading: clear unread flag for the active tab
      tabs: willExpand
        ? s.tabs.map((t) => t.id === activeTabId ? { ...t, hasUnread: false } : t)
        : s.tabs,
    }))
  },

  toggleMarketplace: () => {
    const s = get()
    if (s.marketplaceOpen) {
      set({ marketplaceOpen: false })
    } else {
      set({ isExpanded: false, marketplaceOpen: true })
      get().loadMarketplace()
    }
  },

  closeMarketplace: () => {
    set({ marketplaceOpen: false })
  },

  loadMarketplace: async (forceRefresh) => {
    set({ marketplaceLoading: true, marketplaceError: null })
    try {
      const [catalog, installed] = await Promise.all([
        window.rax.fetchMarketplace(forceRefresh),
        window.rax.listInstalledPlugins(),
      ])
      if (catalog.error && catalog.plugins.length === 0) {
        set({ marketplaceError: catalog.error, marketplaceLoading: false })
        return
      }
      const installedSet = new Set(installed.map((n) => n.toLowerCase()))
      const pluginStates: Record<string, PluginStatus> = {}
      for (const p of catalog.plugins) {
        // For SKILL.md skills: match individual name against ~/.claude/skills/ dirs
        // For CLI plugins: match installName or "installName@marketplace" against installed_plugins.json
        const candidates = p.isSkillMd
          ? [p.installName]
          : [p.installName, `${p.installName}@${p.marketplace}`]
        const isInstalled = candidates.some((c) => installedSet.has(c.toLowerCase()))
        pluginStates[p.id] = isInstalled ? 'installed' : 'not_installed'
      }
      set({
        marketplaceCatalog: catalog.plugins,
        marketplaceInstalledNames: installed,
        marketplacePluginStates: pluginStates,
        marketplaceLoading: false,
      })
    } catch (err: unknown) {
      set({
        marketplaceError: err instanceof Error ? err.message : String(err),
        marketplaceLoading: false,
      })
    }
  },

  setMarketplaceSearch: (query) => {
    set({ marketplaceSearch: query })
  },

  setMarketplaceFilter: (filter) => {
    set({ marketplaceFilter: filter })
  },

  installMarketplacePlugin: async (plugin) => {
    set((s) => ({
      marketplacePluginStates: { ...s.marketplacePluginStates, [plugin.id]: 'installing' },
    }))
    const result = await window.rax.installPlugin(plugin.repo, plugin.installName, plugin.marketplace, plugin.sourcePath, plugin.isSkillMd)
    if (result.ok) {
      set((s) => ({
        marketplacePluginStates: { ...s.marketplacePluginStates, [plugin.id]: 'installed' as PluginStatus },
        marketplaceInstalledNames: [...s.marketplaceInstalledNames, plugin.installName],
      }))
    } else {
      set((s) => ({
        marketplacePluginStates: { ...s.marketplacePluginStates, [plugin.id]: 'failed' },
      }))
    }
  },

  uninstallMarketplacePlugin: async (plugin) => {
    const result = await window.rax.uninstallPlugin(plugin.installName)
    if (result.ok) {
      set((s) => ({
        marketplacePluginStates: { ...s.marketplacePluginStates, [plugin.id]: 'not_installed' as PluginStatus },
        marketplaceInstalledNames: s.marketplaceInstalledNames.filter((n) => n !== plugin.installName),
      }))
    }
  },

  buildYourOwn: () => {
    set({ marketplaceOpen: false, isExpanded: true })
    // Small delay to let the UI transition
    setTimeout(() => {
      get().sendMessage('Help me create a new Claude Code skill')
    }, 100)
  },

  closeTab: (tabId) => {
    // The voice-orb tab is pinned and cannot be closed.
    if (tabId === ORB_TAB_ID) return
    // Agent tabs are part of the fixed roster — they hide, they don't close.
    // The conversation, claude session, and dock identity all stay alive;
    // clicking the agent in the dock later un-hides this same tab. Closing
    // an agent from the pill is the user saying "get this chip out of my
    // way" — not "throw this work out."
    if (isAgentId(tabId)) {
      const s = get()
      // Pick a fallback active tab — prefer a visible (non-hidden, non-orb)
      // tab so the user lands somewhere they can type. The orb tab is the
      // last-resort fallback.
      const remainingVisible = s.tabs.filter(
        (t) => t.id !== tabId && !t.hidden && !t.isOrbTab,
      )
      const newActive =
        s.activeTabId === tabId
          ? (remainingVisible[0]?.id ?? ORB_TAB_ID)
          : s.activeTabId
      set((prev) => ({
        activeTabId: newActive,
        tabs: prev.tabs.map((t) =>
          t.id === tabId ? { ...t, hidden: true, hasUnread: false } : t,
        ),
      }))
      if (newActive !== s.activeTabId) {
        publishMirror({ kind: 'tab-selected', tabId: newActive })
      }
      return
    }

    window.rax.closeTab(tabId).catch(() => {})

    const s = get()
    const remaining = s.tabs.filter((t) => t.id !== tabId)
    // Hidden agent tabs don't count as "remaining visible chat tabs" — they
    // shouldn't satisfy the "we still have tabs to focus" check, otherwise
    // closing the user's last free-form chat would silently park focus on an
    // agent slot that the strip refuses to render.
    const visibleRemaining = remaining.filter((t) => !t.isOrbTab && !t.hidden)

    if (s.activeTabId === tabId) {
      if (visibleRemaining.length === 0) {
        const newTab = makeLocalTab()
        const otherKept = remaining.filter((t) => t.isOrbTab || t.hidden)
        set({ tabs: [...otherKept, newTab], activeTabId: newTab.id })
        publishMirror({ kind: 'tab-closed', tabId })
        publishMirror({ kind: 'tab-created', tabId: newTab.id, workingDirectory: newTab.workingDirectory })
        publishMirror({ kind: 'tab-selected', tabId: newTab.id })
        return
      }
      const closedIndex = s.tabs.findIndex((t) => t.id === tabId)
      const newActive = visibleRemaining[Math.min(
        Math.max(0, visibleRemaining.findIndex((t) => s.tabs.indexOf(t) >= closedIndex)),
        visibleRemaining.length - 1,
      )] ?? visibleRemaining[visibleRemaining.length - 1]
      set({ tabs: remaining, activeTabId: newActive.id })
      publishMirror({ kind: 'tab-closed', tabId })
      publishMirror({ kind: 'tab-selected', tabId: newActive.id })
    } else {
      set({ tabs: remaining })
      publishMirror({ kind: 'tab-closed', tabId })
    }
  },

  clearTab: (tabId?: string) => {
    const target = tabId || get().activeTabId
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === target
          ? { ...t, messages: [], lastResult: null, currentActivity: '', permissionQueue: [], permissionDenied: null, queuedPrompts: [] }
          : t
      ),
    }))
    publishMirror({ kind: 'tab-cleared', tabId: target })
  },

  resumeSession: async (sessionId, title, projectPath) => {
    const defaultDir = projectPath || get().staticInfo?.homePath || '~'
    try {
      const { tabId } = await window.rax.createTab()

      // Load previous conversation messages from the JSONL file
      const history = await window.rax.loadSession(sessionId, defaultDir).catch(() => [])
      const messages: Message[] = history.map((m) => ({
        id: nextMsgId(),
        role: m.role as Message['role'],
        content: m.content,
        toolName: m.toolName,
        toolStatus: m.toolName ? 'completed' as const : undefined,
        timestamp: m.timestamp,
      }))

      const tab: TabState = {
        ...makeLocalTab(),
        id: tabId,
        claudeSessionId: sessionId,
        title: title || 'Resumed Session',
        workingDirectory: defaultDir,
        hasChosenDirectory: !!projectPath,
        messages,
      }
      set((s) => ({
        tabs: [...s.tabs, tab],
        activeTabId: tab.id,
        isExpanded: true,
      }))
      // Don't call initSession — the first real prompt will use --resume with the sessionId
      return tabId
    } catch {
      const tab = makeLocalTab()
      tab.claudeSessionId = sessionId
      tab.title = title || 'Resumed Session'
      tab.workingDirectory = defaultDir
      tab.hasChosenDirectory = !!projectPath
      set((s) => ({
        tabs: [...s.tabs, tab],
        activeTabId: tab.id,
        isExpanded: true,
      }))
      return tab.id
    }
  },

  addSystemMessage: (content) => {
    const { activeTabId } = get()
    const messageId = nextMsgId()
    const timestamp = Date.now()
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === activeTabId
          ? {
              ...t,
              messages: [
                ...t.messages,
                { id: messageId, role: 'system' as const, content, timestamp },
              ],
            }
          : t
      ),
    }))
    publishMirror({ kind: 'system-message', tabId: activeTabId, messageId, content, timestamp })
  },

  // ─── Permission response ───

  respondPermission: (tabId, questionId, optionId) => {
    // Send to backend
    window.rax.respondPermission(tabId, questionId, optionId).catch(() => {})

    // Remove answered item from queue; show next tool's activity or clear
    set((s) => ({
      tabs: s.tabs.map((t) => {
        if (t.id !== tabId) return t
        const remaining = t.permissionQueue.filter((p) => p.questionId !== questionId)
        return {
          ...t,
          permissionQueue: remaining,
          currentActivity: remaining.length > 0
            ? `Waiting for permission: ${remaining[0].toolTitle}`
            : 'Working...',
        }
      }),
    }))
  },

  // ─── Directory management ───

  addDirectory: (dir) => {
    const { activeTabId } = get()
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === activeTabId
          ? {
              ...t,
              additionalDirs: t.additionalDirs.includes(dir)
                ? t.additionalDirs
                : [...t.additionalDirs, dir],
            }
          : t
      ),
    }))
    publishMirror({ kind: 'directory-add', tabId: activeTabId, directory: dir })
  },

  removeDirectory: (dir) => {
    const { activeTabId } = get()
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === activeTabId
          ? { ...t, additionalDirs: t.additionalDirs.filter((d) => d !== dir) }
          : t
      ),
    }))
    publishMirror({ kind: 'directory-remove', tabId: activeTabId, directory: dir })
  },

  setBaseDirectory: (dir) => {
    const { activeTabId } = get()
    window.rax.resetTabSession(activeTabId)
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === activeTabId
          ? {
              ...t,
              workingDirectory: dir,
              hasChosenDirectory: true,
              claudeSessionId: null,
              additionalDirs: [],
            }
          : t
      ),
    }))
    publishMirror({ kind: 'directory-set', tabId: activeTabId, directory: dir })
  },

  // ─── Attachment management ───

  addAttachments: (attachments) => {
    const { activeTabId } = get()
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === activeTabId
          ? { ...t, attachments: [...t.attachments, ...attachments] }
          : t
      ),
    }))
    publishMirror({ kind: 'attachments-add', tabId: activeTabId, attachments })
  },

  removeAttachment: (attachmentId) => {
    const { activeTabId } = get()
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === activeTabId
          ? { ...t, attachments: t.attachments.filter((a) => a.id !== attachmentId) }
          : t
      ),
    }))
    publishMirror({ kind: 'attachments-remove', tabId: activeTabId, attachmentId })
  },

  clearAttachments: () => {
    const { activeTabId } = get()
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === activeTabId ? { ...t, attachments: [] } : t
      ),
    }))
    publishMirror({ kind: 'attachments-clear', tabId: activeTabId })
  },

  // ─── Send ───

  sendMessage: (prompt, projectPath) => {
    const { activeTabId, tabs, staticInfo } = get()
    const tab = tabs.find((t) => t.id === activeTabId)
    // Use explicitly chosen directory, otherwise fall back to user home
    const resolvedPath = projectPath || (tab?.hasChosenDirectory ? tab.workingDirectory : (staticInfo?.homePath || tab?.workingDirectory || '~'))
    if (!tab) return

    // Guard: don't send while connecting (warmup in progress)
    if (tab.status === 'connecting') return

    const isBusy = tab.status === 'running'
    const requestId = crypto.randomUUID()

    // Build full prompt with attachment context
    let fullPrompt = prompt
    if (tab.attachments.length > 0) {
      const attachmentCtx = tab.attachments
        .map((a) => `[Attached ${a.type}: ${a.path}]`)
        .join('\n')
      fullPrompt = `${attachmentCtx}\n\n${prompt}`
    }

    const title = tab.messages.length === 0
      ? (prompt.length > 30 ? prompt.substring(0, 27) + '...' : prompt)
      : tab.title

    const userMessageId = nextMsgId()
    const userMessageTs = Date.now()

    // Optimistic update: clear attachments
    // If busy, add to queuedPrompts (shown at bottom); otherwise add to messages and set connecting
    set((s) => ({
      tabs: s.tabs.map((t) => {
        if (t.id !== activeTabId) return t
        const withEffectiveBase = t.hasChosenDirectory
          ? t
          : {
              ...t,
              // Once the user sends the first message, lock in the effective
              // base directory (home by default) so the footer no longer shows "—".
              hasChosenDirectory: true,
              workingDirectory: resolvedPath,
            }
        if (isBusy) {
          return {
            ...withEffectiveBase,
            title,
            attachments: [],
            queuedPrompts: [...withEffectiveBase.queuedPrompts, prompt],
          }
        }
        return {
          ...withEffectiveBase,
          status: 'connecting' as TabStatus,
          activeRequestId: requestId,
          currentActivity: 'Starting...',
          title,
          attachments: [],
          messages: [
            ...withEffectiveBase.messages,
            { id: userMessageId, role: 'user' as const, content: prompt, timestamp: userMessageTs },
          ],
          // Fresh run: clear any prior denial card and reset the
          // "did the user see a permission prompt?" tracker.
          permissionDenied: null,
          ...({ _permissionShownThisRun: false } as Partial<TabState>),
        }
      }),
    }))

    // Mirror to other renderer (only for the non-busy path that actually adds
    // the user message to the timeline; queued prompts will surface via
    // session_init when the next run picks them up).
    if (!isBusy) {
      publishMirror({
        kind: 'user-message',
        tabId: activeTabId,
        messageId: userMessageId,
        content: prompt,
        timestamp: userMessageTs,
      })
      publishMirror({ kind: 'tab-title', tabId: activeTabId, title })
    }

    // Send to backend — ControlPlane will queue if a run is active
    const { preferredModel } = get()
    window.rax.prompt(activeTabId, requestId, {
      prompt: fullPrompt,
      projectPath: resolvedPath,
      sessionId: tab.claudeSessionId || undefined,
      model: preferredModel || DEFAULT_MODEL_ID,
      addDirs: tab.additionalDirs.length > 0 ? tab.additionalDirs : undefined,
    }).catch((err: Error) => {
      get().handleError(activeTabId, {
        message: err.message,
        stderrTail: [],
        exitCode: null,
        elapsedMs: 0,
        toolCallCount: 0,
      })
    })
  },

  // ─── Event handlers ───

  handleNormalizedEvent: (tabId, event) => {
    set((s) => {
      const { activeTabId } = s
      const tabs = s.tabs.map((tab) => {
        if (tab.id !== tabId) return tab
        const updated = { ...tab }

        switch (event.type) {
          case 'session_init':
            updated.claudeSessionId = event.sessionId
            updated.sessionModel = event.model
            updated.sessionTools = event.tools
            updated.sessionMcpServers = event.mcpServers
            updated.sessionSkills = event.skills
            updated.sessionVersion = event.version
            // Don't change status/activity for warmup inits — they're invisible
            if (!event.isWarmup) {
              updated.status = 'running'
              updated.currentActivity = 'Thinking...'
              // Move the first queued prompt into the timeline (it's now being processed)
              if (updated.queuedPrompts.length > 0) {
                const [nextPrompt, ...rest] = updated.queuedPrompts
                updated.queuedPrompts = rest
                updated.messages = [
                  ...updated.messages,
                  { id: nextMsgId(), role: 'user' as const, content: nextPrompt, timestamp: Date.now() },
                ]
              }
            }
            break

          case 'text_chunk': {
            updated.currentActivity = 'Writing...'
            const lastMsg = updated.messages[updated.messages.length - 1]
            if (lastMsg?.role === 'assistant' && !lastMsg.toolName) {
              updated.messages = [
                ...updated.messages.slice(0, -1),
                { ...lastMsg, content: lastMsg.content + event.text },
              ]
            } else {
              updated.messages = [
                ...updated.messages,
                { id: nextMsgId(), role: 'assistant', content: event.text, timestamp: Date.now() },
              ]
            }
            break
          }

          case 'tool_call':
            updated.currentActivity = `Running ${event.toolName}...`
            updated.messages = [
              ...updated.messages,
              {
                id: nextMsgId(),
                role: 'tool',
                content: '',
                toolName: event.toolName,
                toolInput: '',
                toolStatus: 'running',
                timestamp: Date.now(),
              },
            ]
            break

          case 'tool_call_update': {
            const msgs = [...updated.messages]
            const lastTool = [...msgs].reverse().find((m) => m.role === 'tool' && m.toolStatus === 'running')
            if (lastTool) {
              lastTool.toolInput = (lastTool.toolInput || '') + event.partialInput
            }
            updated.messages = msgs
            break
          }

          case 'tool_call_complete': {
            const msgs2 = [...updated.messages]
            const runningTool = [...msgs2].reverse().find((m) => m.role === 'tool' && m.toolStatus === 'running')
            if (runningTool) {
              runningTool.toolStatus = 'completed'
            }
            updated.messages = msgs2
            break
          }

          case 'task_update': {
            // ── Text fallback ──
            // text_chunk events (from stream_event deltas) are the primary render path.
            // If they didn't arrive for this run (timing, partial stream, etc.), the
            // assembled assistant event still has the full text — extract it here.
            // "This run" = everything after the last user message.
            if (event.message?.content) {
              const lastUserIdx = (() => {
                for (let i = updated.messages.length - 1; i >= 0; i--) {
                  if (updated.messages[i].role === 'user') return i
                }
                return -1
              })()
              const hasStreamedText = updated.messages
                .slice(lastUserIdx + 1)
                .some((m) => m.role === 'assistant' && !m.toolName)

              if (!hasStreamedText) {
                const textContent = event.message.content
                  .filter((b) => b.type === 'text' && b.text)
                  .map((b) => b.text!)
                  .join('')
                if (textContent) {
                  updated.messages = [
                    ...updated.messages,
                    { id: nextMsgId(), role: 'assistant' as const, content: textContent, timestamp: Date.now() },
                  ]
                }
              }

              // ── Tool card deduplication (unchanged) ──
              for (const block of event.message.content) {
                if (block.type === 'tool_use' && block.name) {
                  const exists = updated.messages.find(
                    (m) => m.role === 'tool' && m.toolName === block.name && !m.content
                  )
                  if (!exists) {
                    updated.messages = [
                      ...updated.messages,
                      {
                        id: nextMsgId(),
                        role: 'tool',
                        content: '',
                        toolName: block.name,
                        toolInput: JSON.stringify(block.input, null, 2),
                        toolStatus: 'completed',
                        timestamp: Date.now(),
                      },
                    ]
                  }
                }
              }
            }
            break
          }

          case 'task_complete':
            updated.status = 'completed'
            updated.activeRequestId = null
            updated.currentActivity = ''
            updated.permissionQueue = []
            updated.lastResult = {
              totalCostUsd: event.costUsd,
              durationMs: event.durationMs,
              numTurns: event.numTurns,
              usage: event.usage,
              sessionId: event.sessionId,
            }
            // ── Final text fallback ──
            // If neither text_chunks nor task_update text produced an assistant message,
            // use event.result (the CLI's assembled final output) as last resort.
            if (event.result) {
              const lastUserIdx2 = (() => {
                for (let i = updated.messages.length - 1; i >= 0; i--) {
                  if (updated.messages[i].role === 'user') return i
                }
                return -1
              })()
              const hasAnyText = updated.messages
                .slice(lastUserIdx2 + 1)
                .some((m) => m.role === 'assistant' && !m.toolName)
              if (!hasAnyText) {
                updated.messages = [
                  ...updated.messages,
                  { id: nextMsgId(), role: 'assistant' as const, content: event.result, timestamp: Date.now() },
                ]
              }
            }
            // Mark as unread unless the user is actively viewing this tab
            // (active tab with card expanded). A collapsed active tab still
            // counts as "unread" — the user hasn't seen the response yet.
            if (tabId !== activeTabId || !s.isExpanded) {
              updated.hasUnread = true
            }
            // Show fallback card when tools were denied by permission settings.
            // Track whether the user ever saw an approval card during this run —
            // if not, the denial is a silent infrastructure failure (Claude
            // didn't reach our hook), not a "user clicked deny" outcome.
            if (event.permissionDenials && event.permissionDenials.length > 0) {
              const hookReached = (updated as any)._permissionShownThisRun === true
              updated.permissionDenied = { tools: event.permissionDenials, hookReached }
            } else {
              updated.permissionDenied = null
            }
            ;(updated as any)._permissionShownThisRun = false
            // Play notification sound if window is hidden
            playNotificationIfHidden()
            break

          case 'error':
            updated.status = 'failed'
            updated.activeRequestId = null
            updated.currentActivity = ''
            updated.permissionQueue = []
            updated.permissionDenied = null
            updated.messages = [
              ...updated.messages,
              { id: nextMsgId(), role: 'system', content: `Error: ${event.message}`, timestamp: Date.now() },
            ]
            break

          case 'session_dead':
            updated.status = 'dead'
            updated.activeRequestId = null
            updated.currentActivity = ''
            updated.permissionQueue = []
            updated.permissionDenied = null
            updated.messages = [
              ...updated.messages,
              {
                id: nextMsgId(),
                role: 'system',
                content: `Session ended unexpectedly (exit ${event.exitCode})`,
                timestamp: Date.now(),
              },
            ]
            break

          case 'permission_request': {
            const newReq: import('../../shared/types').PermissionRequest = {
              questionId: event.questionId,
              toolTitle: event.toolName,
              toolDescription: event.toolDescription,
              toolInput: event.toolInput,
              options: event.options.map((o) => ({
                optionId: o.id,
                kind: o.kind,
                label: o.label,
              })),
            }
            updated.permissionQueue = [...updated.permissionQueue, newReq]
            updated.currentActivity = `Waiting for permission: ${event.toolName}`
            // Mark that this run actually surfaced a permission prompt — used
            // to distinguish user-deny from hook-never-fired on the result.
            ;(updated as any)._permissionShownThisRun = true
            break
          }

          case 'permission_resolved': {
            // Backend resolved a pending permission without user input
            // (timeout, run-ended, server shutdown, tab closed). Drop the
            // matching card so the user isn't left staring at a stale prompt.
            const remaining = updated.permissionQueue.filter((p) => p.questionId !== event.questionId)
            if (remaining.length === updated.permissionQueue.length) break
            updated.permissionQueue = remaining
            updated.currentActivity = remaining.length > 0
              ? `Waiting for permission: ${remaining[0].toolTitle}`
              : updated.currentActivity
            break
          }

          case 'rate_limit':
            if (event.status !== 'allowed') {
              updated.messages = [
                ...updated.messages,
                {
                  id: nextMsgId(),
                  role: 'system',
                  content: `Rate limited (${event.rateLimitType}). Resets at ${new Date(event.resetsAt).toLocaleTimeString()}.`,
                  timestamp: Date.now(),
                },
              ]
            }
            break
        }

        return updated
      })

      return { tabs }
    })
  },

  handleStatusChange: (tabId, newStatus) => {
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === tabId
          ? {
              ...t,
              status: newStatus as TabStatus,
              // Clear activity when transitioning to idle (e.g., after warmup init)
              ...(newStatus === 'idle' ? { currentActivity: '', permissionQueue: [] as import('../../shared/types').PermissionRequest[], permissionDenied: null } : {}),
            }
          : t
      ),
    }))
  },

  // ─── Cross-renderer mirroring ───

  applyMirror: (action) => {
    suppressMirror = true
    try {
      switch (action.kind) {
        case 'user-message': {
          set((s) => ({
            tabs: s.tabs.map((t) =>
              t.id === action.tabId
                ? {
                    ...t,
                    messages: t.messages.some((m) => m.id === action.messageId)
                      ? t.messages
                      : [
                          ...t.messages,
                          { id: action.messageId, role: 'user' as const, content: action.content, timestamp: action.timestamp },
                        ],
                  }
                : t
            ),
          }))
          break
        }
        case 'system-message': {
          set((s) => ({
            tabs: s.tabs.map((t) =>
              t.id === action.tabId
                ? {
                    ...t,
                    messages: t.messages.some((m) => m.id === action.messageId)
                      ? t.messages
                      : [
                          ...t.messages,
                          { id: action.messageId, role: 'system' as const, content: action.content, timestamp: action.timestamp },
                        ],
                  }
                : t
            ),
          }))
          break
        }
        case 'tab-created': {
          set((s) => {
            if (s.tabs.some((t) => t.id === action.tabId)) return s
            const tab: TabState = {
              ...makeLocalTab(),
              id: action.tabId,
              workingDirectory: action.workingDirectory,
            }
            return { tabs: [...s.tabs, tab] }
          })
          break
        }
        case 'tab-closed': {
          set((s) => {
            const remaining = s.tabs.filter((t) => t.id !== action.tabId)
            if (remaining.length === 0) {
              const fresh = makeLocalTab()
              return { tabs: [fresh], activeTabId: fresh.id }
            }
            const newActiveId = s.activeTabId === action.tabId ? remaining[0].id : s.activeTabId
            return { tabs: remaining, activeTabId: newActiveId }
          })
          break
        }
        case 'tab-selected': {
          // Mirror of selectTab — also un-hide. Critical for the dock flow:
          // clicking Max in the dock fires DOCK_SELECT_AGENT → main sends a
          // tab-selected mirror to every renderer → here we un-hide Max's
          // tab so it actually shows up in the pill strip.
          set((s) => ({
            activeTabId: action.tabId,
            tabs: s.tabs.map((t) =>
              t.id === action.tabId ? { ...t, hasUnread: false, hidden: false } : t
            ),
          }))
          break
        }
        case 'tab-cleared': {
          set((s) => ({
            tabs: s.tabs.map((t) =>
              t.id === action.tabId
                ? { ...t, messages: [], lastResult: null, currentActivity: '', permissionQueue: [], permissionDenied: null, queuedPrompts: [] }
                : t
            ),
          }))
          break
        }
        case 'tab-title': {
          set((s) => ({
            tabs: s.tabs.map((t) =>
              t.id === action.tabId ? { ...t, title: action.title } : t
            ),
          }))
          break
        }
        case 'attachments-add': {
          set((s) => ({
            tabs: s.tabs.map((t) =>
              t.id === action.tabId
                ? { ...t, attachments: [...t.attachments, ...action.attachments] }
                : t
            ),
          }))
          break
        }
        case 'attachments-remove': {
          set((s) => ({
            tabs: s.tabs.map((t) =>
              t.id === action.tabId
                ? { ...t, attachments: t.attachments.filter((a) => a.id !== action.attachmentId) }
                : t
            ),
          }))
          break
        }
        case 'attachments-clear': {
          set((s) => ({
            tabs: s.tabs.map((t) =>
              t.id === action.tabId ? { ...t, attachments: [] } : t
            ),
          }))
          break
        }
        case 'directory-set': {
          set((s) => ({
            tabs: s.tabs.map((t) =>
              t.id === action.tabId
                ? { ...t, workingDirectory: action.directory, hasChosenDirectory: true, claudeSessionId: null, additionalDirs: [] }
                : t
            ),
          }))
          break
        }
        case 'directory-add': {
          set((s) => ({
            tabs: s.tabs.map((t) =>
              t.id === action.tabId
                ? {
                    ...t,
                    additionalDirs: t.additionalDirs.includes(action.directory)
                      ? t.additionalDirs
                      : [...t.additionalDirs, action.directory],
                  }
                : t
            ),
          }))
          break
        }
        case 'directory-remove': {
          set((s) => ({
            tabs: s.tabs.map((t) =>
              t.id === action.tabId
                ? { ...t, additionalDirs: t.additionalDirs.filter((d) => d !== action.directory) }
                : t
            ),
          }))
          break
        }
        case 'preferred-model': {
          set({ preferredModel: action.model })
          persistPreferredModel(action.model)
          break
        }
        case 'permission-mode': {
          set({ permissionMode: action.mode })
          break
        }
      }
    } finally {
      suppressMirror = false
    }
  },

  exportSnapshot: () => {
    const { tabs, activeTabId, preferredModel, permissionMode } = get()
    return { tabs, activeTabId, preferredModel, permissionMode }
  },

  seedFromSnapshot: (snapshot) => {
    if (!snapshot || !Array.isArray(snapshot.tabs) || snapshot.tabs.length === 0) return
    suppressMirror = true
    try {
      // Preserve the local orb tab when possible — it carries renderer-only
      // history (streamed orb events) that the snapshot may not have caught.
      const existingOrb = get().tabs.find((t) => t.isOrbTab)
      const snapOrb = snapshot.tabs.find((t) => t.isOrbTab)
      const orbTab = (() => {
        if (snapOrb && existingOrb) {
          return (snapOrb.messages?.length ?? 0) >= (existingOrb.messages?.length ?? 0)
            ? snapOrb
            : existingOrb
        }
        return snapOrb || existingOrb || makeOrbTab()
      })()
      // Reconstruct the 5-agent roster from snapshot data when available,
      // otherwise fall back to a fresh hidden agent tab. Snapshots store the
      // `hidden` flag, so an agent the user un-hid via the dock stays visible
      // across an open/close of fullscreen.
      const snapById = new Map(snapshot.tabs.map((t) => [t.id, t]))
      const agentTabs: TabState[] = AGENTS.map((a) => {
        const fromSnap = snapById.get(a.id)
        if (fromSnap) return { ...fromSnap, agentId: a.id }
        return makeAgentTab(a.id)
      })
      // Preserve free-form chat tabs from the snapshot — they're the user's
      // open conversations from the other renderer. Anything that's not the
      // orb and not a known agent id falls into this bucket.
      const freeFormTabs: TabState[] = snapshot.tabs.filter(
        (t) => !t.isOrbTab && !isAgentId(t.id),
      )
      // If the snapshot had no free-form chats, seed a fresh one so the user
      // has somewhere to type. Matches the boot-state invariant from
      // makeOrbTab + initialDefaultTab.
      const ensuredFreeForm = freeFormTabs.length > 0 ? freeFormTabs : [makeLocalTab()]
      const tabs: TabState[] = [orbTab, ...ensuredFreeForm, ...agentTabs]
      // Choose active: keep snapshot's selection if we still have that tab,
      // otherwise fall back to the first free-form chat.
      const activeStillThere = tabs.some((t) => t.id === snapshot.activeTabId)
      const activeTabId = activeStillThere
        ? snapshot.activeTabId
        : (ensuredFreeForm[0]?.id ?? orbTab.id)
      set({
        tabs,
        activeTabId,
        preferredModel: snapshot.preferredModel,
        permissionMode: snapshot.permissionMode,
      })
    } finally {
      suppressMirror = false
    }
  },

  handleError: (tabId, error) => {
    set((s) => ({
      tabs: s.tabs.map((t) => {
        if (t.id !== tabId) return t

        // Deduplicate: skip if the last message is already an error for this failure
        const lastMsg = t.messages[t.messages.length - 1]
        const alreadyHasError = lastMsg?.role === 'system' && lastMsg.content.startsWith('Error:')

        return {
          ...t,
          status: 'failed' as TabStatus,
          activeRequestId: null,
          currentActivity: '',
          permissionQueue: [],
          messages: alreadyHasError
            ? t.messages
            : [
                ...t.messages,
                {
                  id: nextMsgId(),
                  role: 'system' as const,
                  content: `Error: ${error.message}${error.stderrTail.length > 0 ? '\n\n' + error.stderrTail.slice(-5).join('\n') : ''}`,
                  timestamp: Date.now(),
                },
              ],
        }
      }),
    }))
  },
}))
