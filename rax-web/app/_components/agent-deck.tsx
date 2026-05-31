'use client'

import Image from 'next/image'
import { useState } from 'react'

type Agent = {
  name: string
  role: string
  img: string
  accent: string
}

const AGENTS: Agent[] = [
  { name: 'Max',  role: 'orchestrator', img: '/max.png',  accent: '#14c4c0' },
  { name: 'Alex', role: 'engineer',     img: '/alex.png', accent: '#3362ff' },
  { name: 'Luna', role: 'designer',     img: '/luna.png', accent: '#b48cff' },
  { name: 'Nova', role: 'researcher',   img: '/nova.png', accent: '#2cc475' },
  { name: 'Zara', role: 'debugger',     img: '/zara.png', accent: '#ff6aa8' },
]

export default function AgentDeck() {
  const [order, setOrder] = useState<number[]>([0, 1, 2, 3, 4])

  const promote = (agentIdx: number) => {
    setOrder(prev => {
      if (prev[0] === agentIdx) return prev
      const rest = prev.filter(i => i !== agentIdx)
      return [agentIdx, ...rest]
    })
  }

  return (
    <div className="agent-deck-v2" role="group" aria-label="Meet the crew">
      {AGENTS.map((a, agentIdx) => {
        const slot = order.indexOf(agentIdx)
        const isActive = slot === 0
        return (
          <button
            key={a.name}
            type="button"
            onClick={() => promote(agentIdx)}
            className="agent-card-v2"
            style={{
              ['--slot' as string]: slot,
              ['--accent' as string]: a.accent,
              zIndex: AGENTS.length - slot,
            }}
            aria-label={`${a.name}, ${a.role}`}
            aria-pressed={isActive}
            tabIndex={0}
          >
            <Image
              src={a.img}
              alt=""
              fill
              sizes="280px"
              className="agent-card-v2-img"
              priority={agentIdx === 0}
            />
            <div className="agent-card-v2-shade" aria-hidden />
            <div className="agent-card-v2-label">
              <span className="role">{a.role}</span>
              <span className="name">{a.name}</span>
            </div>
            <div className="agent-card-v2-ring" aria-hidden />
          </button>
        )
      })}
    </div>
  )
}
