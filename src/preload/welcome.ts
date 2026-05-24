// Welcome window preload — reuses the standard `rax` API. The welcome
// surface needs onboarding/raxAuth/openExternal, all of which are
// already in the shared API. This file exists so electron-vite emits a
// dedicated dist/preload/welcome.js for the welcome BrowserWindow.
import './index'
