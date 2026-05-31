'use client'

import type { ReactNode } from 'react'

export function BeamButton({ children, variant = 'blue' }: { children: ReactNode; variant?: 'blue' | 'white' }) {
  return (
    <div className="beam-wrap">
      <div className={`beam-ring${variant === 'white' ? ' beam-ring-white' : ''}`} aria-hidden />
      <div className="beam-content">{children}</div>
    </div>
  )
}
