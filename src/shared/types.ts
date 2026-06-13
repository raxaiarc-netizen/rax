// ─── Claude Code Stream Event Types (verified from v2.1.63) ───

export interface InitEvent {
  type: 'system'
  subtype: 'init'
  cwd: string
  session_id: string
  tools: string[]
  mcp_servers: Array<{ name: string; status: string }>
  model: string
  permissionMode: string
  agents: string[]
  skills: string[]
  plugins: string[]
  claude_code_version: string
  fast_mode_state: string
  uuid: string
}

export interface StreamEvent {
  type: 'stream_event'
  event: StreamSubEvent
  session_id: string
  parent_tool_use_id: string | null
  uuid: string
}

export type StreamSubEvent =
  | { type: 'message_start'; message: AssistantMessagePayload }
  | { type: 'content_block_start'; index: number; content_block: ContentBlock }
  | { type: 'content_block_delta'; index: number; delta: ContentDelta }
  | { type: 'content_block_stop'; index: number }
  | { type: 'message_delta'; delta: { stop_reason: string | null }; usage: UsageData; context_management?: unknown }
  | { type: 'message_stop' }

export interface ContentBlock {
  type: 'text' | 'tool_use'
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
}

export type ContentDelta =
  | { type: 'text_delta'; text: string }
  | { type: 'input_json_delta'; partial_json: string }

export interface AssistantEvent {
  type: 'assistant'
  message: AssistantMessagePayload
  parent_tool_use_id: string | null
  session_id: string
  uuid: string
}

export interface AssistantMessagePayload {
  model: string
  id: string
  role: 'assistant'
  content: ContentBlock[]
  stop_reason: string | null
  usage: UsageData
}

export interface RateLimitEvent {
  type: 'rate_limit_event'
  rate_limit_info: {
    status: string
    resetsAt: number
    rateLimitType: string
  }
  session_id: string
  uuid: string
}

export interface ResultEvent {
  type: 'result'
  subtype: 'success' | 'error'
  is_error: boolean
  duration_ms: number
  num_turns: number
  result: string
  total_cost_usd: number
  session_id: string
  usage: UsageData & {
    input_tokens: number
    output_tokens: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
  }
  permission_denials: string[]
  uuid: string
}

export interface UsageData {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  service_tier?: string
}

export interface PermissionEvent {
  type: 'permission_request'
  tool: { name: string; description?: string; input?: Record<string, unknown> }
  question_id: string
  options: Array<{ id: string; label: string; kind?: string }>
  session_id: string
  uuid: string
}

// Union of all possible top-level events
export type ClaudeEvent = InitEvent | StreamEvent | AssistantEvent | RateLimitEvent | ResultEvent | PermissionEvent | UnknownEvent

export interface UnknownEvent {
  type: string
  [key: string]: unknown
}

// ─── Tab State Machine (v2 — from execution plan) ───

export type TabStatus = 'connecting' | 'idle' | 'running' | 'completed' | 'failed' | 'dead'

export interface PermissionRequest {
  questionId: string
  toolTitle: string
  toolDescription?: string
  toolInput?: Record<string, unknown>
  options: Array<{ optionId: string; kind?: string; label: string }>
}

export interface Attachment {
  id: string
  type: 'image' | 'file'
  name: string
  path: string
  mimeType?: string
  /** Base64 data URL for image previews */
  dataUrl?: string
  /** File size in bytes */
  size?: number
}

export interface TabState {
  id: string
  claudeSessionId: string | null
  status: TabStatus
  activeRequestId: string | null
  hasUnread: boolean
  currentActivity: string
  permissionQueue: PermissionRequest[]
  /** Fallback card when tools were denied and no interactive permission is available.
   *  hookReached=true means a PermissionCard was shown and the user (or timeout)
   *  decided deny. hookReached=false means Claude's tool was denied without the
   *  permission prompt ever reaching the user — usually a hook/Claude-CLI mismatch
   *  or a closed tab. The card uses this to show the right explanation. */
  permissionDenied: { tools: Array<{ toolName: string; toolUseId: string }>; hookReached: boolean } | null
  attachments: Attachment[]
  messages: Message[]
  title: string
  /** Last run's result data (cost, tokens, duration) */
  lastResult: RunResult | null
  /** Session metadata from init event */
  sessionModel: string | null
  sessionTools: string[]
  sessionMcpServers: Array<{ name: string; status: string }>
  sessionSkills: string[]
  sessionVersion: string | null
  /** Prompts waiting behind the current run (display text only) */
  queuedPrompts: string[]
  /** Working directory for this tab's Claude sessions */
  workingDirectory: string
  /** Whether the user explicitly chose a directory (vs. using default home) */
  hasChosenDirectory: boolean
  /** Extra directories accessible via --add-dir (session-preserving) */
  additionalDirs: string[]
  /** True for the pinned voice-orb tab. Renders with blue theme + voice
   *  icon, no × button, no composer. Receives streamed orb events instead
   *  of running a per-tab claude session. */
  isOrbTab?: boolean
  /** Identifies which agent (Max / Alex / Luna / Nova / Zara) this tab
   *  represents. For the agent-bound tabs, `agentId === id` — the agent's
   *  stable identifier IS the registered tab id used by main's ControlPlane.
   *  Undefined for the legacy free-form chat path and for the voice orb tab. */
  agentId?: string
  /** Agent tabs start hidden — they exist in the store and are registered
   *  with main's ControlPlane, but the pill tab strip skips them so the
   *  default UI matches the pre-multi-agent build. Clicking an agent in the
   *  dock un-hides its tab (and selects it). Closing an agent tab via the
   *  pill's × hides it again. Always undefined / false for non-agent tabs
   *  (the orb tab and free-form chats). */
  hidden?: boolean
}

/** Stable id of the pinned voice-orb tab. Reserved sentinel — never used
 *  as a real claude tab id. Kept in sync between renderer and main. */
export const ORB_TAB_ID = 'orb-tab'

export interface Message {
  id: string
  role: 'user' | 'assistant' | 'tool' | 'system'
  content: string
  toolName?: string
  toolInput?: string
  toolStatus?: 'running' | 'completed' | 'error'
  timestamp: number
  /**
   * Voice-orb only: this user turn rode in with an auto-attached screenshot
   * of the user's screen (handled by the auto-screenshot pipeline). The chip
   * is rendered next to the bubble so the read-only voice tab matches what
   * the model actually saw. No image bytes are shipped to the renderer — the
   * flag is metadata only.
   */
  hasAutoScreenshot?: boolean
}

export interface RunResult {
  totalCostUsd: number
  durationMs: number
  numTurns: number
  usage: UsageData
  sessionId: string
}

// ─── Canonical Events (normalized from raw stream) ───

export type NormalizedEvent =
  | { type: 'session_init'; sessionId: string; tools: string[]; model: string; mcpServers: Array<{ name: string; status: string }>; skills: string[]; version: string; isWarmup?: boolean }
  | { type: 'text_chunk'; text: string }
  | { type: 'tool_call'; toolName: string; toolId: string; index: number }
  | { type: 'tool_call_update'; toolId: string; partialInput: string }
  | { type: 'tool_call_complete'; index: number }
  | { type: 'task_update'; message: AssistantMessagePayload }
  | { type: 'task_complete'; result: string; costUsd: number; durationMs: number; numTurns: number; usage: UsageData; sessionId: string; permissionDenials?: Array<{ toolName: string; toolUseId: string }> }
  | { type: 'error'; message: string; isError: boolean; sessionId?: string }
  | { type: 'session_dead'; exitCode: number | null; signal: string | null; stderrTail: string[] }
  | { type: 'rate_limit'; status: string; resetsAt: number; rateLimitType: string }
  | { type: 'usage'; usage: UsageData }
  | { type: 'permission_request'; questionId: string; toolName: string; toolDescription?: string; toolInput?: Record<string, unknown>; options: Array<{ id: string; label: string; kind?: string }> }
  | { type: 'permission_resolved'; questionId: string; reason: 'timeout' | 'run-ended' | 'shutdown' | 'tab-closed' }

// ─── Run Options ───

export interface RunOptions {
  prompt: string
  projectPath: string
  sessionId?: string
  allowedTools?: string[]
  maxTurns?: number
  maxBudgetUsd?: number
  systemPrompt?: string
  /** Extra text appended to the RAX system hint via --append-system-prompt.
   *  Injected by ControlPlane for crew tabs: agent identity + voice-orb
   *  contract (see buildCrewAgentHint in run-manager.ts). */
  appendSystemPrompt?: string
  model?: string
  /** Claude CLI effort level (--effort). Omitted = CLI default. */
  effort?: EffortLevel
  /** Path to RAX-scoped settings file with hook config (passed via --settings) */
  hookSettingsPath?: string
  /** Extra directories to add via --add-dir (session-preserving) */
  addDirs?: string[]
  /** Global permission mode at dispatch time. Injected by ControlPlane. */
  permissionMode?: 'ask' | 'auto' | 'bypass'
}

// ─── Control Plane Types ───

export interface TabRegistryEntry {
  tabId: string
  claudeSessionId: string | null
  status: TabStatus
  activeRequestId: string | null
  runPid: number | null
  createdAt: number
  lastActivityAt: number
  promptCount: number
}

export interface HealthReport {
  tabs: Array<{
    tabId: string
    status: TabStatus
    activeRequestId: string | null
    claudeSessionId: string | null
    alive: boolean
  }>
  queueDepth: number
}

export interface EnrichedError {
  message: string
  stderrTail: string[]
  stdoutTail?: string[]
  exitCode: number | null
  elapsedMs: number
  toolCallCount: number
  sawPermissionRequest?: boolean
  permissionDenials?: Array<{ tool_name: string; tool_use_id: string }>
}

// ─── Session History ───

export interface SessionMeta {
  sessionId: string
  slug: string | null
  firstMessage: string | null
  lastTimestamp: string
  size: number
}

export interface SessionLoadMessage {
  role: string
  content: string
  toolName?: string
  timestamp: number
}

// ─── Marketplace / Plugin Types ───

export type PluginStatus = 'not_installed' | 'checking' | 'installing' | 'installed' | 'failed'

export interface CatalogPlugin {
  id: string              // unique: `${repo}/${skillPath}` e.g. 'anthropics/skills/skills/xlsx'
  name: string            // from SKILL.md or plugin.json
  description: string     // from SKILL.md or plugin.json
  version: string         // from plugin.json or '0.0.0'
  author: string          // from plugin.json or marketplace entry
  marketplace: string     // marketplace name from marketplace.json
  repo: string            // 'anthropics/skills'
  sourcePath: string      // path within repo, e.g. 'skills/xlsx'
  installName: string     // individual skill name for SKILL.md skills, bundle name for CLI plugins
  category: string        // 'Agent Skills' | 'Knowledge Work' | 'Financial Services'
  tags: string[]          // Semantic use-case tags derived from name/description (e.g. 'Design', 'Finance')
  isSkillMd: boolean      // true = individual SKILL.md (direct install), false = CLI plugin (bundle install)
}

// ─── Cross-renderer state mirror ───
// The pill and fullscreen window each own a Zustand store. Optimistic-only
// mutations (user messages, tab CRUD, working directory, etc.) need to be
// mirrored from the active renderer → main → other renderer so both stay
// coherent. Streaming events from Claude already broadcast to both renderers
// via rax:normalized-event, so they aren't mirrored here.

export type MirrorAction =
  | { kind: 'user-message'; tabId: string; messageId: string; content: string; timestamp: number }
  | { kind: 'system-message'; tabId: string; messageId: string; content: string; timestamp: number }
  | { kind: 'tab-created'; tabId: string; workingDirectory: string }
  | { kind: 'tab-closed'; tabId: string }
  | { kind: 'tab-selected'; tabId: string }
  | { kind: 'tab-cleared'; tabId: string }
  | { kind: 'tab-title'; tabId: string; title: string }
  | { kind: 'attachments-add'; tabId: string; attachments: Attachment[] }
  | { kind: 'attachments-remove'; tabId: string; attachmentId: string }
  | { kind: 'attachments-clear'; tabId: string }
  | { kind: 'directory-set'; tabId: string; directory: string }
  | { kind: 'directory-add'; tabId: string; directory: string }
  | { kind: 'directory-remove'; tabId: string; directory: string }
  | { kind: 'preferred-model'; model: string | null }
  | { kind: 'preferred-effort'; effort: EffortLevel | null }
  | { kind: 'permission-mode'; mode: 'ask' | 'auto' | 'bypass' }

export interface SessionSnapshot {
  tabs: TabState[]
  activeTabId: string
  preferredModel: string | null
  /** Optional — absent in snapshots written before effort selection shipped. */
  preferredEffort?: EffortLevel | null
  permissionMode: 'ask' | 'auto' | 'bypass'
}

// ─── Default model ───
// Single source of truth for the model used when the user hasn't picked one,
// and when subprocesses (orb, etc.) need an explicit fallback. Shared between
// main and renderer.
export const DEFAULT_MODEL_ID = 'claude-opus-4-8'

// "Rax Default" — the free tier model. The proxy forwards kimi-* upstream at
// no charge, so this is the only model usable on a $0 Rax credit balance.
// Shared between the renderer pickers (lock/auto-select at $0) and the main
// process spawn-time backstop.
export const RAX_DEFAULT_MODEL_ID = 'kimi-k2.7-code'

// ─── Effort ───
// Mirrors the Claude CLI's --effort flag (how hard the model thinks per turn).
// `null` preference means "CLI default" — we omit --effort entirely so the
// spawn inherits whatever Claude Code ships as its default for the model.
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export const EFFORT_LEVELS: ReadonlyArray<{ id: EffortLevel; label: string; hint: string }> = [
  { id: 'low', label: 'Low', hint: 'Fastest, scoped tasks' },
  { id: 'medium', label: 'Medium', hint: 'Cost-efficient balance' },
  { id: 'high', label: 'High', hint: 'Most tasks' },
  { id: 'xhigh', label: 'X-High', hint: 'Coding & agentic work' },
  { id: 'max', label: 'Max', hint: 'Correctness over cost' },
]

export function isEffortLevel(value: unknown): value is EffortLevel {
  return EFFORT_LEVELS.some((e) => e.id === value)
}

// ─── IPC Channel Names ───

export const IPC = {
  // Request-response (renderer → main)
  START: 'rax:start',
  CREATE_TAB: 'rax:create-tab',
  PROMPT: 'rax:prompt',
  CANCEL: 'rax:cancel',
  STOP_TAB: 'rax:stop-tab',
  RETRY: 'rax:retry',
  STATUS: 'rax:status',
  TAB_HEALTH: 'rax:tab-health',
  CLOSE_TAB: 'rax:close-tab',
  SELECT_DIRECTORY: 'rax:select-directory',
  OPEN_EXTERNAL: 'rax:open-external',
  OPEN_IN_TERMINAL: 'rax:open-in-terminal',
  ATTACH_FILES: 'rax:attach-files',
  TAKE_SCREENSHOT: 'rax:take-screenshot',
  TRANSCRIBE_AUDIO: 'rax:transcribe-audio',
  PASTE_IMAGE: 'rax:paste-image',
  GET_DIAGNOSTICS: 'rax:get-diagnostics',
  RESPOND_PERMISSION: 'rax:respond-permission',
  INIT_SESSION: 'rax:init-session',
  RESET_TAB_SESSION: 'rax:reset-tab-session',
  ANIMATE_HEIGHT: 'rax:animate-height',
  LIST_SESSIONS: 'rax:list-sessions',
  LOAD_SESSION: 'rax:load-session',
  EXPORT_TRANSCRIPT: 'rax:export-transcript',

  // One-way events (main → renderer)
  TEXT_CHUNK: 'rax:text-chunk',
  TOOL_CALL: 'rax:tool-call',
  TOOL_CALL_UPDATE: 'rax:tool-call-update',
  TOOL_CALL_COMPLETE: 'rax:tool-call-complete',
  TASK_UPDATE: 'rax:task-update',
  TASK_COMPLETE: 'rax:task-complete',
  SESSION_DEAD: 'rax:session-dead',
  SESSION_INIT: 'rax:session-init',
  ERROR: 'rax:error',
  RATE_LIMIT: 'rax:rate-limit',

  // Window management
  RESIZE_HEIGHT: 'rax:resize-height',
  SET_WINDOW_WIDTH: 'rax:set-window-width',
  HIDE_WINDOW: 'rax:hide-window',
  WINDOW_SHOWN: 'rax:window-shown',
  SET_IGNORE_MOUSE_EVENTS: 'rax:set-ignore-mouse-events',
  ORB_SET_FOCUSABLE: 'rax:orb-set-focusable',
  START_WINDOW_DRAG: 'rax:start-window-drag',
  RESET_WINDOW_POSITION: 'rax:reset-window-position',
  IS_VISIBLE: 'rax:is-visible',

  // Skill provisioning (main → renderer)
  SKILL_STATUS: 'rax:skill-status',

  // Theme
  GET_THEME: 'rax:get-theme',
  THEME_CHANGED: 'rax:theme-changed',

  // Marketplace
  MARKETPLACE_FETCH: 'rax:marketplace-fetch',
  MARKETPLACE_INSTALLED: 'rax:marketplace-installed',
  MARKETPLACE_INSTALL: 'rax:marketplace-install',
  MARKETPLACE_UNINSTALL: 'rax:marketplace-uninstall',

  // Permission mode
  SET_PERMISSION_MODE: 'rax:set-permission-mode',

  // Retroactively allow tools denied during a prior run (session-scoped)
  ALLOW_DENIED_TOOLS: 'rax:allow-denied-tools',

  // Code Mode (live preview of the active tab's working directory)
  CODE_MODE_START: 'rax:code-mode-start',
  CODE_MODE_STOP: 'rax:code-mode-stop',
  CODE_MODE_STATUS: 'rax:code-mode-status',
  CODE_MODE_RELOAD: 'rax:code-mode-reload',
  CODE_MODE_TOGGLE_INSPECT: 'rax:code-mode-toggle-inspect',
  CODE_MODE_SET_DEVICE: 'rax:code-mode-set-device',
  CODE_MODE_GET_INITIAL: 'rax:code-mode-get-initial',
  CODE_MODE_WEBVIEW_REGISTER: 'rax:code-mode-webview-register',
  CODE_MODE_STATUS_CHANGED: 'rax:code-mode-status-changed',
  CODE_MODE_LOG: 'rax:code-mode-log',

  // Fullscreen window (standard Mac window, sidebar layout, mutually exclusive with pill)
  FULLSCREEN_OPEN: 'rax:fullscreen-open',
  FULLSCREEN_CLOSE: 'rax:fullscreen-close',
  FULLSCREEN_TOGGLE: 'rax:fullscreen-toggle',
  FULLSCREEN_IS_OPEN: 'rax:fullscreen-is-open',
  FULLSCREEN_MODE_CHANGED: 'rax:fullscreen-mode-changed',
  // macOS native fullscreen state for the fullscreen BrowserWindow itself
  // (traffic lights hide → controls slide to the edge)
  FULLSCREEN_NATIVE_STATE: 'rax:fullscreen-native-state',

  // State mirror — sync optimistic-only mutations across pill ↔ fullscreen renderers
  STATE_MIRROR_PUBLISH: 'rax:state-mirror-publish',
  STATE_MIRROR_SUBSCRIBE: 'rax:state-mirror-subscribe',
  STATE_SNAPSHOT_PUSH: 'rax:state-snapshot-push',
  STATE_SNAPSHOT_PULL: 'rax:state-snapshot-pull',

  // Voice orb — Siri-style floating voice agent that runs its own claude session
  ORB_TOGGLE: 'rax:orb-toggle',
  ORB_SHOW: 'rax:orb-show',
  ORB_HIDE: 'rax:orb-hide',
  ORB_SUBMIT_TURN: 'rax:orb-submit-turn',
  ORB_CANCEL_TURN: 'rax:orb-cancel-turn',
  ORB_RESET_SESSION: 'rax:orb-reset-session',
  // Renderer→main: keep the voice orb's model aligned with the picker.
  ORB_SET_MODEL: 'rax:orb-set-model',
  ORB_EVENT: 'rax:orb-event',
  ORB_DISMISSED: 'rax:orb-dismissed',
  ORB_FORCE_LISTEN: 'rax:orb-force-listen',
  ORB_HOLD_START: 'rax:orb-hold-start',
  ORB_HOLD_END: 'rax:orb-hold-end',
  /** Main→orb renderer push: traits of the display under the island
   *  ({ notched: boolean }) — sent on renderer-ready, summon, and display
   *  reconfiguration so the island can adapt its geometry. */
  ORB_DISPLAY_PROFILE: 'rax:orb-display-profile',
  ORB_TTS_SPEAK: 'rax:orb-tts-speak',
  ORB_TTS_CANCEL: 'rax:orb-tts-cancel',
  ORB_TTS_DONE: 'rax:orb-tts-done',
  /** Main→orb push at playback start: loudness timeline of the WAV afplay
   *  is now playing (`{ id, startedAtMs, frameMs, levels }`) so the notch
   *  waveform tracks the real voice instead of a synthetic flow. */
  ORB_TTS_LEVELS: 'rax:orb-tts-levels',
  /** Renderer→main invoke. Payload is a Kokoro voice id (e.g. `af_heart`).
   *  Main updates the live TTSManager and persists the choice to
   *  `<userData>/orb-tts-voice.json`. Returns `{ ok, voice }`; `ok=false`
   *  if the id isn't in the known catalog. */
  ORB_TTS_SET_VOICE: 'rax:orb-tts-set-voice',
  /** Renderer→main invoke, no payload. Returns the currently-active
   *  Kokoro voice id so the Settings dropdown can render the right
   *  initial selection on mount (instead of guessing from localStorage,
   *  which can disagree with the persisted main-process state after the
   *  user uninstalls + reinstalls). */
  ORB_TTS_GET_VOICE: 'rax:orb-tts-get-voice',
  /** Renderer→main invoke. Payload is a Kokoro voice id. Synthesizes a
   *  short fixed sample line in THAT voice (without touching the configured
   *  voice) and plays it — the "play" button next to the voice pickers.
   *  A new preview supersedes the previous one and silences any orb speech
   *  first. Returns `{ ok, durationMs }` so the button can show a playing
   *  state for the sample's real length. */
  ORB_TTS_PREVIEW: 'rax:orb-tts-preview',
  /** Renderer→main invoke. Payload is a mascot colorway id (see
   *  shared/mascot-colors.ts — Rax blue or one of the crew skins). Main
   *  persists it to `<userData>/orb-mascot-color.json` and live-pushes it
   *  to the orb window. Returns `{ ok, color }`; `ok=false` for unknown
   *  ids or a failed disk write (same contract as ORB_TTS_SET_VOICE). */
  ORB_SET_MASCOT_COLOR: 'rax:orb-set-mascot-color',
  /** Renderer→main invoke, no payload. Returns `{ color }` — the mascot
   *  colorway main currently holds, so the Settings swatches reflect the
   *  on-disk truth on mount. */
  ORB_GET_MASCOT_COLOR: 'rax:orb-get-mascot-color',
  /** Main→orb renderer push: `{ colorId }` for the mascot's visor. Sent on
   *  renderer-ready and whenever the Settings selection changes. */
  ORB_MASCOT_COLOR: 'rax:orb-mascot-color',
  /** Renderer→main, fire-and-forget: the mascot's seat rect inside the orb
   *  window (`{ x, y, width, height }`, window-relative DIPs, parked bar).
   *  The intro cameo flies the big mascot to exactly this spot. Pushed on
   *  mount, on display-profile changes, and on resize. */
  ORB_MASCOT_SEAT: 'rax:orb-mascot-seat',
  /** Main→orb renderer push: `{ kind: 'hold' | 'land' }` — entrance
   *  choreography control around the intro cameo. 'hold' arms the notch
   *  (bar slides in mascot-less, the little robot waits off-stage); 'land'
   *  releases him into his seat (the intro mascot just flew in behind the
   *  bar). Plain summons send nothing and the notch plays its default
   *  tumble-in. */
  ORB_ENTRANCE: 'rax:orb-entrance',
  /** Intro cameo window (the center-screen mascot that analyzes your
   *  desktop, then merges into the notch). ready: renderer mounted;
   *  play: main→intro payload {seat, display, colorId}; bar-cue: intro→main
   *  "start the bar slide NOW" (fired at leap wind-up); done: intro→main
   *  "touched down behind the bar". */
  INTRO_READY: 'rax:intro-ready',
  INTRO_PLAY: 'rax:intro-play',
  INTRO_BAR_CUE: 'rax:intro-bar-cue',
  INTRO_DONE: 'rax:intro-done',
  ORB_RENDERER_READY: 'rax:orb-renderer-ready',
  ORB_BUSY: 'rax:orb-busy',
  /** Renderer→main, fire-and-forget. Payload is the orb's current voice
   *  state ('idle' | 'listening' | 'transcribing' | 'thinking' | 'talking' |
   *  'error'). Main re-emits it to the caption-pill window so the pill can
   *  drive visibility off real speaking state instead of guessing from
   *  task_complete + a hide timer. */
  ORB_VOICE_STATE: 'rax:orb-voice-state',
  /** Same orb stream event the orb window already receives, also broadcast
   *  to pill + fullscreen so they can populate the dedicated voice tab. */
  ORB_EVENT_BROADCAST: 'rax:orb-event-broadcast',
  /** Fired when the orb conversation is reset — pill + fullscreen insert a
   *  divider into the orb tab so the user can scroll back through old
   *  conversations. */
  ORB_RESET_BROADCAST: 'rax:orb-reset-broadcast',
  /** Forwarded orb stream event sent to the standalone caption-pill window —
   *  the bottom-of-screen "what was just said / what's being said" subtitle.
   *  Same payload shape as ORB_EVENT. */
  CAPTION_PILL_EVENT: 'rax:caption-pill-event',
  STATE_SNAPSHOT_REQUEST: 'rax:state-snapshot-request',

  // Claude instance — which `claude` Rax talks to (bundled vs system).
  // GET/SET are renderer→main invokes; INFO returns full instance details
  // (binary path, version, auth, mcp list, sign-in state) for Settings.
  // CHANGED is the broadcast main→renderer when the mode flips.
  // LOGIN/LOGIN_CANCEL/LOGIN_EVENT run `claude login` in an embedded panel.
  CLAUDE_MODE_GET: 'rax:claude-mode-get',
  CLAUDE_MODE_SET: 'rax:claude-mode-set',
  CLAUDE_MODE_INFO: 'rax:claude-mode-info',
  CLAUDE_MODE_CHANGED: 'rax:claude-mode-changed',
  CLAUDE_LOGIN_START: 'rax:claude-login-start',
  CLAUDE_LOGIN_CANCEL: 'rax:claude-login-cancel',
  CLAUDE_LOGIN_EVENT: 'rax:claude-login-event',

  // Rax cloud — routes the spawned `claude` CLI through the hosted Rax
  // proxy so the user is billed against their Rax credit balance instead
  // of needing their own Anthropic key.
  // STATUS  → { enabled, signedIn, baseUrl, keyPrefix? }
  // SIGN_IN → opens browser to the loopback OAuth flow; resolves after the
  //           user completes the web sign-in or rejects with a reason.
  // SIGN_OUT clears the locally stored key.
  // SET_ENABLED toggles the env-injection without revoking the key.
  RAX_AUTH_STATUS: 'rax:rax-auth-status',
  RAX_AUTH_SIGN_IN: 'rax:rax-auth-sign-in',
  RAX_AUTH_SIGN_OUT: 'rax:rax-auth-sign-out',
  RAX_AUTH_SET_ENABLED: 'rax:rax-auth-set-enabled',
  RAX_AUTH_CHANGED: 'rax:rax-auth-changed',
  /** Renderer→main invoke. Calls `${baseUrl}/api/me` with the stored key
   *  and returns a RaxAccountInfo snapshot (email + balance_cents). */
  RAX_AUTH_FETCH_ACCOUNT: 'rax:rax-auth-fetch-account',

  /** First-launch onboarding: returns whether the user has already seen
   *  + dismissed the welcome screen. Persisted in <userData>/onboarding.json. */
  ONBOARDING_GET: 'rax:onboarding-get',
  ONBOARDING_COMPLETE: 'rax:onboarding-complete',
  /** Open the welcome BrowserWindow (idempotent — focuses if already open). */
  WELCOME_OPEN: 'rax:welcome-open',
  /** Close the welcome BrowserWindow from the welcome renderer itself. */
  WELCOME_CLOSE: 'rax:welcome-close',
  /** Finish onboarding: create the pill (if not already created), show it,
   *  and close the welcome window. Called from the success screen's
   *  "Launch Rax" button. */
  LAUNCH_PILL: 'rax:launch-pill',

  // ─── Agent dock ───
  // Standalone always-on-top vertical dock on the left edge of the user's
  // primary display. Hosts the five agent icons (Max/Alex/Luna/Nova/Zara) +
  // status indicators + completion toasts. Lifecycle is independent of the
  // pill / fullscreen / orb windows.
  DOCK_TOGGLE: 'rax:dock-toggle',
  DOCK_SHOW: 'rax:dock-show',
  DOCK_HIDE: 'rax:dock-hide',
  /** Renderer (dock) → main. User clicked an agent icon in the dock. Main
   *  forwards as a tab-selected mirror so pill + fullscreen update their
   *  active tab, then surfaces the pill / fullscreen window if hidden. */
  DOCK_SELECT_AGENT: 'rax:dock-select-agent',
  /** Renderer (dock) → main, fire-and-forget. Dock saved its new on-screen
   *  position. Mirrors the orb's setBounds + persist-on-moved pattern. */
  DOCK_SET_POSITION: 'rax:dock-set-position',
  /** Main → dock renderer. Broadcast on every task_complete event so the
   *  dock can fire a toast notification independently of pill / fullscreen. */
  DOCK_AGENT_COMPLETED: 'rax:dock-agent-completed',
  /** Main → dock renderer push: `{ autoHide }` — whether the dock is in
   *  activity-driven mode (auto-shown, should tuck itself away when the
   *  crew goes quiet) or pinned by explicit user intent. Sent after every
   *  show. */
  DOCK_MODE: 'rax:dock-mode',
  /** Renderer (dock) → main, fire-and-forget. The quiet grace elapsed —
   *  request a hide WITHOUT flipping user intent (the dock stays in 'auto'
   *  mode for the next episode). Main routes it through the same animated
   *  slide-out handshake as every other hide. */
  DOCK_AUTO_HIDE: 'rax:dock-auto-hide',
  /** Main → dock renderer push: glide the column off-screen, then ack with
   *  DOCK_SLIDE_OUT_DONE. EVERY hide path (toggle, tray, rax_set_dock,
   *  orb-companion, quiet-grace) goes through this so the dock never pops
   *  out of existence. */
  DOCK_SLIDE_OUT: 'rax:dock-slide-out',
  /** Renderer (dock) → main: slide-out finished — safe to hide the window.
   *  Main also has a fallback timer in case the renderer is wedged. */
  DOCK_SLIDE_OUT_DONE: 'rax:dock-slide-out-done',
  /** Renderer (orb) → main invoke, no payload. Toggle the agents dock and
   *  return `{ ok, visible }` — drives the notch's dock toggle button. */
  ORB_TOGGLE_DOCK: 'rax:orb-toggle-dock',
  /** Main → orb renderer push: `{ visible }` whenever dock visibility
   *  changes (toggle button, tray, orb tool, dock lifecycle) so the notch
   *  button reflects truth no matter who flipped it. */
  ORB_DOCK_VISIBLE: 'rax:orb-dock-visible',

  // ─── First-install guided tour ───
  // A fully scripted (no LLM) voice walkthrough the orb performs the first
  // time the notch appears: spoken via the local Kokoro TTS with a guidance
  // card under the bar. State lives in <userData>/orb-tour.json so the tour
  // plays once per machine and can resume mid-way after an interruption.
  /** Renderer (orb) → main invoke, no payload. Returns
   *  `{ pending, step }` — whether the tour still owes the user a
   *  performance and which step to resume from. */
  ORB_TOUR_GET: 'rax:orb-tour-get',
  /** Renderer (orb) → main, fire-and-forget. Payload is the step index the
   *  tour just reached — persisted so a quit/dismiss mid-tour resumes there
   *  instead of replaying from the top. */
  ORB_TOUR_STEP: 'rax:orb-tour-step',
  /** Renderer (orb) → main invoke. Payload `'finished' | 'skipped'`.
   *  Marks the tour done forever (both outcomes count — a skip is an
   *  answer, not a deferral). */
  ORB_TOUR_DONE: 'rax:orb-tour-done',
  /** Renderer (orb) → main invoke, no payload. Opens the Google AI Studio
   *  API-key page in the default browser — the tour's "I'm opening Google
   *  AI Studio for you" beat. Fixed URL on the main side; the sandboxed
   *  orb renderer never gets a general open-any-URL capability. */
  ORB_TOUR_OPEN_KEYS: 'rax:orb-tour-open-keys',
  /** Renderer (orb) → main, fire-and-forget `{ active }`. Brackets the whole
   *  tour: while active main suppresses caption-pill forwarding (the tour's
   *  own card carries the words — no bottom subtitles) and hides the pill. */
  ORB_TOUR_ACTIVE: 'rax:orb-tour-active',
  /** Renderer (orb) → main `{ target: 'tabbar' | 'voicetab' | null }`. The
   *  interactive gate's cross-window reach: main makes the chat pill visible
   *  and relays the cue so the pill can pulse the real element and report
   *  when the user actually does the thing. null clears the highlight. */
  ORB_TOUR_CUE: 'rax:orb-tour-cue',
  /** Main → pill renderer `{ target: 'tabbar' | 'voicetab' | null }` — the
   *  relayed ORB_TOUR_CUE. The pill pulses the matching element and watches
   *  for the gesture (expand / select the Voice tab). */
  TOUR_PILL_CUE: 'rax:tour-pill-cue',
  /** Pill renderer → main `{ target }` — the user performed the gated action
   *  (expanded the pill / selected the Voice tab). Main relays to the orb. */
  TOUR_PILL_DONE: 'rax:tour-pill-done',
  /** Main → orb renderer `{ target }` — the relayed TOUR_PILL_DONE; the tour
   *  resolves the step's gate and moves on. */
  ORB_TOUR_PILL_DONE: 'rax:orb-tour-pill-done',

  // ─── Grok voice (realtime speech-to-speech backend) ───
  // Opt-in alternative to the whisper → claude → Kokoro pipeline, flipped
  // from the notch settings. Main owns the config (<userData>/grok-voice.json,
  // includes the user's xAI key — never shipped to the renderer) and the
  // WebSocket session; the renderer owns the mic capture + PCM playback.
  /** Renderer→main invoke, no payload. Returns the public config
   *  `{ enabled, voice, hasKey, keyTail }`. */
  ORB_GROK_GET_CONFIG: 'rax:orb-grok-get-config',
  /** Renderer→main invoke. Partial `{ enabled?, apiKey?, voice? }` merge-
   *  write. Returns `{ ok, config }` (public shape). Flipping `enabled`
   *  rebuilds the orb backend on the spot. */
  ORB_GROK_SET_CONFIG: 'rax:orb-grok-set-config',
  /** Main → orb renderer push: public config, sent on renderer-ready and
   *  after every ORB_GROK_SET_CONFIG so the notch settings stay in sync. */
  ORB_GROK_CONFIG: 'rax:orb-grok-config',
  /** Renderer→main invoke, no payload. Opens the realtime WebSocket session.
   *  Returns `{ ok, error? }`. */
  ORB_GROK_START: 'rax:orb-grok-start',
  /** Renderer→main invoke, no payload. Closes the realtime session. */
  ORB_GROK_STOP: 'rax:orb-grok-stop',
  /** Renderer→main, fire-and-forget. Base64 PCM16 mono 24kHz mic chunk for
   *  the live realtime session (sent ~16×/sec while a session is open). */
  ORB_GROK_AUDIO: 'rax:orb-grok-audio',
  /** Renderer→main, fire-and-forget. Boolean: ⌥R hold edge for push-to-talk
   *  mode (true = key down, false = released → commit the turn). No-op when
   *  the live session wasn't opened with pushToTalk on. */
  ORB_GROK_HOLD: 'rax:orb-grok-hold',
  /** Main → orb renderer push: realtime session events — ready /
   *  speech_started / speech_stopped / user_transcript / response_started /
   *  audio (base64 PCM16 delta) / text (transcript delta + start_time) /
   *  tool_call / response_done / error / closed. Drives the renderer's
   *  playback + caption + state machine in Grok mode. */
  ORB_GROK_EVENT: 'rax:orb-grok-event',
  /** Renderer (orb) → main, fire-and-forget. Caption traffic for the bottom
   *  pill, authored in the renderer where the audio playback clock lives:
   *  `{ kind:'segment', segment }` (pill tts_segment shape) or
   *  `{ kind:'clear', id }`. Main forwards to the caption-pill window. */
  ORB_GROK_CAPTION: 'rax:orb-grok-caption',

  // ─── Gemini Live voice (realtime speech-to-speech backend) ───
  // Second realtime backend, mirroring the ORB_GROK_* surface one-for-one:
  // Google's Live API replaces the local pipeline when enabled (mutually
  // exclusive with the Grok toggle — main enforces it). Main owns the config
  // (<userData>/gemini-voice.json, includes the user's Google AI key — never
  // shipped to the renderer) and the WebSocket session; the renderer owns
  // mic capture + PCM playback through the same realtime voice client.
  /** Renderer→main invoke, no payload. Returns the public config
   *  `{ enabled, voice, hasKey, keyTail }`. */
  ORB_GEMINI_GET_CONFIG: 'rax:orb-gemini-get-config',
  /** Renderer→main invoke. Partial `{ enabled?, apiKey?, voice? }` merge-
   *  write. Returns `{ ok, config }` (public shape). Flipping `enabled`
   *  rebuilds the orb backend on the spot (and switches Grok off). */
  ORB_GEMINI_SET_CONFIG: 'rax:orb-gemini-set-config',
  /** Main → orb renderer push: public config, sent on renderer-ready and
   *  after every config change so the notch settings stay in sync. */
  ORB_GEMINI_CONFIG: 'rax:orb-gemini-config',
  /** Renderer→main invoke, no payload. Opens the realtime WebSocket session.
   *  Returns `{ ok, error? }`. */
  ORB_GEMINI_START: 'rax:orb-gemini-start',
  /** Renderer→main invoke, no payload. Closes the realtime session. */
  ORB_GEMINI_STOP: 'rax:orb-gemini-stop',
  /** Renderer→main, fire-and-forget. Base64 PCM16 mono 24kHz mic chunk for
   *  the live realtime session (sent ~16×/sec while a session is open). */
  ORB_GEMINI_AUDIO: 'rax:orb-gemini-audio',
  /** Renderer→main, fire-and-forget. Same ⌥R hold-edge contract as
   *  ORB_GROK_HOLD, for Gemini-mode push-to-talk sessions. */
  ORB_GEMINI_HOLD: 'rax:orb-gemini-hold',
  /** Main → orb renderer push: realtime session events in the same shape as
   *  ORB_GROK_EVENT (the renderer client is shared between the backends). */
  ORB_GEMINI_EVENT: 'rax:orb-gemini-event',
  /** Renderer (orb) → main, fire-and-forget. Same caption contract as
   *  ORB_GROK_CAPTION, for Gemini-mode sessions. */
  ORB_GEMINI_CAPTION: 'rax:orb-gemini-caption',

  // ─── Auto-updater ───
  // Backed by `electron-updater` reading `latest-mac.yml` from the GitHub
  // release configured in package.json `build.publish`. The renderer drives
  // checks from the Settings "About" panel; the main process also runs a
  // silent background check shortly after boot + every 6 hours.
  /** Renderer→main invoke. Triggers a check; returns the new status snapshot.
   *  Payload `{ userInitiated: true }` opens the Software Update window when
   *  an update is found; background checks pass `false` and stay silent
   *  (auto-download, then the window appears only when ready to install). */
  UPDATER_CHECK: 'rax:updater-check',
  /** Renderer→main invoke. Opens (or focuses) the dedicated Software Update
   *  window. The window renders the live UpdaterStatus and drives
   *  download/install itself. */
  UPDATER_OPEN_WINDOW: 'rax:updater-open-window',
  /** Renderer→main invoke. Starts downloading the available update. No-op
   *  if no update is currently available. */
  UPDATER_DOWNLOAD: 'rax:updater-download',
  /** Renderer→main send. Quits the app and runs the downloaded installer,
   *  then relaunches. */
  UPDATER_INSTALL: 'rax:updater-install',
  /** Renderer→main invoke. Returns the most recent UpdaterStatus snapshot
   *  without forcing a check (use UPDATER_CHECK to actively poll). */
  UPDATER_GET_STATUS: 'rax:updater-get-status',
  /** Main→renderer broadcast. Fires whenever the updater transitions
   *  (checking → available → downloading → downloaded / error). */
  UPDATER_STATUS: 'rax:updater-status',

  // Legacy (kept for backward compat during migration)
  STREAM_EVENT: 'rax:stream-event',
  RUN_COMPLETE: 'rax:run-complete',
  RUN_ERROR: 'rax:run-error',
} as const

export type ClaudeMode = 'bundled' | 'system'

export interface ClaudeInstanceInfo {
  mode: ClaudeMode
  label: string
  homeDescription: string
  binaryPath: string
  available: boolean
  unavailableReason?: string | null
  version: string | null
  /** Login state surfaced by `claude auth status`. Null when the CLI is
   *  unavailable; otherwise an object with at minimum `signedIn`. Modern CLI
   *  ships `loggedIn`/`authMethod`/`apiProvider`; older CLI versions return
   *  `email`/`subscriptionType` instead — we normalize into `signedIn` so the
   *  renderer doesn't have to know about either shape. */
  auth: {
    signedIn: boolean
    email?: string
    subscriptionType?: string
    authMethod?: string
    apiProvider?: string
  } | null
  mcpServers: string[]
}

/** Rax cloud auth state surfaced to the renderer. */
export interface RaxAuthStatus {
  /** True when env-injection is active and a key is present. */
  enabled: boolean
  /** True when a key is stored locally (regardless of `enabled`). */
  signedIn: boolean
  /** First 12 chars of the active key (e.g. `rax_sk_AbCd`), for display only. */
  keyPrefix: string | null
  /** Base URL the CLI is pointed at when rax-mode is on. */
  baseUrl: string
}

/** Live account info pulled from the Rax /api/me endpoint. Null fields
 *  when the user is not signed in or the fetch failed. */
export interface RaxAccountInfo {
  email: string | null
  balanceCents: number | null
  /** ISO timestamp of when this snapshot was fetched. */
  fetchedAt: string | null
  /** True when the last fetch errored (network / 401 / 5xx). */
  error: string | null
}

/** Stream of events from a running `claude login` flow. */
export type ClaudeLoginEvent =
  | { kind: 'output'; text: string }
  | { kind: 'url'; url: string }
  | { kind: 'exit'; code: number | null; signedIn: boolean }
  | { kind: 'error'; message: string }

/** State of the auto-updater pipeline. Drives the Settings "Check for
 *  updates" UI + tray menu badge. Kept in sync via `UPDATER_STATUS`
 *  broadcasts; UI state should mirror this rather than tracking its own
 *  parallel copy. */
export type UpdaterPhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error'
  | 'unsupported'

export interface UpdaterStatus {
  phase: UpdaterPhase
  currentVersion: string
  availableVersion?: string
  releaseNotes?: string
  releaseUrl?: string
  downloadPercent?: number
  bytesPerSecond?: number
  transferred?: number
  total?: number
  error?: string
  /** True when the most recent check came from a user button click rather
   *  than the background timer. The Settings UI uses this to decide whether
   *  to highlight "no updates" or stay quiet. */
  userInitiated?: boolean
}

// ─── Code Mode ───

export type CodeModeStatus = 'idle' | 'detecting' | 'starting' | 'ready' | 'error' | 'stopping'

export type DeviceMode = 'mobile' | 'tablet' | 'desktop'

export interface DetectedProject {
  kind:
    | 'next'
    | 'vite'
    | 'cra'
    | 'angular'
    | 'nuxt'
    | 'sveltekit'
    | 'astro'
    | 'electron'
    | 'node-script'
    | 'static-html'
    | 'unknown'
  label: string
  command: string
  args: string[]
  /** Best-guess port if stdout parsing fails */
  fallbackPort: number
  /** Some frameworks honour PORT env override */
  honorsPortEnv: boolean
}

export interface CodeModeState {
  status: CodeModeStatus
  projectPath: string | null
  project: DetectedProject | null
  url: string | null
  error: string | null
  device: DeviceMode
  inspecting: boolean
}
