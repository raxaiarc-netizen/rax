import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'dist/main',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'dist/preload',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          'code-mode': resolve(__dirname, 'src/preload/code-mode.ts'),
          fullscreen: resolve(__dirname, 'src/preload/fullscreen.ts'),
          orb: resolve(__dirname, 'src/preload/orb.ts'),
          intro: resolve(__dirname, 'src/preload/intro.ts'),
          'caption-pill': resolve(__dirname, 'src/preload/caption-pill.ts'),
          welcome: resolve(__dirname, 'src/preload/welcome.ts'),
          update: resolve(__dirname, 'src/preload/update.ts'),
          dock: resolve(__dirname, 'src/preload/dock.ts')
        }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react(), tailwindcss()],
    build: {
      outDir: resolve(__dirname, 'dist/renderer'),
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          'code-mode': resolve(__dirname, 'src/renderer/code-mode.html'),
          fullscreen: resolve(__dirname, 'src/renderer/fullscreen.html'),
          orb: resolve(__dirname, 'src/renderer/orb.html'),
          intro: resolve(__dirname, 'src/renderer/intro.html'),
          'caption-pill': resolve(__dirname, 'src/renderer/caption-pill.html'),
          welcome: resolve(__dirname, 'src/renderer/welcome.html'),
          update: resolve(__dirname, 'src/renderer/update.html'),
          dock: resolve(__dirname, 'src/renderer/dock.html')
        }
      }
    }
  }
})
