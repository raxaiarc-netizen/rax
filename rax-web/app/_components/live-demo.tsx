'use client'

import { useEffect, useState } from 'react'
import Image from 'next/image'
import { Mascot } from './mascot'

type Agent = {
  name: string
  role: string
  img: string
  accent: 'max' | 'alex' | 'luna' | 'nova' | 'zara'
  dot: string
}

const AGENTS: Agent[] = [
  { name: 'Max',  role: 'orchestrator', img: '/max.png',  accent: 'max',  dot: 'dot' },
  { name: 'Alex', role: 'engineer',     img: '/alex.png', accent: 'alex', dot: 'dot dot-ocean' },
  { name: 'Luna', role: 'designer',     img: '/luna.png', accent: 'luna', dot: 'dot dot-plum' },
  { name: 'Nova', role: 'researcher',   img: '/nova.png', accent: 'nova', dot: 'dot' },
  { name: 'Zara', role: 'debugger',     img: '/zara.png', accent: 'zara', dot: 'dot dot-coral' },
]

const SCENES: ReadonlyArray<{
  agent: Agent
  user: string
  caption: string
  code: string
}> = [
  {
    agent: AGENTS[0],
    user: 'Max — what changed in the dashboard since Friday?',
    caption: 'Max is reading the last 4 commits…',
    code: `▸ git log --since="friday" -- app/dashboard
 a1f29c2  luna · tighten balance hero spacing
 7d44b09  alex · live tail; 5s polling → SSE
 c11ee84  nova · spent-window chart prototype
 ✓ 3 changes · ready to summarise`,
  },
  {
    agent: AGENTS[1],
    user: 'Alex — refactor TopupButtons to use Suspense.',
    caption: 'Alex is rewriting topup-buttons.tsx…',
    code: `+ import { Suspense } from 'react'
+ <Suspense fallback={<TierSkeleton />}>
+   <TopupButtons options={TOPUP_OPTIONS} />
+ </Suspense>
~ 3 files changed · 41 + / 18 −
✓ build passing · 0 errors`,
  },
  {
    agent: AGENTS[2],
    user: 'Luna — the tier cards feel cramped.',
    caption: 'Luna is dialling the breathing room…',
    code: `~ panel p-5      → panel p-7
~ gap-3          → gap-5
~ leading-none   → leading-tight
✓ rendered preview · 1440 × 900
✓ live reload pushed`,
  },
  {
    agent: AGENTS[3],
    user: 'Nova — research the Whop subscription churn.',
    caption: 'Nova is pulling 30-day cohort data…',
    code: `▸ querying request_logs · 30d
 cohorts:        842
 churned (≤7d):  61  (7.2%)
 modal day:      sunday
 finding:        weekend signup, no usage`,
  },
  {
    agent: AGENTS[4],
    user: 'Zara — the keys API throws on revoke.',
    caption: 'Zara is tracing the stack…',
    code: `▸ DELETE /api/keys → 500
 caused by: PostgrestError 23503
 cause:     fk constraint logs_key_id_fkey
 fix:       ON DELETE SET NULL · migration ready
 ✓ patch staged`,
  },
]

const ACCENT_BG: Record<Agent['accent'], string> = {
  max:  'bg-[#dffaf9]',
  alex: 'bg-[#dde6ff]',
  luna: 'bg-[#ece1ff]',
  nova: 'bg-[#dbf5e6]',
  zara: 'bg-[#ffe2ee]',
}

const ACCENT_RING: Record<Agent['accent'], string> = {
  max:  'ring-[#14c4c0]/40',
  alex: 'ring-[#3362ff]/40',
  luna: 'ring-[#b48cff]/40',
  nova: 'ring-[#2cc475]/40',
  zara: 'ring-[#ff6aa8]/40',
}

const ACCENT_TEXT: Record<Agent['accent'], string> = {
  max:  'text-[#0e8f8b]',
  alex: 'text-[#3362ff]',
  luna: 'text-[#7a4dd6]',
  nova: 'text-[#19914e]',
  zara: 'text-[#c93b73]',
}

export default function LiveDemo() {
  const [idx, setIdx] = useState(0)

  useEffect(() => {
    const t = setInterval(() => setIdx(i => (i + 1) % SCENES.length), 4500)
    return () => clearInterval(t)
  }, [])

  const scene = SCENES[idx]

  return (
    <div className={'card card-hover overflow-hidden border-line-2 ' + ACCENT_BG[scene.agent.accent]}>
      {/* Window chrome */}
      <div className="flex items-center gap-3 px-4 sm:px-5 py-3 border-b border-line bg-paper/60 backdrop-blur">
        <div className="flex gap-1.5">
          <span className="w-3 h-3 rounded-full bg-coral" />
          <span className="w-3 h-3 rounded-full bg-butter" />
          <span className="w-3 h-3 rounded-full bg-lime" />
        </div>
        <span className="font-mono text-[11px] tracking-[0.16em] uppercase text-muted ml-1">
          rax · live · {scene.agent.name.toLowerCase()}
        </span>
        <span className="ml-auto flex items-center gap-2 font-mono text-[10.5px] tracking-[0.18em] uppercase text-muted">
          <span className="dot" /> online
        </span>
      </div>

      {/* Body */}
      <div className="grid grid-cols-[auto_1fr] gap-5 p-5 sm:p-6 min-h-[440px]">
        {/* Dock */}
        <div className="dock self-start" aria-hidden>
          {AGENTS.map((a, i) => {
            const active = i === idx
            return (
              <button
                key={a.name}
                onClick={() => setIdx(i)}
                className={'dock-agent ' + (active ? 'is-active' : '')}
                title={`${a.name} — ${a.role}`}
              >
                <Image src={a.img} alt={a.name} width={88} height={88} />
              </button>
            )
          })}
          {/* The notch mascot tags along under the crew, wearing the active
              agent's colorway. */}
          <div className="mt-2 mx-auto" aria-hidden>
            <Mascot state="idle" colorId={scene.agent.accent} size={36} noDoze />
          </div>
        </div>

        {/* Right column */}
        <div className="flex flex-col gap-5 min-w-0">
          {/* User turn */}
          <div className="flex items-start gap-3">
            <div className="w-8 h-8 rounded-lg border border-line-2 bg-paper flex items-center justify-center font-mono text-[11px] text-muted flex-shrink-0">
              you
            </div>
            <div className="text-[14.5px] text-ink leading-relaxed pt-1 font-medium">
              {scene.user}
            </div>
          </div>

          {/* Agent response */}
          <div className="flex items-start gap-3">
            <div className={'w-8 h-8 rounded-lg overflow-hidden ring-2 ' + ACCENT_RING[scene.agent.accent] + ' flex-shrink-0'}>
              <Image src={scene.agent.img} alt={scene.agent.name} width={64} height={64} className="block w-full h-full object-cover" />
            </div>
            <div className="min-w-0 flex-1 space-y-3">
              <div className={'inline-flex items-center gap-2 font-mono text-[10.5px] tracking-[0.18em] uppercase ' + ACCENT_TEXT[scene.agent.accent]}>
                <span className={scene.agent.dot} />
                {scene.caption}
              </div>

              <pre className="font-mono text-[11.5px] leading-relaxed text-cream bg-ink-900 border border-ink-800 rounded-xl p-4 overflow-x-auto no-scrollbar whitespace-pre">
                {scene.code}
              </pre>
            </div>
          </div>

          {/* Caption pill */}
          <div className="mt-auto self-start inline-flex items-center gap-3 px-4 py-2 rounded-full border border-line-2 bg-paper text-[12.5px] text-ink">
            <span className="dot" />
            <span className="font-mono text-[10px] tracking-[0.16em] uppercase text-muted">caption pill</span>
            <span className="text-soft">·</span>
            <span className="script text-[16px]">{scene.agent.name.toLowerCase()} is working</span>
          </div>
        </div>
      </div>

      {/* Scene chips */}
      <div className="border-t border-line px-4 sm:px-5 py-3 flex items-center justify-between gap-2 bg-paper/40">
        {SCENES.map((s, i) => {
          const active = i === idx
          return (
            <button
              key={s.agent.name}
              onClick={() => setIdx(i)}
              className={
                'flex items-center justify-center gap-1.5 flex-1 min-w-0 px-2 py-1.5 rounded-full border text-[12px] tracking-[-0.005em] transition-colors ' +
                (active
                  ? 'border-ink bg-ink text-cream'
                  : 'border-line-2 bg-paper text-muted hover:text-ink hover:border-line-3')
              }
            >
              <span className={active ? 'dot flex-shrink-0' : 'dot dot-idle flex-shrink-0'} />
              <span className="font-display font-semibold truncate">{s.agent.name}</span>
              <span className="text-soft flex-shrink-0">·</span>
              <span className="font-mono text-[10px] tracking-[0.16em] uppercase truncate">{s.agent.role}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
