import React, { useCallback, useEffect, useRef, useState } from 'react'
import { CaretLeft, CaretRight, SidebarSimple } from '@phosphor-icons/react'
import { Sidebar } from './Sidebar'
import { ChatView } from './views/ChatView'
import { PluginsView } from './views/PluginsView'
import { SearchView } from './views/SearchView'
import { ProjectView } from './views/ProjectView'
import { SettingsView } from './views/SettingsView'
import { ClaudeModeChip } from './ClaudeModeChip'
import { ClaudeFirstRunBanner } from './ClaudeFirstRunBanner'
import { useClaudeEvents } from '../hooks/useClaudeEvents'
import { useHealthReconciliation } from '../hooks/useHealthReconciliation'
import { useSessionStore } from '../stores/sessionStore'
import { AGENTS } from '../../shared/agents'
import { useThemeStore } from '../theme'

export type SidebarSection = 'chat' | 'search' | 'plugins' | 'project' | 'settings'

type ViewState = { section: SidebarSection; tabId: string | null }

export default function App() {
  useClaudeEvents()
  useHealthReconciliation()

  const setSystemTheme = useThemeStore((s) => s.setSystemTheme)
  const initStaticInfo = useSessionStore((s) => s.initStaticInfo)
  const seedFromSnapshot = useSessionStore((s) => s.seedFromSnapshot)
  const exportSnapshot = useSessionStore((s) => s.exportSnapshot)
  const applyMirror = useSessionStore((s) => s.applyMirror)
  const selectTab = useSessionStore((s) => s.selectTab)
  // App-level subscriptions are intentionally minimal — anything that
  // changes per streaming token would cause the whole tree to re-render.
  // activeTabId is the only piece of session-state App actually reads.
  const activeTabId = useSessionStore((s) => s.activeTabId)

  const [section, setSection] = useState<SidebarSection>('chat')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [isNativeFullscreen, setIsNativeFullscreen] = useState(false)

  // ─── View history for Codex-style back/forward ───
  // Stored in a ref so the callbacks have stable identity — prop-drilled into
  // Sidebar/views, which were re-rendering on every nav otherwise.
  const historyRef = useRef<ViewState[]>([{ section: 'chat', tabId: null }])
  const historyIndexRef = useRef(0)
  const [canBack, setCanBack] = useState(false)
  const [canForward, setCanForward] = useState(false)
  const recomputeNavFlags = () => {
    setCanBack(historyIndexRef.current > 0)
    setCanForward(historyIndexRef.current < historyRef.current.length - 1)
  }

  const navigate = useCallback((nextSection: SidebarSection, nextTabId?: string | null) => {
    const currentActive = useSessionStore.getState().activeTabId
    const tabId = nextTabId === undefined ? currentActive : nextTabId
    const truncated = historyRef.current.slice(0, historyIndexRef.current + 1)
    const last = truncated[truncated.length - 1]
    if (!last || last.section !== nextSection || last.tabId !== tabId) {
      historyRef.current = [...truncated, { section: nextSection, tabId }]
      historyIndexRef.current = historyRef.current.length - 1
    }
    setSection(nextSection)
    if (tabId && tabId !== currentActive) selectTab(tabId)
    recomputeNavFlags()
  }, [selectTab])

  const goBack = useCallback(() => {
    if (historyIndexRef.current <= 0) return
    historyIndexRef.current -= 1
    const prev = historyRef.current[historyIndexRef.current]
    setSection(prev.section)
    const currentActive = useSessionStore.getState().activeTabId
    if (prev.tabId && prev.tabId !== currentActive) selectTab(prev.tabId)
    recomputeNavFlags()
  }, [selectTab])

  const goForward = useCallback(() => {
    if (historyIndexRef.current >= historyRef.current.length - 1) return
    historyIndexRef.current += 1
    const next = historyRef.current[historyIndexRef.current]
    setSection(next.section)
    const currentActive = useSessionStore.getState().activeTabId
    if (next.tabId && next.tabId !== currentActive) selectTab(next.tabId)
    recomputeNavFlags()
  }, [selectTab])

  // Seed first history entry once we know which tab is active
  const seededRef = useRef(false)
  useEffect(() => {
    if (seededRef.current || !activeTabId) return
    seededRef.current = true
    historyRef.current = [{ section: 'chat', tabId: activeTabId }]
    historyIndexRef.current = 0
    recomputeNavFlags()
  }, [activeTabId])

  // Theme bootstrap
  useEffect(() => {
    window.rax.getTheme().then(({ isDark }) => setSystemTheme(isDark)).catch(() => {})
    const unsub = window.rax.onThemeChange((isDark) => setSystemTheme(isDark))
    return unsub
  }, [setSystemTheme])

  // Native fullscreen state (traffic lights hidden → controls slide to edge)
  useEffect(() => {
    return window.rax.onFullscreenNativeStateChanged((v) => setIsNativeFullscreen(v))
  }, [])

  // Static info + snapshot seed (so we don't start blank when pill had history)
  useEffect(() => {
    initStaticInfo().then(() => {
      window.rax.pullSnapshot().then((snap) => {
        if (snap && Array.isArray(snap.tabs) && snap.tabs.length > 0) {
          seedFromSnapshot(snap)
        } else {
          // No snapshot — same behavior as the pre-multi-agent build: replace
          // the local free-form chat tab's random id with a real backend id.
          // Agent tabs stay hidden in the strip; they're surfaced by the dock.
          const homeDir = useSessionStore.getState().staticInfo?.homePath || '~'
          const chatTab = useSessionStore
            .getState()
            .tabs.find((t) => !t.isOrbTab && !t.agentId)
          if (chatTab) {
            window.rax
              .createTab()
              .then(({ tabId }) => {
                useSessionStore.setState((s) => ({
                  tabs: s.tabs.map((t) =>
                    t.id === chatTab.id
                      ? { ...t, id: tabId, workingDirectory: homeDir, hasChosenDirectory: false }
                      : t,
                  ),
                  activeTabId: tabId,
                }))
              })
              .catch(() => {})
          }
        }
        // Always (re-)register the 5 agents with main. createTab is idempotent
        // on a known desiredId, so this is safe whether or not the pill already
        // booted the agents.
        for (const agent of AGENTS) {
          void window.rax.createTab({ desiredId: agent.id }).catch(() => {})
        }
      }).catch(() => {})
    })
  }, [initStaticInfo, seedFromSnapshot])

  // Mirror inbound events
  useEffect(() => {
    const unsub = window.rax.onMirror((action) => {
      applyMirror(action)
    })
    return unsub
  }, [applyMirror])

  // Voice orb stream — populate the pinned voice tab with every turn.
  useEffect(() => {
    const offEvent = window.rax.onOrbEventBroadcast((event) => {
      useSessionStore.getState().applyOrbEvent(event)
    })
    const offReset = window.rax.onOrbResetBroadcast(() => {
      useSessionStore.getState().applyOrbReset()
    })
    return () => {
      offEvent()
      offReset()
    }
  }, [])

  // Voice/orb tab is hidden in fullscreen — if it's somehow active (e.g. user
  // expanded from pill while on the voice tab), redirect to a visible chat
  // tab. Prefers a free-form tab over an agent so we don't accidentally
  // surface a hidden agent here. Reads via getState() so this effect doesn't
  // fire on every messages-array change; the activeTabId dep is the only
  // relevant trigger.
  useEffect(() => {
    if (!activeTabId) return
    const tabs = useSessionStore.getState().tabs
    const active = tabs.find((t) => t.id === activeTabId)
    if (!active?.isOrbTab) return
    const firstVisibleChat = tabs.find((t) => !t.isOrbTab && !t.hidden)
    if (firstVisibleChat) selectTab(firstVisibleChat.id)
  }, [activeTabId, selectTab])

  // Push our snapshot to main on every meaningful change so pill can resume
  // smoothly if user closes us. Coalesced to once every 500ms — previously
  // fired via RAF on every text_chunk (1 full snapshot+IPC per streamed token).
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const flush = () => {
      timer = null
      try { window.rax.pushSnapshot(exportSnapshot()) } catch {}
    }
    const schedule = () => {
      if (timer) return
      timer = setTimeout(flush, 500)
    }
    // Initial push so main has our state shortly after mount.
    schedule()
    // Subscribe to the store and trigger a debounced push whenever any field
    // of the snapshot shape changes. Comparing references is cheap and skips
    // pushes for marketplace/codeMode/etc. that the snapshot doesn't include.
    let prev = useSessionStore.getState()
    const unsub = useSessionStore.subscribe((s) => {
      if (
        s.tabs !== prev.tabs ||
        s.activeTabId !== prev.activeTabId ||
        s.preferredModel !== prev.preferredModel ||
        s.permissionMode !== prev.permissionMode
      ) {
        prev = s
        schedule()
      }
    })
    return () => {
      unsub()
      if (timer) clearTimeout(timer)
    }
  }, [exportSnapshot])

  // Cmd+W and Esc: close window (back to pill)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'w' || e.key === 'W')) {
        e.preventDefault()
        window.rax.closeFullscreen()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Pause infinite CSS animations (orb pulse, skeleton shimmer, etc.) while
  // the window is occluded or backgrounded — Chromium still composites these
  // every frame otherwise. The `data-window-hidden` attribute is read by the
  // CSS rule at the bottom of styles.css.
  useEffect(() => {
    const root = document.documentElement
    const sync = () => {
      if (document.hidden) root.setAttribute('data-window-hidden', 'true')
      else root.removeAttribute('data-window-hidden')
    }
    sync()
    document.addEventListener('visibilitychange', sync)
    return () => document.removeEventListener('visibilitychange', sync)
  }, [])

  return (
    <div className={`fs-shell${isNativeFullscreen ? ' is-native-fullscreen' : ''}`}>
      <div className="fs-titlebar">
        <div
          className={`fs-titlebar-bg-sidebar${sidebarCollapsed ? ' is-collapsed' : ''}`}
          aria-hidden
        />
        <div className="fs-titlebar-bg-content" aria-hidden />
        <div className="fs-titlebar-controls" data-no-drag>
          <button
            className="fs-titlebar-btn"
            onClick={() => setSidebarCollapsed((c) => !c)}
            aria-label={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
            title={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
          >
            <SidebarSimple size={15} />
          </button>
          <button
            className="fs-titlebar-btn"
            onClick={goBack}
            disabled={!canBack}
            aria-label="Back"
            title="Back"
          >
            <CaretLeft size={14} weight="bold" />
          </button>
          <button
            className="fs-titlebar-btn"
            onClick={goForward}
            disabled={!canForward}
            aria-label="Forward"
            title="Forward"
          >
            <CaretRight size={14} weight="bold" />
          </button>
        </div>
        <div className="fs-titlebar-right" data-no-drag>
          <ClaudeModeChip onClick={() => navigate('settings')} />
        </div>
      </div>
      <div className="fs-body">
        <Sidebar section={section} collapsed={sidebarCollapsed} onNavigate={navigate} />
        <div className="fs-content">
          <ClaudeFirstRunBanner onGoToSettings={() => navigate('settings')} />
          {section === 'chat' && <ChatView />}
          {section === 'search' && <SearchView onOpenChat={() => navigate('chat')} />}
          {section === 'plugins' && <PluginsView />}
          {section === 'project' && <ProjectView />}
          {section === 'settings' && <SettingsView />}
        </div>
      </div>
    </div>
  )
}
