import React from 'react'
import { Export, Waveform, ArrowCounterClockwise } from '@phosphor-icons/react'
import { useShallow } from 'zustand/react/shallow'
import { Composer } from '../Composer'
import { MessagesPane } from '../MessagesPane'
import { SplitView } from '../SplitView'
import { useSessionStore } from '../../stores/sessionStore'

export function ChatView() {
  const toggleCodeMode = useSessionStore((s) => s.toggleCodeMode)

  // Single shallow selector — keeps re-renders to actual transitions
  // (mode/tab swap, become empty/non-empty, code-mode ready/url change),
  // not every streaming token.
  const view = useSessionStore(useShallow((s) => {
    const tab = s.tabs.find((t) => t.id === s.activeTabId)
    return {
      hasTab: !!tab,
      isOrbTab: !!tab?.isOrbTab,
      isEmpty: (tab?.messages.length ?? 0) === 0 && (tab?.queuedPrompts.length ?? 0) === 0,
      firstName: s.staticInfo?.email?.split('@')[0]?.split('.')[0] || null,
      codeModeReady: s.codeMode.status === 'ready',
      codeModeUrl: s.codeMode.url,
    }
  }))

  // Code mode active → split layout (chat + preview). Not applicable on
  // the pinned orb tab — that tab has no project to preview.
  const showSplit = view.codeModeReady && !!view.codeModeUrl && !view.isOrbTab
  if (showSplit) {
    return <SplitView onCodeModeToggle={toggleCodeMode} />
  }

  if (!view.hasTab) return null

  // ── Pinned voice tab: read-only history of the orb ──
  if (view.isOrbTab) {
    return (
      <div className="fs-chat-shell fs-chat-shell-orb">
        {view.isEmpty ? <OrbWelcome /> : <MessagesPane />}
        <OrbFooter hasHistory={!view.isEmpty} />
      </div>
    )
  }

  // First name fallback for the greeting; never block the headline if absent.
  const greeting = view.firstName
    ? `What should we work on, ${view.firstName.charAt(0).toUpperCase() + view.firstName.slice(1)}?`
    : 'What should we work on?'

  // Export uses a live snapshot via getState() instead of a subscription so
  // ChatView doesn't have to re-render when tab fields used only by export change.
  const handleExport = async () => {
    const t = useSessionStore.getState().tabs.find((x) => x.id === useSessionStore.getState().activeTabId)
    if (!t) return
    try {
      await window.rax.exportTranscript({
        title: t.title,
        workingDirectory: t.workingDirectory,
        sessionModel: t.sessionModel,
        claudeSessionId: t.claudeSessionId,
        sessionVersion: t.sessionVersion,
        messages: t.messages,
        lastResult: t.lastResult,
        exportedAt: Date.now(),
      })
    } catch { /* ignore */ }
  }

  const isEmpty = view.isEmpty

  return (
    <div className="fs-chat-shell">
      {!isEmpty && (
        <div className="fs-chat-floataction">
          <button
            type="button"
            className="fs-topbar-iconbtn"
            onClick={handleExport}
            title="Export transcript"
            aria-label="Export"
          >
            <Export size={15} />
          </button>
        </div>
      )}

      {isEmpty ? (
        <div className="fs-welcome">
          <div className="fs-welcome-inner">
            <h1 className="fs-welcome-title fs-rise-2">{greeting}</h1>

            <div className="fs-rise-3">
              <Composer floating onCodeModeToggle={toggleCodeMode} />
            </div>
          </div>
        </div>
      ) : (
        <>
          <MessagesPane />
          <Composer onCodeModeToggle={toggleCodeMode} />
        </>
      )}
    </div>
  )
}

function OrbWelcome() {
  return (
    <div className="fs-orb-welcome">
      <div className="fs-orb-welcome-orb" aria-hidden>
        <Waveform size={32} weight="bold" />
      </div>
      <h1 className="fs-orb-welcome-title">Voice</h1>
      <p className="fs-orb-welcome-sub">
        Summon the orb with <kbd>⌘⇧O</kbd> or hold <kbd>⌥R</kbd> to push‑to‑talk. Every voice turn
        streams here.
      </p>
      <button
        type="button"
        className="fs-orb-cta"
        onClick={() => { void window.rax.showOrb() }}
      >
        <Waveform size={14} weight="bold" />
        <span>Summon orb</span>
      </button>
    </div>
  )
}

function OrbFooter({ hasHistory }: { hasHistory: boolean }) {
  const handleReset = () => {
    if (!hasHistory) return
    useSessionStore.getState().applyOrbReset()
    try { void window.rax.resetOrb() } catch {}
  }
  return (
    <div className="fs-orb-footer" data-no-drag>
      <button
        type="button"
        className="fs-orb-cta fs-orb-cta-compact"
        onClick={() => { void window.rax.showOrb() }}
        title="Show the voice orb (⌘⇧O)"
      >
        <Waveform size={13} weight="bold" />
        <span>Summon orb</span>
      </button>
      <button
        type="button"
        className="fs-orb-footer-reset"
        onClick={handleReset}
        disabled={!hasHistory}
        title={hasHistory ? 'Wipe the voice transcript and start a fresh orb session' : 'Voice transcript is empty'}
        style={{ opacity: hasHistory ? 1 : 0.5, cursor: hasHistory ? 'pointer' : 'not-allowed' }}
      >
        <ArrowCounterClockwise size={11} style={{ marginRight: 4, verticalAlign: 'middle' }} />
        Reset history
      </button>
    </div>
  )
}
