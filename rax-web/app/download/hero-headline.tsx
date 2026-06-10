'use client'

import { Mascot } from '../_components/mascot'

export function HeroHeadline() {
  return (
    <h1 className="display-xl">
      <span className="text-muted">Ready to install.</span>
      <br />
      Your crew
      {/* The notch mascot stands in as the full stop — alive, watching the cursor. */}
      <span
        aria-hidden
        style={{
          display: 'inline-block',
          width: '0.58em',
          height: '0.58em',
          verticalAlign: '-0.06em',
          marginLeft: '0.1em',
          filter: 'drop-shadow(0 4px 14px rgba(51, 98, 255, 0.35))',
        }}
      >
        <Mascot state="idle" size="100%" />
      </span>
    </h1>
  )
}
