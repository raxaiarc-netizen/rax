'use client'

import { useState } from 'react'
import Image from 'next/image'
import { Mascot } from './mascot'

// Holo-style hero visual: the notch mascot, huge and alive, on a black
// island with the product's life tucked in around him — a voice ask, the
// agent reply, crew faces, a shipped receipt. Cards overlap the island the
// way the GeniAI reference overlaps its phone, so the cluster reads as one
// composition instead of satellites. He stays idle — breathing, blinking,
// watching the cursor — and reacts if you poke him.

export default function MascotShowcase() {
  const [hovered, setHovered] = useState(false)

  return (
    <div className="mh-stage" aria-hidden>
      {/* Rings + halo behind everything, with a few orbit dots for life */}
      <span className="mh-ring mh-ring-1" />
      <span className="mh-ring mh-ring-2" />
      <span className="mh-ring mh-ring-3" />
      <span className="mh-halo" />
      <span className="mh-dot-orbit" style={{ left: '50%', top: '4.5%', background: 'var(--lime)' }} />
      <span className="mh-dot-orbit" style={{ left: '20%', top: '32%', background: 'var(--butter)' }} />
      <span className="mh-dot-orbit" style={{ right: '23%', bottom: '20%', background: 'var(--coral)' }} />

      {/* The big guy — on black, exactly like the notch he lives in. */}
      <div
        className="mh-island"
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        <div className="mh-mascot">
          <Mascot state="idle" hovered={hovered} size="100%" noDoze interactive />
        </div>
      </div>

      {/* 10 o'clock — the voice ask */}
      <div className="mh-float hidden sm:block" style={{ left: '4%', top: '16%', animationDuration: '6.4s' }}>
        <div className="mh-card" style={{ transform: 'rotate(-4deg)' }}>
          <span className="mh-you">you</span>
          <span className="text-ink text-[13.5px] font-medium leading-snug">
            &ldquo;Hey Max — what shipped
            <br />
            since Friday?&rdquo;
          </span>
        </div>
      </div>

      {/* 9 o'clock — push-to-talk chip, tucked against the island edge */}
      <div className="mh-float hidden md:block" style={{ left: '15%', top: '51%', animationDuration: '7s', animationDelay: '2.6s' }}>
        <div className="mh-card mh-card-tight" style={{ transform: 'rotate(2deg)' }}>
          <span className="font-mono text-[10px] tracking-[0.16em] uppercase text-muted">
            hold <span className="cmd">⌥ R</span> · talk
          </span>
        </div>
      </div>

      {/* 1 o'clock — crew face on the second ring */}
      <div className="mh-float hidden sm:block" style={{ right: '15%', top: '7%', animationDuration: '7.2s', animationDelay: '0.8s' }}>
        <div className="mh-avatar">
          <Image src="/nova.png" alt="" width={128} height={128} />
        </div>
      </div>

      {/* 3 o'clock — the reply, overlapping the island */}
      <div className="mh-float hidden md:block" style={{ right: '13%', top: '40%', animationDuration: '5.8s', animationDelay: '1.6s' }}>
        <div className="mh-card" style={{ transform: 'rotate(3deg)' }}>
          <span className="mh-face">
            <Image src="/max.png" alt="" width={72} height={72} />
          </span>
          <span className="inline-flex items-center gap-2 font-mono text-[10px] tracking-[0.16em] uppercase text-[#0e8f8b]">
            <span className="dot" /> Max is on it…
          </span>
        </div>
      </div>

      {/* 7 o'clock — crew face on the second ring */}
      <div className="mh-float hidden sm:block" style={{ left: '11%', bottom: '10%', animationDuration: '6.8s', animationDelay: '2.2s' }}>
        <div className="mh-avatar mh-avatar-sm">
          <Image src="/luna.png" alt="" width={112} height={112} />
        </div>
      </div>

      {/* 5 o'clock — the receipt, overlapping the island corner */}
      <div className="mh-float hidden md:block" style={{ right: '20%', bottom: '11%', animationDuration: '6s', animationDelay: '1.1s' }}>
        <div className="mh-card" style={{ transform: 'rotate(-2deg)' }}>
          <span className="font-mono text-[11px] tracking-[0.04em] text-ink whitespace-pre leading-relaxed">
            ✓ shipped · build passing{'\n'}3 files · 41 + / 18 −
          </span>
        </div>
      </div>

      {/* The handwritten invitation, arrow aimed at him */}
      <div className="mh-note hidden sm:flex">
        <span className="script text-[24px] leading-tight text-ink" style={{ transform: 'rotate(-7deg)' }}>
          go on — poke him!
          <br />
          <span className="text-[18px] text-muted">(he has feelings about it)</span>
        </span>
        <svg width="58" height="44" viewBox="0 0 58 44" fill="none" className="mh-note-arrow">
          <path d="M4 40 C 18 36, 38 24, 50 8" stroke="var(--muted)" strokeWidth="1.8" strokeLinecap="round" />
          <path d="M50 8 l -9 1.5 M50 8 l -1 9" stroke="var(--muted)" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      </div>
    </div>
  )
}
