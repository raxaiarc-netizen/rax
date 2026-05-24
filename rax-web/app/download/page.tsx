import Link from 'next/link'
import { headers } from 'next/headers'
import DownloadButton from './download-button'

// Cache GitHub's release lookup for 5 minutes. Long enough that a flood of
// download-page hits doesn't burn through the unauthenticated REST quota
// (60/hr/IP), short enough that a fresh release is visible to the next user
// without anyone having to redeploy the website.
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

function pickAsset(
  release: Release,
  predicate: (name: string) => boolean,
): ReleaseAsset | null {
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

export default async function DownloadPage() {
  const release = await fetchLatestRelease()
  // The platform-detect button is rendered client-side; we forward the user
  // agent so the *server-rendered* fallback can already display the right
  // primary CTA on first paint (no FOUC, no hydration flicker).
  const ua = (await headers()).get('user-agent') ?? ''
  const looksAppleSilicon = /Mac.*ARM|Mac.*Apple/i.test(ua) || /Macintosh.*OS X/i.test(ua)

  const armDmg = release ? pickAsset(release, (n) => n.endsWith('.dmg') && n.includes('arm64')) : null
  const x64Dmg = release ? pickAsset(release, (n) => n.endsWith('.dmg') && (n.includes('x64') || n.includes('intel'))) : null
  const universalDmg = release ? pickAsset(release, (n) => n.endsWith('.dmg') && !n.includes('arm64') && !n.includes('x64') && !n.includes('intel')) : null

  const version = release?.tag_name?.replace(/^v/, '') ?? '1.0.0'

  return (
    <main className="min-h-screen flex flex-col">
      <header className="px-6 sm:px-10 pt-8 flex items-center justify-between">
        <Link href="/" className="text-lg font-semibold tracking-tight">rax</Link>
        <nav className="flex items-center gap-5 text-sm text-neutral-400">
          <a
            href={`https://github.com/${REPO_OWNER}/${REPO_NAME}`}
            target="_blank"
            rel="noreferrer"
            className="hover:text-white transition-colors"
          >
            GitHub
          </a>
          <Link href="/" className="hover:text-white transition-colors">Sign in</Link>
        </nav>
      </header>

      <section className="flex-1 flex flex-col items-center justify-center px-6 py-16 sm:py-24">
        <div className="w-full max-w-3xl space-y-12">

          <div className="space-y-4 text-center sm:text-left">
            <p className="text-xs uppercase tracking-[0.18em] text-neutral-500">
              Rax for macOS · v{version} {release?.published_at && `· ${formatDate(release.published_at)}`}
            </p>
            <h1 className="text-4xl sm:text-5xl font-semibold tracking-tight leading-[1.05]">
              Claude Code,<br className="hidden sm:block" />
              with a voice and a face.
            </h1>
            <p className="text-base text-neutral-400 max-w-xl sm:mx-0 mx-auto">
              Five named agents, an ambient voice orb, live code preview, and a
              caption pill that follows you across spaces — wrapped around the
              real <span className="text-neutral-200 font-mono">claude</span> CLI.
            </p>
          </div>

          <div className="rounded-2xl border border-neutral-800 bg-neutral-950/60 p-6 sm:p-8 space-y-6">
            <DownloadButton
              defaultArchIsArm={looksAppleSilicon}
              armUrl={armDmg?.browser_download_url ?? null}
              intelUrl={x64Dmg?.browser_download_url ?? null}
              universalUrl={universalDmg?.browser_download_url ?? null}
              version={version}
            />

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
              {armDmg && (
                <a
                  href={armDmg.browser_download_url}
                  className="group flex items-center justify-between rounded-lg border border-neutral-800 px-4 py-3 hover:border-neutral-600 transition-colors"
                >
                  <span>
                    <span className="block text-neutral-200">Apple Silicon</span>
                    <span className="block text-xs text-neutral-500">M1 / M2 / M3 / M4 · DMG</span>
                  </span>
                  <span className="text-xs text-neutral-500 group-hover:text-neutral-300 transition-colors">
                    {formatSize(armDmg.size)} ↓
                  </span>
                </a>
              )}
              {x64Dmg && (
                <a
                  href={x64Dmg.browser_download_url}
                  className="group flex items-center justify-between rounded-lg border border-neutral-800 px-4 py-3 hover:border-neutral-600 transition-colors"
                >
                  <span>
                    <span className="block text-neutral-200">Intel</span>
                    <span className="block text-xs text-neutral-500">x86_64 · DMG</span>
                  </span>
                  <span className="text-xs text-neutral-500 group-hover:text-neutral-300 transition-colors">
                    {formatSize(x64Dmg.size)} ↓
                  </span>
                </a>
              )}
              {!armDmg && !x64Dmg && universalDmg && (
                <a
                  href={universalDmg.browser_download_url}
                  className="group sm:col-span-2 flex items-center justify-between rounded-lg border border-neutral-800 px-4 py-3 hover:border-neutral-600 transition-colors"
                >
                  <span>
                    <span className="block text-neutral-200">macOS — Universal</span>
                    <span className="block text-xs text-neutral-500">Apple Silicon + Intel · DMG</span>
                  </span>
                  <span className="text-xs text-neutral-500 group-hover:text-neutral-300 transition-colors">
                    {formatSize(universalDmg.size)} ↓
                  </span>
                </a>
              )}
            </div>

            <p className="text-xs text-neutral-500">
              Requires macOS 12 Monterey or later. After download: open the DMG,
              drag <span className="font-mono text-neutral-300">Rax</span> to
              Applications, then launch from Spotlight. Auto-update is built in.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm">
            {[
              { title: 'Five agents', desc: 'Max, Alex, Luna, Nova, Zara — a fixed roster in a floating dock.' },
              { title: 'Voice orb', desc: 'Always-on-top Siri-style orb. Push-to-talk on Option+R.' },
              { title: 'Live preview', desc: 'Embedded <webview> spins up your dev server inside the window.' },
            ].map((f) => (
              <div key={f.title} className="rounded-lg border border-neutral-800/70 p-4 space-y-1">
                <div className="text-neutral-200 font-medium">{f.title}</div>
                <div className="text-xs text-neutral-500 leading-relaxed">{f.desc}</div>
              </div>
            ))}
          </div>

          {release && (
            <div className="space-y-3 text-sm">
              <div className="flex items-center justify-between">
                <h2 className="text-neutral-300 font-medium">
                  What&apos;s new in v{version}
                </h2>
                <a
                  href={release.html_url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs text-neutral-500 hover:text-white transition-colors"
                >
                  Full release notes ↗
                </a>
              </div>
              {release.body && (
                <pre className="text-xs text-neutral-400 whitespace-pre-wrap font-mono leading-relaxed rounded-lg border border-neutral-800/70 bg-neutral-950/40 p-4 max-h-72 overflow-auto">
                  {release.body.length > 1600 ? `${release.body.slice(0, 1600)}\n\n…` : release.body}
                </pre>
              )}
            </div>
          )}

          {!release && (
            <div className="rounded-lg border border-amber-900/40 bg-amber-950/20 p-4 text-sm text-amber-200/90">
              No public release yet — check back shortly, or visit{' '}
              <a
                href={`https://github.com/${REPO_OWNER}/${REPO_NAME}/releases`}
                className="underline"
                target="_blank"
                rel="noreferrer"
              >
                the releases page
              </a>.
            </div>
          )}
        </div>
      </section>

      <footer className="px-6 sm:px-10 py-8 border-t border-neutral-900 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 text-xs text-neutral-500">
        <span>© {new Date().getFullYear()} Rax — MIT licensed.</span>
        <span className="flex gap-4">
          <Link href="/terms" className="hover:text-white transition-colors">Terms</Link>
          <Link href="/privacy" className="hover:text-white transition-colors">Privacy</Link>
          <a
            href={`https://github.com/${REPO_OWNER}/${REPO_NAME}/issues`}
            className="hover:text-white transition-colors"
            target="_blank"
            rel="noreferrer"
          >
            Report an issue
          </a>
        </span>
      </footer>
    </main>
  )
}
