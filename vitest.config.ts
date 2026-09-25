import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

/**
 * Test configuration.
 *
 * Vitest does not read `electron.vite.config.ts` — that file exports three separate builds
 * (main, preload, renderer) rather than a single config, so the `@core` alias defined there
 * is invisible here. Core's own tests never noticed, because they import each other by
 * relative path; a main-process test importing `@core/...` fails to resolve without this.
 *
 * The alias is duplicated rather than imported from the electron config to keep this file
 * readable on its own. It has exactly one job, and it must match `tsconfig.json`'s `paths`.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@core': resolve(__dirname, 'packages/core/src'),
      '@backend': resolve(__dirname, 'packages/backend/src')
    }
  },
  test: {
    include: ['packages/**/*.test.ts', 'packages/**/*.test.tsx']
  }
})
