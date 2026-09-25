import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const alias = {
  '@core': resolve(__dirname, 'packages/core/src'),
  '@backend': resolve(__dirname, 'packages/backend/src'),
  '@main': resolve(__dirname, 'packages/main/src'),
  '@renderer': resolve(__dirname, 'packages/renderer/src')
}

export default defineConfig({
  main: {
    resolve: { alias },
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/main',
      lib: { entry: resolve(__dirname, 'packages/main/src/index.ts') },
      // CommonJS on purpose: the main process uses __dirname, which does not exist in ESM.
      rollupOptions: { output: { format: 'cjs', entryFileNames: 'index.cjs' } }
    }
  },
  preload: {
    resolve: { alias },
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/preload',
      // Two bridges, not one: the app gets TimeTrackerAPI, the hidden timelapse encoder
      // gets five channels and nothing else.
      lib: {
        entry: {
          index: resolve(__dirname, 'packages/preload/src/index.ts'),
          timelapse: resolve(__dirname, 'packages/preload/src/timelapse.ts')
        }
      },
      // A sandboxed preload script cannot be an ES module — it must be CommonJS.
      rollupOptions: { output: { format: 'cjs', entryFileNames: '[name].cjs' } }
    }
  },
  renderer: {
    root: resolve(__dirname, 'packages/renderer'),
    resolve: { alias },
    plugins: [react(), tailwindcss()],
    build: {
      outDir: resolve(__dirname, 'out/renderer'),
      emptyOutDir: true,
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'packages/renderer/index.html'),
          quickadd: resolve(__dirname, 'packages/renderer/quickadd.html'),
          timelapse: resolve(__dirname, 'packages/renderer/timelapse.html')
        }
      }
    }
  }
})
