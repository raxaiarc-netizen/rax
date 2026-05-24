/**
 * Regex-based screen-reference classifier for voice-orb transcripts.
 *
 * Two tiers:
 *   - HIGH: the transcript almost certainly refers to something visible on
 *     the user's screen. Auto-capture immediately.
 *   - AMBIGUOUS: the transcript contains a deictic ("this", "that", "it") or
 *     other low-precision signal. Capture only if a downstream LLM verifies
 *     it actually means "the screen".
 *
 * The catalog deliberately overlaps — multiple patterns may fire on the same
 * transcript. We return the highest tier that matched plus the names of every
 * matching pattern so callers can log / test.
 *
 * Whisper output normalisation: text comes in lowercase-or-not, with common
 * contractions, occasional missing punctuation, and sentence-cased fragments.
 * Every pattern is `i`-flagged. We handle both straight and curly apostrophes
 * via `'?` ranges and `’`-tolerant alternations where it matters.
 */

export type DetectionTier = 'high' | 'ambiguous' | 'none'

export interface DetectionResult {
  tier: DetectionTier
  hits: string[]
  /** Coarse category of the strongest match, for logging. */
  category?:
    | 'visual-verb'
    | 'screen-mention'
    | 'read-recite'
    | 'cursor-pointer'
    | 'action-verb'
    | 'visual-query'
    | 'ambiguous-deictic'
    | 'location-word'
}

interface NamedPattern {
  name: string
  pattern: RegExp
  category: NonNullable<DetectionResult['category']>
}

// Shared sub-tokens — keeping them as constants makes the patterns easier to
// read AND eliminates copy-paste drift when we expand a class. `DEICTIC`
// covers "this/that/here/it/these/those" plus "the <noun>" for the cases
// where users say "look at the thing".
const DEICTIC = '(?:this|that|here|it|these|those|the\\s+\\w+)'
const APOS = "[’']" // smart-quote-tolerant apostrophe
const SMALL_DEICTIC = '(?:this|that|it|these|those)'

// Big union of "things visible on a UI surface" — used by `this-element` and
// a few action patterns so we don't have to keep them in sync by hand.
const UI_ELEMENT_NOUNS = [
  // Controls
  'button', 'icon', 'link', 'field', 'box', 'menu', 'option', 'toggle', 'switch',
  'slider', 'checkbox', 'radio', 'dropdown', 'combobox', 'select',
  'input', 'textarea', 'control', 'widget', 'spinner', 'loader', 'progress',
  // Layout / containers
  'row', 'column', 'cell', 'section', 'item', 'element', 'tile', 'card', 'chip',
  'tab', 'pill', 'panel', 'sidebar', 'drawer', 'sheet', 'toolbar', 'breadcrumb',
  'list', 'group', 'grid', 'tree', 'accordion',
  'modal', 'dialog', 'popup', 'popover', 'tooltip', 'overlay', 'banner',
  'header', 'footer', 'nav', 'navbar', 'menubar',
  // Content
  'text', 'image', 'photo', 'thumbnail', 'avatar', 'logo', 'emoji', 'gif',
  'chart', 'graph', 'diagram', 'plot', 'figure', 'table',
  'number', 'date', 'time', 'timestamp', 'price', 'amount',
  'label', 'heading', 'title', 'subtitle', 'caption',
  'paragraph', 'sentence', 'word', 'line',
  // Code
  'code', 'snippet', 'function', 'method', 'class', 'variable', 'expression',
  'statement', 'comment', 'log',
  // System UI
  'error', 'message', 'warning', 'notification', 'alert', 'toast', 'badge',
  'highlight', 'selection', 'cursor', 'caret',
  // Files / data
  'file', 'folder', 'directory', 'document', 'attachment',
  'email', 'mail', 'thread', 'post', 'comment', 'reply', 'tweet', 'dm',
  // Media
  'video', 'audio', 'clip', 'song', 'track', 'playlist', 'thumbnail',
  // Misc UI surfaces
  'window', 'tab', 'page', 'view', 'screen', 'preview', 'output',
  'pr', 'commit', 'diff', 'merge', 'branch',
].join('|')

// Wider list of visible-state predicates ("is it loading", "is that red"…).
const STATE_PREDICATES = [
  // Colors
  'red', 'green', 'blue', 'yellow', 'orange', 'purple', 'pink', 'black', 'white',
  'gray', 'grey', 'cyan', 'magenta', 'brown', 'tan', 'gold', 'silver',
  // Layout / visibility
  'visible', 'hidden', 'expanded', 'collapsed', 'open', 'closed',
  'shown', 'showing', 'displayed',
  // Activity
  'loading', 'spinning', 'stuck', 'frozen', 'hanging', 'paused',
  'done', 'finished', 'completed', 'failed', 'broken', 'errored',
  'running', 'working', 'idle',
  // State
  'highlighted', 'selected', 'focused', 'active', 'inactive',
  'enabled', 'disabled', 'on', 'off', 'checked', 'unchecked',
  // Quality
  'empty', 'full', 'blank', 'populated',
  'correct', 'right', 'wrong', 'valid', 'invalid', 'truthy', 'falsy',
].join('|')

// Visual / pointing verbs.
const VISUAL_VERBS =
  '(?:look(?:ing)?|see|watch|peek|glance|view|stare|gaze|spot|notice|observe|' +
  'examine|review|inspect|study|skim|scan)'

// Action verbs that imply interacting with a visible element.
const ACTION_VERBS =
  '(?:click|double[- ]?click|right[- ]?click|tap|press|hit|push|select|deselect|' +
  'hover(?:\\s+over)?|drag|drop|move|grab|toggle|flip|switch|enable|disable|' +
  'activate|deactivate|focus|defocus|blur|highlight|unhighlight|expand|collapse|' +
  'open|close|dismiss|cancel|submit|send|post|save|delete|remove|trash|' +
  'copy|paste|cut|fill|type|enter|paste\\s+into|input|complete|sign\\s+in|' +
  'log\\s+in|sign\\s+out|log\\s+out|play|pause|stop|mute|unmute|skip|rewind|' +
  'forward|share|like|favorite|bookmark|pin|unpin|star|unstar|' +
  'minimize|maximize|resize|drag|scroll\\s+(?:to|down|up|over))'

// Strings that read like a "UI surface" qualifier in "this <surface>".
const SCREEN_SURFACES =
  '(?:window|tab|app|page|view|panel|sidebar|popup|popover|dialog|modal|' +
  'sheet|drawer|tray|toolbar|menubar|menu|drawer|notification|toast|banner|hud|' +
  'overlay|preview|output|console|terminal|editor|browser|finder|inbox|chat|' +
  'thread|feed|timeline|playlist|gallery|grid|board|canvas|map|video|player|' +
  'screen|display|monitor|desktop|site|website|workspace)'

// ─── HIGH-tier patterns: capture immediately, no LLM verification ───

const HIGH_PATTERNS: NamedPattern[] = [
  // (A) Visual / pointing verbs + deictic
  {
    name: 'visual-verb-deictic',
    category: 'visual-verb',
    pattern: new RegExp(`\\b${VISUAL_VERBS}\\s+(?:at\\s+|over\\s+)?${DEICTIC}\\b`, 'i'),
  },
  {
    name: 'visual-verb-phrasal',
    category: 'visual-verb',
    pattern: /\b(check\s+(?:this|that|it)\s+out|take\s+a\s+look|have\s+a\s+look|give\s+(?:this|that|it)\s+a\s+look|got\s+a\s+sec(?:ond)?\s+to\s+look)\b/i,
  },
  {
    name: 'show-me-deictic',
    category: 'visual-verb',
    pattern: /\b(?:show|point|gesture)\s+(?:me\s+)?(?:to|at)?\s*(?:this|that|here|it|these|those|the\s+\w+)\b/i,
  },
  {
    name: 'identify-deictic',
    category: 'visual-verb',
    pattern: new RegExp(`\\b(identify|recognise|recognize|figure\\s+out|work\\s+out|tell\\s+me\\s+about|describe)\\s+${SMALL_DEICTIC}\\b`, 'i'),
  },

  // (B) Explicit screen / surface mentions
  {
    name: 'screen-noun',
    category: 'screen-mention',
    pattern: /\b(?:my\s+|the\s+)?(?:screen|display|monitor|desktop|window)\b/i,
  },
  {
    name: 'on-screen',
    category: 'screen-mention',
    pattern: /\bon\s+(?:the\s+|my\s+)?(?:screen|display|monitor|page|window|view)\b/i,
  },
  {
    name: 'this-surface',
    category: 'screen-mention',
    pattern: new RegExp(`\\bthis\\s+${SCREEN_SURFACES}\\b`, 'i'),
  },
  {
    name: 'the-surface',
    category: 'screen-mention',
    pattern: new RegExp(`\\bthe\\s+${SCREEN_SURFACES}\\b`, 'i'),
  },
  {
    name: 'in-this-surface',
    category: 'screen-mention',
    pattern: new RegExp(`\\bin\\s+(?:this|that|the)\\s+${SCREEN_SURFACES}\\b`, 'i'),
  },
  {
    name: 'top-bottom-of-screen',
    category: 'screen-mention',
    pattern: /\b(top|bottom|middle|center|centre|left|right|side|corner|edge)\s+of\s+(?:the\s+|my\s+)?(?:screen|display|page|window|view)\b/i,
  },

  // (C) Read / recite / dictate requests
  {
    name: 'read-deictic',
    category: 'read-recite',
    pattern: /\bread\s+(?:this|that|it|out|aloud|to\s+me|me\s+(?:this|that|it))\b/i,
  },
  {
    name: 'what-does-it-say',
    category: 'read-recite',
    pattern: new RegExp(`\\bwhat\\s+(?:does|do)\\s+${SMALL_DEICTIC}\\s+say\\b`, 'i'),
  },
  {
    name: 'tell-me-what-it-says',
    category: 'read-recite',
    pattern: new RegExp(`\\btell\\s+me\\s+what\\s+${SMALL_DEICTIC}\\s+(?:says|reads)\\b`, 'i'),
  },
  {
    name: 'read-whats-here',
    category: 'read-recite',
    pattern: /\b(?:read|say|spell|dictate|recite|transcribe)\s+(?:out\s+)?(?:what(?:'?s| is| are))?\s*(?:here|on|in|at|above|below|next\s+to)\b/i,
  },
  {
    name: 'transcribe-deictic',
    category: 'read-recite',
    pattern: new RegExp(`\\b(transcribe|dictate|recite|spell\\s+out)\\s+${SMALL_DEICTIC}\\b`, 'i'),
  },
  {
    name: 'whats-it-say',
    category: 'read-recite',
    pattern: new RegExp(`\\bwhat${APOS}s\\s+${SMALL_DEICTIC}\\s+say\\b`, 'i'),
  },

  // (D) Cursor / pointer / element references
  {
    name: 'where-im-pointing',
    category: 'cursor-pointer',
    pattern: new RegExp(`\\bwhere\\s+(?:i${APOS}m|i\\s+am)\\s+(?:pointing|hovering|looking|clicking)\\b`, 'i'),
  },
  {
    name: 'cursor-noun',
    category: 'cursor-pointer',
    pattern: /\b(?:my\s+cursor|the\s+cursor|where\s+(?:the\s+)?cursor\s+is|under\s+(?:my\s+|the\s+)?cursor|under\s+my\s+mouse|the\s+(?:little\s+)?arrow)\b/i,
  },
  {
    name: 'this-element',
    category: 'cursor-pointer',
    pattern: new RegExp(`\\b(?:this|that|these|those|the)\\s+(?:${UI_ELEMENT_NOUNS})\\b`, 'i'),
  },
  {
    name: 'highlighted-thing',
    category: 'cursor-pointer',
    pattern: /\b(?:the\s+)?(?:highlighted|selected|focused|active|currently[- ]selected|hovered)\s+(?:one|thing|item|row|cell|element|button|tab|option)\b/i,
  },

  // (E) Action verbs + deictic — orb must see to act
  {
    name: 'action-verb-deictic',
    category: 'action-verb',
    pattern: new RegExp(`\\b${ACTION_VERBS}\\s+(?:on\\s+)?(?:this|that|here|it|these|those|the\\s+\\w+)\\b`, 'i'),
  },
  {
    name: 'open-close-deictic',
    category: 'action-verb',
    pattern: /\b(open|close|expand|collapse|minimize|maximize|fold|unfold)\s+(this|that|it)\b/i,
  },
  {
    name: 'scroll-direction-deictic',
    category: 'action-verb',
    pattern: /\bscroll\s+(?:down|up|left|right|over|toward|towards|past)?\s*(?:to\s+)?(?:here|this|that|it|the\s+\w+)\b/i,
  },
  {
    name: 'type-paste-into-deictic',
    category: 'action-verb',
    pattern: /\b(?:type|paste|input|enter|fill)\s+(?:something|this|that|it)?\s*(?:in|into|to)\s+(?:this|that|it|the\s+\w+)\b/i,
  },

  // (F) Visual queries / judgments / state
  {
    name: 'is-this-state',
    category: 'visual-query',
    pattern: new RegExp(`\\b(?:is|are|does|do)\\s+${SMALL_DEICTIC}\\s+(?:${STATE_PREDICATES})\\b`, 'i'),
  },
  {
    name: 'does-it-look',
    category: 'visual-query',
    pattern: new RegExp(`\\bdoes\\s+${SMALL_DEICTIC}\\s+look\\s+(?:right|correct|good|wrong|broken|off|weird|odd|fine|ok|okay|messed\\s+up|jacked\\s+up|wonky|funky|nice|clean|clear)\\b`, 'i'),
  },
  {
    name: 'how-does-it-look',
    category: 'visual-query',
    pattern: new RegExp(`\\bhow\\s+does\\s+${SMALL_DEICTIC}\\s+look\\b`, 'i'),
  },
  {
    name: 'what-property-is-it',
    category: 'visual-query',
    pattern: new RegExp(`\\bwhat\\s+(?:color|colour|font|size|number|value|label|name|status|state|kind|type)\\s+(?:is|are)\\s+${SMALL_DEICTIC}\\b`, 'i'),
  },
  {
    name: 'count-of-thing',
    category: 'visual-query',
    pattern: /\bhow\s+many\s+(?:are\s+(?:there|here|shown)|i\s+see|are\s+visible|are\s+on\s+(?:the\s+)?screen)\b/i,
  },
]

// ─── AMBIGUOUS-tier patterns: capture only if Haiku confirms ───

const AMBIGUOUS_PATTERNS: NamedPattern[] = [
  // (G) Bare ambiguous deictic — every form of "what is this?" / "what's that?"
  {
    name: 'bare-what-is-this',
    category: 'ambiguous-deictic',
    pattern: new RegExp(`\\bwhat${APOS}s\\s+${SMALL_DEICTIC}\\b`, 'i'),
  },
  {
    name: 'what-is-this',
    category: 'ambiguous-deictic',
    pattern: new RegExp(`\\bwhat\\s+(?:is|are)\\s+${SMALL_DEICTIC}\\b`, 'i'),
  },
  {
    name: 'is-it-verbing',
    category: 'ambiguous-deictic',
    pattern: new RegExp(`\\bis\\s+${SMALL_DEICTIC}\\s+\\w+ing\\b`, 'i'),
  },
  {
    name: 'this-isnt-working',
    category: 'ambiguous-deictic',
    pattern: new RegExp(
      `\\b${SMALL_DEICTIC}\\s+(?:isn${APOS}?t|is\\s+not|wasn${APOS}?t|aren${APOS}?t|are\\s+not|doesn${APOS}?t|don${APOS}?t|did(?:n${APOS}?t)?|won${APOS}?t|can${APOS}?t|cannot|couldn${APOS}?t|wouldn${APOS}?t|shouldn${APOS}?t)\\s+\\w+\\b`,
      'i',
    ),
  },
  {
    name: 'why-is-this',
    category: 'ambiguous-deictic',
    pattern: new RegExp(`\\bwhy\\s+(?:is|isn${APOS}?t|doesn${APOS}?t|does|are|aren${APOS}?t|won${APOS}?t)\\s+${SMALL_DEICTIC}\\b`, 'i'),
  },
  {
    name: 'this-broke',
    category: 'ambiguous-deictic',
    pattern: new RegExp(`\\b${SMALL_DEICTIC}\\s+(?:is|are|seems|looks|appears|got)?\\s*(?:broke|broken|crashed|failed|froze|hangs?|hung|stopped|errored|glitched|jammed|stuck|died|disconnected|disappeared|vanished)\\b`, 'i'),
  },
  {
    name: 'did-it-finish',
    category: 'ambiguous-deictic',
    pattern: new RegExp(`\\bdid\\s+${SMALL_DEICTIC}\\s+(?:finish|complete|work|load|save|run|sync|update|install|deploy|build|render|appear|show\\s+up|fail)\\b`, 'i'),
  },
  {
    name: 'fix-help-this',
    category: 'ambiguous-deictic',
    pattern: new RegExp(`\\b(?:fix|help\\s+(?:me\\s+)?with|debug|troubleshoot|investigate|figure\\s+out|explain|translate|summarize|summarise|make\\s+sense\\s+of)\\s+${SMALL_DEICTIC}\\b`, 'i'),
  },
  {
    name: 'i-dont-understand',
    category: 'ambiguous-deictic',
    pattern: new RegExp(`\\b(?:i\\s+don${APOS}?t|i\\s+do\\s+not|i${APOS}m)\\s+(?:get|understand|follow|see|confused\\s+about|stuck\\s+on|lost\\s+with)\\s+${SMALL_DEICTIC}\\b`, 'i'),
  },
  {
    name: 'whats-going-on',
    category: 'ambiguous-deictic',
    pattern: /\b(?:what(?:'?s| is)\s+(?:going\s+on|happening|wrong))\b/i,
  },
  {
    name: 'any-idea',
    category: 'ambiguous-deictic',
    pattern: /\b(?:any\s+(?:idea|thoughts|clue|comment|opinion)\s+(?:what|why|how|on|about|regarding))\b/i,
  },
  {
    name: 'where-is-this',
    category: 'ambiguous-deictic',
    pattern: new RegExp(`\\bwhere${APOS}?s?\\s+(?:is\\s+)?${SMALL_DEICTIC}\\b`, 'i'),
  },

  // (H) Bare location / direction words at clause boundary
  {
    name: 'bare-location',
    category: 'location-word',
    pattern: /\b(here|right\s+here|over\s+(?:here|there)|down\s+here|up\s+there|right\s+there)\s*[?.!]?\s*$/i,
  },
]

/**
 * Classify a transcript into a tier. Both pattern sets are scanned so we
 * collect every hit (useful for tests and logs); the returned tier is HIGH if
 * any HIGH pattern matched, else AMBIGUOUS if any AMBIGUOUS pattern did, else
 * NONE.
 */
export function classifyTranscript(text: string): DetectionResult {
  const cleaned = (text || '').trim()
  if (!cleaned) return { tier: 'none', hits: [] }

  const hits: string[] = []
  let strongest: NamedPattern | null = null

  for (const p of HIGH_PATTERNS) {
    if (p.pattern.test(cleaned)) {
      hits.push(p.name)
      if (!strongest) strongest = p
    }
  }
  if (strongest) {
    return { tier: 'high', hits, category: strongest.category }
  }

  let ambig: NamedPattern | null = null
  for (const p of AMBIGUOUS_PATTERNS) {
    if (p.pattern.test(cleaned)) {
      hits.push(p.name)
      if (!ambig) ambig = p
    }
  }
  if (ambig) {
    return { tier: 'ambiguous', hits, category: ambig.category }
  }

  return { tier: 'none', hits }
}
