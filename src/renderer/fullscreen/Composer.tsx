import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  ArrowUp, Microphone, Paperclip, Camera, X, Check, SpinnerGap, Code,
  Plus, HandPalm, CaretDown, CaretRight, FolderOpen, ShieldCheck, LockOpen, LockSimple,
} from '@phosphor-icons/react'
import type { Icon } from '@phosphor-icons/react'
import { useShallow } from 'zustand/react/shallow'
import { useSessionStore, EFFORT_LEVELS, getModelDisplayLabel, useSelectableModels } from '../stores/sessionStore'
import { LiveWaveform } from '../components/LiveWaveform'
import { useColors } from '../theme'
import { DEFAULT_MODEL_ID } from '../../shared/types'

const MAX_HEIGHT = 200

type VoiceState = 'idle' | 'recording' | 'transcribing'
type PermissionMode = 'ask' | 'auto' | 'bypass'

const PERMISSION_OPTIONS: Array<{ value: PermissionMode; label: string; description: string; Icon: Icon }> = [
  { value: 'ask',    label: 'Default permissions', description: 'Ask before each action',        Icon: HandPalm    },
  { value: 'auto',   label: 'Auto-review',         description: 'Auto-approve safe actions',     Icon: ShieldCheck },
  { value: 'bypass', label: 'Full access',         description: 'Bypass approvals (dangerous)',  Icon: LockOpen    },
]

function permissionLabel(mode: PermissionMode): string {
  return PERMISSION_OPTIONS.find((o) => o.value === mode)?.label || 'Default permissions'
}

function permissionIcon(mode: PermissionMode): Icon {
  return PERMISSION_OPTIONS.find((o) => o.value === mode)?.Icon || HandPalm
}

/**
 * Codex-style composer:
 *   ┌────────────────────────────────────────────┐
 *   │  Ask Claude Code anything…                 │
 *   │                                            │
 *   │  [+] [✋ permissions ▾]   [Model ▾] 🎤 ↑   │
 *   └────────────────────────────────────────────┘
 *   [📂 folder ▾]
 *
 * The "+" button opens a small attach menu; permission/model are inline
 * dropdowns; folder selector is a chip below the surface.
 */
export function Composer({ floating = false, onCodeModeToggle }: {
  floating?: boolean
  onCodeModeToggle?: () => void
}) {
  const colors = useColors()
  const taRef = useRef<HTMLTextAreaElement>(null)
  const chunksRef = useRef<Blob[]>([])
  const recorderRef = useRef<MediaRecorder | null>(null)
  const cancelledRef = useRef(false)

  const [text, setText] = useState('')
  const [voice, setVoice] = useState<VoiceState>('idle')
  const [audioStream, setAudioStream] = useState<MediaStream | null>(null)
  const [voiceError, setVoiceError] = useState<string | null>(null)
  const [openMenu, setOpenMenu] = useState<null | 'attach' | 'perm' | 'model' | 'folder'>(null)

  const sendMessage = useSessionStore((s) => s.sendMessage)
  const addAttachments = useSessionStore((s) => s.addAttachments)
  const removeAttachment = useSessionStore((s) => s.removeAttachment)
  const codeModeStatus = useSessionStore((s) => s.codeMode.status)
  const preferredModel = useSessionStore((s) => s.preferredModel)
  const selectableModels = useSelectableModels()
  const setPreferredModel = useSessionStore((s) => s.setPreferredModel)
  const preferredEffort = useSessionStore((s) => s.preferredEffort)
  const setPreferredEffort = useSessionStore((s) => s.setPreferredEffort)
  const permissionMode = useSessionStore((s) => s.permissionMode)
  const setPermissionMode = useSessionStore((s) => s.setPermissionMode)
  const setBaseDirectory = useSessionStore((s) => s.setBaseDirectory)

  // Slim tab selector: only the fields Composer actually renders.
  // Without this, the entire 584-LOC Composer re-renders on every text_chunk
  // because the full tab object has a new reference whenever messages change.
  const tabSlim = useSessionStore(useShallow((s) => {
    const t = s.tabs.find((x) => x.id === s.activeTabId)
    if (!t) return null
    return {
      id: t.id,
      status: t.status,
      attachments: t.attachments,
      permissionQLen: t.permissionQueue.length,
      hasChosenDirectory: t.hasChosenDirectory,
      workingDirectory: t.workingDirectory,
      claudeSessionId: t.claudeSessionId,
    }
  }))

  const attachments = tabSlim?.attachments || []
  const isConnecting = tabSlim?.status === 'connecting'
  const isRunning = tabSlim?.status === 'running'
  const isAwaitingPermission = (tabSlim?.permissionQLen ?? 0) > 0
  const isBusy = isConnecting || isRunning
  const hasContent = text.trim().length > 0 || attachments.length > 0
  const canSend = !!tabSlim && !isConnecting && !isAwaitingPermission && hasContent

  // Auto-resize textarea
  const autoResize = useCallback(() => {
    const el = taRef.current
    if (!el) return
    el.style.height = '24px'
    const h = Math.min(el.scrollHeight, MAX_HEIGHT)
    el.style.height = `${h}px`
    el.style.overflowY = el.scrollHeight > MAX_HEIGHT ? 'auto' : 'hidden'
  }, [])
  useLayoutEffect(() => { autoResize() }, [text, autoResize])

  useEffect(() => {
    taRef.current?.focus()
  }, [tabSlim?.id])

  // Close menu on outside click / escape
  useEffect(() => {
    if (!openMenu) return
    const onDoc = (e: MouseEvent) => {
      const tgt = e.target as HTMLElement
      if (!tgt.closest('.fs-codex-menu') && !tgt.closest('.fs-codex-trigger')) {
        setOpenMenu(null)
      }
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpenMenu(null) }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [openMenu])

  // ─── Send ───
  const handleSend = useCallback(() => {
    const prompt = text.trim()
    if (!prompt && attachments.length === 0) return
    if (isConnecting) return
    setText('')
    if (taRef.current) taRef.current.style.height = '24px'
    sendMessage(prompt || 'See attached files')
    requestAnimationFrame(() => taRef.current?.focus())
  }, [text, attachments.length, isConnecting, sendMessage])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  // ─── Paste image ───
  const handlePaste = useCallback(async (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items
    if (!items) return
    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/')) {
        e.preventDefault()
        const blob = item.getAsFile()
        if (!blob) return
        const reader = new FileReader()
        reader.onload = async () => {
          const dataUrl = reader.result as string
          const attachment = await window.rax.pasteImage(dataUrl)
          if (attachment) addAttachments([attachment])
        }
        reader.readAsDataURL(blob)
        return
      }
    }
  }, [addAttachments])

  // ─── Attach + screenshot ───
  const handleAttach = useCallback(async () => {
    setOpenMenu(null)
    const files = await window.rax.attachFiles()
    if (files && files.length > 0) addAttachments(files)
  }, [addAttachments])
  const handleScreenshot = useCallback(async () => {
    setOpenMenu(null)
    const result = await window.rax.takeScreenshot()
    if (result) addAttachments([result])
  }, [addAttachments])
  const handleCodeMode = useCallback(() => {
    setOpenMenu(null)
    onCodeModeToggle?.()
  }, [onCodeModeToggle])
  const handleChooseFolder = useCallback(async () => {
    setOpenMenu(null)
    const dir = await window.rax.selectDirectory()
    if (dir) setBaseDirectory(dir)
  }, [setBaseDirectory])

  // ─── Voice ───
  const stopRecording = useCallback(() => {
    cancelledRef.current = false
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop()
  }, [])
  const cancelRecording = useCallback(() => {
    cancelledRef.current = true
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop()
  }, [])
  const startRecording = useCallback(async () => {
    setVoiceError(null)
    chunksRef.current = []
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      setVoiceError('Microphone permission denied.')
      return
    }
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm'
    const recorder = new MediaRecorder(stream, { mimeType })
    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data) }
    recorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop())
      setAudioStream(null)
      if (cancelledRef.current) { cancelledRef.current = false; setVoice('idle'); return }
      if (chunksRef.current.length === 0) { setVoice('idle'); return }
      setVoice('transcribing')
      try {
        const blob = new Blob(chunksRef.current, { type: mimeType })
        const wav = await blobToWavBase64(blob)
        const result = await window.rax.transcribeAudio(wav)
        if (result.error) setVoiceError(result.error)
        else if (result.transcript) setText((prev) => (prev ? `${prev} ${result.transcript}` : result.transcript!))
      } catch (err: any) {
        setVoiceError(`Voice failed: ${err.message}`)
      } finally {
        setVoice('idle')
      }
    }
    recorder.onerror = () => {
      stream.getTracks().forEach((t) => t.stop())
      setAudioStream(null)
      setVoiceError('Recording failed.')
      setVoice('idle')
    }
    recorderRef.current = recorder
    setAudioStream(stream)
    setVoice('recording')
    recorder.start()
  }, [])
  const handleVoiceToggle = () => {
    if (voice === 'recording') stopRecording()
    else if (voice === 'idle') void startRecording()
  }

  const codeModeOn = codeModeStatus === 'ready'
  const codeModeBusy = codeModeStatus === 'starting' || codeModeStatus === 'detecting' || codeModeStatus === 'stopping'
  const modelId = preferredModel || DEFAULT_MODEL_ID
  const effortLabel = EFFORT_LEVELS.find((e) => e.id === preferredEffort)?.label
  const modelLabel = effortLabel
    ? `${getModelDisplayLabel(modelId)} · ${effortLabel}`
    : getModelDisplayLabel(modelId)
  const folderLabel = tabSlim?.hasChosenDirectory ? truncatePath(tabSlim.workingDirectory) : 'Choose folder'

  return (
    <div className={`fs-codex-shell${floating ? ' is-floating' : ''}`}>
      <div className="fs-codex-composer">
        {attachments.length > 0 && (
          <div className="fs-attach-row">
            {attachments.map((a) => (
              <div key={a.id} className="fs-attach-chip">
                {a.dataUrl ? (
                  <img src={a.dataUrl} alt="" />
                ) : (
                  <Paperclip size={12} />
                )}
                <span className="fs-attach-chip-name">{a.name}</span>
                <button
                  aria-label={`Remove ${a.name}`}
                  className="fs-attach-chip-x"
                  onClick={() => removeAttachment(a.id)}
                >
                  <X size={11} />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="fs-codex-text">
          {voice === 'recording' ? (
            <div style={{ flex: 1, minWidth: 0 }}>
              <LiveWaveform
                active
                stream={audioStream}
                height={32}
                barColor={colors.accent}
                mode="static"
                sensitivity={1.4}
              />
            </div>
          ) : (
            <textarea
              ref={taRef}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder={
                isAwaitingPermission ? 'Awaiting your approval above…'
                : isConnecting ? 'Initializing…'
                : voice === 'transcribing' ? 'Transcribing…'
                : isBusy ? 'Type to queue a message…'
                : 'Ask Rax anything. @ to mention files…'
              }
              rows={1}
            />
          )}
        </div>

        <div className="fs-codex-footer">
          {/* + attach menu */}
          <div className="fs-codex-pop">
            <button
              type="button"
              className="fs-codex-trigger fs-codex-icon"
              title="Attach"
              aria-haspopup="menu"
              aria-expanded={openMenu === 'attach'}
              onClick={() => setOpenMenu((m) => (m === 'attach' ? null : 'attach'))}
              disabled={isRunning}
            >
              <Plus size={16} weight="regular" />
            </button>
            {openMenu === 'attach' && (
              <div className="fs-codex-menu" role="menu">
                <button type="button" role="menuitem" className="fs-codex-menu-item" onClick={handleAttach}>
                  <Paperclip size={15} />
                  <span>Add photos &amp; files</span>
                </button>
                <button type="button" role="menuitem" className="fs-codex-menu-item" onClick={handleScreenshot}>
                  <Camera size={15} />
                  <span>Take screenshot</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="fs-codex-menu-item"
                  onClick={handleCodeMode}
                  disabled={codeModeBusy}
                >
                  <Code size={15} weight={codeModeOn ? 'fill' : 'regular'} />
                  <span>{codeModeOn ? 'Stop code mode' : 'Code mode preview'}</span>
                </button>
              </div>
            )}
          </div>

          {/* Permissions chip */}
          <div className="fs-codex-pop">
            {(() => {
              const TriggerIcon = permissionIcon(permissionMode)
              return (
                <button
                  type="button"
                  className="fs-codex-trigger fs-codex-chip"
                  aria-haspopup="menu"
                  aria-expanded={openMenu === 'perm'}
                  onClick={() => setOpenMenu((m) => (m === 'perm' ? null : 'perm'))}
                  title="Permissions"
                >
                  <TriggerIcon size={14} />
                  <span className="fs-codex-chip-label">{permissionLabel(permissionMode)}</span>
                  <CaretDown size={10} weight="bold" />
                </button>
              )
            })()}
            {openMenu === 'perm' && (
              <div className="fs-codex-menu" role="menu">
                {PERMISSION_OPTIONS.map((opt) => {
                  const OptIcon = opt.Icon
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      role="menuitemradio"
                      aria-checked={permissionMode === opt.value}
                      className={`fs-codex-menu-item${permissionMode === opt.value ? ' is-active' : ''}`}
                      onClick={() => { setPermissionMode(opt.value); setOpenMenu(null) }}
                    >
                      <OptIcon size={15} />
                      <span className="fs-codex-menu-label">{opt.label}</span>
                      {permissionMode === opt.value && <Check size={13} weight="bold" />}
                    </button>
                  )
                })}
              </div>
            )}
          </div>

          <div className="fs-codex-spacer" />

          {/* Model chip — flat, on the right */}
          <div className="fs-codex-pop">
            <button
              type="button"
              className="fs-codex-trigger fs-codex-chip is-flat"
              aria-haspopup="menu"
              aria-expanded={openMenu === 'model'}
              onClick={() => setOpenMenu((m) => (m === 'model' ? null : 'model'))}
              title="Model"
            >
              <span className="fs-codex-chip-label">{modelLabel}</span>
            </button>
            {openMenu === 'model' && (
              <div className="fs-codex-menu fs-codex-menu-end" role="menu">
                <div className="fs-codex-menu-heading">Model</div>
                {selectableModels.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={modelId === m.id}
                    aria-disabled={m.locked || undefined}
                    disabled={m.locked}
                    title={m.locked ? 'Top up Rax credits to unlock' : undefined}
                    className={`fs-codex-menu-item${modelId === m.id ? ' is-active' : ''}`}
                    style={m.locked ? { opacity: 0.45, cursor: 'not-allowed' } : undefined}
                    onClick={() => { if (m.locked) return; setPreferredModel(m.id); setOpenMenu(null) }}
                  >
                    <span className="fs-codex-menu-label">{getModelDisplayLabel(m.id)}</span>
                    {m.locked ? <LockSimple size={13} /> : modelId === m.id && <Check size={13} weight="bold" />}
                  </button>
                ))}
                <div className="fs-codex-menu-heading">Effort</div>
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={preferredEffort === null}
                  className={`fs-codex-menu-item${preferredEffort === null ? ' is-active' : ''}`}
                  onClick={() => { setPreferredEffort(null); setOpenMenu(null) }}
                >
                  <span className="fs-codex-menu-label">Default</span>
                  {preferredEffort === null && <Check size={13} weight="bold" />}
                </button>
                {EFFORT_LEVELS.map((e) => (
                  <button
                    key={e.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={preferredEffort === e.id}
                    className={`fs-codex-menu-item${preferredEffort === e.id ? ' is-active' : ''}`}
                    title={e.hint}
                    onClick={() => { setPreferredEffort(e.id); setOpenMenu(null) }}
                  >
                    <span className="fs-codex-menu-label">{e.label}</span>
                    {preferredEffort === e.id && <Check size={13} weight="bold" />}
                  </button>
                ))}
              </div>
            )}
          </div>

          {voice === 'recording' ? (
            <>
              <button
                className="fs-codex-icon"
                onClick={cancelRecording}
                title="Cancel recording"
              >
                <X size={15} />
              </button>
              <button
                className="fs-codex-send"
                onClick={stopRecording}
                title="Confirm recording"
                style={{ background: colors.accent, color: '#fff' }}
              >
                <Check size={15} />
              </button>
            </>
          ) : voice === 'transcribing' ? (
            <button className="fs-codex-icon" disabled title="Transcribing">
              <SpinnerGap size={16} className="fs-pulse" />
            </button>
          ) : (
            <>
              <button
                className="fs-codex-icon is-flat"
                onClick={handleVoiceToggle}
                disabled={isConnecting}
                title="Voice input"
              >
                <Microphone size={16} />
              </button>
              <button
                className={`fs-codex-send${canSend ? ' is-ready' : ''}`}
                onClick={handleSend}
                disabled={!canSend}
                title={isBusy ? 'Queue message' : 'Send (Enter)'}
              >
                <ArrowUp size={14} weight="bold" />
              </button>
            </>
          )}
        </div>

        {voiceError && (
          <div className="fs-codex-error">{voiceError}</div>
        )}
      </div>

      {/* Below-composer chip strip — folder selector */}
      <div className="fs-codex-belowstrip">
        <div className="fs-codex-pop">
          <button
            type="button"
            className="fs-codex-trigger fs-codex-belowchip"
            aria-haspopup="menu"
            aria-expanded={openMenu === 'folder'}
            onClick={() => setOpenMenu((m) => (m === 'folder' ? null : 'folder'))}
            title="Working folder"
          >
            <FolderOpen size={13} />
            <span>{folderLabel}</span>
            <CaretDown size={10} weight="bold" />
          </button>
          {openMenu === 'folder' && (
            <div className="fs-codex-menu fs-codex-menu-up" role="menu">
              <button type="button" role="menuitem" className="fs-codex-menu-item" onClick={handleChooseFolder}>
                <FolderOpen size={15} />
                <span className="fs-codex-menu-label">Choose folder…</span>
                <CaretRight size={11} />
              </button>
              {tabSlim?.hasChosenDirectory && (
                <div className="fs-codex-menu-current">
                  <span className="fs-codex-menu-current-label">Current</span>
                  <span className="fs-codex-menu-current-path" title={tabSlim.workingDirectory}>
                    {truncatePath(tabSlim.workingDirectory)}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function truncatePath(p: string): string {
  if (!p) return '~'
  const home = '/Users/'
  if (p.startsWith(home)) {
    const rest = p.slice(home.length)
    const slash = rest.indexOf('/')
    if (slash >= 0) return '~/' + rest.slice(slash + 1)
    return '~/' + rest
  }
  if (p.length <= 40) return p
  return '…' + p.slice(p.length - 39)
}

// ─── WebM blob → 16kHz mono WAV base64 ─── (mirrors InputBar) ───

async function blobToWavBase64(blob: Blob): Promise<string> {
  const arrayBuffer = await blob.arrayBuffer()
  const audioCtx = new AudioContext()
  const decoded = await audioCtx.decodeAudioData(arrayBuffer)
  audioCtx.close()
  const mono = mixToMono(decoded)
  const inputRms = rmsLevel(mono)
  if (inputRms < 0.003) {
    throw new Error('No voice detected. Speak closer to the mic.')
  }
  const resampled = resampleLinear(mono, decoded.sampleRate, 16000)
  const normalized = normalizePcm(resampled)
  const wav = encodeWav(normalized, 16000)
  return bufferToBase64(wav)
}
function mixToMono(buffer: AudioBuffer): Float32Array {
  const { numberOfChannels, length } = buffer
  if (numberOfChannels <= 1) return buffer.getChannelData(0)
  const mono = new Float32Array(length)
  for (let ch = 0; ch < numberOfChannels; ch++) {
    const channel = buffer.getChannelData(ch)
    for (let i = 0; i < length; i++) mono[i] += channel[i]
  }
  const inv = 1 / numberOfChannels
  for (let i = 0; i < length; i++) mono[i] *= inv
  return mono
}
function resampleLinear(input: Float32Array, inRate: number, outRate: number): Float32Array {
  if (inRate === outRate) return input
  const ratio = inRate / outRate
  const outLen = Math.max(1, Math.floor(input.length / ratio))
  const out = new Float32Array(outLen)
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio
    const i0 = Math.floor(pos)
    const i1 = Math.min(i0 + 1, input.length - 1)
    const t = pos - i0
    out[i] = input[i0] * (1 - t) + input[i1] * t
  }
  return out
}
function normalizePcm(samples: Float32Array): Float32Array {
  let peak = 0
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i])
    if (a > peak) peak = a
  }
  if (peak < 1e-4 || peak > 0.95) return samples
  const gain = Math.min(0.95 / peak, 8)
  const out = new Float32Array(samples.length)
  for (let i = 0; i < samples.length; i++) out[i] = samples[i] * gain
  return out
}
function rmsLevel(samples: Float32Array): number {
  if (samples.length === 0) return 0
  let s = 0
  for (let i = 0; i < samples.length; i++) s += samples[i] * samples[i]
  return Math.sqrt(s / samples.length)
}
function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const numSamples = samples.length
  const buf = new ArrayBuffer(44 + numSamples * 2)
  const view = new DataView(buf)
  writeString(view, 0, 'RIFF')
  view.setUint32(4, 36 + numSamples * 2, true)
  writeString(view, 8, 'WAVE')
  writeString(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeString(view, 36, 'data')
  view.setUint32(40, numSamples * 2, true)
  let offset = 44
  for (let i = 0; i < numSamples; i++) {
    const x = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(offset, x < 0 ? x * 0x8000 : x * 0x7FFF, true)
    offset += 2
  }
  return buf
}
function writeString(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i))
}
function bufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}
