'use client'

import { useEffect, useState } from 'react'

type Arch = 'arm64' | 'x64' | 'universal' | 'unknown'

interface Props {
  defaultArchIsArm: boolean
  armUrl: string | null
  intelUrl: string | null
  universalUrl: string | null
  version: string
}

function detectArch(uaHint: boolean): Arch {
  if (typeof navigator === 'undefined') return uaHint ? 'arm64' : 'unknown'
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
    // fall through
  }

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
      case 'arm64':     return 'Apple Silicon · M1/M2/M3/M4'
      case 'x64':       return 'Intel · x86_64'
      case 'universal': return 'Universal'
      default:          return 'macOS'
    }
  })()

  if (!primaryUrl) {
    return (
      <button
        disabled
        className="w-full rounded-2xl border border-line-2 bg-surface2 text-muted py-4 text-[14px] font-medium cursor-not-allowed flex flex-col items-center gap-1"
      >
        <span className="font-mono text-[10.5px] tracking-[0.22em] uppercase text-soft">// unavailable</span>
        <span>no release found</span>
      </button>
    )
  }

  return (
    <a
      href={primaryUrl}
      className="group relative block w-full overflow-hidden rounded-2xl bg-lime text-white py-4 px-5 transition-all duration-200 hover:-translate-y-0.5 active:translate-y-0"
      style={{
        boxShadow:
          '0 14px 38px -14px rgba(30, 63, 196, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.25)',
        border: '1px solid var(--lime-deep)',
      }}
    >
      {/* shimmer sweep */}
      <span
        aria-hidden
        className="absolute inset-0 -translate-x-full group-hover:translate-x-full transition-transform duration-700 ease-out"
        style={{
          background:
            'linear-gradient(110deg, transparent 30%, rgba(255,255,255,0.45) 50%, transparent 70%)',
        }}
      />

      <div className="relative flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <svg viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5" aria-hidden>
            <path d="M17.05 11.97a4.78 4.78 0 0 1 2.28-4.01 4.9 4.9 0 0 0-3.86-2.09c-1.62-.16-3.18 1-4 1-.84 0-2.1-.97-3.46-.95a5.16 5.16 0 0 0-4.34 2.65c-1.86 3.22-.47 7.99 1.34 10.6.88 1.28 1.93 2.72 3.31 2.67 1.33-.05 1.84-.86 3.45-.86 1.6 0 2.07.86 3.48.83 1.44-.02 2.35-1.3 3.23-2.59a11.5 11.5 0 0 0 1.46-3.02 4.65 4.65 0 0 1-2.89-4.23zM14.6 4.5A4.7 4.7 0 0 0 15.7 1a4.78 4.78 0 0 0-3.07 1.59 4.4 4.4 0 0 0-1.13 3.36 3.95 3.95 0 0 0 3.1-1.45z" />
          </svg>
          <div className="text-left">
            <div className="font-mono text-[10px] tracking-[0.22em] uppercase font-semibold opacity-70">
              download · v{version}
            </div>
            <div className="font-display font-bold text-[17px] tracking-[-0.02em] leading-tight">
              Get Rax for macOS
            </div>
          </div>
        </div>
        <span className="font-mono text-[11px] tracking-[0.18em] uppercase opacity-75 font-medium hidden sm:flex items-center gap-1.5">
          {archLabel}
          <span aria-hidden>↓</span>
        </span>
        <span className="sm:hidden text-[18px] opacity-80" aria-hidden>↓</span>
      </div>
    </a>
  )
}
