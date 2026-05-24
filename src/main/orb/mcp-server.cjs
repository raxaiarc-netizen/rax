#!/usr/bin/env node
/* eslint-disable */
// MCP stdio shim for Rax's voice orb. Claude spawns this; it proxies every
// tools/call to the orb's local HTTP bridge inside Electron main.
//
// Protocol: JSON-RPC 2.0 over stdio, line-delimited.
// Auth: RAX_ORB_RPC_URL + RAX_ORB_RPC_SECRET supplied via env.
//
// This file is intentionally CommonJS with zero deps — it must run anywhere
// node is available, with no build step.

'use strict'

const http = require('http')
const { URL } = require('url')

const RPC_URL = process.env.RAX_ORB_RPC_URL
const RPC_SECRET = process.env.RAX_ORB_RPC_SECRET

// RAX_MCP_TOOLSET filters which tools we advertise:
//   - 'orb' / unset: full set (tab tools + screen tools).
//   - 'tab': computer-use only (screenshot + control_screen). Chat tabs use
//      this — they should see + drive the screen, but should NOT be able to
//      spawn or send to other tabs (avoids loops and surprise side-effects).
const TOOLSET = (process.env.RAX_MCP_TOOLSET || 'orb').toLowerCase()

if (!RPC_URL || !RPC_SECRET) {
  process.stderr.write('rax-orb-mcp: RAX_ORB_RPC_URL or RAX_ORB_RPC_SECRET missing\n')
  process.exit(2)
}

const ALL_TOOLS = [
  {
    name: 'rax_list_tabs',
    description:
      'Roll call of your five-agent crew (Max, Alex, Luna, Nova, Zara) — current status, last user/assistant message, last tool, last error for each one. Call whenever the user mentions a teammate by name or asks "what is everyone working on".',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'rax_read_tab',
    description:
      'Read the recent message log of one crew member. Use when the user wants detail beyond the summary. Pass the agent\'s NAME as `tab` ("Max", "Alex", "Luna", "Nova", "Zara" — case-insensitive). UUID / 1-based index also accepted.',
    inputSchema: {
      type: 'object',
      properties: {
        tab: { type: 'string', description: 'Crew member name (preferred), UUID, prefix, or 1-based index.' },
        lastN: { type: 'integer', minimum: 1, maximum: 40, description: 'Default 12.' },
      },
      required: ['tab'],
      additionalProperties: false,
    },
  },
  {
    name: 'rax_open_tab',
    description:
      'LEGACY — DO NOT CALL. The Rax crew is fixed at five named agents (Max, Alex, Luna, Nova, Zara); you cannot create new ones. Use rax_send_to_tab against an idle crew member instead.',
    inputSchema: {
      type: 'object',
      properties: {
        workingDirectory: { type: 'string', description: 'Absolute or "~/..." path. Defaults to project path.' },
        prompt: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'rax_send_to_tab',
    description:
      'Dispatch a prompt to a named crew member as if the user typed it (fire and forget). Returns immediately. Pass their NAME as `tab` ("Max" / "Alex" / "Luna" / "Nova" / "Zara"). Tell the user out loud who you handed it to.',
    inputSchema: {
      type: 'object',
      properties: {
        tab: { type: 'string', description: 'Crew member name — Max, Alex, Luna, Nova, or Zara.' },
        prompt: { type: 'string' },
      },
      required: ['tab', 'prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'rax_send_to_tab_and_wait',
    description:
      'Dispatch a prompt to a named crew member AND wait for them to finish, returning their final assistant message. Use when you need their answer before you can reply. Pass agent NAME as `tab`. Waits indefinitely — no timeout.',
    inputSchema: {
      type: 'object',
      properties: {
        tab: { type: 'string', description: 'Crew member name — Max, Alex, Luna, Nova, or Zara.' },
        prompt: { type: 'string' },
      },
      required: ['tab', 'prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'rax_focus_tab',
    description: 'Bring a crew member\'s window to the foreground in the pill UI so the user can watch them work. Pass agent NAME as `tab`.',
    inputSchema: {
      type: 'object',
      properties: { tab: { type: 'string', description: 'Crew member name — Max, Alex, Luna, Nova, or Zara.' } },
      required: ['tab'],
      additionalProperties: false,
    },
  },
  {
    name: 'rax_describe_self',
    description: 'Self-description: host, project path, platform. Useful for grounding at start of conversation.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'rax_screenshot',
    description:
      'Capture the user\'s screen and return it as an image you can SEE. The OS cursor arrow is HIDDEN in the capture; instead, a red ring with a white dot is drawn over the cursor\'s position so you can tell what the user is pointing at without the arrow obscuring small UI. Use this whenever the user says "look at this", "what am I pointing at", "what\'s on my screen", or before driving the cursor with rax_control_screen so you know where to click. Captures the main display by default; pass a 1-based display index for secondary monitors. The response\'s text channel includes the cursor\'s coordinates and the image\'s pixel dimensions — both are in IMAGE PIXEL space (matching the picture you see). Pass the same image-pixel coordinates to rax_control_screen; the tool handles Retina/downscale/multi-display conversion internally.',
    inputSchema: {
      type: 'object',
      properties: {
        display: { type: 'integer', minimum: 1, maximum: 8, description: '1-based display index. Omit for main display.' },
        downscale: { type: 'boolean', description: 'Default true — clamp longest edge to 1600px. Set false for full-resolution capture.' },
        annotateCursor: { type: 'boolean', description: 'Default true — draw a red ring at the cursor location. Set false for a perfectly clean capture.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'rax_control_screen',
    description:
      'Drive the user\'s mouse and keyboard. ALWAYS take a rax_screenshot FIRST — clicks are calibrated against the most recent screenshot. Coordinates (x, y) are IMAGE-PIXEL coordinates of that screenshot (top-left origin) — i.e. the exact pixels you see in the picture. The tool internally converts those to global display points and posts real CGEvent mouse/keyboard events (not AppleScript), so clicks work reliably in browsers, Electron apps, Slack, IDEs, etc. Actions: "click" {x,y,button?}, "double_click" {x,y}, "type" {text}, "key" {key, modifiers?}, "scroll" {dy?,dx?} (real scroll-wheel — positive dy scrolls content down), "cursor_position". If the response comes back with error="accessibility_denied", tell the user out loud to approve Rax in System Settings → Privacy & Security → Accessibility, then retry. If calibrated=false comes back on a click, no screenshot has been taken yet this session — take one and retry.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['click', 'double_click', 'type', 'key', 'scroll', 'cursor_position'] },
        x: { type: 'integer' },
        y: { type: 'integer' },
        button: { type: 'string', enum: ['left', 'right'] },
        text: { type: 'string' },
        key: { type: 'string', description: 'Key name: a-z, 0-9, return, tab, space, escape, left, right, up, down, f1-f12, etc.' },
        modifiers: { type: 'array', items: { type: 'string', enum: ['cmd', 'command', 'shift', 'alt', 'option', 'opt', 'ctrl', 'control'] } },
        dy: { type: 'integer', description: 'Vertical scroll delta in pixels. Positive scrolls content down (page moves up), negative scrolls up.' },
        dx: { type: 'integer', description: 'Horizontal scroll delta in pixels. Positive scrolls content right.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
]

const TOOL_TO_PATH = {
  rax_list_tabs: '/list_tabs',
  rax_read_tab: '/read_tab',
  rax_open_tab: '/open_tab',
  rax_send_to_tab: '/send_to_tab',
  rax_send_to_tab_and_wait: '/send_to_tab_and_wait',
  rax_focus_tab: '/focus_tab',
  rax_describe_self: '/describe_self',
  rax_screenshot: '/screenshot',
  rax_control_screen: '/control_screen',
}

// Filter the advertised tool list per toolset. Tab sessions only see the
// computer-use subset; orb sessions see everything (backward-compatible).
const TAB_TOOL_NAMES = new Set(['rax_screenshot', 'rax_control_screen', 'rax_describe_self'])
const TOOLS = TOOLSET === 'tab'
  ? ALL_TOOLS.filter((t) => TAB_TOOL_NAMES.has(t.name))
  : ALL_TOOLS

function postJson(path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, RPC_URL)
    const data = JSON.stringify(body || {})
    const opts = {
      method: 'POST',
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        Authorization: 'Bearer ' + RPC_SECRET,
      },
    }
    const req = http.request(opts, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8')
        try {
          const parsed = raw ? JSON.parse(raw) : {}
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error('HTTP ' + res.statusCode + ': ' + (parsed && parsed.error ? parsed.error : raw)))
            return
          }
          resolve(parsed)
        } catch (err) {
          reject(new Error('Bad RPC response: ' + raw.slice(0, 200)))
        }
      })
    })
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id: id, result: result })
}

function error(id, code, message, data) {
  const err = { code: code, message: message }
  if (data !== undefined) err.data = data
  send({ jsonrpc: '2.0', id: id, error: err })
}

async function handle(msg) {
  const id = msg.id
  const method = msg.method
  const params = msg.params || {}

  // Notifications — no response.
  if (id === undefined || id === null) {
    // claude sends notifications/initialized after the initialize handshake.
    return
  }

  switch (method) {
    case 'initialize':
      reply(id, {
        protocolVersion: params.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'rax-orb', version: '0.1.0' },
      })
      return

    case 'tools/list':
      reply(id, { tools: TOOLS })
      return

    case 'tools/call': {
      const name = params.name
      const args = params.arguments || {}
      const path = TOOL_TO_PATH[name]
      if (!path) {
        error(id, -32601, 'Unknown tool: ' + name)
        return
      }
      // Defense in depth: if this toolset doesn't advertise the tool, deny —
      // the LLM shouldn't be able to invoke a hidden tool by name.
      if (TOOLSET === 'tab' && !TAB_TOOL_NAMES.has(name)) {
        error(id, -32601, 'Tool not available in tab toolset: ' + name)
        return
      }
      try {
        const result = await postJson(path, args)
        const isError = !!(result && result.error)
        let content
        if (isError) {
          content = [{ type: 'text', text: 'Error: ' + result.error + (result.message ? ' — ' + result.message : '') }]
        } else if (result && typeof result.base64 === 'string' && typeof result.mimeType === 'string') {
          // Image-bearing result (rax_screenshot) — surface as MCP image content
          // so the model actually sees the pixels instead of a base64 wall of text.
          const meta = []
          if (result.bytes) meta.push(result.bytes + ' bytes')
          if (result.display) meta.push('display ' + result.display)
          if (result.imageSize) meta.push(result.imageSize.width + '×' + result.imageSize.height + ' px')
          let cursorLine = ''
          if (result.cursor && typeof result.cursor.x === 'number' && typeof result.cursor.y === 'number') {
            const onCap = result.cursor.onCapturedDisplay !== false
            if (onCap && result.cursorMarker) {
              cursorLine =
                '\nUser\'s cursor is at image-pixel (' + result.cursor.x + ', ' + result.cursor.y +
                '), top-left origin. The RED RING + white dot in the image marks that exact spot — that is what the user is pointing at. Pass these same coordinates to rax_control_screen to click there.'
            } else if (onCap) {
              cursorLine =
                '\nUser\'s cursor is at image-pixel (' + result.cursor.x + ', ' + result.cursor.y + '), top-left origin.'
            } else {
              const cursorIdx = result.cursor.cursorDisplayIndex
              const capIdx = result.cursor.capturedDisplayIndex
              const idxNote = (cursorIdx && capIdx)
                ? ' (cursor on display ' + cursorIdx + ', captured display ' + capIdx + ')'
                : ''
              cursorLine =
                '\nUser\'s cursor is on a DIFFERENT display than the one captured' + idxNote +
                ' — no red-ring marker was drawn. Re-capture with display=' + (cursorIdx || '?') +
                ' if you need to see what they are pointing at.'
            }
          }
          content = [
            { type: 'image', data: result.base64, mimeType: result.mimeType },
            { type: 'text', text: (meta.length ? 'Captured screenshot (' + meta.join(', ') + ').' : 'Captured screenshot.') + cursorLine },
          ]
        } else {
          content = [{ type: 'text', text: JSON.stringify(result, null, 2) }]
        }
        reply(id, { content: content, isError: isError })
      } catch (err) {
        error(id, -32000, 'Tool execution failed: ' + (err && err.message ? err.message : String(err)))
      }
      return
    }

    case 'ping':
      reply(id, {})
      return

    default:
      error(id, -32601, 'Method not implemented: ' + method)
  }
}

let buffer = ''
process.stdin.setEncoding('utf-8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  const lines = buffer.split('\n')
  buffer = lines.pop() || ''
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let parsed
    try {
      parsed = JSON.parse(trimmed)
    } catch (err) {
      // Garbage in stdin — claude shouldn't send it, but stay alive.
      process.stderr.write('rax-orb-mcp: parse error\n')
      continue
    }
    handle(parsed).catch((err) => {
      process.stderr.write('rax-orb-mcp: handler error: ' + (err && err.message ? err.message : err) + '\n')
    })
  }
})

process.stdin.on('end', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))
process.on('SIGINT', () => process.exit(0))
