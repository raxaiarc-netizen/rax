import './globals.css'
import type { Metadata } from 'next'
import { Poppins, Caveat, Fragment_Mono } from 'next/font/google'

const poppins = Poppins({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
  variable: '--font-poppins',
  display: 'swap',
})

const script = Caveat({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-script',
  display: 'swap',
})

const mono = Fragment_Mono({
  subsets: ['latin'],
  weight: '400',
  variable: '--font-mono',
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'Rax — your AI engineering crew, on your desktop',
  description:
    'Five named agents, an ambient voice orb, and live preview — a friendly desktop crew that ships code for you. Pay only for the tokens you use.',
  icons: {
    icon: [{ url: '/rax-logo.png' }],
  },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${poppins.variable} ${script.variable} ${mono.variable}`}
    >
      <body className="font-sans antialiased text-ink min-h-screen" suppressHydrationWarning>
        <div className="bg-cream-base" aria-hidden />
        {children}
      </body>
    </html>
  )
}
