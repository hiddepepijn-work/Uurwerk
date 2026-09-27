// A stand-in for the real preload bridge: the corner's demo state only needs calls that
// answer quietly, and events that never fire.
const { contextBridge } = require('electron')

const quiet = async () => null

contextBridge.exposeInMainWorld('api', {
  window: {
    jarvisShow: quiet,
    jarvisHide: quiet,
    jarvisInteractive: quiet,
    openApp: quiet,
    wakeWordKey: quiet
  },
  jarvis: {
    status: async () => ({ openingDue: false, ready: true })
  }
})
contextBridge.exposeInMainWorld('events', { on: () => () => undefined })
