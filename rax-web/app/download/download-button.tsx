'use client'

import { useEffect, useState } from 'react'

type Arch = 'arm64' | 'x64' | 'universal' | 'unknown'

interface Props {
  /** Server-side hint from the request UA. Used for the very first paint so
   *  the button is correct before client-side detection runs. */
  defaultArchIsArm: boolean
  armUrl: string | null
  intelUrl: string | null
  universalUrl: string | null
  version: string
}

// Detect Apple Silicon vs Intel at runtime. WebGL hack: ANGLE_instanced_arrays
// renders different vendor strings on M-series ("Apple GPU") vs Intel
// integrated graphics. Falls back to UA + memory heuristics when WebGL is
// unavailable (Safari with hardware acceleration off, headless browsers).
function detectArch(uaHint: boolean): Arch {
  if (typeof navigator === 'undefined') {
    return uaHint ? 'arm64' : 'unknown'
  }
  const platform = (navigator.platform || '').toLowerCase()
  if (!platform.includes('mac')) return 'unknown'

  try {
    const canvas = document.createElement('canvas')
    const gl = (canvas.getContext('webgl') || canvas.getContext('experimental-webgl')) as WebGLRenderingContext | null
    if (gl) {
      const ext = gl.getExtension('WEBGL_debug_renderer_info')
      if (ext) {
        const renderer = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || '').toLowerCase()
        if (renderer.includes('apple')) return 'arm64'
        if (renderer.includes('intel') || renderer.includes('amd') || renderer.includes('radeon')) return 'x64'
      }
    }
  } catch {
    // ignore — fall through to UA heuristic
  }

  // CPU cores ≥ 8 on a Mac is much more common on Apple Silicon than
  // pre-2021 Intel models. Combined with the UA hint this is a decent
  // tiebreaker when WebGL is locked down.
  const cores = navigator.hardwareConcurrency ?? 0
  if (uaHint && cores >= 8) return 'arm64'
  if (cores <= 4) return 'x64'

  return uaHint ? 'arm64' : 'x64'
}

export default function DownloadButton({
  defaultArchIsArm,
  armUrl,
  intelUrl,
  universalUrl,
  version,
}: Props) {
  const [arch, setArch] = useState<Arch>(defaultArchIsArm ? 'arm64' : 'unknown')

  useEffect(() => {
    setArch(detectArch(defaultArchIsArm))
  }, [defaultArchIsArm])

  const primaryUrl = (() => {
    if (arch === 'arm64') return armUrl ?? universalUrl ?? intelUrl
    if (arch === 'x64') return intelUrl ?? universalUrl ?? armUrl
    return universalUrl ?? armUrl ?? intelUrl
  })()

  const archLabel = (() => {
    switch (arch) {
      case 'arm64': return 'Apple Silicon · M1/M2/M3/M4'
      case 'x64': return 'Intel · x86_64'
      case 'universal': return 'Universal'
      default: return 'macOS'
    }
  })()

  if (!primaryUrl) {
    return (
      <button
        disabled
        className="w-full rounded-xl bg-neutral-900 text-neutral-500 py-4 text-sm font-medium cursor-not-allowed"
      >
        Download unavailable — no release found
      </button>
    )
  }

  return (
    <a
      href={primaryUrl}
      className="group block w-full rounded-xl bg-white text-black py-4 px-5 text-center transition-transform hover:scale-[1.01] active:scale-[0.99]"
    >
      <div className="flex items-center justify-center gap-3">
        <svg viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5">
          <path d="M17.05 11.97a4.78 4.78 0 0 1 2.28-4.01 4.9 4.9 0 0 0-3.86-2.09c-1.62-.16-3.18 1-4 1-.84 0-2.1-.97-3.46-.95a5.16 5.16 0 0 0-4.34 2.65c-1.86 3.22-.47 7.99 1.34 10.6.88 1.28 1.93 2.72 3.31 2.67 1.33-.05 1.84-.86 3.45-.86 1.6 0 2.07.86 3.48.83 1.44-.02 2.35-1.3 3.23-2.59a11.5 11.5 0 0 0 1.46-3.02 4.65 4.65 0 0 1-2.89-4.23zM14.6 4.5A4.7 4.7 0 0 0 15.7 1a4.78 4.78 0 0 0-3.07 1.59 4.4 4.4 0 0 0-1.13 3.36 3.95 3.95 0 0 0 3.1-1.45z" />
        </svg>
        <span className="text-base font-semibold">Download Rax v{version}</span>
      </div>
      <div className="mt-1 text-xs text-neutral-600 group-hover:text-neutral-700 transition-colors">
        macOS · {archLabel}
      </div>
    </a>
  )
}
