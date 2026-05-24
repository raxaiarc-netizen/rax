import './globals.css'
import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Rax',
  description: 'Claude Code, billed by the token.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="font-mono antialiased">{children}</body>
    </html>
  )
}
