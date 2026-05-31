import Link from 'next/link'
import Image from 'next/image'
import { headers } from 'next/headers'
import DownloadButton from './download-button'
import AgentDeck from '../_components/agent-deck'
import { HeroHeadline } from './hero-headline'

export const revalidate = 300

const REPO_OWNER = 'raxaiarc-netizen'
const REPO_NAME = 'rax'

type ReleaseAsset = {
  name: string
  browser_download_url: string
  size: number
  content_type: string
}

type Release = {
  tag_name: string
  name: string | null
  body: string | null
  published_at: string | null
  html_url: string
  assets: ReleaseAsset[]
}

async function fetchLatestRelease(): Promise<Release | null> {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        next: { revalidate },
      },
    )
    if (!res.ok) return null
    return (await res.json()) as Release
  } catch {
    return null
  }
}

function pickAsset(release: Release, predicate: (name: string) => boolean): ReleaseAsset | null {
  return release.assets.find((a) => predicate(a.name.toLowerCase())) ?? null
}

function formatSize(bytes: number): string {
  if (!bytes || bytes < 0) return '—'
  const mb = bytes / 1024 / 1024
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`
  return `${mb.toFixed(0)} MB`
}

function formatDate(iso: string | null): string {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })
  } catch {
    return '—'
  }
}

const CREW = [
  { name: 'Max',  role: 'orchestrator', img: '/max.png',  blurb: 'Routes the work, holds the plan, keeps the crew honest.' },
  { name: 'Alex', role: 'engineer',     img: '/alex.png', blurb: 'Writes the code. Ships fast, reviews carefully.' },
  { name: 'Luna', role: 'designer',     img: '/luna.png', blurb: 'Hairlines, hierarchy, breathing room. The polish layer.' },
  { name: 'Nova', role: 'researcher',   img: '/nova.png', blurb: 'Trawls logs, papers, and your codebase. Brings receipts.' },
  { name: 'Zara', role: 'debugger',     img: '/zara.png', blurb: 'Stack traces, not vibes. Finds it, names it, fixes it.' },
]

export default async function DownloadPage() {
  const release = await fetchLatestRelease()
  const ua = (await headers()).get('user-agent') ?? ''
  const looksAppleSilicon = /Mac.*ARM|Mac.*Apple/i.test(ua) || /Macintosh.*OS X/i.test(ua)

  const armDmg = release ? pickAsset(release, (n) => n.endsWith('.dmg') && n.includes('arm64')) : null
  const x64Dmg = release ? pickAsset(release, (n) => n.endsWith('.dmg') && (n.includes('x64') || n.includes('intel'))) : null
  const universalDmg = release
    ? pickAsset(release, (n) => n.endsWith('.dmg') && !n.includes('arm64') && !n.includes('x64') && !n.includes('intel'))
    : null

  const version = release?.tag_name?.replace(/^v/, '') ?? '1.0.0'

  return (
    <main className="relative min-h-screen flex flex-col overflow-x-hidden">

      {/* Top bar */}
      <header className="px-5 sm:px-8 pt-5 sm:pt-7 pb-2">
        <div className="max-w-[1240px] mx-auto flex items-center justify-between">
          <Link href="/" className="flex items-center gap-3 group">
            <span className="brand-mark brand-mark-lg" aria-hidden />
            <span className="font-display font-bold text-[20px] tracking-[-0.02em] text-ink">rax</span>
          </Link>
          <Link href="/" className="btn-link text-[14px]">← home</Link>
        </div>
      </header>

      {/* Hero */}
      <section className="px-5 sm:px-8 pt-10 sm:pt-16 pb-20 sm:pb-28 flex-1">
        <div className="max-w-[1240px] mx-auto grid lg:grid-cols-[1.35fr_1fr] gap-12 lg:gap-20 items-center">

          {/* Left: copy */}
          <div className="space-y-7 enter enter-d1">
            <span className="eyebrow-pill">
              <span className="dot" /> five agents · one desktop
            </span>
            <HeroHeadline />
            <p className="text-[17px] sm:text-[18px] leading-relaxed text-muted max-w-[52ch]">
              Five named agents, one ambient voice orb, a floating dock.
              Free to download — drag the DMG to Applications and you&rsquo;re in.
            </p>
            <div className="flex flex-wrap items-center gap-3 pt-1">
              <DownloadButton
                defaultArchIsArm={looksAppleSilicon}
                armUrl={armDmg?.browser_download_url ?? null}
                intelUrl={x64Dmg?.browser_download_url ?? null}
                universalUrl={universalDmg?.browser_download_url ?? null}
                version={version}
              />
            </div>
            <div className="flex flex-wrap items-center gap-4 text-[13px] text-muted">
              <span className="inline-flex items-center gap-2"><span className="dot" /> free to install</span>
              <span className="text-soft">·</span>
              <span>pay only for tokens</span>
              <span className="text-soft">·</span>
              <span>credits never expire</span>
            </div>
          </div>

          {/* Right: agent deck — click to promote, hover to spread */}
          <div className="relative enter enter-d3 flex justify-center lg:justify-end lg:pr-8 xl:pr-16">
            <AgentDeck />
          </div>

        </div>
      </section>

      {/* Footer */}
      <footer className="px-5 sm:px-8 py-8 border-t border-line bg-paper">
        <div className="max-w-[1240px] mx-auto flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 font-mono text-[11.5px] tracking-[0.02em] text-muted">
          <div className="flex items-center gap-3">
            <span className="brand-mark scale-75 origin-left" aria-hidden />
            <span>© {new Date().getFullYear()} rax</span>
          </div>
          <div className="flex items-center gap-5">
            <Link href="/terms" className="btn-link">terms</Link>
            <Link href="/privacy" className="btn-link">privacy</Link>
            <Link href="/" className="btn-link">home</Link>
          </div>
        </div>
      </footer>

    </main>
  )
}

function ArchTile({
  href,
  title,
  subtitle,
  size,
}: {
  href: string
  title: string
  subtitle: string
  size: string
}) {
  return (
    <a
      href={href}
      className="group flex items-center justify-between rounded-xl border border-line-2 bg-paper px-4 py-3 hover:border-line-3 hover:bg-surface2 transition-colors"
    >
      <span>
        <span className="block text-ink text-[13.5px] font-medium">{title}</span>
        <span className="block text-[11.5px] text-muted">{subtitle} · DMG</span>
      </span>
      <span className="text-[12px] text-muted group-hover:text-lime-deep transition-colors flex items-center gap-1.5">
        {size} <span className="text-soft group-hover:text-lime-deep">↓</span>
      </span>
    </a>
  )
}
