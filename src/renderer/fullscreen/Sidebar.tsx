import React, { useRef } from 'react'
import {
  PencilSimple, MagnifyingGlass, Gear, Plus, X,
  Sparkle, BookOpen, Sun, Moon, ArrowsInSimple, Waveform,
} from '@phosphor-icons/react'
import { useSessionStore } from '../stores/sessionStore'
import { useThemeStore } from '../theme'
import type { SidebarSection } from './App'
import type { TabStatus } from '../../shared/types'
import { AGENTS, getAgent } from '../../shared/agents'

// Slim projection used by Sidebar. Subscribing to the full tabs array makes
// Sidebar re-render on every streaming token because messages[] changes the
// array reference. We project to a primitives-only shape and memoize the
// result with a custom equality so the selector returns a stable reference
// when nothing Sidebar cares about changed — `useShallow` alone would NOT
// work here because it does one-level shallow compare and `visibleTabs` is
// a freshly-built array each call (different ref → infinite re-render via
// useSyncExternalStore's "snapshot keeps changing" detector).
interface SidebarTab {
  id: string
  title: string
  status: TabStatus
  hasUnread: boolean
  hasPermission: boolean
  isFirstAndEmpty: boolean
  agentId?: string
}

interface SidebarSelection {
  visibleTabs: SidebarTab[]
  agentStatuses: Record<string, {
    status: TabStatus
    hasUnread: boolean
    hasPermission: boolean
    hidden: boolean
  }>
  activeTabId: string | null
  activeTabIsEmpty: boolean
}

function sameSidebarTab(a: SidebarTab, b: SidebarTab): boolean {
  return a.id === b.id
    && a.title === b.title
    && a.status === b.status
    && a.hasUnread === b.hasUnread
    && a.hasPermission === b.hasPermission
    && a.isFirstAndEmpty === b.isFirstAndEmpty
    && a.agentId === b.agentId
}

function sameAgentStatuses(
  a: SidebarSelection['agentStatuses'],
  b: SidebarSelection['agentStatuses'],
): boolean {
  for (const def of AGENTS) {
    const x = a[def.id]
    const y = b[def.id]
    if (!x || !y) return false
    if (
      x.status !== y.status
      || x.hasUnread !== y.hasUnread
      || x.hasPermission !== y.hasPermission
      || x.hidden !== y.hidden
    ) {
      return false
    }
  }
  return true
}

function sameSelection(a: SidebarSelection | null, b: SidebarSelection): boolean {
  if (!a) return false
  if (a.activeTabId !== b.activeTabId) return false
  if (a.activeTabIsEmpty !== b.activeTabIsEmpty) return false
  if (a.visibleTabs.length !== b.visibleTabs.length) return false
  for (let i = 0; i < a.visibleTabs.length; i++) {
    if (!sameSidebarTab(a.visibleTabs[i], b.visibleTabs[i])) return false
  }
  if (!sameAgentStatuses(a.agentStatuses, b.agentStatuses)) return false
  return true
}

export function Sidebar({ section, collapsed, onNavigate }: {
  section: SidebarSection
  collapsed: boolean
  onNavigate: (section: SidebarSection, tabId?: string | null) => void
}) {
  const closeTab = useSessionStore((s) => s.closeTab)
  const createTab = useSessionStore((s) => s.createTab)
  const staticInfoVersion = useSessionStore((s) => s.staticInfo?.version)
  const isDark = useThemeStore((s) => s.isDark)
  const themeMode = useThemeStore((s) => s.themeMode)
  const setThemeMode = useThemeStore((s) => s.setThemeMode)

  const prevSelectionRef = useRef<SidebarSelection | null>(null)
  const { visibleTabs, agentStatuses, activeTabId, activeTabIsEmpty } = useSessionStore((s) => {
    const visible: SidebarTab[] = []
    let activeIsEmpty = false
    const agentStatusMap: SidebarSelection['agentStatuses'] = {}
    for (const t of s.tabs) {
      if (t.isOrbTab) continue
      if (t.agentId) {
        // Track agent state separately for the "Agents" row group — these
        // never show up in the regular chat list.
        agentStatusMap[t.agentId] = {
          status: t.status,
          hasUnread: t.hasUnread,
          hasPermission: t.permissionQueue.length > 0,
          hidden: !!t.hidden,
        }
        // BUT — once the user un-hides an agent (via dock click), it ALSO
        // surfaces in the chat list so they can switch back and forth like
        // any other chat. The roster row stays as a quick-access anchor.
        if (!t.hidden) {
          visible.push({
            id: t.id,
            title: getAgent(t.agentId)?.name || t.title || 'Agent',
            status: t.status,
            hasUnread: t.hasUnread,
            hasPermission: t.permissionQueue.length > 0,
            isFirstAndEmpty: false,
            agentId: t.agentId,
          })
        }
        continue
      }
      visible.push({
        id: t.id,
        title: t.title || 'New chat',
        status: t.status,
        hasUnread: t.hasUnread,
        hasPermission: t.permissionQueue.length > 0,
        isFirstAndEmpty: false,
      })
      if (t.id === s.activeTabId) activeIsEmpty = t.messages.length === 0
    }
    const next: SidebarSelection = {
      visibleTabs: visible,
      agentStatuses: agentStatusMap,
      activeTabId: s.activeTabId,
      activeTabIsEmpty: activeIsEmpty,
    }
    if (sameSelection(prevSelectionRef.current, next)) return prevSelectionRef.current!
    prevSelectionRef.current = next
    return next
  })

  const handleNew = async () => {
    const newTabId = await createTab()
    onNavigate('chat', newTabId)
  }

  const cycleTheme = () => {
    const next = themeMode === 'light' ? 'dark' : themeMode === 'dark' ? 'system' : 'light'
    setThemeMode(next)
  }

  return (
    <div className={`fs-sidebar${collapsed ? ' is-collapsed' : ''}`} aria-hidden={collapsed}>
      <div className="fs-sidebar-inner">
      <div className="fs-nav-group">
        <NavRow
          icon={<PencilSimple size={18} />}
          label="New chat"
          onClick={handleNew}
          shortcut="⌘N"
          active={section === 'chat' && (visibleTabs.length === 0 || activeTabIsEmpty)}
        />
        <NavRow
          icon={<Sparkle size={18} weight={section === 'plugins' ? 'fill' : 'regular'} />}
          label="Plugins"
          active={section === 'plugins'}
          onClick={() => onNavigate('plugins')}
          badge="New"
        />
        <NavRow
          icon={<MagnifyingGlass size={18} />}
          label="Search"
          active={section === 'search'}
          onClick={() => onNavigate('search')}
          shortcut="⌘K"
        />
        <NavRow
          icon={<BookOpen size={18} />}
          label="Project"
          active={section === 'project'}
          onClick={() => onNavigate('project')}
        />
      </div>

      {/* Agents row group — the dock's roster surfaced inside the fullscreen
          sidebar. Clicking an agent un-hides + selects it (same path as
          clicking it on the floating dock). Always shows all 5 so the user
          has a single source of truth for "who exists." */}
      <div className="fs-sidebar-section">
        <span>Agents</span>
        <span className="fs-sidebar-section-hint" title="Open the floating dock (⌘⇧D)">⌘⇧D</span>
      </div>
      <div className="fs-agent-list">
        {AGENTS.map((def) => {
          const st = agentStatuses[def.id]
          const active = activeTabId === def.id && section === 'chat'
          return (
            <AgentRosterRow
              key={def.id}
              agentId={def.id}
              active={active}
              status={st?.status ?? 'idle'}
              hasUnread={!!st?.hasUnread}
              hasPermission={!!st?.hasPermission}
              hidden={st?.hidden ?? true}
              onSelect={() => onNavigate('chat', def.id)}
            />
          )
        })}
      </div>

      <div className="fs-sidebar-section">
        <span>Tasks</span>
        <button
          aria-label="New chat"
          title="New chat"
          onClick={handleNew}
          className="fs-sidebar-section-action"
        >
          <Plus size={13} weight="bold" />
        </button>
      </div>

      <div className="fs-chat-list">
        {visibleTabs.length === 0 ? (
          <div className="fs-chat-empty">No tasks yet</div>
        ) : (
          visibleTabs.map((tab) => (
            <ChatRow
              key={tab.id}
              id={tab.id}
              title={tab.title}
              active={tab.id === activeTabId && section === 'chat'}
              status={tab.status}
              hasUnread={tab.hasUnread}
              hasPermission={tab.hasPermission}
              agentId={tab.agentId}
              onSelect={() => onNavigate('chat', tab.id)}
              onClose={() => closeTab(tab.id)}
            />
          ))
        )}
      </div>

      <div className="fs-sidebar-bottom">
        <div className="fs-sidebar-bottom-actions">
          <button
            className={`fs-sidebar-bottom-btn${section === 'settings' ? ' is-active' : ''}`}
            onClick={() => onNavigate('settings')}
            aria-label="Settings"
            title="Settings"
          >
            <Gear size={16} />
          </button>
          <button
            className="fs-sidebar-bottom-btn"
            onClick={cycleTheme}
            aria-label={`Theme: ${themeMode}`}
            title={`Theme: ${themeMode}${themeMode === 'system' ? ` (${isDark ? 'dark' : 'light'})` : ''}`}
          >
            {isDark ? <Moon size={16} /> : <Sun size={16} />}
          </button>
          <button
            className="fs-sidebar-bottom-btn"
            onClick={() => window.rax.closeFullscreen()}
            aria-label="Back to pill"
            title="Back to pill mode (⌘⇧F)"
          >
            <ArrowsInSimple size={16} />
          </button>
        </div>
        {staticInfoVersion && (
          <span className="fs-sidebar-version">v{staticInfoVersion}</span>
        )}
      </div>
      </div>
    </div>
  )
}

function NavRow({
  icon, label, active, onClick, shortcut, badge,
}: {
  icon: React.ReactNode
  label: string
  active?: boolean
  onClick: () => void
  shortcut?: string
  badge?: string
}) {
  return (
    <button
      className={`fs-nav-row${active ? ' is-active' : ''}`}
      onClick={onClick}
    >
      <span className="fs-nav-icon">{icon}</span>
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
      {badge && <span className="fs-nav-badge">{badge}</span>}
      {shortcut && !badge && <span className="fs-nav-trail">{shortcut}</span>}
    </button>
  )
}

const ChatRow = React.memo(function ChatRow({
  id: _id, title, active, status, hasUnread, hasPermission, isOrb, agentId, onSelect, onClose,
}: {
  id: string
  title: string
  active: boolean
  status: TabStatus
  hasUnread: boolean
  hasPermission: boolean
  isOrb?: boolean
  agentId?: string
  onSelect: () => void
  onClose: () => void
}) {
  const agent = agentId ? getAgent(agentId) : undefined
  const accent = agent?.accent
  let dot = 'transparent'
  let pulse = false
  if (status === 'dead' || status === 'failed') {
    dot = 'var(--fs-pastel-rose-fg)'
  } else if (hasPermission) {
    dot = accent || 'var(--fs-accent)'
    pulse = true
  } else if (status === 'connecting' || status === 'running') {
    dot = isOrb ? 'var(--rax-orb-accent, #7aa7ff)' : (accent || 'var(--fs-accent)')
    pulse = true
  } else if (hasUnread) {
    dot = isOrb ? 'var(--rax-orb-accent, #7aa7ff)' : (accent || 'var(--fs-pastel-green-fg)')
  }

  return (
    <div
      className={`fs-chat-row${active ? ' is-active' : ''}${isOrb ? ' is-orb' : ''}`}
      onClick={onSelect}
      title={isOrb ? 'Voice — orb conversation history (pinned)' : title}
    >
      {isOrb ? (
        <span
          className={`fs-chat-orb-icon ${status === 'running' ? 'fs-pulse' : ''}`}
          aria-hidden="true"
        >
          <Waveform size={11} weight="bold" />
        </span>
      ) : agent ? (
        <span
          className="fs-agent-glyph"
          aria-hidden
          style={{
            color: accent,
            background: `color-mix(in srgb, ${accent} 14%, transparent)`,
            border: `1px solid color-mix(in srgb, ${accent} 30%, transparent)`,
          }}
        >
          {agent.glyph}
        </span>
      ) : (
        <span
          className={`fs-chat-dot ${pulse ? 'fs-pulse' : ''}`}
          style={{ background: dot }}
          aria-hidden="true"
        />
      )}
      <span className="fs-chat-title">{title}</span>
      {!isOrb && (
        <button
          className="fs-chat-close"
          aria-label={agent ? `Hide ${agent.name}` : 'Close chat'}
          title={agent ? `Hide ${agent.name}` : 'Close chat'}
          onClick={(e) => { e.stopPropagation(); onClose() }}
        >
          <X size={11} />
        </button>
      )}
    </div>
  )
})

// Compact row used in the "Agents" roster section. Always renders all 5
// agents regardless of `hidden` — the section IS the dock equivalent inside
// fullscreen, so it needs to be the place a user comes to find their roster.
// Clicking an agent here un-hides + selects (same path as the dock click).
const AgentRosterRow = React.memo(function AgentRosterRow({
  agentId, active, status, hasUnread, hasPermission, hidden, onSelect,
}: {
  agentId: string
  active: boolean
  status: TabStatus
  hasUnread: boolean
  hasPermission: boolean
  hidden: boolean
  onSelect: () => void
}) {
  const agent = getAgent(agentId)
  if (!agent) return null
  const accent = agent.accent

  // Run-state pip — running pulses with accent; completed/unread shows soft
  // green to mirror the dock's behavior; idle is invisible so the section
  // looks calm by default.
  let pip = 'transparent'
  let pulse = false
  let glow = false
  if (status === 'dead' || status === 'failed') {
    pip = 'var(--fs-pastel-rose-fg, #ff6b6b)'
  } else if (hasPermission) {
    pip = accent
    glow = true
  } else if (status === 'connecting' || status === 'running') {
    pip = accent
    pulse = true
  } else if (hasUnread) {
    pip = 'var(--fs-pastel-green-fg, #5dd5a8)'
  }

  return (
    <div
      className={`fs-chat-row fs-agent-row${active ? ' is-active' : ''}${hidden ? ' is-dormant' : ''}`}
      onClick={onSelect}
      title={`${agent.name} — ${agent.tagline}${hidden ? '' : ' (open in chat)'}`}
      style={
        active
          ? ({ borderLeft: `2px solid ${accent}`, paddingLeft: 10 } as React.CSSProperties)
          : undefined
      }
    >
      <span
        className="fs-agent-glyph"
        aria-hidden
        style={{
          color: accent,
          background: `color-mix(in srgb, ${accent} ${hidden ? 8 : 14}%, transparent)`,
          border: `1px solid color-mix(in srgb, ${accent} ${hidden ? 18 : 30}%, transparent)`,
        }}
      >
        {agent.glyph}
      </span>
      <span className="fs-chat-title" style={{ flex: 1, opacity: hidden ? 0.7 : 1 }}>{agent.name}</span>
      <span
        className={`fs-chat-dot ${pulse ? 'fs-pulse' : ''}`}
        style={{
          background: pip,
          ...(glow ? { boxShadow: `0 0 6px 2px ${accent}` } : {}),
        }}
        aria-hidden="true"
      />
    </div>
  )
})
