import React, { useEffect, useRef, useState } from 'react'
import type { DeviceMode } from '../../shared/types'
import type { PageEntry } from './App'

interface ToolbarProps {
  device: DeviceMode
  rotated: boolean
  inspecting: boolean
  isReady: boolean
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  url: string | null
  currentPath: string
  pages: PageEntry[]
  onBack: () => void
  onForward: () => void
  onReload: (hard?: boolean) => void
  onStop: () => void
  onToggleInspect: () => void
  onSetDevice: (mode: DeviceMode) => void
  onToggleRotate: () => void
  onCopyUrl: () => void
  onOpenExternal: () => void
  onNavigate: (url: string) => void
  onSelectPage: (path: string) => void
}

const DEVICE_META: Record<DeviceMode, { title: string; icon: React.ReactNode }> = {
  mobile: {
    title: 'Mobile · 412 × 870',
    icon: (
      <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <rect x="8.5" y="3.5" width="7" height="17" rx="1" />
        <line x1="11" y1="17.5" x2="13" y2="17.5" />
      </svg>
    ),
  },
  tablet: {
    title: 'Tablet · 834 × 1000',
    icon: (
      <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <rect x="5" y="3.5" width="14" height="17" rx="1.2" />
      </svg>
    ),
  },
  desktop: {
    title: 'Desktop · 1280 × 900',
    icon: (
      <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="4.5" width="18" height="12" rx="1.2" />
        <line x1="9" y1="20" x2="15" y2="20" />
        <line x1="12" y1="16.5" x2="12" y2="20" />
      </svg>
    ),
  },
}

// Minimal "selection arrow" — the classic inspector cursor, sleek and pure outline.
const InspectArrowIcon = (
  <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M6 4 L6 18 L10 14 L12.5 19.5 L14.5 18.6 L12 13 L18 13 Z" />
  </svg>
)

const RefreshIcon = (className?: string) => (
  <svg className={`icon${className ? ` ${className}` : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3.5 12a8.5 8.5 0 1 0 2.5-6" />
    <polyline points="3 4 6 7 9 4" />
  </svg>
)

const StopIcon = (
  <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <line x1="6" y1="6" x2="18" y2="18" />
    <line x1="18" y1="6" x2="6" y2="18" />
  </svg>
)

const BackIcon = (
  <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="14.5 6 8.5 12 14.5 18" />
  </svg>
)

const ForwardIcon = (
  <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="9.5 6 15.5 12 9.5 18" />
  </svg>
)

const CopyIcon = (
  <svg className="icon icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <rect x="9" y="9" width="11" height="11" rx="1.5" />
    <path d="M5 15V5.5A1.5 1.5 0 0 1 6.5 4H15" />
  </svg>
)

const CheckIcon = (
  <svg className="icon icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="5 12.5 10 17 19 7" />
  </svg>
)

const ExternalIcon = (
  <svg className="icon icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 5h5v5" />
    <line x1="19" y1="5" x2="11.5" y2="12.5" />
    <path d="M19 13.5V18a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 18V7a1.5 1.5 0 0 1 1.5-1.5H10.5" />
  </svg>
)

const RotateIcon = (
  <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M5 12a7 7 0 0 1 11.95-4.95L19 9" />
    <polyline points="19 4 19 9 14 9" />
    <path d="M19 12a7 7 0 0 1-11.95 4.95L5 15" />
    <polyline points="5 20 5 15 10 15" />
  </svg>
)

const ChevronIcon = (
  <svg className="icon icon-xs" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="6 9.5 12 15.5 18 9.5" />
  </svg>
)

function shortenForDisplay(input: string | null | undefined): string {
  if (!input) return ''
  try {
    const u = new URL(input)
    const path = u.pathname.replace(/\/$/, '')
    return path ? `${u.host}${path}${u.search}` : `${u.host}${u.search}`
  } catch {
    return input
  }
}

function formatPath(path: string): string {
  return path === '' ? '/' : path
}

export function Toolbar({
  device,
  rotated,
  inspecting,
  isReady,
  loading,
  canGoBack,
  canGoForward,
  url,
  currentPath,
  pages,
  onBack,
  onForward,
  onReload,
  onStop,
  onToggleInspect,
  onSetDevice,
  onToggleRotate,
  onCopyUrl,
  onOpenExternal,
  onNavigate,
  onSelectPage,
}: ToolbarProps) {
  const [refreshing, setRefreshing] = useState(false)
  const [copied, setCopied] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draftUrl, setDraftUrl] = useState('')
  const [pagesOpen, setPagesOpen] = useState(false)
  const [pageQuery, setPageQuery] = useState('')

  const refreshTimer = useRef<number | null>(null)
  const copyTimer = useRef<number | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const pagesRef = useRef<HTMLDivElement | null>(null)
  const pageSearchRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [editing])

  useEffect(() => {
    if (pagesOpen && pageSearchRef.current) {
      pageSearchRef.current.focus()
    }
    if (!pagesOpen) setPageQuery('')
  }, [pagesOpen])

  useEffect(() => {
    if (!pagesOpen) return
    const onDocDown = (e: MouseEvent) => {
      if (!pagesRef.current) return
      if (!pagesRef.current.contains(e.target as Node)) setPagesOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPagesOpen(false)
    }
    window.addEventListener('mousedown', onDocDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDocDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [pagesOpen])

  const handleReloadClick = (e: React.MouseEvent) => {
    if (!isReady) return
    if (loading) {
      onStop()
      return
    }
    setRefreshing(true)
    if (refreshTimer.current) window.clearTimeout(refreshTimer.current)
    refreshTimer.current = window.setTimeout(() => setRefreshing(false), 600)
    onReload(e.altKey || e.shiftKey)
  }

  const handleCopy = () => {
    onCopyUrl()
    setCopied(true)
    if (copyTimer.current) window.clearTimeout(copyTimer.current)
    copyTimer.current = window.setTimeout(() => setCopied(false), 1100)
  }

  const beginEdit = () => {
    if (!url) return
    setDraftUrl(url)
    setEditing(true)
  }

  const commitEdit = () => {
    setEditing(false)
    const next = draftUrl.trim()
    if (!next) return
    let normalized = next
    if (!/^https?:\/\//i.test(normalized) && !normalized.startsWith('about:')) {
      normalized = `http://${normalized}`
    }
    if (normalized !== url) onNavigate(normalized)
  }

  const cancelEdit = () => {
    setEditing(false)
    setDraftUrl('')
  }

  const allowsRotate = device !== 'desktop'

  const filteredPages = (() => {
    if (!pageQuery.trim()) return pages
    const q = pageQuery.trim().toLowerCase()
    return pages.filter(
      (p) => p.path.toLowerCase().includes(q) || (p.title || '').toLowerCase().includes(q),
    )
  })()

  const pickPage = (path: string) => {
    onSelectPage(path)
    setPagesOpen(false)
  }

  return (
    <div className="cm-toolbar" role="toolbar" aria-label="Code mode controls">
      <div className="cm-nav">
        <button
          type="button"
          className="cm-tool-btn"
          onClick={onBack}
          title="Back"
          disabled={!isReady || !canGoBack}
        >
          {BackIcon}
        </button>
        <button
          type="button"
          className="cm-tool-btn"
          onClick={onForward}
          title="Forward"
          disabled={!isReady || !canGoForward}
        >
          {ForwardIcon}
        </button>
        <button
          type="button"
          className={`cm-tool-btn${loading ? ' is-loading' : ''}`}
          onClick={handleReloadClick}
          title={loading ? 'Stop' : 'Reload (⌥ click for hard reload)'}
          disabled={!isReady}
        >
          {loading ? StopIcon : RefreshIcon(refreshing ? 'is-spinning' : undefined)}
        </button>
      </div>

      <div className={`cm-urlbar${editing ? ' is-editing' : ''}${!isReady ? ' is-disabled' : ''}`}>
        {editing ? (
          <input
            ref={inputRef}
            className="cm-urlbar-input"
            value={draftUrl}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setDraftUrl(e.target.value)}
            onBlur={commitEdit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                commitEdit()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                cancelEdit()
              }
            }}
          />
        ) : (
          <button
            type="button"
            className="cm-urlbar-display"
            onDoubleClick={beginEdit}
            onClick={beginEdit}
            title={url || 'No URL yet'}
            disabled={!url}
          >
            <span className="cm-urlbar-scheme" aria-hidden="true">
              {url?.startsWith('https') ? '🔒' : url ? '·' : ''}
            </span>
            <span className="cm-urlbar-text">{shortenForDisplay(url) || 'No URL'}</span>
          </button>
        )}

        <span className="cm-urlbar-actions">
          <button
            type="button"
            className="cm-urlbar-action"
            onClick={handleCopy}
            title={copied ? 'Copied' : 'Copy URL'}
            disabled={!url}
          >
            {copied ? CheckIcon : CopyIcon}
          </button>
          <button
            type="button"
            className="cm-urlbar-action"
            onClick={onOpenExternal}
            title="Open in browser"
            disabled={!url}
          >
            {ExternalIcon}
          </button>
        </span>
      </div>

      <div className="cm-pages-wrap" ref={pagesRef}>
        <button
          type="button"
          className={`cm-pages-btn${pagesOpen ? ' is-open' : ''}`}
          onClick={() => setPagesOpen((v) => !v)}
          title={`Pages — ${pages.length} discovered`}
          disabled={!isReady}
          aria-haspopup="listbox"
          aria-expanded={pagesOpen}
        >
          <span className="cm-pages-slash" aria-hidden="true">/</span>
          <span className="cm-pages-current">{formatPath(currentPath).replace(/^\//, '') || ''}</span>
          {pages.length > 0 && (
            <span className="cm-pages-count" aria-hidden="true">{pages.length}</span>
          )}
          <span className="cm-pages-chevron" aria-hidden="true">{ChevronIcon}</span>
        </button>

        {pagesOpen && (
          <div className="cm-pages-pop" role="listbox" aria-label="Available pages">
            <div className="cm-pages-search">
              <input
                ref={pageSearchRef}
                value={pageQuery}
                onChange={(e) => setPageQuery(e.target.value)}
                placeholder="Search pages…"
                spellCheck={false}
                autoComplete="off"
              />
            </div>
            <div className="cm-pages-list">
              {filteredPages.length === 0 ? (
                <div className="cm-pages-empty">
                  {pages.length === 0
                    ? 'No pages discovered yet — navigate inside the preview to populate this list.'
                    : 'No matches'}
                </div>
              ) : (
                filteredPages.map((p) => {
                  const isCurrent = p.path === currentPath
                  return (
                    <button
                      key={p.path}
                      type="button"
                      role="option"
                      aria-selected={isCurrent}
                      className={`cm-pages-row${isCurrent ? ' is-current' : ''}`}
                      onClick={() => pickPage(p.path)}
                    >
                      <span className="cm-pages-row-path">{formatPath(p.path)}</span>
                      {p.title && <span className="cm-pages-row-title">{p.title}</span>}
                      {p.visited && (
                        <span
                          className="cm-pages-row-dot"
                          title="Visited"
                          aria-hidden="true"
                        />
                      )}
                    </button>
                  )
                })
              )}
            </div>
          </div>
        )}
      </div>

      <button
        type="button"
        className={`cm-tool-btn${inspecting ? ' is-active' : ''}`}
        onClick={onToggleInspect}
        title={inspecting ? 'Close DevTools' : 'Inspect element'}
        aria-pressed={inspecting}
        disabled={!isReady}
      >
        {InspectArrowIcon}
      </button>

      <div className="cm-device" role="radiogroup" aria-label="Viewport size">
        {(Object.keys(DEVICE_META) as DeviceMode[]).map((mode) => {
          const isActive = device === mode
          return (
            <button
              key={mode}
              type="button"
              role="radio"
              aria-checked={isActive}
              className={`cm-device-btn${isActive ? ' is-active' : ''}`}
              onClick={() => onSetDevice(mode)}
              title={DEVICE_META[mode].title}
            >
              {DEVICE_META[mode].icon}
            </button>
          )
        })}
        <button
          type="button"
          className={`cm-device-btn cm-rotate-btn${rotated ? ' is-active' : ''}${!allowsRotate ? ' is-hidden' : ''}`}
          onClick={onToggleRotate}
          title={rotated ? 'Rotate to portrait' : 'Rotate to landscape'}
          disabled={!allowsRotate}
          aria-hidden={!allowsRotate}
        >
          {RotateIcon}
        </button>
      </div>
    </div>
  )
}
