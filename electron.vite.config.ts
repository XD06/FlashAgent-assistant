import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { resolve } from 'node:path'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs'
        }
      }
    },
    resolve: {
      alias: {
        '@main': resolve('src/main'),
        '@shared': resolve('src/shared')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs'
        }
      }
    },
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    }
  },
  renderer: {
    plugins: [react()],
    // Pin the dev server to IPv4. Without this, "localhost" may bind to ::1
    // (IPv6) while Electron resolves it to 127.0.0.1 — the window then loads
    // a blank page with ERR_CONNECTION_REFUSED, seemingly at random.
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true
    },
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer'),
        '@shared': resolve('src/shared')
      }
    },
    build: {
      rollupOptions: {
        input: {
          settings: resolve(__dirname, 'src/renderer/settings.html'),
          selectionAction: resolve(__dirname, 'src/renderer/selectionAction.html'),
          selectionToolbar: resolve(__dirname, 'src/renderer/selectionToolbar.html'),
          screenshotOverlay: resolve(__dirname, 'src/renderer/screenshotOverlay.html'),
          screenshotPin: resolve(__dirname, 'src/renderer/screenshotPin.html')
        }
      }
    }
  }
})
