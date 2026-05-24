import type { CodeModePreviewAPI } from '../../preload/code-mode'

declare global {
  interface Window {
    codeMode: CodeModePreviewAPI
  }
}

export {}
