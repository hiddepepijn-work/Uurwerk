#!/usr/bin/env node
/**
 * The keys the server uses on your behalf: the language model and the voice for Jarvis.
 *
 *   uurwerk-secrets set anthropicKey      asks for the value with the echo off
 *   uurwerk-secrets set openaiKey
 *   uurwerk-secrets set azureSpeechKey
 *   uurwerk-secrets list                  which keys are set (never their values)
 *   uurwerk-secrets remove openaiKey
 *
 * Stored in secrets.json in the data directory, mode 0600, readable by the service user
 * only — the same file the server reads. A value never appears on screen or in history.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { readConfig } from '../src/config.js'

const KNOWN = ['anthropicKey', 'openaiKey', 'azureSpeechKey']
const file = join(readConfig().dataDir, 'secrets.json')
const [command, key] = process.argv.slice(2)

const read = () => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
}
const write = (vault) => writeFileSync(file, JSON.stringify(vault), { mode: 0o600 })

/** Reads a line with the echo off; piped input (echo … | uurwerk-secrets set …) works too. */
function askHidden(question) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      let data = ''
      process.stdin.setEncoding('utf8')
      process.stdin.on('data', (chunk) => (data += chunk))
      process.stdin.on('end', () => resolve(data.trim()))
      return
    }
    process.stdout.write(question)
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.setEncoding('utf8')
    let value = ''
    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === '\r' || character === '\n') {
          process.stdin.setRawMode(false)
          process.stdin.pause()
          process.stdin.off('data', onData)
          process.stdout.write('\n')
          resolve(value.trim())
          return
        }
        if (character === '\u0003') process.exit(130)
        if (character === '\u007f') value = value.slice(0, -1)
        else value += character
      }
    }
    process.stdin.on('data', onData)
  })
}

async function main() {
  if (command === 'list') {
    const vault = read()
    for (const name of KNOWN) console.log(`${name.padEnd(16)} ${vault[name] ? 'gezet' : '—'}`)
    return
  }
  if ((command === 'set' || command === 'remove') && KNOWN.includes(key)) {
    const vault = read()
    if (command === 'remove') {
      delete vault[key]
      write(vault)
      console.log(`${key} verwijderd.`)
      return
    }
    const value = await askHidden(`${key}: `)
    if (!value) {
      console.log('Leeg; er is niets veranderd.')
      return
    }
    vault[key] = value
    write(vault)
    console.log(`${key} opgeslagen. Herstart niet nodig: de server leest hem bij de volgende vraag.`)
    return
  }
  console.log(`Gebruik: uurwerk-secrets set|remove <${KNOWN.join('|')}> | list`)
  process.exitCode = 1
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
