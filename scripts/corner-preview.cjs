// Screenshots of the laptop's Jarvis corner in its demo state, to check the design before
// shipping. Run after `npx electron-vite build`:
//
//   npx electron scripts/corner-preview.cjs <output-dir>
//
// Renders out/renderer/jarvis.html#demo offscreen over a desktop-like background and saves
// frames during the spring animations and once they have settled.
const { app, BrowserWindow } = require('electron')
const { writeFileSync, mkdirSync } = require('node:fs')
const { join, resolve } = require('node:path')

const out = resolve(process.argv[process.argv.length - 1])
mkdirSync(out, { recursive: true })

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 420,
    height: 620,
    show: false,
    webPreferences: {
      offscreen: true,
      preload: join(__dirname, 'corner-preview-preload.cjs'),
      contextIsolation: true
    }
  })
  window.webContents.on('console-message', (_event, _level, message) => console.log('[page]', message))
  window.webContents.on('did-fail-load', (_event, code, description, url) => console.log('[fail]', code, description, url))
  // A wallpaper-ish backdrop, so the glass reads as it would over a real desktop.
  window.webContents.on('dom-ready', () => {
    void window.webContents.insertCSS(
      'html,body{background:radial-gradient(circle at 20% 20%,#3b4a6b,#1a2233 55%,#101520) !important;}'
    )
  })
  await window.loadFile(join(__dirname, '../out/renderer/jarvis.html'), { hash: 'demo' })
  for (const [name, ms] of [['0-start', 120], ['1-orb', 450], ['2-cards-mid', 750], ['3-settled', 2200]]) {
    await new Promise((done) => setTimeout(done, ms))
    const image = await window.webContents.capturePage()
    writeFileSync(join(out, `corner-${name}.png`), image.toPNG())
  }
  app.quit()
})
