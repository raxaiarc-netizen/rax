import Link from 'next/link'
import Image from 'next/image'
import { redirect } from 'next/navigation'
import { supabaseServer } from '@/lib/supabase-server'
import LoginForm from './login-form'
import LiveDemo from './_components/live-demo'
import NotchDemo from './_components/notch-demo'
import MascotShowcase from './_components/mascot-showcase'
import { BeamButton } from './_components/beam-button'

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>
}) {
  const { next } = await searchParams
  const sb = await supabaseServer()
  const { data: { user } } = await sb.auth.getUser()
  if (user) redirect(next ?? '/app/dashboard')

  return (
    <main className="relative min-h-screen flex flex-col overflow-x-hidden">
      <TopBar />
      <Hero />
      <MeetTheLittleGuy />
      <Crew />
      <Capabilities />
      <LiveSection />
      <FinalCta />
      <Footer />
    </main>
  )
}

/* ─────────────────────────── Hero ─────────────────────────── */

function Hero() {
  return (
    <section className="px-5 sm:px-8 pt-10 sm:pt-16 pb-20 sm:pb-28">
      <div className="max-w-[1240px] mx-auto grid lg:grid-cols-[1.35fr_1fr] gap-12 lg:gap-20 items-center">
        <div className="space-y-7 enter enter-d1">
          <span className="eyebrow-pill">
            <span className="dot" /> five agents · one desktop
          </span>
          <h1 className="display-xl">
            Your engineering crew,{' '}
            <span className="text-muted">on your desktop.</span>
          </h1>
          <p className="text-[17px] sm:text-[18px] leading-relaxed text-muted max-w-[52ch]">
            Five named agents — a living notch companion, floating dock, live preview.
            Free to install. Pay only for the tokens the crew burns.
          </p>
          <div className="flex flex-wrap items-center gap-3 pt-1">
            <BeamButton>
              <Link href="/download" className="btn-lime !text-[15px] relative z-10 !bg-white !text-ink !border-none">
                download for macOS <span aria-hidden>↓</span>
              </Link>
            </BeamButton>
            <a href="#crew" className="btn-ghost !text-[14px]">
              meet the crew
            </a>
          </div>
        </div>

        <div className="relative enter enter-d3">
          <div className="flex items-center -space-x-5 sm:-space-x-6">
            {CREW.map((m, i) => (
              <div
                key={m.name}
                className="relative w-[88px] h-[88px] sm:w-[104px] sm:h-[104px] rounded-2xl overflow-hidden ring-4 ring-cream shadow-[0_14px_36px_-18px_rgba(12,12,12,0.25)] bg-ink-900 transition-transform duration-200 ease-out hover:-translate-y-2"
                style={{ zIndex: CREW.length - i }}
              >
                <Image
                  src={m.img}
                  alt={m.name}
                  width={208}
                  height={208}
                  className="block w-full h-full object-cover"
                />
              </div>
            ))}
          </div>
          <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12.5px] text-muted">
            {CREW.map((m, i) => (
              <span key={m.name} className="inline-flex items-center gap-2">
                <span className={'font-display font-semibold text-ink'}>{m.name}</span>
                <span className="font-mono text-[10px] tracking-[0.18em] uppercase text-soft">
                  {m.role}
                </span>
                {i < CREW.length - 1 && <span className="text-soft">·</span>}
              </span>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}

/* ─────────────────────────── Meet the little guy ─────────────────────────── */

function MeetTheLittleGuy() {
  return (
    <section className="px-5 sm:px-8 pb-20 sm:pb-28 overflow-hidden">
      <div className="max-w-[1240px] mx-auto">
        <div className="text-center space-y-5 mb-2 enter enter-d2">
          <span className="eyebrow-pill mx-auto">
            <span className="dot" /> the notch companion
          </span>
          <h2 className="display-lg">
            Say hello to <span className="script text-lime-deep text-[1.1em]">the little guy.</span>
          </h2>
          <p className="text-[16px] sm:text-[17px] leading-relaxed text-muted max-w-[56ch] mx-auto">
            He lives wrapped around your MacBook&rsquo;s notch. Hold <span className="cmd">⌥+R</span> and
            talk — he leans in, thinks with the crew, and answers out loud while the work
            floats in around him.
          </p>
        </div>
        <MascotShowcase />
      </div>
    </section>
  )
}

/* ─────────────────────────── Top bar ─────────────────────────── */

function TopBar() {
  return (
    <header className="px-5 sm:px-8 pt-5 sm:pt-7 pb-2">
      <div className="max-w-[1240px] mx-auto flex items-center justify-between">
        <Link href="/" className="flex items-center gap-3 group">
          <span className="brand-mark brand-mark-lg" aria-hidden />
          <span className="font-display font-bold text-[20px] tracking-[-0.02em] text-ink">rax</span>
        </Link>
        <nav className="hidden md:flex items-center gap-7 text-[14px] text-muted">
          <a href="#crew" className="btn-link">the crew</a>
          <a href="#what" className="btn-link">what you get</a>
          <a href="#live" className="btn-link">live mode</a>
        </nav>
        <div className="flex items-center gap-3">
          <Link href="/signin" className="hidden sm:inline-flex btn-link text-[14px]">sign in</Link>
          <Link href="/download" className="btn-primary !py-2.5 !px-5 !text-[13.5px]">
            get rax <span aria-hidden>↓</span>
          </Link>
        </div>
      </div>
    </header>
  )
}

/* ─────────────────────────── The crew ─────────────────────────── */

const CREW: {
  name: string
  role: string
  img: string
  tag: string
  blurb: string
  bg: string
  accent: string
  sticker: 'lime' | 'butter' | 'sky' | 'coral' | 'plum'
}[] = [
  {
    name: 'Max',  role: 'orchestrator', img: '/max.png',  tag: '/plan',
    blurb: 'Routes the work, holds the plan, keeps the crew honest. Talk to Max first when you don\'t know who to ask.',
    bg: 'bg-[#dffaf9]', accent: 'text-[#0e8f8b]', sticker: 'lime',
  },
  {
    name: 'Alex', role: 'engineer',     img: '/alex.png', tag: '/ship',
    blurb: 'Writes the code. Reaches for the diff before the docs. Ships fast, reviews carefully.',
    bg: 'bg-[#dde6ff]', accent: 'text-[#3362ff]', sticker: 'sky',
  },
  {
    name: 'Luna', role: 'designer',     img: '/luna.png', tag: '/refine',
    blurb: 'Hairlines, hierarchy, breathing room. The polish layer that makes your app feel expensive.',
    bg: 'bg-[#ece1ff]', accent: 'text-[#7a4dd6]', sticker: 'plum',
  },
  {
    name: 'Nova', role: 'researcher',   img: '/nova.png', tag: '/dig',
    blurb: 'Trawls logs, papers, and your codebase. Brings receipts. Never makes things up.',
    bg: 'bg-[#dbf5e6]', accent: 'text-[#19914e]', sticker: 'lime',
  },
  {
    name: 'Zara', role: 'debugger',     img: '/zara.png', tag: '/trace',
    blurb: 'Stack traces, not vibes. Finds it, names it, fixes it — without breaking three other things.',
    bg: 'bg-[#ffe2ee]', accent: 'text-[#c93b73]', sticker: 'coral',
  },
]

function Crew() {
  return (
    <section id="crew" className="px-5 sm:px-8 pt-8 sm:pt-12 pb-20 sm:pb-28 border-t border-line">
      <div className="max-w-[1240px] mx-auto">
        <div className="ribbon">
          <span className="num">01</span>
          <span className="rule" />
          <span className="label">meet the crew · five agents · one dock</span>
        </div>

        <div className="grid lg:grid-cols-[1fr_1fr] gap-10 lg:gap-16 items-end mb-12">
          <h2 className="display-lg">
            Not a chatbot.
            <br />
            <span className="script text-lime-deep text-[1.1em]">A whole crew.</span>
          </h2>
          <p className="text-[17px] leading-relaxed text-muted max-w-[52ch] lg:pb-3">
            Each agent has a name, a face, a voice, and a job they actually want.
            They live in a floating dock on the left edge of your screen — colour-coded,
            addressable, and one click away. You always know who&rsquo;s working.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {CREW.map((m, i) => (
            <article key={m.name} className={'card card-hover overflow-hidden ' + m.bg}>
              <div className="relative aspect-[5/4] bg-ink-900 overflow-hidden">
                <Image
                  src={m.img}
                  alt={`${m.name} — ${m.role}`}
                  width={1080}
                  height={1080}
                  className="block w-full h-full object-cover"
                />
                <div className="absolute top-3 left-3">
                  <span className={'sticker sticker-' + m.sticker}>{m.tag}</span>
                </div>
                <div className="absolute bottom-3 right-3">
                  <span className="font-mono text-[10px] tracking-[0.2em] uppercase text-cream/70">0{i + 1} / 05</span>
                </div>
              </div>
              <div className="p-6 space-y-3">
                <div className="flex items-baseline justify-between">
                  <h3 className="font-display font-bold text-[32px] tracking-[-0.02em] text-ink leading-none">
                    {m.name}
                  </h3>
                  <span className={'font-mono text-[10.5px] tracking-[0.2em] uppercase ' + m.accent}>
                    {m.role}
                  </span>
                </div>
                <p className="text-[14.5px] text-muted leading-relaxed">{m.blurb}</p>
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  )
}

/* ─────────────────────────── Capabilities ─────────────────────────── */

function Capabilities() {
  return (
    <section id="what" className="px-5 sm:px-8 py-20 sm:py-28 border-t border-line">
      <div className="max-w-[1240px] mx-auto">
        <div className="ribbon">
          <span className="num">02</span>
          <span className="rule" />
          <span className="label">what you get</span>
        </div>

        <h2 className="display-lg mb-14 max-w-[22ch]">
          A real desktop app. Not another tab.
        </h2>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
          {/* Notch */}
          <article className="card card-hover overflow-hidden p-7 space-y-5">
            <div className="flex items-start justify-between">
              <span className="sticker sticker-lime">notch</span>
              <span className="font-mono text-[10.5px] tracking-[0.2em] uppercase text-muted">01 / 03</span>
            </div>
            <div className="py-3">
              <NotchDemo />
            </div>
            <h3 className="font-display font-bold text-[26px] tracking-[-0.02em] text-ink">
              He lives in your notch
            </h3>
            <p className="text-[14.5px] text-muted leading-relaxed">
              A little robot wrapped around the menu-bar notch. Hold <span className="cmd">⌥+R</span> to
              speak — he leans in while you talk, gazes off while the crew thinks, and dances
              to his own voice when he answers. Try his moods above.
            </p>
          </article>

          {/* Dock */}
          <article className="card card-hover overflow-hidden p-7 space-y-5">
            <div className="flex items-start justify-between">
              <span className="sticker sticker-sky">dock</span>
              <span className="font-mono text-[10.5px] tracking-[0.2em] uppercase text-muted">02 / 03</span>
            </div>
            <div className="py-3 flex justify-center">
              <div className="dock">
                {CREW.map((m, i) => (
                  <div key={m.name} className={'dock-agent ' + (i === 0 ? 'is-active' : '')}>
                    <Image src={m.img} alt={m.name} width={88} height={88} />
                  </div>
                ))}
              </div>
            </div>
            <h3 className="font-display font-bold text-[26px] tracking-[-0.02em] text-ink">
              The floating dock
            </h3>
            <p className="text-[14.5px] text-muted leading-relaxed">
              The whole crew lives on the left edge, vertical, always one click away.
              Click an agent to call them. The active one glows in their colour.
              Drag the dock anywhere you like.
            </p>
          </article>

          {/* Live preview */}
          <article className="card card-hover overflow-hidden p-7 space-y-5">
            <div className="flex items-start justify-between">
              <span className="sticker">preview</span>
              <span className="font-mono text-[10.5px] tracking-[0.2em] uppercase text-muted">03 / 03</span>
            </div>
            <div className="py-3">
              <div className="rounded-2xl border border-line-2 bg-paper p-3 shadow-[0_10px_30px_-12px_rgba(12,18,40,0.18)]">
                <div className="flex items-center gap-1.5 pb-2 border-b border-line">
                  <span className="w-2.5 h-2.5 rounded-full bg-coral" />
                  <span className="w-2.5 h-2.5 rounded-full bg-butter" />
                  <span className="w-2.5 h-2.5 rounded-full bg-lime" />
                  <span className="ml-2 font-mono text-[9.5px] tracking-[0.16em] uppercase text-muted">localhost:3000</span>
                </div>
                <div className="aspect-[4/2.5] rounded-md bg-cream2 mt-3 flex items-center justify-center">
                  <span className="font-display font-bold text-[22px] text-ink/40">your app</span>
                </div>
              </div>
            </div>
            <h3 className="font-display font-bold text-[26px] tracking-[-0.02em] text-ink">
              Live preview, in-window
            </h3>
            <p className="text-[14.5px] text-muted leading-relaxed">
              An embedded webview spins up your dev server inside Rax. Watch the crew
              push an edit and see your app refresh — no context-switch, no missed reload.
            </p>
          </article>
        </div>
      </div>
    </section>
  )
}

/* ─────────────────────────── Live demo ─────────────────────────── */

function LiveSection() {
  return (
    <section id="live" className="px-5 sm:px-8 py-20 sm:py-28 border-t border-line">
      <div className="max-w-[1240px] mx-auto">
        <div className="grid lg:grid-cols-[0.8fr_1.2fr] gap-12 lg:gap-16 items-start">
          <div className="lg:sticky lg:top-24 space-y-7">
            <div className="ribbon">
              <span className="num">03</span>
              <span className="rule" />
              <span className="label">live mode · watch them work</span>
            </div>
            <h2 className="display-lg">
              <span className="halo-lime">Five turns</span> in a row.
              <br />
              No hands.
            </h2>
            <p className="text-[15.5px] leading-relaxed text-muted max-w-[40ch]">
              Talk to one, the others quiet down. Talk to nobody, Max routes for you.
              Every turn shows up in the notch bar — even when Rax is behind another window.
            </p>
            <ul className="space-y-3 text-[14.5px] text-ink">
              <li className="flex items-center gap-3">
                <span className="dot" />
                <span>push-to-talk on <span className="cmd">⌥+R</span></span>
              </li>
              <li className="flex items-center gap-3">
                <span className="dot dot-ocean" />
                <span>dev server in-window · auto-reload</span>
              </li>
              <li className="flex items-center gap-3">
                <span className="dot dot-plum" />
                <span>auto-recap when an agent finishes</span>
              </li>
              <li className="flex items-center gap-3">
                <span className="dot dot-butter" />
                <span>balance ticks live · no surprises</span>
              </li>
            </ul>
          </div>

          <div className="enter enter-d2">
            <LiveDemo />
          </div>
        </div>
      </div>
    </section>
  )
}

/* ─────────────────────────── Final CTA ─────────────────────────── */

function FinalCta() {
  return (
    <section className="px-5 sm:px-8 py-24 sm:py-32 border-t border-line">
      <div className="max-w-[1240px] mx-auto">
        <div
          className="relative rounded-[32px] overflow-hidden"
          style={{
            background: 'linear-gradient(150deg, #4d7aff 0%, #3362ff 60%, #2952e3 100%)',
            border: '1px solid rgba(255,255,255,0.1)',
          }}
        >
          <div aria-hidden style={{ position:'absolute', top:'-80px', right:'-80px', width:'480px', height:'480px', borderRadius:'50%', background:'radial-gradient(circle, rgba(255,255,255,0.1) 0%, transparent 65%)', pointerEvents:'none' }} />
          <div aria-hidden style={{ position:'absolute', bottom:'-60px', left:'10%', width:'360px', height:'360px', borderRadius:'50%', background:'radial-gradient(circle, rgba(100,140,255,0.22) 0%, transparent 65%)', pointerEvents:'none' }} />
          <div aria-hidden style={{ position:'absolute', inset:0, backgroundImage:'radial-gradient(rgba(255,255,255,0.07) 1px, transparent 1px)', backgroundSize:'28px 28px', pointerEvents:'none' }} />

          <div className="relative grid lg:grid-cols-[1fr_1.2fr] gap-0 items-stretch">

            <div
              className="flex flex-col items-center justify-center gap-0 p-10 sm:p-14"
              style={{ borderRight: '1px solid rgba(255,255,255,0.1)' }}
            >
              {/* Row 1: 3 avatars */}
              <div className="flex items-end justify-center gap-4">
                {CREW.slice(0, 3).map((m, i) => (
                  <div key={m.name} className="flex flex-col items-center gap-2">
                    <div style={{ width: i === 1 ? '96px' : '72px', height: i === 1 ? '96px' : '72px', borderRadius:'20px', overflow:'hidden', border: i === 1 ? '2px solid rgba(255,255,255,0.45)' : '2px solid rgba(255,255,255,0.2)', background:'#1a2f8a', flexShrink:0, boxShadow: i === 1 ? '0 8px 32px -8px rgba(0,0,0,0.35)' : 'none' }}>
                      <Image src={m.img} alt={m.name} width={192} height={192} style={{ width:'100%', height:'100%', objectFit:'cover' }} />
                    </div>
                    <span style={{ fontFamily:'var(--font-mono)', fontSize:'10px', letterSpacing:'0.14em', textTransform:'uppercase', color: i === 1 ? 'rgba(255,255,255,0.7)' : 'rgba(255,255,255,0.4)' }}>{m.name}</span>
                  </div>
                ))}
              </div>
              {/* Row 2: 2 avatars centered */}
              <div className="flex items-end justify-center gap-4 mt-4">
                {CREW.slice(3, 5).map((m) => (
                  <div key={m.name} className="flex flex-col items-center gap-2">
                    <div style={{ width:'72px', height:'72px', borderRadius:'20px', overflow:'hidden', border:'2px solid rgba(255,255,255,0.2)', background:'#1a2f8a', flexShrink:0 }}>
                      <Image src={m.img} alt={m.name} width={144} height={144} style={{ width:'100%', height:'100%', objectFit:'cover' }} />
                    </div>
                    <span style={{ fontFamily:'var(--font-mono)', fontSize:'10px', letterSpacing:'0.14em', textTransform:'uppercase', color:'rgba(255,255,255,0.4)' }}>{m.name}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="flex flex-col justify-center gap-6 p-10 sm:p-14">
              <div style={{ display:'inline-flex', alignItems:'center', gap:'8px', padding:'5px 14px', borderRadius:'999px', border:'1px solid rgba(255,255,255,0.25)', background:'rgba(255,255,255,0.1)', fontFamily:'var(--font-mono)', fontSize:'11px', letterSpacing:'0.16em', textTransform:'uppercase' as const, color:'rgba(255,255,255,0.8)', width:'fit-content' }}>
                <span style={{ width:'6px', height:'6px', borderRadius:'50%', background:'rgba(255,255,255,0.7)', display:'inline-block' }} />
                five agents · free to install
              </div>

              <h2 className="display-lg" style={{ color:'#ffffff', lineHeight:1.06 }}>
                Bring the crew home.{' '}
                <span className="script" style={{ color:'rgba(255,255,255,0.7)', fontSize:'1.05em' }}>Ship tonight.</span>
              </h2>

              <p style={{ fontSize:'16px', lineHeight:'1.72', color:'rgba(255,255,255,0.65)', maxWidth:'40ch' }}>
                Rax is free to install. Pay only when the crew works — by the token,
                at Anthropic&rsquo;s published rates plus 30%. Credits never expire.
              </p>

              <div>
                <BeamButton variant="white">
                  <Link
                    href="/download"
                    style={{
                      display:'inline-flex', alignItems:'center', gap:'10px',
                      background:'#ffffff', color:'#0c0c0c',
                      fontFamily:'var(--font-display)', fontWeight:700,
                      letterSpacing:'-0.01em', border:'none',
                      borderRadius:'999px', padding:'15px 30px', fontSize:'16px',
                      boxShadow:'0 10px 40px -10px rgba(0,0,0,0.3)',
                      position:'relative', zIndex:1,
                    }}
                  >
                    download rax for macOS <span aria-hidden>↓</span>
                  </Link>
                </BeamButton>
              </div>

              <div style={{ display:'flex', alignItems:'center', gap:'14px', fontFamily:'var(--font-mono)', fontSize:'11px', letterSpacing:'0.1em', color:'rgba(255,255,255,0.38)' }}>
                <span>macOS 13+</span>
                <span style={{ width:'3px', height:'3px', borderRadius:'50%', background:'rgba(255,255,255,0.3)', display:'inline-block' }} />
                <span>Apple Silicon & Intel</span>
                <span style={{ width:'3px', height:'3px', borderRadius:'50%', background:'rgba(255,255,255,0.3)', display:'inline-block' }} />
                <span>no subscription</span>
              </div>
            </div>

          </div>
        </div>
      </div>
    </section>
  )
}

/* ─────────────────────────── Sign in ─────────────────────────── */

function SignIn({ next }: { next: string }) {
  return (
    <section id="signin" className="px-5 sm:px-8 pt-4 pb-20">
      <div className="max-w-[640px] mx-auto card p-7 sm:p-8 bg-paper">
        <div className="flex items-center justify-between mb-5">
          <div>
            <div className="font-mono text-[10.5px] tracking-[0.18em] uppercase text-muted">
              already have an account?
            </div>
            <h2 className="display-md mt-1">Welcome back.</h2>
          </div>
          <span className="font-mono text-[10px] tracking-[0.18em] uppercase text-soft">↳ 0x01</span>
        </div>
        <LoginForm next={next} />
      </div>
    </section>
  )
}

/* ─────────────────────────── Footer ─────────────────────────── */

function Footer() {
  return (
    <footer className="px-5 sm:px-8 py-8 border-t border-line bg-paper">
      <div className="max-w-[1240px] mx-auto flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 font-mono text-[11.5px] tracking-[0.02em] text-muted">
        <div className="flex items-center gap-3">
          <span className="brand-mark scale-75 origin-left" aria-hidden />
          <span>© {new Date().getFullYear()} rax</span>
        </div>
        <div className="flex items-center gap-5">
          <Link href="/terms" className="btn-link">terms</Link>
          <Link href="/privacy" className="btn-link">privacy</Link>
          <Link href="/download" className="btn-link">download ↓</Link>
        </div>
      </div>
    </footer>
  )
}
