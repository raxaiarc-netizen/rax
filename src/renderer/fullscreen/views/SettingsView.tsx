import React, { useEffect, useState } from 'react'
import { Bell, Moon, Sun, Monitor as MonitorIcon, DownloadSimple, Robot, Lock, ClosedCaptioning, Cube, ArrowsClockwise, SignIn, SpeakerHigh, Rocket, Palette, Play, Gauge } from '@phosphor-icons/react'
import { useSessionStore, EFFORT_LEVELS, getModelDisplayLabel, useSelectableModels } from '../../stores/sessionStore'
import { useThemeStore } from '../../theme'
import { DEFAULT_MODEL_ID, isEffortLevel, type ClaudeInstanceInfo, type ClaudeLoginEvent, type UpdaterStatus } from '../../../shared/types'
import { KOKORO_VOICES } from '../../../shared/kokoro-voices'
import { MASCOT_COLORWAYS, getMascotColorway } from '../../../shared/mascot-colors'
import { RaxCloudSection } from '../../components/RaxCloudSection'

// Group voices into native <optgroup>s. American voices first because
// `af_heart` (the default) is American — keeps the current selection at
// the top of the list. Inside each group, voices are sorted by grade so
// the natural-sounding ones surface above the rougher ones.
const GRADE_ORDER: Record<string, number> = {
  'A+': 0, A: 1, 'A-': 2,
  'B+': 3, B: 4, 'B-': 5,
  'C+': 6, C: 7, 'C-': 8,
  'D+': 9, D: 10, 'D-': 11,
  'F+': 12, F: 13,
}

const VOICE_GROUPS = (() => {
  const byKey: Record<string, typeof KOKORO_VOICES[number][]> = {}
  for (const v of KOKORO_VOICES) {
    const langLabel = v.language === 'en-gb' ? 'British' : 'American'
    const key = `${langLabel} ${v.gender}`
    if (!byKey[key]) byKey[key] = []
    byKey[key].push(v)
  }
  // Order groups: American Female → American Male → British Female → British Male.
  const order = ['American Female', 'American Male', 'British Female', 'British Male']
  return order
    .filter((k) => byKey[k]?.length)
    .map((label) => ({
      label,
      voices: [...byKey[label]].sort(
        (a, b) => (GRADE_ORDER[a.overallGrade] ?? 99) - (GRADE_ORDER[b.overallGrade] ?? 99),
      ),
    }))
})()

export function SettingsView() {
  const themeMode = useThemeStore((s) => s.themeMode)
  const setThemeMode = useThemeStore((s) => s.setThemeMode)
  const soundEnabled = useThemeStore((s) => s.soundEnabled)
  const setSoundEnabled = useThemeStore((s) => s.setSoundEnabled)
  const voiceCaptionsEnabled = useThemeStore((s) => s.voiceCaptionsEnabled)
  const setVoiceCaptionsEnabled = useThemeStore((s) => s.setVoiceCaptionsEnabled)
  const voiceId = useThemeStore((s) => s.voiceId)
  const setVoiceId = useThemeStore((s) => s.setVoiceId)
  const mascotColorId = useThemeStore((s) => s.mascotColorId)
  const setMascotColorId = useThemeStore((s) => s.setMascotColorId)

  // Voice preview — plays a short sample in the selected voice without
  // changing the configured one; the button holds a "Playing…" state for
  // the sample's real duration (reported by main at playback start).
  const [voicePreviewing, setVoicePreviewing] = useState(false)
  const voicePreviewTimer = React.useRef(0)
  const handleVoicePreview = () => {
    window.clearTimeout(voicePreviewTimer.current)
    setVoicePreviewing(true)
    window.rax
      .previewOrbVoice(voiceId)
      .then((res) => {
        const ms =
          res?.ok && typeof res.durationMs === 'number' && res.durationMs > 0
            ? Math.min(res.durationMs + 250, 8000)
            : 2200
        voicePreviewTimer.current = window.setTimeout(() => setVoicePreviewing(false), ms)
      })
      .catch(() => setVoicePreviewing(false))
  }

  // On mount, ask the main process what voice it's currently using. If
  // the user (or a dev env override) set something different from
  // localStorage, the dropdown should reflect that truth instead of
  // silently disagreeing.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await window.rax?.getOrbVoice?.()
        if (cancelled || !res?.voice) return
        if (res.voice !== voiceId) setVoiceId(res.voice)
      } catch {}
    })()
    return () => { cancelled = true }
  // We only want to reconcile on mount — running this on every voiceId
  // change would create a re-sync feedback loop.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Same mount-time reconcile for the mascot colorway — main's JSON is the
  // on-disk truth; localStorage is just this window's cache of it.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await window.rax?.getOrbMascotColor?.()
        if (cancelled || !res?.color) return
        if (res.color !== mascotColorId) setMascotColorId(res.color)
      } catch {}
    })()
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const preferredModel = useSessionStore((s) => s.preferredModel)
  const selectableModels = useSelectableModels()
  const setPreferredModel = useSessionStore((s) => s.setPreferredModel)
  const preferredEffort = useSessionStore((s) => s.preferredEffort)
  const setPreferredEffort = useSessionStore((s) => s.setPreferredEffort)
  const permissionMode = useSessionStore((s) => s.permissionMode)
  const setPermissionMode = useSessionStore((s) => s.setPermissionMode)
  const staticInfo = useSessionStore((s) => s.staticInfo)

  const [exporting, setExporting] = useState(false)
  const [exportFlash, setExportFlash] = useState<string | null>(null)

  const [claudeInfo, setClaudeInfo] = useState<ClaudeInstanceInfo | null>(null)
  const [claudeBusy, setClaudeBusy] = useState(false)
  const [loginLog, setLoginLog] = useState<string[]>([])
  const [loginUrl, setLoginUrl] = useState<string | null>(null)
  const [loginActive, setLoginActive] = useState(false)

  const [updater, setUpdater] = useState<UpdaterStatus | null>(null)

  useEffect(() => {
    window.rax.getUpdaterStatus().then(setUpdater).catch(() => {})
    const unsub = window.rax.onUpdaterStatus((status: UpdaterStatus) => setUpdater(status))
    return unsub
  }, [])

  const handleCheckForUpdates = async () => {
    if (!updater) return
    // Anything beyond a fresh check happens in the dedicated Software
    // Update window — release notes, progress, the restart decision.
    if (updater.phase === 'available' || updater.phase === 'downloading' || updater.phase === 'downloaded') {
      window.rax.openUpdateWindow().catch(() => {})
      return
    }
    if (updater.phase === 'checking') return
    try {
      const next = await window.rax.checkForUpdates({ userInitiated: true })
      setUpdater(next)
    } catch {}
  }

  const updaterButtonLabel = (() => {
    if (!updater) return 'Check for updates'
    switch (updater.phase) {
      case 'checking': return 'Checking…'
      case 'available': return `Get v${updater.availableVersion}`
      case 'downloading': {
        const pct = Math.round(updater.downloadPercent ?? 0)
        return `Downloading ${pct}%…`
      }
      case 'downloaded': return `Install v${updater.availableVersion}`
      case 'unsupported': return 'Updates unavailable'
      case 'error': return 'Retry'
      default: return 'Check for updates'
    }
  })()

  const updaterHelp = (() => {
    if (!updater) return 'Loading…'
    switch (updater.phase) {
      case 'idle': return `You're on v${updater.currentVersion}.`
      case 'checking': return 'Reaching GitHub…'
      case 'not-available': return `v${updater.currentVersion} is the latest.`
      case 'available': return `v${updater.availableVersion} is available — click to see what's new.`
      case 'downloading': {
        const mb = updater.transferred ? (updater.transferred / 1024 / 1024).toFixed(1) : '?'
        const totalMb = updater.total ? (updater.total / 1024 / 1024).toFixed(1) : '?'
        return `Downloading v${updater.availableVersion} (${mb} / ${totalMb} MB)…`
      }
      case 'downloaded': return `v${updater.availableVersion} downloaded — click to restart and apply.`
      case 'error': return updater.error || 'Update check failed.'
      case 'unsupported': return updater.error || 'Auto-update is unavailable in this build.'
    }
  })()

  useEffect(() => {
    window.rax.getClaudeInstanceInfo().then(setClaudeInfo).catch(() => {})
    const unsub = window.rax.onClaudeModeChanged((next) => setClaudeInfo(next))
    return unsub
  }, [])

  useEffect(() => {
    const unsub = window.rax.onClaudeLoginEvent((event: ClaudeLoginEvent) => {
      if (event.kind === 'output') {
        setLoginLog((l) => {
          const next = [...l, event.text]
          return next.length > 60 ? next.slice(next.length - 60) : next
        })
      } else if (event.kind === 'url') {
        setLoginUrl(event.url)
        window.rax.openExternal(event.url).catch(() => {})
      } else if (event.kind === 'exit') {
        setLoginActive(false)
        setLoginLog((l) => [...l, `\n[Login process exited with code ${event.code}; signed in: ${event.signedIn}]`])
      } else if (event.kind === 'error') {
        setLoginActive(false)
        setLoginLog((l) => [...l, `\n[Error: ${event.message}]`])
      }
    })
    return unsub
  }, [])

  const handleSetClaudeMode = async (mode: 'bundled' | 'system') => {
    if (claudeBusy || mode === claudeInfo?.mode) return
    setClaudeBusy(true)
    try {
      const next = await window.rax.setClaudeMode(mode)
      setClaudeInfo(next)
    } finally {
      setClaudeBusy(false)
    }
  }

  const handleClaudeLogin = async () => {
    if (loginActive) return
    setLoginLog([])
    setLoginUrl(null)
    setLoginActive(true)
    const res = await window.rax.startClaudeLogin()
    if (!res.ok) {
      setLoginActive(false)
      setLoginLog([`[Could not start login: ${res.error ?? 'unknown error'}]`])
    }
  }

  const handleCancelClaudeLogin = async () => {
    await window.rax.cancelClaudeLogin()
    setLoginActive(false)
  }

  const handleExport = async () => {
    if (exporting) return
    const { tabs, activeTabId } = useSessionStore.getState()
    const tab = tabs.find((t) => t.id === activeTabId)
    if (!tab) return
    setExporting(true)
    setExportFlash(null)
    try {
      const res = await window.rax.exportTranscript({
        title: tab.title,
        workingDirectory: tab.workingDirectory,
        sessionModel: tab.sessionModel,
        claudeSessionId: tab.claudeSessionId,
        sessionVersion: tab.sessionVersion,
        messages: tab.messages,
        lastResult: tab.lastResult,
        exportedAt: Date.now(),
      })
      if (res.ok) setExportFlash('Saved')
      else if (res.canceled) setExportFlash(null)
      else setExportFlash(res.error ?? 'Failed')
    } catch (err) {
      setExportFlash(err instanceof Error ? err.message : 'Failed')
    } finally {
      setExporting(false)
      setTimeout(() => setExportFlash(null), 2000)
    }
  }

  return (
    <div className="fs-page">
      <div className="fs-page-header">
        <div>
          <div className="fs-page-title">Settings</div>
          <div className="fs-page-subtitle">Theme, defaults, and account.</div>
        </div>
      </div>

      <div className="fs-page-body">
        <div className="fs-settings-section">
          <div className="fs-settings-section-title">Appearance</div>
          <div className="fs-settings-section-desc">
            How the window looks across the desktop.
          </div>

          <div className="fs-settings-group">
            <div className="fs-settings-row">
              <Moon size={16} className="fs-settings-icon" />
              <div className="fs-settings-label">
                <div className="fs-settings-name">Theme</div>
                <div className="fs-settings-help">Light, dark, or follow the system.</div>
              </div>
              <div className="fs-segmented">
                {[
                  { id: 'system', label: 'System', icon: <MonitorIcon size={11} /> },
                  { id: 'light', label: 'Light', icon: <Sun size={11} /> },
                  { id: 'dark', label: 'Dark', icon: <Moon size={11} /> },
                ].map((opt) => (
                  <button
                    key={opt.id}
                    className={themeMode === opt.id ? 'is-active' : ''}
                    onClick={() => setThemeMode(opt.id as typeof themeMode)}
                  >
                    {opt.icon} {opt.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="fs-settings-row">
              <Bell size={16} className="fs-settings-icon" />
              <div className="fs-settings-label">
                <div className="fs-settings-name">Notification sound</div>
                <div className="fs-settings-help">Play a sound when a task completes while the window is hidden.</div>
              </div>
              <Toggle on={soundEnabled} onChange={setSoundEnabled} />
            </div>

            <div className="fs-settings-row">
              <ClosedCaptioning size={16} className="fs-settings-icon" />
              <div className="fs-settings-label">
                <div className="fs-settings-name">Voice captions</div>
                <div className="fs-settings-help">Show a glass caption pill below the orb during voice turns.</div>
              </div>
              <Toggle on={voiceCaptionsEnabled} onChange={setVoiceCaptionsEnabled} />
            </div>

            <div className="fs-settings-row">
              <SpeakerHigh size={16} className="fs-settings-icon" />
              <div className="fs-settings-label">
                <div className="fs-settings-name">Orb voice</div>
                <div className="fs-settings-help">
                  Which voice the orb uses to speak. All voices run on-device — no API calls.
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <button
                  type="button"
                  className="fs-button"
                  onClick={handleVoicePreview}
                  aria-label="Preview this voice"
                  title="Hear a sample of the selected voice"
                >
                  {voicePreviewing ? <SpeakerHigh size={12} weight="fill" /> : <Play size={12} weight="fill" />}{' '}
                  {voicePreviewing ? 'Playing…' : 'Play'}
                </button>
                <select
                  className="fs-select"
                  value={voiceId}
                  onChange={(e) => setVoiceId(e.target.value)}
                >
                  {VOICE_GROUPS.map((group) => (
                    <optgroup key={group.label} label={group.label}>
                      {group.voices.map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.name} · {v.overallGrade}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </div>
            </div>

            <div className="fs-settings-row">
              <Palette size={16} className="fs-settings-icon" />
              <div className="fs-settings-label">
                <div className="fs-settings-name">Mascot color</div>
                <div className="fs-settings-help">
                  The notch robot's visor. Skins borrow the agent crew's colors — wearing{' '}
                  <strong>{getMascotColorway(mascotColorId).name}</strong>,{' '}
                  {getMascotColorway(mascotColorId).tagline}.
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, flexShrink: 0 }} role="radiogroup" aria-label="Mascot color">
                {MASCOT_COLORWAYS.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    role="radio"
                    aria-checked={mascotColorId === c.id}
                    aria-label={`${c.name} — ${c.tagline}`}
                    title={`${c.name} — ${c.tagline}`}
                    onClick={() => setMascotColorId(c.id)}
                    style={{
                      width: 20,
                      height: 20,
                      padding: 0,
                      borderRadius: '50%',
                      border: 'none',
                      cursor: 'pointer',
                      background: `linear-gradient(135deg, ${c.visorLight}, ${c.visorDeep})`,
                      boxShadow: 'inset 0 0 0 1px rgba(0, 0, 0, 0.12)',
                      outline: mascotColorId === c.id ? `2px solid ${c.visorDeep}` : 'none',
                      outlineOffset: 2,
                      transform: mascotColorId === c.id ? 'scale(1.06)' : 'none',
                      transition: 'transform 0.15s ease',
                    }}
                  />
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className="fs-settings-section">
          <div className="fs-settings-section-title">Defaults</div>
          <div className="fs-settings-section-desc">
            Used as the starting state for every new chat.
          </div>

          <div className="fs-settings-group">
            <div className="fs-settings-row">
              <Robot size={16} className="fs-settings-icon" />
              <div className="fs-settings-label">
                <div className="fs-settings-name">Preferred model</div>
                <div className="fs-settings-help">Default for every new prompt.</div>
              </div>
              <select
                className="fs-select"
                value={preferredModel || DEFAULT_MODEL_ID}
                onChange={(e) => setPreferredModel(e.target.value)}
              >
                {selectableModels.map((m) => (
                  <option key={m.id} value={m.id} disabled={m.locked}>
                    {getModelDisplayLabel(m.id)}{m.locked ? ' — locked (top up to unlock)' : ''}
                  </option>
                ))}
              </select>
            </div>

            <div className="fs-settings-row">
              <Gauge size={16} className="fs-settings-icon" />
              <div className="fs-settings-label">
                <div className="fs-settings-name">Effort</div>
                <div className="fs-settings-help">
                  How hard Claude thinks per turn. Higher = smarter but slower and pricier.
                </div>
              </div>
              <select
                className="fs-select"
                value={preferredEffort || ''}
                onChange={(e) => setPreferredEffort(isEffortLevel(e.target.value) ? e.target.value : null)}
              >
                <option value="">Default</option>
                {EFFORT_LEVELS.map((lvl) => (
                  <option key={lvl.id} value={lvl.id}>{lvl.label} — {lvl.hint}</option>
                ))}
              </select>
            </div>

            <div className="fs-settings-row">
              <Lock size={16} className="fs-settings-icon" />
              <div className="fs-settings-label">
                <div className="fs-settings-name">Permission mode</div>
                <div className="fs-settings-help">
                  <strong>Ask</strong> shows an approval card. <strong>Auto</strong> auto-approves.
                  <strong> Bypass</strong> skips all permission checks (dangerous).
                </div>
              </div>
              <select
                className="fs-select"
                value={permissionMode}
                onChange={(e) => setPermissionMode(e.target.value as typeof permissionMode)}
              >
                <option value="ask">Ask</option>
                <option value="auto">Auto-approve</option>
                <option value="bypass">Bypass (dangerous)</option>
              </select>
            </div>
          </div>
        </div>

        <RaxCloudSection />

        <div className="fs-settings-section">
          <div className="fs-settings-section-title">Claude</div>
          <div className="fs-settings-section-desc">
            Pick which Claude runs every chat, fullscreen tab, and the voice orb.
            Rax ships its own — fully isolated history, memory, MCP, plugins, and login.
            Switch to your system <code>claude</code> to share state with your terminal install.
          </div>

          <div className="fs-settings-group">
            <div className="fs-settings-row">
              <Cube size={16} className="fs-settings-icon" />
              <div className="fs-settings-label">
                <div className="fs-settings-name">Active Claude</div>
                <div className="fs-settings-help">
                  {claudeInfo ? (
                    <>
                      <strong>{claudeInfo.label}</strong> · <code>{claudeInfo.homeDescription}</code>
                    </>
                  ) : (
                    'Loading…'
                  )}
                </div>
              </div>
              <div className="fs-segmented">
                {[
                  { id: 'bundled' as const, label: "Rax's" },
                  { id: 'system' as const, label: 'Default' },
                ].map((opt) => (
                  <button
                    key={opt.id}
                    className={claudeInfo?.mode === opt.id ? 'is-active' : ''}
                    onClick={() => handleSetClaudeMode(opt.id)}
                    disabled={claudeBusy}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="fs-settings-row">
              <div className="fs-settings-label">
                <div className="fs-settings-name">Version</div>
                <div className="fs-settings-help">
                  {claudeInfo?.version ? <code>{claudeInfo.version}</code> : '—'}
                </div>
              </div>
            </div>

            <div className="fs-settings-row">
              <div className="fs-settings-label">
                <div className="fs-settings-name">Sign-in</div>
                <div className="fs-settings-help">
                  {claudeInfo?.auth?.signedIn
                    ? claudeInfo.auth.email
                      ? `${claudeInfo.auth.email}${claudeInfo.auth.subscriptionType ? ` · ${claudeInfo.auth.subscriptionType}` : ''}`
                      : `Signed in${claudeInfo.auth.authMethod ? ` via ${claudeInfo.auth.authMethod}` : ''}`
                    : 'Not signed in'}
                </div>
              </div>
              <button
                className="fs-button"
                onClick={loginActive ? handleCancelClaudeLogin : handleClaudeLogin}
                disabled={claudeInfo ? !claudeInfo.available : true}
              >
                {loginActive ? 'Cancel' : <><SignIn size={12} /> {claudeInfo?.auth?.signedIn ? 'Re-sign in' : 'Sign in'}</>}
              </button>
            </div>

            {claudeInfo && !claudeInfo.available && (
              <div className="fs-settings-row">
                <div className="fs-settings-label">
                  <div className="fs-settings-name" style={{ color: 'var(--fs-warn, #c2410c)' }}>
                    Unavailable
                  </div>
                  <div className="fs-settings-help">
                    {claudeInfo.unavailableReason || 'Claude could not be located.'}
                  </div>
                </div>
                <button
                  className="fs-button"
                  onClick={() => window.rax.getClaudeInstanceInfo().then(setClaudeInfo)}
                >
                  <ArrowsClockwise size={12} /> Recheck
                </button>
              </div>
            )}

            {(loginActive || loginLog.length > 0) && (
              <div className="fs-settings-row" style={{ alignItems: 'flex-start' }}>
                <div className="fs-settings-label" style={{ width: '100%' }}>
                  <div className="fs-settings-name">Login output</div>
                  {loginUrl && (
                    <div className="fs-settings-help" style={{ marginBottom: 6 }}>
                      Opened in browser: <a href="#" onClick={(e) => { e.preventDefault(); window.rax.openExternal(loginUrl) }}>{loginUrl}</a>
                    </div>
                  )}
                  <pre style={{
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                    fontSize: 11,
                    background: 'var(--fs-surface, rgba(0,0,0,0.04))',
                    padding: 8,
                    borderRadius: 6,
                    whiteSpace: 'pre-wrap',
                    maxHeight: 200,
                    overflow: 'auto',
                    margin: 0,
                  }}>
                    {loginLog.join('') || (loginActive ? 'Starting…' : '')}
                  </pre>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="fs-settings-section">
          <div className="fs-settings-section-title">Account & app</div>
          <div className="fs-settings-section-desc">
            Identity and subscription for your default Claude install.
          </div>

          <div className="fs-settings-group">
            {staticInfo && (
              <>
                <div className="fs-settings-row">
                  <div className="fs-settings-label">
                    <div className="fs-settings-name">Email</div>
                    <div className="fs-settings-help">{staticInfo.email || 'Not signed in'}</div>
                  </div>
                </div>
                <div className="fs-settings-row">
                  <div className="fs-settings-label">
                    <div className="fs-settings-name">Subscription</div>
                    <div className="fs-settings-help">{staticInfo.subscriptionType || '—'}</div>
                  </div>
                </div>
              </>
            )}

            <div className="fs-settings-row">
              <DownloadSimple size={16} className="fs-settings-icon" />
              <div className="fs-settings-label">
                <div className="fs-settings-name">Export current chat</div>
                <div className="fs-settings-help">{exportFlash || 'Markdown (.md)'}</div>
              </div>
              <button
                className="fs-button"
                onClick={handleExport}
                disabled={exporting}
              >
                {exporting ? 'Exporting…' : 'Export'}
              </button>
            </div>
          </div>
        </div>

        <div className="fs-settings-section">
          <div className="fs-settings-section-title">About Rax</div>
          <div className="fs-settings-section-desc">
            Version and updates. New versions ship as signed builds via GitHub releases.
          </div>

          <div className="fs-settings-group">
            <div className="fs-settings-row">
              <Rocket size={16} className="fs-settings-icon" />
              <div className="fs-settings-label">
                <div className="fs-settings-name">Version</div>
                <div className="fs-settings-help">
                  v{updater?.currentVersion ?? '—'}
                </div>
              </div>
            </div>

            <div className="fs-settings-row">
              <ArrowsClockwise size={16} className="fs-settings-icon" />
              <div className="fs-settings-label">
                <div className="fs-settings-name">Auto-update</div>
                <div className="fs-settings-help">{updaterHelp}</div>
              </div>
              <button
                className="fs-button"
                onClick={handleCheckForUpdates}
                disabled={updater?.phase === 'unsupported' || updater?.phase === 'checking'}
              >
                {updaterButtonLabel}
              </button>
            </div>

            {updater?.releaseUrl && (updater.phase === 'available' || updater.phase === 'downloaded') && (
              <div className="fs-settings-row">
                <div className="fs-settings-label">
                  <div className="fs-settings-name">Release notes</div>
                  <div className="fs-settings-help">
                    <a
                      href="#"
                      onClick={(e) => {
                        e.preventDefault()
                        if (updater.releaseUrl) window.rax.openExternal(updater.releaseUrl).catch(() => {})
                      }}
                    >
                      View on GitHub
                    </a>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function Toggle({ on, onChange }: { on: boolean; onChange: (next: boolean) => void }) {
  return (
    <button
      type="button"
      className={`fs-toggle${on ? ' is-on' : ''}`}
      onClick={() => onChange(!on)}
      aria-pressed={on}
    >
      <span className="fs-toggle-dot" />
    </button>
  )
}
