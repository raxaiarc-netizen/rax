/**
 * Tracks whether the user has finished (or skipped) the first-launch
 * welcome screen. Persisted to `<userData>/onboarding.json` so the
 * choice survives app restarts.
 */

import { promises as fsp } from 'fs'
import { join } from 'path'
import { app } from 'electron'

interface OnboardingState {
  completed: boolean
  completedAt: string | null
  /** Which path the user picked: 'rax', 'own-claude', or 'skip'. */
  choice: 'rax' | 'own-claude' | 'skip' | null
}

const DEFAULT_STATE: OnboardingState = {
  completed: false,
  completedAt: null,
  choice: null,
}

let cached: OnboardingState | null = null

function storePath(): string {
  return join(app.getPath('userData'), 'onboarding.json')
}

async function load(): Promise<OnboardingState> {
  if (cached) return cached
  try {
    const raw = await fsp.readFile(storePath(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<OnboardingState>
    cached = {
      completed: !!parsed.completed,
      completedAt: parsed.completedAt ?? null,
      choice: parsed.choice ?? null,
    }
  } catch {
    cached = { ...DEFAULT_STATE }
  }
  return cached
}

export async function getState(): Promise<OnboardingState> {
  return load()
}

export async function complete(choice: OnboardingState['choice']): Promise<OnboardingState> {
  cached = {
    completed: true,
    completedAt: new Date().toISOString(),
    choice,
  }
  await fsp.mkdir(join(storePath(), '..'), { recursive: true })
  await fsp.writeFile(storePath(), JSON.stringify(cached, null, 2), { mode: 0o600 })
  return cached
}
