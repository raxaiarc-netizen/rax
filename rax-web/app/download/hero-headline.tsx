'use client'

export function HeroHeadline() {
  return (
    <h1 className="display-xl">
      <span className="text-muted">Ready to install.</span>
      <br />
      Your crew
      <span
        aria-hidden
        style={{
          width: '0.18em',
          height: '0.18em',
          borderRadius: '50%',
          background:
            'radial-gradient(circle at 35% 28%, #ffffff 0%, #7da1ff 45%, #3362ff 100%)',
          boxShadow: '0 4px 20px -2px rgba(51,98,255,0.6)',
          display: 'inline-block',
          verticalAlign: '0.05em',
          marginLeft: '0.12em',
          animation: 'orb-breathe 4.2s ease-in-out infinite',
        }}
      />
    </h1>
  )
}
