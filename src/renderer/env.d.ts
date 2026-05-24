/// <reference types="vite/client" />

import type { RaxAPI } from '../preload/index'

declare module '*.mp3' {
  const src: string
  export default src
}

declare global {
  interface Window {
    rax: RaxAPI
  }
}
