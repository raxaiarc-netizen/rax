import React, { useEffect, useMemo, useState } from 'react'
import { MagnifyingGlass, ChatCircle, Clock, SpinnerGap } from '@phosphor-icons/react'
import { useSessionStore } from '../../stores/sessionStore'
import type { SessionMeta } from '../../../shared/types'

function formatTimeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d}d ago`
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function SearchView({ onOpenChat }: { onOpenChat: () => void }) {
  const tabs = useSessionStore((s) => s.tabs)
  const activeTabId = useSessionStore((s) => s.activeTabId)
  const selectTab = useSessionStore((s) => s.selectTab)
  const resumeSession = useSessionStore((s) => s.resumeSession)
  const staticInfo = useSessionStore((s) => s.staticInfo)

  const [sessions, setSessions] = useState<SessionMeta[]>([])
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')

  const activeTab = tabs.find((t) => t.id === activeTabId)
  const projectPath = activeTab?.hasChosenDirectory
    ? activeTab.workingDirectory
    : (staticInfo?.homePath || activeTab?.workingDirectory || '~')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    window.rax.listSessions(projectPath)
      .then((s) => { if (!cancelled) setSessions(s) })
      .catch(() => { /* ignore */ })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [projectPath])

  const filteredTabs = useMemo(() => {
    if (!query.trim()) return tabs
    const q = query.toLowerCase()
    return tabs.filter((t) =>
      (t.title || '').toLowerCase().includes(q) ||
      t.messages.some((m) => m.content.toLowerCase().includes(q))
    )
  }, [tabs, query])

  const filteredSessions = useMemo(() => {
    if (!query.trim()) return sessions
    const q = query.toLowerCase()
    return sessions.filter((s) =>
      (s.firstMessage || '').toLowerCase().includes(q) ||
      (s.slug || '').toLowerCase().includes(q)
    )
  }, [sessions, query])

  return (
    <div className="fs-page">
      <div className="fs-page-header">
        <div>
          <div className="fs-page-title">Search</div>
          <div className="fs-page-subtitle">Find an open chat or resume a past session.</div>
        </div>
      </div>

      <div style={{ padding: '16px 40px 0' }}>
        <div className="fs-search-field">
          <MagnifyingGlass size={14} style={{ color: 'var(--fs-text-tertiary)' }} />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search chats and past sessions"
          />
        </div>
      </div>

      <div className="fs-page-body" style={{ padding: '14px 40px 40px' }}>
        <div className="fs-section-label">Open chats</div>
        {filteredTabs.length === 0 ? (
          <div style={{ padding: '8px 0', fontSize: 12.5, color: 'var(--fs-text-tertiary)' }}>
            No matching chats.
          </div>
        ) : (
          filteredTabs.map((t) => (
            <div
              key={t.id}
              className="fs-search-row"
              onClick={() => { selectTab(t.id); onOpenChat() }}
            >
              <ChatCircle size={14} style={{ color: 'var(--fs-text-tertiary)' }} />
              <span className="fs-search-title">{t.title || 'New chat'}</span>
              <span className="fs-search-time">{t.messages.length} msg{t.messages.length === 1 ? '' : 's'}</span>
            </div>
          ))
        )}

        <div className="fs-section-label" style={{ paddingTop: 22 }}>
          <span>Past sessions</span>
          {projectPath !== '~' && (
            <span style={{
              fontSize: 10.5, fontFamily: 'var(--fs-font-mono)',
              color: 'var(--fs-text-muted)', textTransform: 'none', letterSpacing: 0,
              maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              · {projectPath}
            </span>
          )}
        </div>
        {loading ? (
          <div style={{
            padding: '8px 0', fontSize: 12.5, color: 'var(--fs-text-tertiary)',
            display: 'flex', alignItems: 'center', gap: 8,
          }}>
            <SpinnerGap size={13} className="fs-pulse" /> Loading…
          </div>
        ) : filteredSessions.length === 0 ? (
          <div style={{ padding: '8px 0', fontSize: 12.5, color: 'var(--fs-text-tertiary)' }}>
            No past sessions{query ? ' match your query' : ' for this directory'}.
          </div>
        ) : (
          filteredSessions.map((s) => (
            <div
              key={s.sessionId}
              className="fs-search-row"
              onClick={async () => {
                await resumeSession(s.sessionId, s.firstMessage || s.slug || 'Resumed Session', projectPath)
                onOpenChat()
              }}
            >
              <Clock size={14} style={{ color: 'var(--fs-text-tertiary)' }} />
              <span className="fs-search-title">{s.firstMessage || s.slug || s.sessionId.slice(0, 8)}</span>
              <span className="fs-search-time">{formatTimeAgo(s.lastTimestamp)}</span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
