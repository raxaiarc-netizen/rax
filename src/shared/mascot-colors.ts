// ─── Mascot colorways ───
//
// The notch mascot's visor ships in Rax blue, but every member of the agent
// crew wears the same hardware in their own color — picking a colorway is
// picking which agent's "skin" the orb mascot wears. One source of truth
// here so the Settings swatches (fullscreen renderer), the persistence layer
// (main), and the visor gradient (orb renderer) can never drift.
//
// Each colorway is a left→right visor gradient (lit side → deep side, same
// lighting as the reference art). The crew entries are hand-tuned around the
// matching agent's dock accent (see shared/agents.ts) rather than derived,
// so the visor keeps its jewel-like contrast at 6px tall instead of going
// muddy from programmatic lighten/darken.

export interface MascotColorway {
  /** Stable id persisted to disk and localStorage. */
  id: string
  /** Swatch label. */
  name: string
  /** Crew agent this colorway belongs to (absent on the Rax default). */
  agentId?: string
  /** Tooltip flavor, mirrors the agent taglines. */
  tagline: string
  /** Visor gradient stops, left (lit) → right (deep). */
  visorLight: string
  visorDeep: string
}

export const MASCOT_COLORWAYS: readonly MascotColorway[] = [
  {
    id: 'rax',
    name: 'Rax Blue',
    tagline: 'the original',
    visorLight: '#5BC4FA',
    visorDeep: '#3D7DF8',
  },
  {
    id: 'max',
    name: 'Max',
    agentId: 'agent-max',
    tagline: 'the heavy lifter',
    visorLight: '#53E5E8',
    visorDeep: '#17AFC9',
  },
  {
    id: 'alex',
    name: 'Alex',
    agentId: 'agent-alex',
    tagline: 'the architect',
    visorLight: '#93BBFF',
    visorDeep: '#5F86F5',
  },
  {
    id: 'luna',
    name: 'Luna',
    agentId: 'agent-luna',
    tagline: 'the night owl',
    visorLight: '#C8A6FF',
    visorDeep: '#9163F2',
  },
  {
    id: 'nova',
    name: 'Nova',
    agentId: 'agent-nova',
    tagline: 'the spark',
    visorLight: '#71E9B9',
    visorDeep: '#2EBE83',
  },
  {
    id: 'zara',
    name: 'Zara',
    agentId: 'agent-zara',
    tagline: 'the closer',
    visorLight: '#FF92B8',
    visorDeep: '#F2477F',
  },
] as const

export const DEFAULT_MASCOT_COLOR_ID = MASCOT_COLORWAYS[0].id

const BY_ID: Map<string, MascotColorway> = new Map(MASCOT_COLORWAYS.map((c) => [c.id, c]))

export function isValidMascotColor(id: string | undefined | null): boolean {
  return !!id && BY_ID.has(id)
}

/** Resolve a colorway, falling back to Rax blue for unknown/stale ids so a
 *  hand-edited persistence file can never render an uncolored visor. */
export function getMascotColorway(id: string | undefined | null): MascotColorway {
  return (id && BY_ID.get(id)) || MASCOT_COLORWAYS[0]
}
