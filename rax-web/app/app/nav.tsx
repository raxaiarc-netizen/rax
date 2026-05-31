'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const ITEMS = [
  { href: '/app/dashboard', label: 'dashboard', tag: '01' },
  { href: '/app/keys',      label: 'api keys',  tag: '02' },
] as const

export default function Nav() {
  const path = usePathname()
  return (
    <nav className="flex items-center gap-1">
      {ITEMS.map(item => {
        const active = path === item.href || path.startsWith(item.href + '/')
        return (
          <Link
            key={item.href}
            href={item.href}
            className={
              'group relative px-3 py-1.5 rounded-full text-[13px] transition-colors flex items-center gap-2 ' +
              (active
                ? 'text-ink bg-paper border border-line-2'
                : 'text-muted hover:text-ink hover:bg-paper')
            }
          >
            <span
              className={
                'font-mono text-[10px] tracking-[0.16em] ' +
                (active ? 'text-lime-deep' : 'text-soft group-hover:text-muted')
              }
            >
              {item.tag}
            </span>
            <span className="font-display font-semibold tracking-[-0.005em]">{item.label}</span>
          </Link>
        )
      })}
    </nav>
  )
}
