import React from 'react'
import { motion } from 'framer-motion'
import { ShieldWarning, Terminal, PencilSimple, Globe, Wrench } from '@phosphor-icons/react'
import { useSessionStore } from '../stores/sessionStore'
import { useColors } from '../theme'
import type { PermissionRequest } from '../../shared/types'

interface Props {
  tabId: string
  permission: PermissionRequest
  queueLength?: number
}

const TOOL_ICONS: Record<string, React.ReactNode> = {
  Bash: <Terminal size={14} />,
  Edit: <PencilSimple size={14} />,
  Write: <PencilSimple size={14} />,
  WebSearch: <Globe size={14} />,
  WebFetch: <Globe size={14} />,
}

function getToolIcon(name: string) {
  return TOOL_ICONS[name] || <Wrench size={14} />
}

const SENSITIVE_FIELD_RE = /token|password|secret|key|auth|credential|api.?key/i

function formatInput(input?: Record<string, unknown>): string | null {
  if (!input) return null
  const entries = Object.entries(input)
  if (entries.length === 0) return null

  const parts: string[] = []
  for (const [key, value] of entries) {
    // Defense-in-depth: mask sensitive fields (backend already masks too)
    if (SENSITIVE_FIELD_RE.test(key)) {
      parts.push(`${key}: ***`)
      continue
    }
    const val = typeof value === 'string' ? value : JSON.stringify(value)
    const truncated = val.length > 120 ? val.substring(0, 117) + '...' : val
    parts.push(`${key}: ${truncated}`)
  }
  return parts.join('\n')
}

export function PermissionCard({ tabId, permission, queueLength = 1 }: Props) {
  const respondPermission = useSessionStore((s) => s.respondPermission)
  const colors = useColors()
  // `responded` drives the disabled state in the rendered buttons. A ref
  // backs the gate that protects against double-send: setState is async and
  // a held key-repeat fires keydowns faster than React re-renders, so the
  // closure-captured `responded` would still be false on the second event.
  const [responded, setResponded] = React.useState(false)
  const respondedRef = React.useRef(false)
  const cardRef = React.useRef<HTMLDivElement>(null)

  // Reset responded flag when the displayed permission changes (queue advancing)
  React.useEffect(() => {
    respondedRef.current = false
    setResponded(false)
  }, [permission.questionId])

  // Scroll the card into view as soon as it appears so the user can't miss it
  // — same energy as terminal CLI snapping focus to the y/n prompt.
  React.useEffect(() => {
    cardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [permission.questionId])

  const handleOption = React.useCallback((optionId: string) => {
    if (respondedRef.current) return
    respondedRef.current = true
    setResponded(true)
    respondPermission(tabId, permission.questionId, optionId)
  }, [respondPermission, tabId, permission.questionId])

  // Keyboard shortcuts: y = allow once, s = allow session, d = allow domain,
  // n/Esc = deny. Mirrors the terminal CLI's single-key prompt UX.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (respondedRef.current) return
      // Don't hijack typing in inputs/textareas
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      const allow = permission.options.find((o) => o.optionId === 'allow')
      const session = permission.options.find((o) => o.optionId === 'allow-session')
      const domain = permission.options.find((o) => o.optionId === 'allow-domain')
      const deny = permission.options.find((o) => o.optionId === 'deny')
      if ((e.key === 'y' || e.key === 'Y') && allow) { e.preventDefault(); handleOption(allow.optionId) }
      else if ((e.key === 's' || e.key === 'S') && session) { e.preventDefault(); handleOption(session.optionId) }
      else if ((e.key === 'd' || e.key === 'D') && domain) { e.preventDefault(); handleOption(domain.optionId) }
      else if ((e.key === 'n' || e.key === 'N' || e.key === 'Escape') && deny) { e.preventDefault(); handleOption(deny.optionId) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [permission.options, handleOption])

  const inputPreview = formatInput(permission.toolInput)

  return (
    <motion.div
      ref={cardRef}
      initial={{ opacity: 0, y: 8, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -4, scale: 0.97 }}
      transition={{ duration: 0.2 }}
      className="mx-4 mt-2 mb-2"
    >
      <div
        style={{
          background: colors.containerBg,
          border: `1px solid ${colors.permissionBorder}`,
          borderRadius: 12,
          boxShadow: colors.permissionShadow,
        }}
        className="overflow-hidden"
      >
        {/* Header */}
        <div
          className="flex items-center gap-1.5 px-3 py-1.5"
          style={{
            background: colors.permissionHeaderBg,
            borderBottom: `1px solid ${colors.permissionHeaderBorder}`,
          }}
        >
          <ShieldWarning size={12} style={{ color: colors.statusPermission }} />
          <span className="text-[11px] font-semibold" style={{ color: colors.statusPermission }}>
            Permission Required
          </span>
        </div>

        <div className="px-3 py-2.5">
          <div className="flex items-center gap-1.5 mb-1">
            <span style={{ color: colors.textTertiary }}>{getToolIcon(permission.toolTitle)}</span>
            <span className="text-[12px] font-medium" style={{ color: colors.textPrimary }}>
              {permission.toolTitle}
            </span>
          </div>

          {permission.toolDescription && (
            <p className="text-[11px] leading-[1.4] mb-1.5" style={{ color: colors.textSecondary }}>
              {permission.toolDescription}
            </p>
          )}

          {inputPreview && (
            <pre
              className="text-[10px] leading-[1.4] px-2 py-1.5 rounded-md overflow-x-auto whitespace-pre-wrap break-all mb-2"
              style={{
                background: colors.codeBg,
                color: colors.textSecondary,
                maxHeight: 80,
              }}
            >
              {inputPreview}
            </pre>
          )}

          <div className="flex items-center gap-2 flex-wrap">
            {permission.options.map((opt) => {
              const isAllow = opt.kind === 'allow' || opt.label.toLowerCase().includes('allow')
                || opt.label.toLowerCase().includes('yes')
              const isDeny = opt.kind === 'deny' || opt.label.toLowerCase().includes('deny')
                || opt.label.toLowerCase().includes('no') || opt.label.toLowerCase().includes('reject')

              let bg: string
              let hoverBg: string
              let textColor: string
              let borderColor: string

              if (isAllow) {
                bg = colors.permissionAllowBg
                hoverBg = colors.permissionAllowHoverBg
                textColor = colors.statusComplete
                borderColor = colors.permissionAllowBorder
              } else if (isDeny) {
                bg = colors.permissionDenyBg
                hoverBg = colors.permissionDenyHoverBg
                textColor = colors.statusError
                borderColor = colors.permissionDenyBorder
              } else {
                bg = colors.accentLight
                hoverBg = colors.accentSoft
                textColor = colors.accent
                borderColor = colors.accentSoft
              }

              const shortcut =
                opt.optionId === 'allow' ? 'Y' :
                opt.optionId === 'allow-session' ? 'S' :
                opt.optionId === 'deny' ? 'N' :
                opt.optionId === 'allow-domain' ? 'D' : null

              return (
                <button
                  key={opt.optionId}
                  onClick={() => handleOption(opt.optionId)}
                  disabled={responded}
                  title={shortcut ? `Press ${shortcut}` : undefined}
                  className="text-[11px] font-medium px-3 py-1.5 rounded-full transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1.5"
                  style={{
                    background: bg,
                    color: textColor,
                    border: `1px solid ${borderColor}`,
                  }}
                  onMouseEnter={(e) => {
                    if (!responded) e.currentTarget.style.background = hoverBg
                  }}
                  onMouseLeave={(e) => {
                    if (!responded) e.currentTarget.style.background = bg
                  }}
                >
                  <span>{opt.label}</span>
                  {shortcut && (
                    <kbd
                      className="text-[9px] font-mono px-1 rounded"
                      style={{
                        background: 'rgba(0,0,0,0.15)',
                        color: textColor,
                        opacity: 0.75,
                      }}
                    >
                      {shortcut}
                    </kbd>
                  )}
                </button>
              )
            })}

            {queueLength > 1 && (
              <span
                className="text-[10px] px-2 py-0.5 rounded-full"
                style={{
                  background: colors.accentLight,
                  color: colors.accent,
                }}
              >
                +{queueLength - 1} more
              </span>
            )}
          </div>
        </div>
      </div>
    </motion.div>
  )
}
