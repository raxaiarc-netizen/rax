// ─── First-install tour state ───
//
// Tracks whether the orb has performed its scripted first-install voice
// tour (see src/renderer/orb/Onboarding.tsx for the performance itself).
// Persisted to `<userData>/orb-tour.json` so the tour plays once per
// machine; `step` is the resume point so a quit / dismissal / ⌥R takeover
// mid-tour continues where it left off on the next summon instead of
// replaying from the top.
//
// Dev override: RAX_FORCE_TOUR=1 reports the tour as pending (from step 0)
// regardless of what's on disk — writes still land so the normal flow can
// be exercised end-to-end without hand-deleting the JSON between runs.
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { log as _log } from '../logger'

function log(msg: string): void {
  _log('OrbTour', msg)
}

export interface TourState {
  done: boolean
  /** Resume point — index into the renderer's canonical step list. */
  step: number
  completedAt: string | null
  how: 'finished' | 'skipped' | null
}

const DEFAULT_STATE: TourState = { done: false, step: 0, completedAt: null, how: null }

function tourFile(): string {
  return join(app.getPath('userData'), 'orb-tour.json')
}

function readState(): TourState {
  try {
    const parsed = JSON.parse(readFileSync(tourFile(), 'utf-8')) as Partial<TourState>
    return {
      done: !!parsed.done,
      step: Number.isInteger(parsed.step) && (parsed.step as number) >= 0 ? (parsed.step as number) : 0,
      completedAt: typeof parsed.completedAt === 'string' ? parsed.completedAt : null,
      how: parsed.how === 'finished' || parsed.how === 'skipped' ? parsed.how : null,
    }
  } catch {
    return { ...DEFAULT_STATE }
  }
}

function writeState(state: TourState): void {
  try {
    writeFileSync(tourFile(), JSON.stringify(state, null, 2), 'utf-8')
  } catch (err) {
    // Non-fatal: worst case the tour replays next boot.
    log(`Failed to persist tour state: ${(err as Error).message}`)
  }
}

export function getTourState(): TourState {
  if (process.env.RAX_FORCE_TOUR === '1') return { ...DEFAULT_STATE }
  return readState()
}

export function saveTourStep(step: number): void {
  if (!Number.isInteger(step) || step < 0) return
  const cur = readState()
  if (cur.done) return
  writeState({ ...cur, step })
}

export function completeTour(how: 'finished' | 'skipped'): void {
  log(`Tour ${how}`)
  writeState({ done: true, step: 0, completedAt: new Date().toISOString(), how })
}
