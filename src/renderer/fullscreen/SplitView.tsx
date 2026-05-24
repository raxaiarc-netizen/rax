import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  ArrowClockwise, ArrowSquareOut, X, DeviceMobile, Monitor, DeviceTabletSpeaker, Bug, CaretLeft, CaretRight,
} from '@phosphor-icons/react'
import { Composer } from './Composer'
import { MessagesPane } from './MessagesPane'
import { useSessionStore } from '../stores/sessionStore'
import type { DeviceMode } from '../../shared/types'

type WebviewEl = HTMLElement & {
  reload?: () => void
  reloadIgnoringCache?: () => void
  goBack?: () => void
  goForward?: () => void
  canGoBack?: () => boolean
  canGoForward?: () => boolean
  loadURL?: (url: string) => Promise<void>
  getURL?: () => string
  getTitle?: () => string
  openDevTools?: () => void
  closeDevTools?: () => void
  isDevToolsOpened?: () => boolean
  addEventListener: (event: string, listener: (e: any) => void) => void
  removeEventListener: (event: string, listener: (e: any) => void) => void
  src: string
}

export function SplitView({ onCodeModeToggle }: { onCodeModeToggle: () => void }) {
  const codeMode = useSessionStore((s) => s.codeMode)
  const setCodeModeState = useSessionStore((s) => s.setCodeModeState)

  const wvRef = useRef<WebviewEl | null>(null)
  const [currentUrl, setCurrentUrl] = useState<string | null>(codeMode.url)
  const [loading, setLoading] = useState(false)
  const [canBack, setCanBack] = useState(false)
  const [canFwd, setCanFwd] = useState(false)
  const [device, setDevice] = useState<DeviceMode>(codeMode.device || 'desktop')

  const url = codeMode.url
  const projectLabel = codeMode.project?.label || 'Code Mode'

  // Sync device with backend
  useEffect(() => {
    setDevice(codeMode.device)
  }, [codeMode.device])

  useEffect(() => {
    setCurrentUrl(url)
  }, [url])

  // Webview event wiring
  useEffect(() => {
    const wv = wvRef.current
    if (!wv || !url) return

    const refreshNav = () => {
      try {
        setCanBack(!!wv.canGoBack?.())
        setCanFwd(!!wv.canGoForward?.())
      } catch {}
      try {
        const u = wv.getURL?.()
        if (u) setCurrentUrl(u)
      } catch {}
    }
    const onStart = () => setLoading(true)
    const onStop = () => { setLoading(false); refreshNav() }
    const onNav = (e: any) => {
      if (typeof e?.url === 'string') setCurrentUrl(e.url)
      refreshNav()
    }
    const onFail = (e: any) => {
      if (e?.errorCode === -3) return
      setLoading(false)
    }

    wv.addEventListener('did-start-loading', onStart)
    wv.addEventListener('did-stop-loading', onStop)
    wv.addEventListener('did-navigate', onNav)
    wv.addEventListener('did-navigate-in-page', onNav)
    wv.addEventListener('did-finish-load', refreshNav)
    wv.addEventListener('did-fail-load', onFail)
    return () => {
      wv.removeEventListener('did-start-loading', onStart)
      wv.removeEventListener('did-stop-loading', onStop)
      wv.removeEventListener('did-navigate', onNav)
      wv.removeEventListener('did-navigate-in-page', onNav)
      wv.removeEventListener('did-finish-load', refreshNav)
      wv.removeEventListener('did-fail-load', onFail)
    }
  }, [url])

  const handleReload = useCallback(() => {
    try { wvRef.current?.reload?.() } catch {}
  }, [])

  const handleBack = useCallback(() => {
    try { wvRef.current?.goBack?.() } catch {}
  }, [])
  const handleForward = useCallback(() => {
    try { wvRef.current?.goForward?.() } catch {}
  }, [])

  const handleOpenExternal = useCallback(() => {
    if (currentUrl) window.rax.openExternal(currentUrl).catch(() => {})
  }, [currentUrl])

  const handleSetDevice = useCallback(async (mode: DeviceMode) => {
    setDevice(mode)
    try {
      const next = await window.rax.setCodeModeDevice(mode)
      setCodeModeState(next)
    } catch {}
  }, [setCodeModeState])

  const handleInspect = useCallback(() => {
    const wv = wvRef.current
    if (!wv) return
    try {
      if (wv.isDevToolsOpened?.()) wv.closeDevTools?.()
      else wv.openDevTools?.()
    } catch {}
  }, [])

  return (
    <div className="fs-split">
      <div className="fs-split-pane-chat">
        <MessagesPane />
        <Composer onCodeModeToggle={onCodeModeToggle} />
      </div>
      <div className="fs-split-pane-preview">
        <div className="fs-preview-toolbar">
          <button className="fs-icon-btn" onClick={handleBack} disabled={!canBack} title="Back">
            <CaretLeft size={14} />
          </button>
          <button className="fs-icon-btn" onClick={handleForward} disabled={!canFwd} title="Forward">
            <CaretRight size={14} />
          </button>
          <button className="fs-icon-btn" onClick={handleReload} title="Reload">
            <ArrowClockwise size={14} className={loading ? 'fs-pulse' : ''} />
          </button>

          <div className="fs-preview-url" title={currentUrl || ''}>
            <span className="fs-preview-url-label">{projectLabel}</span>
            <span className="fs-preview-url-divider" aria-hidden />
            <span className="fs-preview-url-text">{currentUrl || url || 'Loading…'}</span>
          </div>

          <button
            className={`fs-icon-btn${device === 'desktop' ? ' is-on' : ''}`}
            title="Desktop"
            onClick={() => handleSetDevice('desktop')}
          >
            <Monitor size={14} />
          </button>
          <button
            className={`fs-icon-btn${device === 'tablet' ? ' is-on' : ''}`}
            title="Tablet"
            onClick={() => handleSetDevice('tablet')}
          >
            <DeviceTabletSpeaker size={14} />
          </button>
          <button
            className={`fs-icon-btn${device === 'mobile' ? ' is-on' : ''}`}
            title="Mobile"
            onClick={() => handleSetDevice('mobile')}
          >
            <DeviceMobile size={14} />
          </button>
          <button className="fs-icon-btn" onClick={handleInspect} title="Inspect">
            <Bug size={14} />
          </button>
          <button className="fs-icon-btn" onClick={handleOpenExternal} title="Open in browser">
            <ArrowSquareOut size={14} />
          </button>
          <button
            className="fs-icon-btn"
            onClick={onCodeModeToggle}
            title="Stop code mode preview"
            style={{ color: 'var(--fs-pastel-rose-fg)' }}
          >
            <X size={14} />
          </button>
        </div>

        <div className="fs-preview-stage">
          {url ? (
            <div className={`fs-preview-frame device-${device}`}>
              {React.createElement('webview', {
                ref: wvRef,
                src: url,
                partition: 'persist:rax-code-mode',
                allowpopups: 'true',
                webpreferences: 'contextIsolation=yes',
              })}
            </div>
          ) : (
            <div className="fs-preview-empty">Loading preview…</div>
          )}
        </div>
      </div>
    </div>
  )
}
