import { useEffect, useMemo, useRef, useState } from 'react'
import type { UpdaterStatus } from '../../shared/types'

/**
 * Software Update window — the single surface for the whole update journey:
 *
 *   checking → up-to-date            ("You're up to date" + check again)
 *            → available             (release notes + Download / Later)
 *            → downloading           (live progress: %, MB, speed, ETA)
 *            → downloaded            (Restart & Install / Install on Quit)
 *            → error / unsupported   (inline explanation + retry)
 *
 * Status arrives over the UPDATER_STATUS broadcast; the window never polls.
 * If it opens with nothing in flight (tray "Check for Updates…") it kicks
 * off a user-initiated check itself.
 */

const ALLOWED_TAGS = new Set([
  'P', 'UL', 'OL', 'LI', 'STRONG', 'EM', 'B', 'I', 'CODE', 'PRE',
  'A', 'H1', 'H2', 'H3', 'H4', 'BR', 'DIV', 'SPAN', 'BLOCKQUOTE',
])

/** GitHub release bodies arrive as HTML (via electron-updater's feed) or as
 *  raw markdown. Strip everything but basic formatting either way. */
function sanitizeNotesHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  doc.body.querySelectorAll('script,style,iframe,object,embed,link,meta,img').forEach((el) => el.remove())
  // Unwrap disallowed elements (keep their children) until none remain.
  for (;;) {
    const bad = Array.from(doc.body.querySelectorAll('*')).find((el) => !ALLOWED_TAGS.has(el.tagName))
    if (!bad) break
    bad.replaceWith(...Array.from(bad.childNodes))
  }
  doc.body.querySelectorAll('*').forEach((el) => {
    for (const attr of Array.from(el.attributes)) {
      if (el.tagName === 'A' && attr.name === 'href' && /^https?:/i.test(attr.value)) continue
      el.removeAttribute(attr.name)
    }
  })
  return doc.body.innerHTML
}

/** Tiny markdown→HTML for release bodies that arrive as raw markdown
 *  (headings, bullets, bold, inline code). Output goes through the
 *  sanitizer anyway, so this can stay naive. */
function markdownToHtml(md: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const inline = (s: string) =>
    esc(s)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
  const lines = md.split(/\r?\n/)
  const out: string[] = []
  let inList = false
  for (const line of lines) {
    const bullet = line.match(/^\s*[-*]\s+(.*)$/)
    const heading = line.match(/^\s*(#{1,4})\s+(.*)$/)
    if (bullet) {
      if (!inList) { out.push('<ul>'); inList = true }
      out.push(`<li>${inline(bullet[1])}</li>`)
      continue
    }
    if (inList) { out.push('</ul>'); inList = false }
    if (heading) {
      out.push(`<h3>${inline(heading[2])}</h3>`)
    } else if (line.trim()) {
      out.push(`<p>${inline(line.trim())}</p>`)
    }
  }
  if (inList) out.push('</ul>')
  return out.join('')
}

function renderNotes(raw: string): string {
  const looksLikeHtml = /<\s*[a-z][\s\S]*>/i.test(raw)
  return sanitizeNotesHtml(looksLikeHtml ? raw : markdownToHtml(raw))
}

function formatMb(bytes?: number): string {
  if (!bytes || bytes <= 0) return '—'
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function formatSpeed(bytesPerSecond?: number): string {
  if (!bytesPerSecond || bytesPerSecond <= 0) return ''
  return `${(bytesPerSecond / 1024 / 1024).toFixed(1)} MB/s`
}

function formatEta(status: UpdaterStatus): string {
  const { total, transferred, bytesPerSecond } = status
  if (!total || !transferred || !bytesPerSecond || bytesPerSecond <= 0) return ''
  const secs = Math.max(0, Math.round((total - transferred) / bytesPerSecond))
  if (secs < 5) return 'almost done'
  if (secs < 90) return `about ${secs}s left`
  return `about ${Math.round(secs / 60)} min left`
}

export function UpdateApp() {
  const [status, setStatus] = useState<UpdaterStatus | null>(null)
  const autoChecked = useRef(false)

  useEffect(() => {
    let mounted = true
    window.rax.getUpdaterStatus().then((s) => {
      if (!mounted) return
      setStatus(s)
      // Opened with nothing in flight (tray / Settings "Check for
      // updates") → run the check ourselves so the window tells the
      // whole story from "Checking…" onwards.
      if (!autoChecked.current && (s.phase === 'idle' || s.phase === 'not-available' || s.phase === 'error')) {
        autoChecked.current = true
        window.rax.checkForUpdates({ userInitiated: true }).then((next) => {
          if (mounted) setStatus(next)
        }).catch(() => {})
      }
    }).catch(() => {})
    const unsub = window.rax.onUpdaterStatus((s: UpdaterStatus) => setStatus(s))
    return () => { mounted = false; unsub() }
  }, [])

  const phase = status?.phase ?? 'checking'
  const busy = phase === 'idle' || phase === 'checking' || !status

  const notesHtml = useMemo(
    () => (status?.releaseNotes ? renderNotes(status.releaseNotes) : ''),
    [status?.releaseNotes],
  )

  const checkAgain = () => {
    window.rax.checkForUpdates({ userInitiated: true }).then(setStatus).catch(() => {})
  }
  const download = () => {
    // electron-updater stays silent until the first progress event; flip to
    // the downloading view immediately so the click lands somewhere.
    setStatus((s) => (s ? { ...s, phase: 'downloading', downloadPercent: 0 } : s))
    window.rax.downloadUpdate().catch(() => {})
  }
  const install = () => { window.rax.installUpdate() }
  const close = () => { window.close() }
  const openRelease = () => {
    if (status?.releaseUrl) window.rax.openExternal(status.releaseUrl).catch(() => {})
  }

  // Links inside release notes open in the default browser (the window
  // itself denies navigation).
  const onNotesClick = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest('a')
    if (a?.href) {
      e.preventDefault()
      window.rax.openExternal(a.href).catch(() => {})
    }
  }

  const pct = Math.max(0, Math.min(100, status?.downloadPercent ?? 0))

  return (
    <div className={`rax-update-window phase-${busy ? 'checking' : phase}`}>
      <div className="upd-titlebar" />
      <div className="upd-body">

        <div className="upd-orb-wrap">
          {phase === 'downloading' && (
            <div
              className="upd-orb-progress-ring"
              style={{ background: `conic-gradient(var(--upd-ring, #1a2f8a) ${pct * 3.6}deg, var(--upd-ring-track, #e9edf5) 0deg)` }}
            />
          )}
          {busy && <div className="upd-orb-spinner-ring" />}
          <div className="upd-orb">
            {(phase === 'downloaded' || phase === 'not-available') && (
              <svg className="upd-orb-check" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path d="M5 12.5l4.2 4.2L19 7" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
            {(phase === 'error' || phase === 'unsupported') && <span className="upd-orb-mark">!</span>}
          </div>
        </div>

        {busy && (
          <>
            <div className="upd-eyebrow">Software Update</div>
            <h1 className="upd-title">Checking for updates…</h1>
            <p className="upd-sub">You're on Rax v{status?.currentVersion ?? '…'}. Hang tight — this only takes a moment.</p>
          </>
        )}

        {phase === 'not-available' && (
          <>
            <div className="upd-eyebrow">Software Update</div>
            <h1 className="upd-title">You're up to date</h1>
            <p className="upd-sub">Rax v{status?.currentVersion} is the latest version. We check again automatically every 6 hours.</p>
          </>
        )}

        {phase === 'available' && (
          <>
            <div className="upd-eyebrow">Update Available</div>
            <h1 className="upd-title">Rax v{status?.availableVersion} is here</h1>
            <div className="upd-version-chips">
              <span className="upd-chip">v{status?.currentVersion}</span>
              <span className="upd-chip-arrow">→</span>
              <span className="upd-chip upd-chip-new">v{status?.availableVersion}</span>
            </div>
            {notesHtml ? (
              <div className="upd-notes" onClick={onNotesClick} dangerouslySetInnerHTML={{ __html: notesHtml }} />
            ) : (
              <p className="upd-sub">A new version is ready to download. It installs in the background — no interruptions.</p>
            )}
            {status?.releaseUrl && (
              <button className="upd-link" onClick={openRelease}>View full release notes on GitHub ↗</button>
            )}
          </>
        )}

        {phase === 'downloading' && (
          <>
            <div className="upd-eyebrow">Downloading Update</div>
            <h1 className="upd-title">Rax v{status?.availableVersion}</h1>
            <div className="upd-progress">
              <div className="upd-progress-track">
                <div className="upd-progress-fill" style={{ width: `${pct}%` }} />
              </div>
              <div className="upd-stats">
                <span>{Math.round(pct)}%</span>
                <span>{formatMb(status?.transferred)} of {formatMb(status?.total)}</span>
                <span>{[formatSpeed(status?.bytesPerSecond), formatEta(status ?? ({} as UpdaterStatus))].filter(Boolean).join(' · ')}</span>
              </div>
            </div>
            <p className="upd-sub upd-sub-dim">You can close this window — the download continues in the background and we'll let you know when it's ready.</p>
          </>
        )}

        {phase === 'downloaded' && (
          <>
            <div className="upd-eyebrow">Ready to Install</div>
            <h1 className="upd-title">Rax v{status?.availableVersion} is ready</h1>
            <p className="upd-sub">Restart now to finish the update — it takes a few seconds and your in-progress sessions will be reloaded. Or keep working and it installs the next time you quit.</p>
          </>
        )}

        {phase === 'error' && (
          <>
            <div className="upd-eyebrow">Software Update</div>
            <h1 className="upd-title">Couldn't check for updates</h1>
            <p className="upd-sub">Something went wrong reaching the update server. Check your connection and try again.</p>
            {status?.error && <pre className="upd-error-detail">{status.error}</pre>}
          </>
        )}

        {phase === 'unsupported' && (
          <>
            <div className="upd-eyebrow">Software Update</div>
            <h1 className="upd-title">Auto-update unavailable</h1>
            <p className="upd-sub">{status?.error || 'Auto-update is not available in this build.'}</p>
          </>
        )}

        <div className="upd-actions">
          {phase === 'available' && (
            <>
              <button className="upd-btn upd-btn-primary" onClick={download}>Download Update</button>
              <button className="upd-btn upd-btn-ghost" onClick={close}>Later</button>
            </>
          )}
          {phase === 'downloaded' && (
            <>
              <button className="upd-btn upd-btn-primary" onClick={install}>Restart &amp; Install</button>
              <button className="upd-btn upd-btn-ghost" onClick={close}>Install on Quit</button>
            </>
          )}
          {phase === 'not-available' && (
            <button className="upd-btn upd-btn-ghost" onClick={checkAgain}>Check Again</button>
          )}
          {phase === 'error' && (
            <>
              <button className="upd-btn upd-btn-primary" onClick={checkAgain}>Try Again</button>
              <button className="upd-btn upd-btn-ghost" onClick={close}>Later</button>
            </>
          )}
          {phase === 'unsupported' && (
            <button className="upd-btn upd-btn-ghost" onClick={close}>Close</button>
          )}
        </div>

        <div className="upd-footnote">
          Rax checks for updates automatically and downloads them in the background.
        </div>
      </div>
    </div>
  )
}
