// Fullscreen window preload — re-exports the standard `rax` API.
// We keep this as a separate entry so the build system produces a dedicated
// dist/preload/fullscreen.js. Functionally it's identical to the pill preload
// since both renderers talk to the same main-process IPC.
import './index'
