// Software Update window preload — reuses the standard `rax` API. The
// update surface needs the updater methods + openExternal, all of which
// are already in the shared API. This file exists so electron-vite emits
// a dedicated dist/preload/update.js for the update BrowserWindow.
import './index'
