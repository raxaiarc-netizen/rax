import React, { useCallback, useEffect, useMemo, useRef } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Wrench, SpinnerGap, Square, ArrowCounterClockwise, Camera } from '@phosphor-icons/react'
import { useShallow } from 'zustand/react/shallow'
import { useSessionStore } from '../stores/sessionStore'
import { PermissionCard } from '../components/PermissionCard'
import { PermissionDeniedCard } from '../components/PermissionDeniedCard'
import type { Message } from '../../shared/types'

const REMARK_PLUGINS = [remarkGfm]

// Hoisted out of MessageRow so the component object identity is stable across
// renders — otherwise react-markdown re-instantiates renderers every time and
// can't memoize subtrees. The link click handler is also defined once at
// module level so the button prop identity stays stable for React.memo'd
// MessageRow children.
const onMdLinkClick = (e: React.MouseEvent<HTMLButtonElement>) => {
  const href = e.currentTarget.dataset.href
  if (href) window.rax.openExternal(href)
}
const MD_COMPONENTS = {
  a: ({ href, children }: any) => (
    <button
      type="button"
      className="fs-md-link"
      data-href={href ? String(href) : undefined}
      onClick={onMdLinkClick}
    >
      {children}
    </button>
  ),
}

export function MessagesPane() {
  const sendMessage = useSessionStore((s) => s.sendMessage)

  // Only re-render this component when the fields it actually uses change.
  // Picking the tab in a `useShallow` block means messages-array reference
  // changes (one per text_chunk) still re-render this — but the parent App,
  // Sidebar, Composer no longer have to.
  const data = useSessionStore(useShallow((s) => {
    const tab = s.tabs.find((t) => t.id === s.activeTabId)
    if (!tab) return null
    return {
      id: tab.id,
      isOrbTab: !!tab.isOrbTab,
      status: tab.status,
      currentActivity: tab.currentActivity,
      title: tab.title,
      claudeSessionId: tab.claudeSessionId,
      messages: tab.messages,
      permissionQueue: tab.permissionQueue,
      permissionDenied: tab.permissionDenied,
      queuedPrompts: tab.queuedPrompts,
      hasUserMessage: tab.messages.some((m) => m.role === 'user'),
    }
  }))

  const scrollRef = useRef<HTMLDivElement>(null)
  const stickyRef = useRef(true)

  // Auto-scroll when content grows and user is near bottom.
  const msgCount = data?.messages.length ?? 0
  const lastLen = data?.messages[data.messages.length - 1]?.content?.length ?? 0
  const queue = data?.permissionQueue?.length ?? 0
  const queued = data?.queuedPrompts?.length ?? 0
  const trigger = `${data?.id}:${msgCount}:${lastLen}:${queue}:${queued}`

  useEffect(() => {
    if (stickyRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [trigger])

  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    stickyRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }, [])

  // Group consecutive tool calls so they render compactly
  const grouped = useMemo(() => {
    const out: Array<{ kind: 'msg'; msg: Message } | { kind: 'tools'; key: string; msgs: Message[] }> = []
    let buf: Message[] = []
    const flush = () => { if (buf.length) { out.push({ kind: 'tools', key: `tools-${buf[0].id}`, msgs: buf }); buf = [] } }
    for (const m of data?.messages || []) {
      if (m.role === 'tool') buf.push(m)
      else { flush(); out.push({ kind: 'msg', msg: m }) }
    }
    flush()
    return out
  }, [data?.messages])

  if (!data) return null

  const isRunning = data.status === 'running' || data.status === 'connecting'
  const isFailed = data.status === 'failed'

  const handleRetry = () => {
    const last = [...data.messages].reverse().find((m) => m.role === 'user')
    if (last) sendMessage(last.content)
  }

  return (
    <div className="fs-chat-stream" ref={scrollRef} onScroll={onScroll}>
      <div className={`fs-chat-inner${data.isOrbTab ? ' is-orb' : ''}`}>
        {grouped.map((g) => {
          if (g.kind === 'msg') {
            return <MessageRow key={g.msg.id} message={g.msg} variant={data.isOrbTab ? 'orb' : 'normal'} />
          }
          return <ToolGroup key={g.key} tools={g.msgs} />
        })}

        {data.permissionQueue.length > 0 && (
          <div className="fs-msg" style={{ alignSelf: 'stretch' }}>
            <PermissionCard
              tabId={data.id}
              permission={data.permissionQueue[0]}
              queueLength={data.permissionQueue.length}
            />
          </div>
        )}

        {data.permissionDenied && (
          <div className="fs-msg" style={{ alignSelf: 'stretch' }}>
            <PermissionDeniedCard
              tabId={data.id}
              tools={data.permissionDenied.tools}
              hookReached={data.permissionDenied.hookReached}
              sessionId={data.claudeSessionId}
              onDismiss={() => {
                useSessionStore.setState((s) => ({
                  tabs: s.tabs.map((t) =>
                    t.id === data.id ? { ...t, permissionDenied: null } : t
                  ),
                }))
              }}
            />
          </div>
        )}

        {data.queuedPrompts.map((p, i) => (
          <div
            key={`q-${i}`}
            className="fs-msg-user"
            style={{ opacity: 0.55, borderStyle: 'dashed' }}
          >
            {p}
          </div>
        ))}

        {/* Status row */}
        {(isRunning || isFailed) && (
          <div className="fs-msg-statusrow">
            {isRunning && (
              <span className="fs-thinking">
                <span className="fs-bounce fs-thinking-dot" style={{ animationDelay: '0ms' }} />
                <span className="fs-bounce fs-thinking-dot" style={{ animationDelay: '150ms' }} />
                <span className="fs-bounce fs-thinking-dot" style={{ animationDelay: '300ms' }} />
                <span>{data.currentActivity || 'Working…'}</span>
              </span>
            )}
            {isFailed && (
              <>
                <span className="fs-msg-failed-label">Failed</span>
                <button
                  className="fs-button fs-msg-retry-btn"
                  onClick={handleRetry}
                >
                  <ArrowCounterClockwise size={11} /> Retry
                </button>
              </>
            )}
            {isRunning && data.hasUserMessage && (
              <button
                className="fs-button fs-msg-interrupt-btn"
                onClick={() => window.rax.stopTab(data.id)}
              >
                <Square size={9} weight="fill" /> Interrupt
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// React.memo: skip re-render unless message identity OR content (length) changes.
// During streaming, only the LAST assistant message's content grows — every
// prior message is content-stable, so default referential equality is enough.
// This is the single biggest perf win for streaming chats with many messages.
const MessageRow = React.memo(function MessageRow({ message, variant = 'normal' }: { message: Message; variant?: 'normal' | 'orb' }) {
  const orb = variant === 'orb'

  if (message.role === 'user') {
    return (
      <div className="fs-msg-user-wrap">
        <div className={`fs-msg-user${orb ? ' is-orb' : ''}`}>{message.content}</div>
        {orb && message.hasAutoScreenshot ? (
          <div
            className="fs-msg-orb-attachment"
            title="A screenshot of your screen was auto-attached for this turn"
          >
            <Camera size={11} weight="fill" /> screenshot attached
          </div>
        ) : null}
      </div>
    )
  }

  if (message.role === 'system') {
    const isError = message.content.startsWith('Error:') || message.content.includes('unexpectedly')
    const isOrbDivider = orb && /^—\s*new voice conversation\s*—$/i.test(message.content)
    if (isOrbDivider) {
      return (
        <div className="fs-msg-orb-divider" aria-hidden>
          <span className="fs-msg-orb-divider-line" />
          <span className="fs-msg-orb-divider-text">new voice conversation</span>
          <span className="fs-msg-orb-divider-line" />
        </div>
      )
    }
    return (
      <div className={`fs-msg-system${isError ? ' is-error' : ''}`}>{message.content}</div>
    )
  }

  // assistant — markdown
  return (
    <div className="fs-msg-assistant prose-cloud">
      <Markdown remarkPlugins={REMARK_PLUGINS} components={MD_COMPONENTS}>
        {message.content}
      </Markdown>
    </div>
  )
}, (prev, next) => prev.message === next.message && prev.variant === next.variant)

const ToolGroup = React.memo(function ToolGroup({ tools }: { tools: Message[] }) {
  const running = tools.find((t) => t.toolStatus === 'running')

  return (
    <div className="fs-tool-group">
      {tools.map((t) => {
        const isRun = t.toolStatus === 'running'
        let desc = t.toolName || 'Tool'
        if (t.toolInput) {
          try {
            const parsed = JSON.parse(t.toolInput)
            const s = (v: unknown) => (typeof v === 'string' ? v : '')
            switch (t.toolName) {
              case 'Read': desc = `Read ${s(parsed.file_path) || s(parsed.path) || 'file'}`; break
              case 'Edit': desc = `Edit ${s(parsed.file_path) || 'file'}`; break
              case 'Write': desc = `Write ${s(parsed.file_path) || 'file'}`; break
              case 'Glob': desc = `Search files: ${s(parsed.pattern)}`; break
              case 'Grep': desc = `Search: ${s(parsed.pattern)}`; break
              case 'Bash': {
                const cmd = s(parsed.command)
                desc = cmd.length > 80 ? `${cmd.slice(0, 77)}...` : cmd || 'Bash'
                break
              }
              case 'WebSearch': desc = `Search: ${s(parsed.query) || s(parsed.search_query)}`; break
              case 'WebFetch': desc = `Fetch: ${s(parsed.url)}`; break
              default: desc = `${t.toolName}`
            }
          } catch { /* partial JSON */ }
        }
        return (
          <div key={t.id} className={`fs-msg-tool${isRun ? ' is-running' : ''}`}>
            {isRun
              ? <SpinnerGap size={14} className="fs-pulse fs-tool-icon-run" />
              : <Wrench size={14} className="fs-tool-icon" />}
            <span className="fs-msg-tool-desc">{desc}</span>
            {!isRun && <span className="fs-msg-tool-done">done</span>}
          </div>
        )
      })}
      {running && tools.length > 1 && (
        <span className="fs-msg-tool-progress">
          {`${tools.length - 1} tool${tools.length > 2 ? 's' : ''} completed`}
        </span>
      )}
    </div>
  )
}, (prev, next) => {
  // Custom equality: tools array reference is rebuilt by useMemo each time the
  // full messages list changes (i.e. every token). Same-length-same-status
  // means visible state hasn't changed and we can skip re-rendering this row.
  if (prev.tools.length !== next.tools.length) return false
  for (let i = 0; i < prev.tools.length; i++) {
    const a = prev.tools[i]
    const b = next.tools[i]
    if (a === b) continue
    if (a.id !== b.id || a.toolStatus !== b.toolStatus || a.toolInput !== b.toolInput || a.toolName !== b.toolName) return false
  }
  return true
})
