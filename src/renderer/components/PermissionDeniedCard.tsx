import React, { useState } from 'react'
import { motion } from 'framer-motion'
import { ShieldWarning, Terminal, ArrowSquareOut, CheckCircle, Prohibit } from '@phosphor-icons/react'
import { useColors } from '../theme'
import { useSessionStore } from '../stores/sessionStore'

interface Props {
  tabId: string
  tools: Array<{ toolName: string; toolUseId: string }>
  sessionId: string | null
  projectPath: string
  /** Whether the user actually saw an approval prompt for this run.
   *  false = the hook never reached the user — treated as an error condition. */
  hookReached: boolean
  onDismiss: () => void
}

export function PermissionDeniedCard({ tabId, tools, sessionId, projectPath, hookReached, onDismiss }: Props) {
  const colors = useColors()
  const [busy, setBusy] = useState(false)

  const toolNames = [...new Set(tools.map((t) => t.toolName))]

  const handleAllowAndRetry = async () => {
    if (busy) return
    setBusy(true)
    const ok = await window.rax.allowDeniedTools(tabId, toolNames)
    onDismiss()
    if (ok) {
      const list = toolNames.join(', ')
      useSessionStore.getState().sendMessage(
        `Permission granted for ${list} for the rest of this conversation. Please continue what you were doing — don't start over, just resume from where the tool call was blocked.`
      )
    }
  }

  const handleOpenInCli = () => {
    if (sessionId) {
      window.rax.openInTerminal(sessionId, projectPath)
    }
    onDismiss()
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 8, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -4, scale: 0.97 }}
      transition={{ duration: 0.2 }}
      className="mx-4 mb-2"
    >
      <div
        style={{
          background: colors.containerBg,
          border: `1px solid ${colors.permissionDeniedBorder}`,
          borderRadius: 14,
          boxShadow: `0 2px 12px ${colors.statusErrorBg}`,
        }}
        className="overflow-hidden"
      >
        {/* Header */}
        <div
          className="flex items-center gap-2 px-3 py-2"
          style={{
            background: colors.statusErrorBg,
            borderBottom: `1px solid ${colors.permissionDeniedHeaderBorder}`,
          }}
        >
          <ShieldWarning size={14} style={{ color: colors.statusError }} />
          <span className="text-[12px] font-semibold" style={{ color: colors.statusError }}>
            {hookReached ? 'Tool use denied' : 'Permission prompt didn\'t reach you'}
          </span>
        </div>

        {/* Body */}
        <div className="px-3 py-2">
          <p className="text-[11px] leading-[1.5] mb-2" style={{ color: colors.textSecondary }}>
            {hookReached ? (
              <>
                Claude tried to use{' '}
                {toolNames.length > 0 ? (
                  <span style={{ color: colors.textPrimary }}>{toolNames.join(', ')}</span>
                ) : 'a restricted tool'}
                {' '}and the request was denied. Allow it for this conversation and retry, or stay denied.
              </>
            ) : (
              <>
                Claude tried to use{' '}
                {toolNames.length > 0 ? (
                  <span style={{ color: colors.textPrimary }}>{toolNames.join(', ')}</span>
                ) : 'a restricted tool'}
                {' '}but the approval prompt never reached this window — so it was auto-denied. Click <b>Allow & Retry</b> to grant permission for this conversation and re-run the request.
              </>
            )}
          </p>

          {/* Tool list */}
          {tools.length > 0 && (
            <div className="flex flex-wrap gap-1 mb-2">
              {toolNames.map((name) => (
                <span
                  key={name}
                  className="inline-flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded-md"
                  style={{
                    background: colors.surfacePrimary,
                    color: colors.textTertiary,
                    border: `1px solid ${colors.surfaceSecondary}`,
                  }}
                >
                  <Terminal size={10} />
                  {name}
                </span>
              ))}
            </div>
          )}

          {/* Actions */}
          <div className="flex flex-wrap gap-1.5">
            {sessionId && toolNames.length > 0 && (
              <button
                onClick={handleAllowAndRetry}
                disabled={busy}
                className="text-[11px] font-medium px-3 py-1.5 rounded-full transition-colors cursor-pointer flex items-center gap-1.5 disabled:opacity-60 disabled:cursor-wait"
                style={{
                  background: colors.accentLight,
                  color: colors.accent,
                  border: `1px solid ${colors.accentBorderMedium}`,
                }}
                onMouseEnter={(e) => {
                  if (!busy) e.currentTarget.style.background = colors.accentSoft
                }}
                onMouseLeave={(e) => {
                  if (!busy) e.currentTarget.style.background = colors.accentLight
                }}
              >
                <CheckCircle size={12} weight="fill" />
                Allow & Retry
              </button>
            )}
            <button
              onClick={onDismiss}
              className="text-[11px] font-medium px-3 py-1.5 rounded-full transition-colors cursor-pointer flex items-center gap-1.5"
              style={{
                background: colors.statusErrorBg,
                color: colors.statusError,
                border: `1px solid ${colors.permissionDeniedBorder}`,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = colors.surfaceActive
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = colors.statusErrorBg
              }}
            >
              <Prohibit size={12} />
              Deny
            </button>
            {sessionId && (
              <button
                onClick={handleOpenInCli}
                className="text-[11px] font-medium px-3 py-1.5 rounded-full transition-colors cursor-pointer flex items-center gap-1.5"
                style={{
                  background: colors.surfaceHover,
                  color: colors.textTertiary,
                  border: `1px solid ${colors.surfaceSecondary}`,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = colors.surfaceActive
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = colors.surfaceHover
                }}
              >
                <ArrowSquareOut size={12} />
                Open in CLI
              </button>
            )}
          </div>
        </div>
      </div>
    </motion.div>
  )
}
