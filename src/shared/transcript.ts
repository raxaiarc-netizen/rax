import type { Message, TabState } from './types'

export interface TranscriptInput {
  title: string
  workingDirectory: string
  sessionModel: string | null
  claudeSessionId: string | null
  sessionVersion: string | null
  messages: Message[]
  lastResult: TabState['lastResult']
  exportedAt: number
}

function formatTimestamp(ms: number): string {
  return new Date(ms).toISOString()
}

function formatCost(usd: number): string {
  return usd >= 0.01 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(4)}`
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  return `${m}m ${Math.round(s - m * 60)}s`
}

function roleHeading(role: Message['role']): string {
  switch (role) {
    case 'user': return 'You'
    case 'assistant': return 'Claude'
    case 'tool': return 'Tool'
    case 'system': return 'System'
  }
}

function renderMessage(m: Message): string {
  const heading = `### ${roleHeading(m.role)} · ${formatTimestamp(m.timestamp)}`
  if (m.role === 'tool') {
    const name = m.toolName ?? 'tool'
    const input = m.toolInput ? `\n\n\`\`\`json\n${m.toolInput}\n\`\`\`` : ''
    const status = m.toolStatus ? ` _(${m.toolStatus})_` : ''
    return `${heading}\n\n**${name}**${status}${input}`
  }
  return `${heading}\n\n${m.content.trim()}`
}

export function tabToMarkdown(input: TranscriptInput): string {
  const lines: string[] = []
  lines.push(`# ${input.title || 'Rax transcript'}`)
  lines.push('')
  lines.push('## Session metadata')
  lines.push('')
  lines.push(`- **Exported:** ${formatTimestamp(input.exportedAt)}`)
  lines.push(`- **Working directory:** \`${input.workingDirectory}\``)
  if (input.sessionModel) lines.push(`- **Model:** ${input.sessionModel}`)
  if (input.claudeSessionId) lines.push(`- **Session ID:** \`${input.claudeSessionId}\``)
  if (input.sessionVersion) lines.push(`- **Claude Code version:** ${input.sessionVersion}`)
  if (input.lastResult) {
    lines.push(`- **Last run cost:** ${formatCost(input.lastResult.totalCostUsd)}`)
    lines.push(`- **Last run duration:** ${formatDuration(input.lastResult.durationMs)}`)
    lines.push(`- **Turns:** ${input.lastResult.numTurns}`)
  }
  lines.push('')

  if (input.messages.length === 0) {
    lines.push('_(no messages in this session yet)_')
    return lines.join('\n')
  }

  lines.push('## Conversation')
  lines.push('')
  for (const m of input.messages) {
    lines.push(renderMessage(m))
    lines.push('')
    lines.push('---')
    lines.push('')
  }
  // Drop trailing separator
  while (lines.length && (lines[lines.length - 1] === '' || lines[lines.length - 1] === '---')) {
    lines.pop()
  }
  lines.push('')
  return lines.join('\n')
}

export function defaultExportFilename(title: string, exportedAt: number): string {
  const safe = (title || 'rax-transcript')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'rax-transcript'
  const stamp = new Date(exportedAt).toISOString().replace(/[:.]/g, '-').slice(0, 19)
  return `${safe}-${stamp}.md`
}
