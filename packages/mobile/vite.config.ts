/**
 * The phone build: the renderer's screens plus core and backend, bundled for a web view.
 * `npm run build:mobile` writes packages/mobile/dist, which Capacitor copies into the app.
 */

import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

const root = resolve(__dirname, '../..')
const stub = resolve(__dirname, 'src/stubs/node.ts')

export default defineConfig({
  root: __dirname,
  // Relative asset paths: the web view loads the bundle from capacitor://localhost/.
  base: './',
  publicDir: resolve(__dirname, 'public'),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      { find: '@core', replacement: resolve(root, 'packages/core/src') },
      { find: '@backend', replacement: resolve(root, 'packages/backend/src') },
      { find: '@renderer', replacement: resolve(root, 'packages/renderer/src') },
      // No Node on a phone; see src/stubs/node.ts for why that is fine.
      { find: /^node:(fs|fs\/promises|path|os)$/, replacement: stub },
      { find: /^(nodemailer|node-sqlite3-wasm)$/, replacement: stub }
    ]
  },
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    // Top-level await and the rest of ES2022: every iOS the app supports (17+) has it.
    target: 'es2022',
    chunkSizeWarningLimit: 4000
  },
  server: { port: 5188 }
})
