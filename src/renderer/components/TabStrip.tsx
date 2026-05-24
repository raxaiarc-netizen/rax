import React from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Plus, X, Waveform } from '@phosphor-icons/react'
import { useSessionStore } from '../stores/sessionStore'
import { HistoryPicker } from './HistoryPicker'
import { SettingsPopover } from './SettingsPopover'
import { useColors } from '../theme'
import type { TabStatus } from '../../shared/types'
import { getAgent } from '../../shared/agents'

function StatusDot({ status, hasUnread, hasPermission, orb, accent }: { status: TabStatus; hasUnread: boolean; hasPermission: boolean; orb?: boolean; accent?: string }) {
  const colors = useColors()
  let bg: string = colors.statusIdle
  let pulse = false
  let glow = false

  // Per-agent accent overrides the default running/unread color so the pill
  // tab strip stays in visual lockstep with the dock when an agent tab is
  // surfaced. Error/permission states still use the canonical alarm/warning
  // colors — those are meant to stand out, not blend with the roster.
  const runningColor = orb ? colors.orbAccent : (accent || colors.statusRunning)
  const completeColor = orb ? colors.orbAccent : (accent || colors.statusComplete)

  if (status === 'dead' || status === 'failed') {
    bg = colors.statusError
  } else if (hasPermission) {
    bg = colors.statusPermission
    glow = true
  } else if (status === 'connecting' || status === 'running') {
    bg = runningColor
    pulse = true
  } else if (hasUnread) {
    bg = completeColor
  }

  return (
    <span
      className={`w-[6px] h-[6px] rounded-full flex-shrink-0 ${pulse ? 'animate-pulse-dot' : ''}`}
      style={{
        background: bg,
        ...(glow ? { boxShadow: `0 0 6px 2px ${colors.statusPermissionGlow}` } : {}),
      }}
    />
  )
}

export function TabStrip() {
  // Subscribe to the raw tabs array (stable reference; only changes when the
  // tab set actually changes) and filter in render. Filtering inside the
  // selector would build a fresh array each call and trip the
  // useSyncExternalStore "snapshot keeps changing" detector. Hidden agent
  // tabs are managed by the floating dock — they re-appear here once the
  // user clicks them in the dock (which un-hides via the tab-selected
  // mirror).
  const allTabs = useSessionStore((s) => s.tabs)
  const tabs = React.useMemo(() => allTabs.filter((t) => !t.hidden), [allTabs])
  const activeTabId = useSessionStore((s) => s.activeTabId)
  const selectTab = useSessionStore((s) => s.selectTab)
  const createTab = useSessionStore((s) => s.createTab)
  const closeTab = useSessionStore((s) => s.closeTab)
  const colors = useColors()

  return (
    <div
      data-rax-ui
      className="flex items-center no-drag"
      style={{ padding: '8px 0' }}
    >
      <div className="relative min-w-0 flex-1">
        <div
          className="flex items-center gap-1 overflow-x-auto min-w-0"
          style={{
            scrollbarWidth: 'none',
            paddingLeft: 8,
            paddingRight: 14,
            maskImage: 'linear-gradient(to right, black 0%, black calc(100% - 40px), transparent 100%)',
            WebkitMaskImage: 'linear-gradient(to right, black 0%, black calc(100% - 40px), transparent 100%)',
          }}
        >
          <AnimatePresence mode="popLayout">
            {tabs.map((tab) => {
              const isActive = tab.id === activeTabId
              const orb = !!tab.isOrbTab
              const agent = tab.agentId ? getAgent(tab.agentId) : undefined
              const accent = agent?.accent
              const accentSoft = agent?.accentSoft
              // Hide the close button on the orb tab (pinned) and on the last
              // free-form chat tab (you must have at least one chat).
              const nonOrbVisibleCount = tabs.filter((t) => !t.isOrbTab).length
              const showClose = !orb && (!!agent || nonOrbVisibleCount > 1)
              // Agent tabs adopt their accent palette; everything else uses
              // the default tab colors.
              const activeBg = orb
                ? colors.orbTabActive
                : (accentSoft || colors.tabActive)
              const activeBorder = orb
                ? colors.orbTabActiveBorder
                : (accent || colors.tabActiveBorder)
              const activeColor = orb
                ? colors.orbAccent
                : (accent || colors.textPrimary)
              const inactiveColor = orb
                ? colors.orbAccent
                : (accent || colors.textTertiary)
              const displayTitle = agent ? agent.name : tab.title
              return (
                <motion.div
                  key={tab.id}
                  layout
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.9 }}
                  transition={{ duration: 0.15 }}
                  onClick={() => selectTab(tab.id)}
                  className="group flex items-center gap-1.5 cursor-pointer select-none flex-shrink-0 max-w-[160px] transition-all duration-150"
                  style={{
                    background: isActive ? activeBg : 'transparent',
                    border: isActive ? `1px solid ${activeBorder}` : '1px solid transparent',
                    borderRadius: 9999,
                    padding: '4px 10px',
                    fontSize: 12,
                    color: isActive ? activeColor : inactiveColor,
                    fontWeight: isActive ? 500 : (orb || agent ? 500 : 400),
                    opacity: orb && !isActive ? 0.78 : 1,
                  }}
                  title={
                    orb
                      ? 'Voice — orb conversation history (pinned)'
                      : agent
                        ? `${agent.name} — ${agent.tagline}`
                        : tab.title
                  }
                >
                  {orb ? (
                    <span
                      className="flex-shrink-0 flex items-center justify-center"
                      style={{
                        color: colors.orbAccent,
                        filter: tab.status === 'running' ? `drop-shadow(0 0 4px ${colors.orbAccentGlow})` : undefined,
                      }}
                    >
                      <Waveform size={11} weight="bold" />
                    </span>
                  ) : agent ? (
                    <span
                      className="flex-shrink-0 flex items-center justify-center text-[11px] font-bold"
                      style={{
                        color: accent,
                        width: 14,
                        height: 14,
                        borderRadius: 4,
                        background: `color-mix(in srgb, ${accent} 18%, transparent)`,
                      }}
                    >
                      {agent.glyph}
                    </span>
                  ) : (
                    <StatusDot status={tab.status} hasUnread={tab.hasUnread} hasPermission={tab.permissionQueue.length > 0} />
                  )}
                  <span className="truncate flex-1">{displayTitle}</span>
                  {agent && (
                    <StatusDot
                      status={tab.status}
                      hasUnread={tab.hasUnread}
                      hasPermission={tab.permissionQueue.length > 0}
                      accent={accent}
                    />
                  )}
                  {showClose && (
                    <button
                      onClick={(e) => { e.stopPropagation(); closeTab(tab.id) }}
                      className="flex-shrink-0 rounded-full w-4 h-4 flex items-center justify-center transition-opacity"
                      style={{
                        opacity: isActive ? 0.5 : 0,
                        color: colors.textSecondary,
                      }}
                      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.opacity = '1' }}
                      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.opacity = isActive ? '0.5' : '0' }}
                      title={agent ? `Hide ${agent.name}` : 'Close tab'}
                    >
                      <X size={10} />
                    </button>
                  )}
                </motion.div>
              )
            })}
          </AnimatePresence>
        </div>
      </div>

      <div className="flex items-center gap-0.5 flex-shrink-0 ml-1 pr-2">
        <button
          onClick={() => createTab()}
          className="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded-full transition-colors"
          style={{ color: colors.textTertiary }}
          title="New tab"
        >
          <Plus size={14} />
        </button>

        <HistoryPicker />

        <SettingsPopover />
      </div>
    </div>
  )
}
