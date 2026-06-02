import React, { useEffect, useCallback, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Paperclip, Camera, HeadCircuit, Code, ArrowsOutSimple } from '@phosphor-icons/react'
import { TabStrip } from './components/TabStrip'
import { ConversationView } from './components/ConversationView'
import { InputBar } from './components/InputBar'
import { StatusBar } from './components/StatusBar'
import { MarketplacePanel } from './components/MarketplacePanel'
import { PopoverLayerProvider } from './components/PopoverLayer'
import { useClaudeEvents } from './hooks/useClaudeEvents'
import { useHealthReconciliation } from './hooks/useHealthReconciliation'
import { useSessionStore } from './stores/sessionStore'
import { DEFAULT_MODEL_ID } from '../shared/types'
import { AGENTS } from '../shared/agents'
import { useColors, useThemeStore, spacing } from './theme'

const TRANSITION = { duration: 0.26, ease: [0.4, 0, 0.1, 1] as const }

export default function App() {
  useClaudeEvents()
  useHealthReconciliation()

  const activeTabStatus = useSessionStore((s) => s.tabs.find((t) => t.id === s.activeTabId)?.status)
  const addAttachments = useSessionStore((s) => s.addAttachments)
  const codeMode = useSessionStore((s) => s.codeMode)
  const toggleCodeMode = useSessionStore((s) => s.toggleCodeMode)
  const colors = useColors()
  const setSystemTheme = useThemeStore((s) => s.setSystemTheme)
  const expandedUI = useThemeStore((s) => s.expandedUI)

  // ─── Theme initialization ───
  useEffect(() => {
    // Get initial OS theme — setSystemTheme respects themeMode (system/light/dark)
    window.rax.getTheme().then(({ isDark }) => {
      setSystemTheme(isDark)
    }).catch(() => {})

    // Listen for OS theme changes
    const unsub = window.rax.onThemeChange((isDark) => {
      setSystemTheme(isDark)
    })
    return unsub
  }, [setSystemTheme])

  useEffect(() => {
    useSessionStore.getState().initStaticInfo().then(() => {
      const homeDir = useSessionStore.getState().staticInfo?.homePath || '~'
      // Default free-form chat tab: replace its random local UUID with a real
      // backend-issued tab id, identical to the pre-multi-agent flow so the
      // pill UI behaves unchanged for the casual user.
      const chatTab = useSessionStore
        .getState()
        .tabs.find((t) => !t.isOrbTab && !t.agentId)
      if (chatTab) {
        useSessionStore.setState((s) => ({
          tabs: s.tabs.map((t) =>
            t.id === chatTab.id
              ? { ...t, workingDirectory: homeDir, hasChosenDirectory: false }
              : t,
          ),
        }))
        window.rax
          .createTab()
          .then(({ tabId }) => {
            useSessionStore.setState((s) => ({
              tabs: s.tabs.map((t) => (t.id === chatTab.id ? { ...t, id: tabId } : t)),
              activeTabId: tabId,
            }))
          })
          .catch(() => {})
      }
      // Seed working directory on the hidden agent tabs too, and register
      // each agent id with main's ControlPlane so a future dock click can
      // dispatch prompts against `agent-max` etc. createTab is idempotent on
      // a known desiredId.
      useSessionStore.setState((s) => ({
        tabs: s.tabs.map((t) =>
          t.agentId ? { ...t, workingDirectory: homeDir } : t,
        ),
      }))
      for (const agent of AGENTS) {
        void window.rax.createTab({ desiredId: agent.id }).catch(() => {})
      }
    })
  }, [])

  // Align the voice orb's model with the picker ON STARTUP. setPreferredModel
  // pushes to the orb on every *change*, but the store hydrates the persisted
  // model from localStorage at boot without firing that path — so a user who
  // had "Rax Default" selected would have the orb fall back to its own default
  // (a paid Claude model) and 402 on the free tier. Push the hydrated model
  // once on mount so the orb matches what the picker shows from the first turn.
  useEffect(() => {
    const model = useSessionStore.getState().preferredModel || DEFAULT_MODEL_ID
    try { void window.rax.setOrbModel(model) } catch {}
  }, [])

  // Cross-renderer state mirror — receive mutations from the fullscreen window
  // while the pill is alive in the background.
  useEffect(() => {
    const apply = useSessionStore.getState().applyMirror
    const unsub = window.rax.onMirror((action) => apply(action))
    return unsub
  }, [])

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

  // When the pill becomes visible again (fullscreen closed), refresh from
  // the main-process snapshot so any state mutations made while we were
  // hidden are reflected here too.
  useEffect(() => {
    const unsub = window.rax.onFullscreenModeChanged((isOpen) => {
      if (!isOpen) {
        window.rax.pullSnapshot().then((snap) => {
          if (snap) useSessionStore.getState().seedFromSnapshot(snap)
        }).catch(() => {})
      } else {
        // Push our snapshot before fullscreen renders so it can seed itself.
        try { window.rax.pushSnapshot(useSessionStore.getState().exportSnapshot()) } catch {}
      }
    })
    return unsub
  }, [])

  // Push a fresh snapshot whenever pill state changes (rate-limited via RAF).
  // The orb reads these in main to keep its tab context in sync without ever
  // having to round-trip back to a renderer at query time.
  const tabsForSnap = useSessionStore((s) => s.tabs)
  const activeIdForSnap = useSessionStore((s) => s.activeTabId)
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      try { window.rax.pushSnapshot(useSessionStore.getState().exportSnapshot()) } catch {}
    })
    return () => cancelAnimationFrame(id)
  }, [tabsForSnap, activeIdForSnap])

  // Shared drag ref — must be declared before the setIgnoreMouseEvents effect so both closures can read it
  const dragRef = useRef<{ startX: number; startY: number } | null>(null)

  // Vertical position tracking — window moves first (until macOS clamps it), then CSS overflows
  const PILL_HEIGHT_CONST = 720
  const PILL_BOTTOM_MARGIN_CONST = 24
  const minWindowY = window.screen.availTop   // top of work area (below menu bar)
  const initialWindowY = window.screen.availTop + window.screen.availHeight - PILL_HEIGHT_CONST - PILL_BOTTOM_MARGIN_CONST
  const windowYRef = useRef(initialWindowY)
  const cardYRef = useRef(0) // CSS translateY offset (only used after window hits its y constraint)

  // OS-level click-through (RAF-throttled to avoid per-pixel IPC)
  useEffect(() => {
    if (!window.rax?.setIgnoreMouseEvents) return
    let lastIgnored: boolean | null = null

    const onMouseMove = (e: MouseEvent) => {
      // While dragging, keep full mouse capture — don't toggle ignore-events
      if (dragRef.current) return
      const el = document.elementFromPoint(e.clientX, e.clientY)
      const isUI = !!(el && el.closest('[data-rax-ui]'))
      const shouldIgnore = !isUI
      if (shouldIgnore !== lastIgnored) {
        lastIgnored = shouldIgnore
        if (shouldIgnore) {
          window.rax.setIgnoreMouseEvents(true, { forward: true })
        } else {
          window.rax.setIgnoreMouseEvents(false)
        }
      }
    }

    const onMouseLeave = () => {
      if (dragRef.current) return
      if (lastIgnored !== true) {
        lastIgnored = true
        window.rax.setIgnoreMouseEvents(true, { forward: true })
      }
    }

    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseleave', onMouseLeave)
    return () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseleave', onMouseLeave)
    }
  }, [])

  // Manual window drag — bypasses -webkit-app-region conflicts with setIgnoreMouseEvents
  useEffect(() => {
    if (!window.rax?.startWindowDrag) return

    const onMouseDown = (e: MouseEvent) => {
      const el = e.target as HTMLElement
      // Skip interactive elements — everything else on the card is draggable
      if (el.closest('button, input, textarea, a, select, [role="button"], [contenteditable], .cm-editor')) return
      if (!el.closest('[data-rax-ui]')) return
      e.preventDefault()
      // Double-click: snap back to default position
      if (e.detail >= 2) {
        window.rax.resetWindowPosition()
        windowYRef.current = initialWindowY
        cardYRef.current = 0
        document.documentElement.style.setProperty('--rax-card-y', '0px')
        return
      }
      // Ensure full mouse capture for the duration of the drag
      window.rax.setIgnoreMouseEvents(false)
      dragRef.current = { startX: e.screenX, startY: e.screenY }
    }

    const onMouseMove = (e: MouseEvent) => {
      if (!dragRef.current) return
      const dx = e.screenX - dragRef.current.startX
      const dy = e.screenY - dragRef.current.startY
      if (dx !== 0 || dy !== 0) {
        // Horizontal: always native window movement (full screen width range)
        if (dx !== 0) window.rax.startWindowDrag(dx, 0)
        // Vertical: move window first (until macOS y constraint), then CSS within window
        if (dy !== 0) {
          if (dy < 0) {
            // Moving up — window first, then CSS overflow
            const windowCanMove = windowYRef.current - minWindowY
            const windowDy = Math.max(-windowCanMove, dy)
            const cssDy = dy - windowDy
            if (windowDy !== 0) {
              window.rax.startWindowDrag(0, windowDy)
              windowYRef.current += windowDy
            }
            if (cssDy !== 0) {
              cardYRef.current += cssDy
              document.documentElement.style.setProperty('--rax-card-y', `${cardYRef.current}px`)
            }
          } else {
            // Moving down — undo CSS first, then move window
            const cssUndo = Math.min(-cardYRef.current, dy)
            const windowDy = dy - cssUndo
            if (cssUndo !== 0) {
              cardYRef.current += cssUndo
              document.documentElement.style.setProperty('--rax-card-y', `${cardYRef.current}px`)
            }
            if (windowDy !== 0) {
              window.rax.startWindowDrag(0, windowDy)
              windowYRef.current += windowDy
            }
          }
        }
        dragRef.current.startX = e.screenX
        dragRef.current.startY = e.screenY
      }
    }

    const onMouseUp = () => {
      dragRef.current = null
    }

    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }
  }, [])

  const isExpanded = useSessionStore((s) => s.isExpanded)
  const marketplaceOpen = useSessionStore((s) => s.marketplaceOpen)
  const isRunning = activeTabStatus === 'running' || activeTabStatus === 'connecting'
  const isOrbTabActive = useSessionStore((s) => !!s.tabs.find((t) => t.id === s.activeTabId)?.isOrbTab)

  // Layout dimensions — expandedUI widens and heightens the panel
  const contentWidth = expandedUI ? 700 : spacing.contentWidth
  const cardExpandedWidth = expandedUI ? 700 : 460
  const cardCollapsedWidth = expandedUI ? 670 : 430
  const cardCollapsedMargin = expandedUI ? 15 : 15
  const bodyMaxHeight = expandedUI ? 520 : 400

  const handleScreenshot = useCallback(async () => {
    const result = await window.rax.takeScreenshot()
    if (!result) return
    addAttachments([result])
  }, [addAttachments])

  const handleAttachFile = useCallback(async () => {
    const files = await window.rax.attachFiles()
    if (!files || files.length === 0) return
    addAttachments(files)
  }, [addAttachments])

  // ─── Code Mode state (rendered as a right-side circle button) ───
  const codeModeOn = codeMode.status === 'ready'
  const codeModeWorking = codeMode.status === 'starting' || codeMode.status === 'detecting' || codeMode.status === 'stopping'
  const codeModeError = codeMode.status === 'error'
  const codeModeTooltip = codeModeError
    ? `Code Mode error: ${codeMode.error || 'unknown'}`
    : codeModeOn
      ? `Live preview: ${codeMode.url || ''} — click to stop`
      : codeModeWorking
        ? codeMode.status === 'detecting' ? 'Detecting…' : codeMode.status === 'stopping' ? 'Stopping…' : 'Starting…'
        : 'Open this folder in Code Mode (live preview)'

  return (
    <PopoverLayerProvider>
      <div className="flex flex-col justify-end h-full" style={{ background: 'transparent' }}>

        {/* ─── 460px content column, centered. Circles overflow left. ─── */}
        <div style={{ width: contentWidth, position: 'relative', margin: '0 auto', transition: 'width 0.26s cubic-bezier(0.4, 0, 0.1, 1)', transform: 'translateY(var(--rax-card-y, 0px))' }}>

          <AnimatePresence initial={false}>
            {marketplaceOpen && (
              <div
                data-rax-ui
                style={{
                  width: 720,
                  maxWidth: 720,
                  marginLeft: '50%',
                  transform: 'translateX(-50%)',
                  marginBottom: 14,
                  position: 'relative',
                  zIndex: 30,
                }}
              >
                <motion.div
                  initial={{ opacity: 0, y: 14, scale: 0.98 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: 10, scale: 0.985 }}
                  transition={TRANSITION}
                >
                  <div
                    data-rax-ui
                    className="glass-surface glass-pane glass-highlight overflow-hidden no-drag"
                    style={{
                      borderRadius: 24,
                      maxHeight: 470,
                    }}
                  >
                    <MarketplacePanel />
                  </div>
                </motion.div>
              </div>
            )}
          </AnimatePresence>

          {/*
            ─── Tabs / message shell ───
            This always remains the chat shell. The marketplace is a separate
            panel rendered above it, never inside it.
          */}
          <motion.div
            data-rax-ui
            className="overflow-hidden flex flex-col drag-region glass-pane glass-highlight"
            animate={{
              width: isExpanded ? cardExpandedWidth : cardCollapsedWidth,
              marginBottom: isExpanded ? 10 : -14,
              marginLeft: isExpanded ? 0 : cardCollapsedMargin,
              marginRight: isExpanded ? 0 : cardCollapsedMargin,
              background: isExpanded ? colors.containerBg : colors.containerBgCollapsed,
              borderColor: colors.containerBorder,
              boxShadow: isExpanded ? colors.cardShadow : colors.cardShadowCollapsed,
            }}
            transition={TRANSITION}
            style={{
              borderWidth: 1,
              borderStyle: 'solid',
              borderRadius: 20,
              position: 'relative',
              zIndex: isExpanded ? 20 : 10,
            }}
          >
            {/* Tab strip — always mounted */}
            <div className="no-drag">
              <TabStrip />
            </div>

            {/* Body — chat history only; the marketplace is a separate overlay above */}
            <motion.div
              initial={false}
              animate={{
                height: isExpanded ? 'auto' : 0,
                opacity: isExpanded ? 1 : 0,
              }}
              transition={TRANSITION}
              className="overflow-hidden no-drag"
            >
              <div style={{ maxHeight: bodyMaxHeight }}>
                <ConversationView />
                <StatusBar />
              </div>
            </motion.div>
          </motion.div>

          {/* ─── Input row — circles float outside left ─── */}
          {/* marginBottom: shadow buffer so the glass-surface drop shadow isn't clipped at the native window edge */}
          <div data-rax-ui className="relative" style={{ minHeight: 46, zIndex: 15, marginBottom: 10 }}>
            {/* Stacked circle buttons — expand on hover */}
            <div
              data-rax-ui
              className="circles-out"
            >
              <div className="btn-stack">
                {/* btn-1: Attach (front, rightmost) */}
                <button
                  className="stack-btn stack-btn-1 glass-surface"
                  title="Attach file"
                  onClick={handleAttachFile}
                  disabled={isRunning || isOrbTabActive}
                >
                  <Paperclip size={17} />
                </button>
                {/* btn-2: Screenshot (middle) */}
                <button
                  className="stack-btn stack-btn-2 glass-surface"
                  title="Take screenshot"
                  onClick={handleScreenshot}
                  disabled={isRunning || isOrbTabActive}
                >
                  <Camera size={17} />
                </button>
                {/* btn-3: Skills (back, leftmost) */}
                <button
                  className="stack-btn stack-btn-3 glass-surface"
                  title="Skills & Plugins"
                  onClick={() => useSessionStore.getState().toggleMarketplace()}
                  disabled={isRunning}
                >
                  <HeadCircuit size={17} />
                </button>
              </div>
            </div>

            {/* Input pill */}
            <div
              data-rax-ui
              className="glass-surface glass-highlight w-full"
              style={{ minHeight: 50, borderRadius: 20, padding: '0 6px 0 16px', background: colors.inputPillBg }}
            >
              <InputBar />
            </div>

            {/* Right-side circle stack — Code Mode + Fullscreen */}
            <div data-rax-ui className="circles-out-right">
              <div className="btn-stack-right">
                <button
                  className={`stack-btn-r stack-btn-r-1 glass-surface`}
                  title="Open as full window (⌘⇧F)"
                  onClick={() => { void window.rax.openFullscreen() }}
                >
                  <ArrowsOutSimple size={17} />
                </button>
                <button
                  className={`stack-btn-r stack-btn-r-2 glass-surface${codeModeOn ? ' is-on' : ''}${codeModeError ? ' is-error' : ''}`}
                  title={isOrbTabActive ? 'Code Mode is per-chat — pick a chat tab' : codeModeTooltip}
                  onClick={() => { void toggleCodeMode() }}
                  disabled={codeModeWorking || isOrbTabActive}
                >
                  <Code size={17} weight={codeModeOn ? 'fill' : 'regular'} />
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </PopoverLayerProvider>
  )
}
