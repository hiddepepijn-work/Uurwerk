#!/usr/bin/env node
/**
 * The devices that sync with this server.
 *
 *   uurwerk-devices add laptop      prints the token once — paste it into the app
 *   uurwerk-devices list
 *   uurwerk-devices remove laptop   locks that device out at its next round
 */

import { readConfig } from '../src/config.js'
import { DeviceStore } from '../src/devices.js'

const config = readConfig()
const devices = new DeviceStore(config.devicesFile)
const [command, name] = process.argv.slice(2)

try {
  if (command === 'add' && name) {
    const token = devices.add(name)
    console.log(`Apparaat "${name}" aangemaakt. Het token staat hieronder en wordt nergens bewaard:`)
    console.log('')
    console.log(`  ${token}`)
    console.log('')
    console.log('Plak het in Uurwerk → Settings → Server. Kwijt? Maak het apparaat opnieuw aan.')
  } else if (command === 'list') {
    const rows = devices.list()
    if (rows.length === 0) console.log('Nog geen apparaten. Maak er een met: uurwerk-devices add laptop')
    for (const row of rows) console.log(`${row.name.padEnd(20)} sinds ${new Date(row.createdAt).toISOString().slice(0, 10)}`)
  } else if (command === 'remove' && name) {
    console.log(devices.remove(name) ? `${name} verwijderd.` : `${name} bestond niet.`)
  } else {
    console.log('Gebruik: uurwerk-devices add <naam> | list | remove <naam>')
    process.exitCode = 1
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
