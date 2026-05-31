import type { Config } from 'tailwindcss'

export default {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        display: ['var(--font-display)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        script:  ['var(--font-script)',  'ui-serif', 'Georgia', 'serif'],
        sans:    ['var(--font-sans)',    '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'sans-serif'],
        mono:    ['var(--font-mono)',    'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      colors: {
        // Light surfaces
        cream:      'var(--cream)',
        cream2:     'var(--cream-2)',
        paper:      'var(--paper)',
        surface:    'var(--surface)',
        surface2:   'var(--surface-2)',
        // Ink
        ink:        'var(--ink)',
        ink2:       'var(--ink-2)',
        muted:      'var(--muted)',
        soft:       'var(--soft)',
        line:       'var(--line)',
        'line-2':   'var(--line-2)',
        'line-3':   'var(--line-3)',
        // Brand + agent accents
        lime:       'var(--lime)',
        'lime-soft':'var(--lime-soft)',
        'lime-deep':'var(--lime-deep)',
        butter:     'var(--butter)',
        coral:      'var(--coral)',
        sky:        'var(--sky)',
        ocean:      'var(--ocean)',
        plum:       'var(--plum)',
        // Dark contrast surface
        ink999:     'var(--ink-999)',
        ink900:     'var(--ink-900)',
        ink800:     'var(--ink-800)',
        // Agent personal
        'agent-max':   'var(--agent-max)',
        'agent-alex':  'var(--agent-alex)',
        'agent-luna':  'var(--agent-luna)',
        'agent-nova':  'var(--agent-nova)',
        'agent-zara':  'var(--agent-zara)',
      },
      letterSpacing: {
        mega:  '-0.045em',
        ultra: '-0.06em',
        wider2:'0.18em',
      },
      borderRadius: {
        '4xl': '2rem',
        '5xl': '2.5rem',
      },
    },
  },
  plugins: [],
} satisfies Config
