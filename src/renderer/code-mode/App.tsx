import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Toolbar } from './Toolbar'
import type { CodeModeState, DeviceMode } from '../../shared/types'

interface InitialFromUrl {
  url: string | null
  device: DeviceMode
}

function readInitialFromUrl(): InitialFromUrl {
  const params = new URLSearchParams(window.location.search)
  const url = params.get('url')
  const deviceRaw = params.get('device') as DeviceMode | null
  const device: DeviceMode =
    deviceRaw === 'mobile' || deviceRaw === 'tablet' || deviceRaw === 'desktop'
      ? deviceRaw
      : 'desktop'
  return { url, device }
}

type DotState = 'idle' | 'loading' | 'ready' | 'error'

type WebviewEl = HTMLElement & {
  reload?: () => void
  reloadIgnoringCache?: () => void
  stop?: () => void
  goBack?: () => void
  goForward?: () => void
  canGoBack?: () => boolean
  canGoForward?: () => boolean
  loadURL?: (url: string) => Promise<void>
  getURL?: () => string
  getTitle?: () => string
  executeJavaScript?: (code: string, userGesture?: boolean) => Promise<unknown>
  openDevTools?: () => void
  closeDevTools?: () => void
  isDevToolsOpened?: () => boolean
  getWebContentsId?: () => number
  addEventListener: (event: string, listener: (e: any) => void) => void
  removeEventListener: (event: string, listener: (e: any) => void) => void
  src: string
}

export interface PageEntry {
  path: string
  title?: string
  visited?: boolean
}

function getPathFromUrl(input: string | null | undefined): string | null {
  if (!input) return null
  try {
    const u = new URL(input)
    return (u.pathname || '/') + (u.search || '')
  } catch {
    return null
  }
}

function getOriginFromUrl(input: string | null | undefined): string | null {
  if (!input) return null
  try {
    return new URL(input).origin
  } catch {
    return null
  }
}

export default function App() {
  const initialUrlInfo = useMemo(readInitialFromUrl, [])

  const [state, setState] = useState<CodeModeState | null>(null)
  const [device, setDeviceLocal] = useState<DeviceMode>(initialUrlInfo.device)
  const [rotated, setRotated] = useState(false)
  const [inspecting, setInspecting] = useState(false)
  const [webviewReady, setWebviewReady] = useState(false)
  const [webviewError, setWebviewError] = useState<string | null>(null)

  const [currentUrl, setCurrentUrl] = useState<string | null>(null)
  const [pageTitle, setPageTitle] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [canGoBack, setCanGoBack] = useState(false)
  const [canGoForward, setCanGoForward] = useState(false)
  const [progress, setProgress] = useState(0)

  // path -> { title?, visited? }
  const [pages, setPages] = useState<Record<string, { title?: string; visited?: boolean }>>({})

  const webviewRef = useRef<WebviewEl | null>(null)
  const progressTimer = useRef<number | null>(null)

  useEffect(() => {
    let unsub: (() => void) | undefined
    window.codeMode.getInitialState().then((s) => {
      setState(s)
      setDeviceLocal(s.device)
      setInspecting(!!s.inspecting)
    }).catch(() => {})
    unsub = window.codeMode.onStatus((s) => {
      setState(s)
      setDeviceLocal(s.device)
      setInspecting(!!s.inspecting)
    })
    return () => {
      if (unsub) unsub()
    }
  }, [])

  const url = state?.url || initialUrlInfo.url
  const status = state?.status ?? 'starting'
  const showFrame = status === 'ready' && !!url && !webviewError

  const refreshNavState = useCallback(() => {
    const wv = webviewRef.current
    if (!wv) return
    try {
      setCanGoBack(!!wv.canGoBack?.())
      setCanGoForward(!!wv.canGoForward?.())
    } catch {}
    try {
      const u = wv.getURL?.()
      if (u) setCurrentUrl(u)
    } catch {}
  }, [])

  const recordVisit = useCallback((u: string | null | undefined, title?: string | null) => {
    const path = getPathFromUrl(u)
    if (!path) return
    setPages((prev) => {
      const existing = prev[path]
      const next = { ...existing, visited: true, ...(title ? { title } : {}) }
      if (existing && existing.visited && existing.title === next.title) return prev
      return { ...prev, [path]: next }
    })
  }, [])

  const discoverLinks = useCallback(async () => {
    const wv = webviewRef.current
    if (!wv?.executeJavaScript) return
    try {
      const result = (await wv.executeJavaScript(
        `(() => {
          try {
            const out = [];
            const seen = new Set();
            const origin = location.origin;
            const anchors = document.querySelectorAll('a[href]');
            for (const a of anchors) {
              const raw = a.getAttribute('href');
              if (!raw) continue;
              if (raw.startsWith('#') || raw.startsWith('javascript:') || raw.startsWith('mailto:') || raw.startsWith('tel:')) continue;
              try {
                const u = new URL(a.href);
                if (u.origin !== origin) continue;
                const path = (u.pathname || '/') + (u.search || '');
                if (seen.has(path)) continue;
                seen.add(path);
                const text = (a.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
                out.push({ path, text });
              } catch {}
            }
            return out;
          } catch (e) { return []; }
        })()`,
      )) as Array<{ path: string; text: string }> | null
      if (!Array.isArray(result)) return
      setPages((prev) => {
        let changed = false
        const next = { ...prev }
        for (const { path, text } of result) {
          const existing = next[path]
          if (!existing) {
            next[path] = { title: text || undefined }
            changed = true
          } else if (!existing.title && text) {
            next[path] = { ...existing, title: text }
            changed = true
          }
        }
        return changed ? next : prev
      })
    } catch {}
  }, [])

  useEffect(() => {
    if (!showFrame) return
    const webview = webviewRef.current
    if (!webview) return

    const markReady = () => {
      setWebviewReady(true)
      setWebviewError(null)
      try {
        const id = webview.getWebContentsId?.()
        if (typeof id === 'number') window.codeMode.registerWebview(id)
      } catch {}
      refreshNavState()
      try {
        recordVisit(webview.getURL?.(), webview.getTitle?.() || null)
      } catch {}
      void discoverLinks()
    }

    const onFailLoad = (e: any) => {
      if (e?.errorCode === -3) return
      setWebviewError(`${e?.errorDescription || 'Failed to load'} (${e?.errorCode ?? '?'})`)
    }

    const onDidNavigate = (e: any) => {
      setWebviewError(null)
      if (typeof e?.url === 'string') {
        setCurrentUrl(e.url)
        recordVisit(e.url)
      }
      refreshNavState()
    }
    const onDidNavigateInPage = (e: any) => {
      if (typeof e?.url === 'string') {
        setCurrentUrl(e.url)
        recordVisit(e.url)
      }
      refreshNavState()
      void discoverLinks()
    }
    const onTitle = (e: any) => {
      if (typeof e?.title === 'string') {
        setPageTitle(e.title)
        try {
          recordVisit(webview.getURL?.(), e.title)
        } catch {}
      }
    }
    const onStartLoading = () => {
      setLoading(true)
      setProgress(0.08)
      if (progressTimer.current) window.clearInterval(progressTimer.current)
      progressTimer.current = window.setInterval(() => {
        setProgress((p) => (p < 0.85 ? p + (0.9 - p) * 0.08 : p))
      }, 120)
    }
    const onStopLoading = () => {
      setLoading(false)
      setProgress(1)
      if (progressTimer.current) {
        window.clearInterval(progressTimer.current)
        progressTimer.current = null
      }
      window.setTimeout(() => setProgress(0), 320)
      refreshNavState()
      void discoverLinks()
    }

    webview.addEventListener('dom-ready', markReady)
    webview.addEventListener('did-finish-load', markReady)
    webview.addEventListener('did-fail-load', onFailLoad)
    webview.addEventListener('did-navigate', onDidNavigate)
    webview.addEventListener('did-navigate-in-page', onDidNavigateInPage)
    webview.addEventListener('page-title-updated', onTitle)
    webview.addEventListener('did-start-loading', onStartLoading)
    webview.addEventListener('did-stop-loading', onStopLoading)

    return () => {
      webview.removeEventListener('dom-ready', markReady)
      webview.removeEventListener('did-finish-load', markReady)
      webview.removeEventListener('did-fail-load', onFailLoad)
      webview.removeEventListener('did-navigate', onDidNavigate)
      webview.removeEventListener('did-navigate-in-page', onDidNavigateInPage)
      webview.removeEventListener('page-title-updated', onTitle)
      webview.removeEventListener('did-start-loading', onStartLoading)
      webview.removeEventListener('did-stop-loading', onStopLoading)
      if (progressTimer.current) {
        window.clearInterval(progressTimer.current)
        progressTimer.current = null
      }
    }
  }, [showFrame, url, refreshNavState, recordVisit, discoverLinks])

  const effectiveUrl = currentUrl || url || null
  const currentPath = getPathFromUrl(effectiveUrl) || '/'
  const origin = getOriginFromUrl(effectiveUrl) || getOriginFromUrl(url)

  const pageList: PageEntry[] = useMemo(() => {
    const entries = Object.entries(pages)
      .map<PageEntry>(([path, meta]) => ({ path, title: meta.title, visited: meta.visited }))
    entries.sort((a, b) => {
      if (a.path === '/' && b.path !== '/') return -1
      if (b.path === '/' && a.path !== '/') return 1
      const aSeg = a.path.split('/').filter(Boolean).length
      const bSeg = b.path.split('/').filter(Boolean).length
      if (aSeg !== bSeg) return aSeg - bSeg
      return a.path.localeCompare(b.path)
    })
    return entries
  }, [pages])

  const handleReload = (hard?: boolean) => {
    setWebviewError(null)
    try {
      if (hard) webviewRef.current?.reloadIgnoringCache?.()
      else webviewRef.current?.reload?.()
    } catch {}
    if (!hard) void window.codeMode.reload()
  }

  const handleStop = () => {
    try { webviewRef.current?.stop?.() } catch {}
  }

  const handleBack = () => {
    try { webviewRef.current?.goBack?.() } catch {}
  }

  const handleForward = () => {
    try { webviewRef.current?.goForward?.() } catch {}
  }

  const handleNavigate = (target: string) => {
    try { webviewRef.current?.loadURL?.(target).catch(() => {}) } catch {}
  }

  const handleSelectPage = (path: string) => {
    if (!origin) return
    const target = `${origin}${path.startsWith('/') ? path : `/${path}`}`
    handleNavigate(target)
  }

  const handleCopyUrl = () => {
    if (!effectiveUrl) return
    try {
      navigator.clipboard?.writeText(effectiveUrl).catch(() => {})
    } catch {}
  }

  const handleOpenExternal = () => {
    if (!effectiveUrl) return
    void window.codeMode.openExternal(effectiveUrl).catch(() => {})
  }

  const handleToggleInspect = async () => {
    const next = await window.codeMode.toggleInspect()
    setInspecting(!!next)
  }

  const handleSetDevice = async (mode: DeviceMode) => {
    setDeviceLocal(mode)
    if (mode === 'desktop') setRotated(false)
    await window.codeMode.setDevice(mode)
  }

  const handleToggleRotate = () => {
    if (device === 'desktop') return
    setRotated((r) => !r)
  }

  // Keyboard shortcuts: ⌘R reload, ⌘[/⌘] back/forward, ⌘L focus URL bar
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (!mod) return
      if (e.key === 'r' || e.key === 'R') {
        e.preventDefault()
        handleReload(e.shiftKey)
      } else if (e.key === '[') {
        e.preventDefault()
        handleBack()
      } else if (e.key === ']') {
        e.preventDefault()
        handleForward()
      } else if (e.key === 'l' || e.key === 'L') {
        e.preventDefault()
        const ev = new CustomEvent('cm-focus-url')
        window.dispatchEvent(ev)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const dotState: DotState = (() => {
    if (status === 'error') return 'error'
    if (status === 'detecting' || status === 'starting' || status === 'stopping') return 'loading'
    if (status === 'ready' && webviewError) return 'error'
    if (status === 'ready' && !webviewReady) return 'loading'
    if (status === 'ready' && loading) return 'loading'
    if (status === 'ready') return 'ready'
    return 'idle'
  })()

  const projectLabel = (() => {
    if (status === 'detecting') return 'Detecting'
    if (status === 'stopping') return 'Stopping'
    if (status === 'error') return 'Error'
    if (status === 'starting') return state?.project?.label || 'Starting'
    return state?.project?.label || 'Code Mode'
  })()

  const subStatus = (() => {
    if (status === 'error') return state?.error || 'Something went wrong'
    if (status === 'starting') return 'Booting dev server'
    if (status === 'detecting') return 'Inspecting working directory'
    if (status === 'ready' && webviewError) return webviewError
    if (status === 'ready' && !webviewReady) return 'Connecting'
    if (status === 'ready' && pageTitle) return pageTitle
    return ''
  })()

  const loadingLabel = (() => {
    if (status === 'detecting') return 'Detecting project'
    if (status === 'starting') {
      return state?.project?.label
        ? `Starting ${state.project.label}`
        : 'Starting dev server'
    }
    if (status === 'stopping') return 'Stopping'
    if (status === 'ready' && !webviewReady) return 'Connecting'
    return 'Initialising'
  })()

  const frameClass = (() => {
    const parts = [`cm-frame`, `device-${device}`]
    if (rotated && device !== 'desktop') parts.push('is-rotated')
    return parts.join(' ')
  })()

  return (
    <div className="cm-shell">
      <header className="cm-chrome">
        <div className="cm-chrome-spacer" aria-hidden="true" />

        <div className="cm-meta" title={subStatus || projectLabel}>
          <span className={`cm-dot is-${dotState}`} aria-hidden="true" />
          <span className="cm-meta-label">{projectLabel}</span>
          {subStatus && (
            <>
              <span className="cm-meta-sep" aria-hidden="true">·</span>
              <span className="cm-meta-text">{subStatus}</span>
            </>
          )}
        </div>

        <Toolbar
          device={device}
          rotated={rotated}
          inspecting={inspecting}
          isReady={showFrame && webviewReady}
          loading={loading}
          canGoBack={canGoBack}
          canGoForward={canGoForward}
          url={effectiveUrl}
          currentPath={currentPath}
          pages={pageList}
          onBack={handleBack}
          onForward={handleForward}
          onReload={handleReload}
          onStop={handleStop}
          onToggleInspect={handleToggleInspect}
          onSetDevice={handleSetDevice}
          onToggleRotate={handleToggleRotate}
          onCopyUrl={handleCopyUrl}
          onOpenExternal={handleOpenExternal}
          onNavigate={handleNavigate}
          onSelectPage={handleSelectPage}
        />

        <div
          className={`cm-progress${progress > 0 && progress < 1 ? ' is-active' : progress === 1 ? ' is-finishing' : ''}`}
          aria-hidden="true"
        >
          <span className="cm-progress-bar" style={{ transform: `scaleX(${progress})` }} />
        </div>
      </header>

      <main className="cm-stage">
        {showFrame ? (
          <div className={frameClass}>
            {React.createElement('webview', {
              ref: webviewRef,
              src: url!,
              partition: 'persist:rax-code-mode',
              allowpopups: 'true',
              webpreferences: 'contextIsolation=yes',
            })}
          </div>
        ) : status === 'error' ? (
          <div className="cm-error" role="alert">
            {state?.error || 'Code Mode could not start.'}
          </div>
        ) : (
          <div className="cm-loading">
            <span className="cm-loading-dot" />
            <span>{loadingLabel}</span>
          </div>
        )}
      </main>
    </div>
  )
}
