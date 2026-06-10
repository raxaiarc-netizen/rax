/**
 * RAX Design Tokens — Dual theme (dark + light)
 * Colors derived from ChatCN oklch system and design-fixed.html reference.
 */
import { create } from 'zustand'
import { DEFAULT_KOKORO_VOICE, isValidVoice } from '../shared/kokoro-voices'
import { DEFAULT_MASCOT_COLOR_ID, isValidMascotColor } from '../shared/mascot-colors'

// ─── Color palettes ───

const darkColors = {
  // Container (liquid-glass surfaces — opaque enough to read, backdrop-filter handles glass feel)
  containerBg: 'rgba(32, 32, 30, 0.88)',
  containerBgCollapsed: 'rgba(28, 28, 26, 0.92)',
  containerBorder: 'rgba(255, 255, 255, 0.14)',
  containerShadow: '0 22px 60px rgba(0, 0, 0, 0.65), 0 6px 18px rgba(0, 0, 0, 0.45), inset 0 1px 0 rgba(255, 255, 255, 0.10), inset 0 0 0 1px rgba(255, 255, 255, 0.04)',
  cardShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.10), inset 0 0 0 1px rgba(255, 255, 255, 0.04)',
  cardShadowCollapsed: 'inset 0 1px 0 rgba(255, 255, 255, 0.08), inset 0 0 0 1px rgba(255, 255, 255, 0.03)',

  // Surface layers (nested cards inside the glass container)
  surfacePrimary: 'rgba(255, 255, 255, 0.06)',
  surfaceSecondary: 'rgba(255, 255, 255, 0.10)',
  surfaceHover: 'rgba(255, 255, 255, 0.08)',
  surfaceActive: 'rgba(255, 255, 255, 0.12)',

  // Input
  inputBg: 'transparent',
  inputBorder: 'rgba(255, 255, 255, 0.10)',
  inputFocusBorder: 'rgba(217, 119, 87, 0.45)',
  inputPillBg: 'rgba(40, 40, 38, 0.85)',

  // Text
  textPrimary: '#e8e5dc',
  textSecondary: '#c0bdb2',
  textTertiary: '#85857c',
  textMuted: 'rgba(255, 255, 255, 0.18)',

  // Accent — orange
  accent: '#e88469',
  accentLight: 'rgba(217, 119, 87, 0.14)',
  accentSoft: 'rgba(217, 119, 87, 0.20)',

  // Status dots
  statusIdle: '#8a8a80',
  statusRunning: '#e88469',
  statusRunningBg: 'rgba(217, 119, 87, 0.14)',
  statusComplete: '#7aac8c',
  statusCompleteBg: 'rgba(122, 172, 140, 0.14)',
  statusError: '#d68272',
  statusErrorBg: 'rgba(196, 112, 96, 0.12)',
  statusDead: '#d68272',
  statusPermission: '#e88469',
  statusPermissionGlow: 'rgba(217, 119, 87, 0.5)',

  // Tab
  tabActive: 'rgba(255, 255, 255, 0.10)',
  tabActiveBorder: 'rgba(255, 255, 255, 0.14)',
  tabInactive: 'transparent',
  tabHover: 'rgba(255, 255, 255, 0.06)',

  // User message bubble
  userBubble: 'rgba(255, 255, 255, 0.06)',
  userBubbleBorder: 'rgba(255, 255, 255, 0.10)',
  userBubbleText: '#e8e5dc',

  // Tool card
  toolBg: 'rgba(255, 255, 255, 0.05)',
  toolBorder: 'rgba(255, 255, 255, 0.09)',
  toolRunningBorder: 'rgba(217, 119, 87, 0.35)',
  toolRunningBg: 'rgba(217, 119, 87, 0.08)',

  // Timeline
  timelineLine: 'rgba(255, 255, 255, 0.10)',
  timelineNode: 'rgba(217, 119, 87, 0.25)',
  timelineNodeActive: '#e88469',

  // Scrollbar
  scrollThumb: 'rgba(255, 255, 255, 0.18)',
  scrollThumbHover: 'rgba(255, 255, 255, 0.32)',

  // Stop button
  stopBg: '#ef4444',
  stopHover: '#dc2626',

  // Send button
  sendBg: '#d97757',
  sendHover: '#c96442',
  sendDisabled: 'rgba(217, 119, 87, 0.3)',

  // Popover (liquid glass)
  popoverBg: 'rgba(38, 38, 36, 0.92)',
  popoverBorder: 'rgba(255, 255, 255, 0.14)',
  popoverShadow: '0 22px 60px rgba(0, 0, 0, 0.60), 0 6px 18px rgba(0, 0, 0, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.10)',

  // Code block
  codeBg: 'rgba(0, 0, 0, 0.30)',

  // Mic button
  micBg: 'rgba(255, 255, 255, 0.06)',
  micColor: '#c0bdb2',
  micDisabled: 'rgba(255, 255, 255, 0.12)',

  // Placeholder
  placeholder: 'rgba(232, 229, 220, 0.42)',

  // Disabled button color
  btnDisabled: 'rgba(255, 255, 255, 0.18)',

  // Text on accent backgrounds
  textOnAccent: '#ffffff',

  // Button hover (CSS-only stack buttons)
  btnHoverColor: '#e8e5dc',
  btnHoverBg: 'rgba(255, 255, 255, 0.10)',

  // Accent border variants (replaces hex-alpha concatenation antipattern)
  accentBorder: 'rgba(217, 119, 87, 0.19)',
  accentBorderMedium: 'rgba(217, 119, 87, 0.25)',

  // Permission card (amber)
  permissionBorder: 'rgba(245, 158, 11, 0.3)',
  permissionShadow: '0 2px 12px rgba(245, 158, 11, 0.08)',
  permissionHeaderBg: 'rgba(245, 158, 11, 0.06)',
  permissionHeaderBorder: 'rgba(245, 158, 11, 0.12)',

  // Permission allow (green)
  permissionAllowBg: 'rgba(34, 197, 94, 0.1)',
  permissionAllowHoverBg: 'rgba(34, 197, 94, 0.22)',
  permissionAllowBorder: 'rgba(34, 197, 94, 0.25)',

  // Permission deny (red)
  permissionDenyBg: 'rgba(239, 68, 68, 0.08)',
  permissionDenyHoverBg: 'rgba(239, 68, 68, 0.18)',
  permissionDenyBorder: 'rgba(239, 68, 68, 0.22)',

  // Permission denied card
  permissionDeniedBorder: 'rgba(196, 112, 96, 0.3)',
  permissionDeniedHeaderBorder: 'rgba(196, 112, 96, 0.12)',

  // Diff (Edit tool inline diff)
  diffRemovedBg: 'rgba(248, 81, 73, 0.1)',
  diffAddedBg: 'rgba(63, 185, 80, 0.1)',

  // Voice orb tab — blue accent for the pinned voice conversation tab.
  // Sits alongside the normal (orange) accent system; only used when
  // rendering the orb tab itself.
  orbAccent: '#7aa7ff',
  orbAccentSoft: 'rgba(122, 167, 255, 0.22)',
  orbAccentLight: 'rgba(122, 167, 255, 0.14)',
  orbAccentBorder: 'rgba(122, 167, 255, 0.32)',
  orbAccentGlow: 'rgba(122, 167, 255, 0.55)',
  orbTabActive: 'rgba(122, 167, 255, 0.18)',
  orbTabActiveBorder: 'rgba(122, 167, 255, 0.38)',
  orbBubble: 'rgba(122, 167, 255, 0.18)',
  orbBubbleBorder: 'rgba(122, 167, 255, 0.34)',
  orbBubbleText: '#e8efff',
} as const

const lightColors = {
  // Container (liquid-glass surfaces — opaque enough to read, backdrop-filter handles glass feel)
  containerBg: 'rgba(248, 246, 240, 0.86)',
  containerBgCollapsed: 'rgba(244, 242, 236, 0.92)',
  containerBorder: 'rgba(255, 255, 255, 0.85)',
  containerShadow: '0 22px 60px rgba(20, 16, 8, 0.18), 0 6px 18px rgba(20, 16, 8, 0.10), inset 0 1px 0 rgba(255, 255, 255, 0.95), inset 0 0 0 1px rgba(255, 255, 255, 0.40)',
  cardShadow: '0 18px 50px rgba(20, 16, 8, 0.16), 0 4px 14px rgba(20, 16, 8, 0.09), inset 0 1px 0 rgba(255, 255, 255, 0.90), inset 0 0 0 1px rgba(255, 255, 255, 0.35)',
  cardShadowCollapsed: '0 14px 36px rgba(20, 16, 8, 0.18), 0 3px 10px rgba(20, 16, 8, 0.10), inset 0 1px 0 rgba(255, 255, 255, 0.85), inset 0 0 0 1px rgba(255, 255, 255, 0.30)',

  // Surface layers (nested cards inside the glass container)
  surfacePrimary: 'rgba(255, 255, 255, 0.65)',
  surfaceSecondary: 'rgba(255, 255, 255, 0.85)',
  surfaceHover: 'rgba(255, 255, 255, 0.75)',
  surfaceActive: 'rgba(255, 255, 255, 0.95)',

  // Input
  inputBg: 'transparent',
  inputBorder: 'rgba(0, 0, 0, 0.08)',
  inputFocusBorder: 'rgba(217, 119, 87, 0.45)',
  inputPillBg: 'rgba(255, 255, 255, 0.85)',

  // Text
  textPrimary: '#3c3929',
  textSecondary: '#5a5749',
  textTertiary: '#8a8a80',
  textMuted: 'rgba(60, 57, 41, 0.30)',

  // Accent — orange
  accent: '#d97757',
  accentLight: 'rgba(217, 119, 87, 0.14)',
  accentSoft: 'rgba(217, 119, 87, 0.22)',

  // Status dots
  statusIdle: '#8a8a80',
  statusRunning: '#d97757',
  statusRunningBg: 'rgba(217, 119, 87, 0.14)',
  statusComplete: '#5a9e6f',
  statusCompleteBg: 'rgba(90, 158, 111, 0.14)',
  statusError: '#c47060',
  statusErrorBg: 'rgba(196, 112, 96, 0.10)',
  statusDead: '#c47060',
  statusPermission: '#d97757',
  statusPermissionGlow: 'rgba(217, 119, 87, 0.35)',

  // Tab
  tabActive: 'rgba(255, 255, 255, 0.55)',
  tabActiveBorder: 'rgba(255, 255, 255, 0.85)',
  tabInactive: 'transparent',
  tabHover: 'rgba(255, 255, 255, 0.40)',

  // User message bubble
  userBubble: 'rgba(255, 255, 255, 0.45)',
  userBubbleBorder: 'rgba(255, 255, 255, 0.65)',
  userBubbleText: '#3c3929',

  // Tool card
  toolBg: 'rgba(255, 255, 255, 0.45)',
  toolBorder: 'rgba(0, 0, 0, 0.07)',
  toolRunningBorder: 'rgba(217, 119, 87, 0.35)',
  toolRunningBg: 'rgba(217, 119, 87, 0.08)',

  // Timeline
  timelineLine: 'rgba(0, 0, 0, 0.08)',
  timelineNode: 'rgba(217, 119, 87, 0.25)',
  timelineNodeActive: '#d97757',

  // Scrollbar
  scrollThumb: 'rgba(0, 0, 0, 0.12)',
  scrollThumbHover: 'rgba(0, 0, 0, 0.22)',

  // Stop button
  stopBg: '#ef4444',
  stopHover: '#dc2626',

  // Send button
  sendBg: '#d97757',
  sendHover: '#c96442',
  sendDisabled: 'rgba(217, 119, 87, 0.3)',

  // Popover (liquid glass)
  popoverBg: 'rgba(252, 250, 245, 0.92)',
  popoverBorder: 'rgba(255, 255, 255, 0.85)',
  popoverShadow: '0 22px 60px rgba(20, 16, 8, 0.20), 0 6px 18px rgba(20, 16, 8, 0.12), inset 0 1px 0 rgba(255, 255, 255, 0.95)',

  // Code block
  codeBg: 'rgba(0, 0, 0, 0.06)',

  // Mic button
  micBg: 'rgba(255, 255, 255, 0.45)',
  micColor: '#5a5749',
  micDisabled: 'rgba(60, 57, 41, 0.28)',

  // Placeholder
  placeholder: 'rgba(60, 57, 41, 0.42)',

  // Disabled button color
  btnDisabled: 'rgba(60, 57, 41, 0.28)',

  // Text on accent backgrounds
  textOnAccent: '#ffffff',

  // Button hover (CSS-only stack buttons)
  btnHoverColor: '#3c3929',
  btnHoverBg: 'rgba(255, 255, 255, 0.65)',

  // Accent border variants (replaces hex-alpha concatenation antipattern)
  accentBorder: 'rgba(217, 119, 87, 0.19)',
  accentBorderMedium: 'rgba(217, 119, 87, 0.25)',

  // Permission card (amber)
  permissionBorder: 'rgba(245, 158, 11, 0.3)',
  permissionShadow: '0 2px 12px rgba(245, 158, 11, 0.08)',
  permissionHeaderBg: 'rgba(245, 158, 11, 0.06)',
  permissionHeaderBorder: 'rgba(245, 158, 11, 0.12)',

  // Permission allow (green)
  permissionAllowBg: 'rgba(34, 197, 94, 0.1)',
  permissionAllowHoverBg: 'rgba(34, 197, 94, 0.22)',
  permissionAllowBorder: 'rgba(34, 197, 94, 0.25)',

  // Permission deny (red)
  permissionDenyBg: 'rgba(239, 68, 68, 0.08)',
  permissionDenyHoverBg: 'rgba(239, 68, 68, 0.18)',
  permissionDenyBorder: 'rgba(239, 68, 68, 0.22)',

  // Permission denied card
  permissionDeniedBorder: 'rgba(196, 112, 96, 0.3)',
  permissionDeniedHeaderBorder: 'rgba(196, 112, 96, 0.12)',

  // Diff (Edit tool inline diff)
  diffRemovedBg: 'rgba(248, 81, 73, 0.15)',
  diffAddedBg: 'rgba(63, 185, 80, 0.15)',

  // Voice orb tab — blue accent (light theme tuned for paper background)
  orbAccent: '#3b6fd6',
  orbAccentSoft: 'rgba(59, 111, 214, 0.16)',
  orbAccentLight: 'rgba(59, 111, 214, 0.10)',
  orbAccentBorder: 'rgba(59, 111, 214, 0.28)',
  orbAccentGlow: 'rgba(59, 111, 214, 0.35)',
  orbTabActive: 'rgba(59, 111, 214, 0.10)',
  orbTabActiveBorder: 'rgba(59, 111, 214, 0.30)',
  orbBubble: 'rgba(59, 111, 214, 0.10)',
  orbBubbleBorder: 'rgba(59, 111, 214, 0.28)',
  orbBubbleText: '#1f3a78',
} as const

export type ColorPalette = { [K in keyof typeof darkColors]: string }

// ─── Theme store ───

export type ThemeMode = 'system' | 'light' | 'dark'

interface ThemeState {
  isDark: boolean
  themeMode: ThemeMode
  soundEnabled: boolean
  expandedUI: boolean
  /** Show a glass caption pill below the orb during voice turns. */
  voiceCaptionsEnabled: boolean
  /** Kokoro voice id the orb uses for TTS. Persisted alongside the other
   *  settings; main process gets a copy via `setOrbVoice` IPC. */
  voiceId: string
  /** Mascot visor colorway (shared/mascot-colors.ts). Persisted alongside
   *  the other settings; main owns the on-disk truth via `setOrbMascotColor`
   *  IPC and pushes it to the orb window. */
  mascotColorId: string
  /** OS-reported dark mode — used when themeMode is 'system' */
  _systemIsDark: boolean
  setIsDark: (isDark: boolean) => void
  setThemeMode: (mode: ThemeMode) => void
  setSoundEnabled: (enabled: boolean) => void
  setExpandedUI: (expanded: boolean) => void
  setVoiceCaptionsEnabled: (enabled: boolean) => void
  setVoiceId: (id: string) => void
  setMascotColorId: (id: string) => void
  /** Called by OS theme change listener — updates system value */
  setSystemTheme: (isDark: boolean) => void
}

/** Convert camelCase token name to --rax-kebab-case CSS custom property */
function camelToKebab(s: string): string {
  return s.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)
}

/** Sync all JS design tokens to CSS custom properties on :root */
function syncTokensToCss(tokens: ColorPalette): void {
  const style = document.documentElement.style
  for (const [key, value] of Object.entries(tokens)) {
    style.setProperty(`--rax-${camelToKebab(key)}`, value)
  }
}

function applyTheme(isDark: boolean): void {
  document.documentElement.classList.toggle('dark', isDark)
  document.documentElement.classList.toggle('light', !isDark)
  syncTokensToCss(isDark ? darkColors : lightColors)
}

const RAX_SETTINGS_KEY = 'rax-settings'

interface PersistedSettings {
  themeMode: ThemeMode
  soundEnabled: boolean
  expandedUI: boolean
  voiceCaptionsEnabled: boolean
  voiceId: string
  mascotColorId: string
}

// Default voice id, kept as single-source-of-truth in shared/.
const DEFAULT_VOICE_ID = DEFAULT_KOKORO_VOICE

function loadSettings(): PersistedSettings {
  try {
    const raw = localStorage.getItem(RAX_SETTINGS_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      return {
        themeMode: ['light', 'dark'].includes(parsed.themeMode) ? parsed.themeMode : 'dark',
        soundEnabled: typeof parsed.soundEnabled === 'boolean' ? parsed.soundEnabled : true,
        expandedUI: typeof parsed.expandedUI === 'boolean' ? parsed.expandedUI : false,
        voiceCaptionsEnabled:
          typeof parsed.voiceCaptionsEnabled === 'boolean' ? parsed.voiceCaptionsEnabled : true,
        voiceId: typeof parsed.voiceId === 'string' ? parsed.voiceId : DEFAULT_VOICE_ID,
        mascotColorId: isValidMascotColor(parsed.mascotColorId)
          ? parsed.mascotColorId
          : DEFAULT_MASCOT_COLOR_ID,
      }
    }
  } catch {}
  return {
    themeMode: 'dark',
    soundEnabled: true,
    expandedUI: false,
    voiceCaptionsEnabled: true,
    voiceId: DEFAULT_VOICE_ID,
    mascotColorId: DEFAULT_MASCOT_COLOR_ID,
  }
}

function saveSettings(s: PersistedSettings): void {
  try { localStorage.setItem(RAX_SETTINGS_KEY, JSON.stringify(s)) } catch {}
}

// Always start in compact UI mode on launch.
const saved = { ...loadSettings(), expandedUI: false }

function persistFromState(s: ThemeState): void {
  saveSettings({
    themeMode: s.themeMode,
    soundEnabled: s.soundEnabled,
    expandedUI: s.expandedUI,
    voiceCaptionsEnabled: s.voiceCaptionsEnabled,
    voiceId: s.voiceId,
    mascotColorId: s.mascotColorId,
  })
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  isDark: saved.themeMode === 'dark' ? true : saved.themeMode === 'light' ? false : true,
  themeMode: saved.themeMode,
  soundEnabled: saved.soundEnabled,
  expandedUI: saved.expandedUI,
  voiceCaptionsEnabled: saved.voiceCaptionsEnabled,
  voiceId: saved.voiceId,
  mascotColorId: saved.mascotColorId,
  _systemIsDark: true,
  setIsDark: (isDark) => {
    set({ isDark })
    applyTheme(isDark)
  },
  setThemeMode: (mode) => {
    const resolved = mode === 'system' ? get()._systemIsDark : mode === 'dark'
    set({ themeMode: mode, isDark: resolved })
    applyTheme(resolved)
    persistFromState(get())
  },
  setSoundEnabled: (enabled) => {
    set({ soundEnabled: enabled })
    persistFromState(get())
  },
  setExpandedUI: (expanded) => {
    set({ expandedUI: expanded })
    persistFromState(get())
  },
  setVoiceCaptionsEnabled: (enabled) => {
    set({ voiceCaptionsEnabled: enabled })
    persistFromState(get())
  },
  setVoiceId: (id) => {
    // Defense-in-depth: refuse ids that aren't in the catalog. The
    // dropdown only renders known options, so this only triggers from a
    // hand-edited localStorage or a future renderer/main catalog drift.
    if (!isValidVoice(id)) {
      // eslint-disable-next-line no-console
      console.warn(`[rax] refusing unknown voice id: ${id}`)
      return
    }
    // Optimistically apply for instant UI feedback — the <select> stays
    // visually responsive while the IPC round-trips. Persistence happens
    // after main confirms; on failure we roll the in-memory state back
    // (and skip writing to localStorage) so a flaky disk doesn't leave
    // localStorage and the main-process file disagreeing forever.
    const prev = get().voiceId
    set({ voiceId: id })
    const api = (window as any).rax
    if (!api?.setOrbVoice) {
      // Pre-IPC boot path — accept the local set and persist; main will
      // pick it up via getOrbVoice on next mount.
      persistFromState(get())
      return
    }
    void (async () => {
      try {
        const res = await api.setOrbVoice(id)
        if (res?.ok) {
          persistFromState(get())
        } else {
          // Main rejected (unknown id) OR persistence failed. Roll the
          // visible state back so the user sees the truth instead of
          // a phantom selection that won't survive relaunch.
          if (res?.voice && typeof res.voice === 'string') {
            set({ voiceId: res.voice })
          } else {
            set({ voiceId: prev })
          }
          // Don't persist — keep localStorage matching whatever main
          // actually has on disk.
          // eslint-disable-next-line no-console
          console.warn(`[rax] voice change rejected: ${res?.error ?? 'unknown'}`)
        }
      } catch (err) {
        // IPC failure (e.g. main process dead) — roll back the local set.
        set({ voiceId: prev })
        // eslint-disable-next-line no-console
        console.warn(`[rax] voice IPC failed:`, err)
      }
    })()
  },
  setMascotColorId: (id) => {
    // Same contract as setVoiceId: validate, apply optimistically for
    // instant swatch feedback, persist only after main confirms, roll back
    // on rejection/IPC failure so localStorage never disagrees with the
    // main-process file.
    if (!isValidMascotColor(id)) {
      // eslint-disable-next-line no-console
      console.warn(`[rax] refusing unknown mascot color: ${id}`)
      return
    }
    const prev = get().mascotColorId
    set({ mascotColorId: id })
    const api = (window as any).rax
    if (!api?.setOrbMascotColor) {
      persistFromState(get())
      return
    }
    void (async () => {
      try {
        const res = await api.setOrbMascotColor(id)
        if (res?.ok) {
          persistFromState(get())
        } else {
          if (res?.color && typeof res.color === 'string' && isValidMascotColor(res.color)) {
            set({ mascotColorId: res.color })
          } else {
            set({ mascotColorId: prev })
          }
          // eslint-disable-next-line no-console
          console.warn(`[rax] mascot color change rejected: ${res?.error ?? 'unknown'}`)
        }
      } catch (err) {
        set({ mascotColorId: prev })
        // eslint-disable-next-line no-console
        console.warn(`[rax] mascot color IPC failed:`, err)
      }
    })()
  },
  setSystemTheme: (isDark) => {
    set({ _systemIsDark: isDark })
    // Only apply if following system
    if (get().themeMode === 'system') {
      set({ isDark })
      applyTheme(isDark)
    }
  },
}))

// Initialize CSS vars with saved theme
syncTokensToCss(saved.themeMode === 'light' ? lightColors : darkColors)

/** Reactive hook — returns the active color palette */
export function useColors(): ColorPalette {
  const isDark = useThemeStore((s) => s.isDark)
  return isDark ? darkColors : lightColors
}

/** Non-reactive getter — use outside React components */
export function getColors(isDark: boolean): ColorPalette {
  return isDark ? darkColors : lightColors
}

// ─── Backward compatibility ───
// Legacy static export — components being migrated should use useColors() instead
export const colors = darkColors

// ─── Spacing ───

export const spacing = {
  contentWidth: 460,
  containerRadius: 20,
  containerPadding: 12,
  tabHeight: 32,
  inputMinHeight: 44,
  inputMaxHeight: 160,
  conversationMaxHeight: 380,
  pillRadius: 9999,
  circleSize: 36,
  circleGap: 8,
} as const

// ─── Animation ───

export const motion = {
  spring: { type: 'spring' as const, stiffness: 500, damping: 30 },
  easeOut: { duration: 0.2, ease: [0.25, 0.46, 0.45, 0.94] as const },
  fadeIn: {
    initial: { opacity: 0, y: 8 },
    animate: { opacity: 1, y: 0 },
    exit: { opacity: 0, y: -4 },
    transition: { duration: 0.15 },
  },
} as const
