/**
 * Architectural boundaries are enforced here, not by convention.
 *
 *   core     -> pure domain logic. May not know about electron or react.
 *   main     -> the backend process. May use electron + core.
 *   renderer -> the frontend. May not touch node, fs, sqlite or core/db.
 *
 * Breaking a boundary fails `npm run lint`, which fails the build.
 */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 2022, sourceType: 'module', ecmaFeatures: { jsx: true } },
  plugins: ['@typescript-eslint', 'react-hooks'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react-hooks/recommended'
  ],
  env: { node: true, browser: true, es2022: true },
  ignorePatterns: ['out/', 'dist/', 'node_modules/', '*.cjs'],
  rules: {
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    '@typescript-eslint/no-explicit-any': 'warn'
  },
  overrides: [
    {
      files: ['packages/core/**/*.ts'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            paths: [
              { name: 'electron', message: 'core must stay electron-free — it is reused by the web view.' },
              { name: 'react', message: 'core must stay react-free.' },
              { name: 'react-dom', message: 'core must stay react-free.' }
            ]
          }
        ]
      }
    },
    {
      // The backend runs on the laptop and on the VPS. Anything Electron goes through host().
      files: ['packages/backend/**/*.ts'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            paths: [
              { name: 'electron', message: 'backend must stay electron-free — it also runs on the server. Use host().' },
              { name: 'react', message: 'backend must stay react-free.' }
            ],
            patterns: [{ group: ['@main/*', '@renderer/*'], message: 'backend may not reach into main or renderer.' }]
          }
        ]
      }
    },
    {
      files: ['packages/renderer/**/*.{ts,tsx}'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            paths: [
              { name: 'electron', message: 'renderer talks to the backend only via @renderer/api/client.' },
              { name: 'fs', message: 'no filesystem access in the renderer.' },
              { name: 'node:fs', message: 'no filesystem access in the renderer.' },
              { name: 'path', message: 'no node builtins in the renderer.' },
              { name: 'node:path', message: 'no node builtins in the renderer.' },
              { name: 'better-sqlite3', message: 'the renderer never touches the database.' }
            ],
            patterns: [
              {
                group: ['@core/db/*', '@core/db', '@core/services/*'],
                message: 'renderer may import @core/contract only — logic lives behind the IPC seam.'
              }
            ]
          }
        ]
      }
    }
  ]
}
