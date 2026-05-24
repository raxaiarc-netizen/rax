import { systemPreferences, dialog, shell, BrowserWindow, nativeImage } from 'electron'
import { join } from 'path'
import { log as _log } from './logger'

function log(msg: string): void {
  _log('Permissions', msg)
}

/**
 * macOS-only permission helpers. Every Rax keyboard shortcut
 * (Cmd+Shift+O to summon the orb, Option+R hold-to-speak, etc.) goes
 * through Electron's `globalShortcut.register` which calls Carbon's
 * `RegisterEventHotKey` under the hood. The register call returns true
 * even when macOS will refuse to actually deliver events to the app —
 * silently dropping every keypress until the user adds Rax to
 * System Settings → Privacy & Security → Accessibility.
 *
 * For the dev binary (`Electron.app` at the repo's
 * `node_modules/electron/...` path) most developers already granted this
 * once. For the signed DMG-installed binary at `/Applications/Rax.app`
 * it's a fresh identity and starts ungranted. Without the prompt below,
 * a brand-new user's first keypress just does nothing.
 *
 * The fix is to call `isTrustedAccessibilityClient(true)` once during
 * boot — that explicitly tells macOS "this app needs Accessibility",
 * which causes macOS to:
 *   (a) add the app to the Accessibility list in Privacy & Security,
 *   (b) surface the system's own "X wants to use accessibility
 *       features" notification.
 *
 * On top of that we render our own Electron dialog with a clearer
 * explanation + a deeplink button to the right pane, because the
 * native prompt is easy to miss / dismiss.
 */

const PRIVACY_PANE_PREFIX = 'x-apple.systempreferences:com.apple.preference.security?Privacy_'

type PrivacyPane =
  | 'Accessibility'
  | 'InputMonitoring'
  | 'Microphone'
  | 'ScreenCapture'
  | 'AppleEvents'

export type PermissionKey = 'accessibility' | 'microphone' | 'screen'

export interface PermissionState {
  accessibility: boolean
  microphone: 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown'
  screen: 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown'
}

/** Open System Settings → Privacy & Security at a specific pane. The
 *  shell handler intercepts `x-apple.systempreferences:` URLs natively;
 *  no AppleScript hop. Best-effort: macOS may ignore the deeplink on
 *  some versions and just open the top-level Security pane. */
export function openPrivacyPane(pane: PrivacyPane): void {
  if (process.platform !== 'darwin') return
  const url = `${PRIVACY_PANE_PREFIX}${pane}`
  shell.openExternal(url).catch((err) => log(`openPrivacyPane(${pane}) failed: ${err.message}`))
}

/** Synchronous check — does NOT trigger any system prompt. */
export function isAccessibilityGranted(): boolean {
  if (process.platform !== 'darwin') return true
  return systemPreferences.isTrustedAccessibilityClient(false)
}

/** Trigger macOS's "add to Accessibility list" path. Calling this with
 *  `true` is the official way to ask macOS to surface the system prompt
 *  the first time. Safe to call on every launch; macOS keeps the user's
 *  decision and won't re-prompt once granted. */
function promptAccessibility(): boolean {
  if (process.platform !== 'darwin') return true
  return systemPreferences.isTrustedAccessibilityClient(true)
}

/** Snapshot of all permissions Rax cares about. Used by the
 *  Settings UI / tray menu to show a checklist. */
export function getPermissionState(): PermissionState {
  if (process.platform !== 'darwin') {
    return { accessibility: true, microphone: 'granted', screen: 'granted' }
  }
  let microphone: PermissionState['microphone'] = 'unknown'
  let screen: PermissionState['screen'] = 'unknown'
  try { microphone = systemPreferences.getMediaAccessStatus('microphone') as PermissionState['microphone'] } catch {}
  try { screen = systemPreferences.getMediaAccessStatus('screen') as PermissionState['screen'] } catch {}
  return { accessibility: isAccessibilityGranted(), microphone, screen }
}

let firstLaunchPromptShown = false

/**
 * Run on startup BEFORE `globalShortcut.register` is invoked. If
 * Accessibility is already granted we return immediately. Otherwise we
 * trigger macOS's native "add to list" path AND show our own Electron
 * dialog walking the user to the right Settings pane.
 *
 * The dialog is non-blocking — we don't await the user's response
 * before letting startup continue, because:
 *   - macOS will start delivering events to the registered shortcuts
 *     as soon as the user toggles the switch (no app restart needed).
 *   - Blocking startup on a user-decision dialog is hostile UX
 *     (the user might be reading docs or in a meeting).
 */
export function ensureAccessibilityOnStartup(): void {
  if (process.platform !== 'darwin') return
  if (firstLaunchPromptShown) return
  firstLaunchPromptShown = true

  if (isAccessibilityGranted()) {
    log('Accessibility already granted — keyboard shortcuts will work')
    return
  }

  log('Accessibility not granted — prompting user')

  // Trigger macOS's native flow first. This adds the app to the
  // Accessibility list (so the user sees it when they open the pane)
  // and surfaces macOS's own "use accessibility features" notification.
  promptAccessibility()

  // Then show our own dialog with a clearer explanation. macOS's
  // notification is small and easy to miss; this dialog stays put.
  // Async so startup proceeds.
  void showAccessibilityDialog().catch((err) => {
    log(`accessibility dialog error: ${err.message}`)
  })

  // Start a poller — once macOS reports the permission as granted, we
  // notify the user and re-register any shortcuts that might be needed.
  startAccessibilityPoller()
}

/** Render our explanation dialog. */
async function showAccessibilityDialog(): Promise<void> {
  const result = await dialog.showMessageBox({
    type: 'info',
    title: 'Rax needs Accessibility permission',
    message: 'Grant Accessibility so keyboard shortcuts work',
    detail:
      'macOS requires Rax to be added to System Settings → Privacy & Security → Accessibility before keyboard shortcuts can be delivered to it.\n\n' +
      'These shortcuts won\'t work until you grant it:\n' +
      '   •  ⌘⇧O — summon the voice orb\n' +
      '   •  ⌥R hold — push-to-talk\n' +
      '   •  ⌘⇧F — open the main window\n' +
      '\n' +
      'After you toggle the switch on, you can come back here — the shortcuts start working instantly. No restart needed.',
    buttons: ['Open System Settings', 'Already granted — recheck', 'Later'],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  })

  if (result.response === 0) {
    openPrivacyPane('Accessibility')
  } else if (result.response === 1) {
    if (isAccessibilityGranted()) {
      void dialog.showMessageBox({
        type: 'info',
        title: 'All set',
        message: 'Accessibility is granted — shortcuts are live.',
        buttons: ['OK'],
      })
    } else {
      // Loop back: still not granted, re-offer.
      firstLaunchPromptShown = false
      ensureAccessibilityOnStartup()
    }
  }
  // result.response === 2 → user chose Later; the poller will catch a
  // late grant and notify them, no further prompts.
}

let accessibilityPoller: ReturnType<typeof setInterval> | null = null

/** Poll every 1.5s for up to 10 min. The moment Accessibility flips to
 *  granted we show a small confirmation toast so the user knows shortcuts
 *  are live without having to test them. */
function startAccessibilityPoller(): void {
  if (accessibilityPoller) return
  let elapsedMs = 0
  const intervalMs = 1500
  const ceilingMs = 10 * 60 * 1000

  accessibilityPoller = setInterval(() => {
    if (isAccessibilityGranted()) {
      log('Accessibility granted — shortcuts now live')
      stopAccessibilityPoller()
      void dialog.showMessageBox({
        type: 'info',
        title: 'Shortcuts unlocked',
        message: 'Accessibility granted — Rax is ready.',
        detail: 'Try ⌘⇧O to summon the voice orb, or hold ⌥R to push-to-talk.',
        buttons: ['Got it'],
      })
      return
    }
    elapsedMs += intervalMs
    if (elapsedMs >= ceilingMs) {
      stopAccessibilityPoller()
      log('Accessibility poller giving up after 10 min')
    }
  }, intervalMs)
  // Unref so the poller doesn't keep the process alive at quit time.
  if (accessibilityPoller && typeof accessibilityPoller === 'object' && 'unref' in accessibilityPoller) {
    accessibilityPoller.unref()
  }
}

function stopAccessibilityPoller(): void {
  if (accessibilityPoller) {
    clearInterval(accessibilityPoller)
    accessibilityPoller = null
  }
}

/** Manual re-check (from a tray menu item or settings UI). */
export function recheckAccessibilityAndPrompt(): void {
  firstLaunchPromptShown = false
  ensureAccessibilityOnStartup()
}
