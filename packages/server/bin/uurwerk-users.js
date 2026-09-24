#!/usr/bin/env node
/**
 * Making the two accounts, on the server, by hand.
 *
 * There is no sign-up page and there is not going to be one. Two people get an account —
 * the internship supervisor and the teacher — and they get it from you, over a channel you
 * chose. This is that command.
 *
 *   uurwerk-users add begeleider supervisor        asks for a password, twice
 *   uurwerk-users add docent teacher --password …  for a script; it lands in your shell history
 *   uurwerk-users list
 *   uurwerk-users remove docent
 *
 * The password is asked for with the echo switched off when a terminal is attached, so it
 * does not end up on screen or in `~/.bash_history`.
 */

import { readConfig } from '../src/config.js'
import { ROLES, ROLE_LABELS, UserStore } from '../src/users.js'

const config = readConfig()
const users = new UserStore(config.usersFile)

const [command, ...rest] = process.argv.slice(2)

function flag(name) {
  const index = rest.indexOf(`--${name}`)
  return index === -1 ? null : (rest[index + 1] ?? null)
}

const positional = rest.filter((argument, index) => {
  if (argument.startsWith('--')) return false
  return !(index > 0 && rest[index - 1]?.startsWith('--'))
})

/** Reads a line with the echo off, so a password never appears on screen. */
function askHidden(question) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error('No terminal to ask on. Pass --password instead.'))
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
          resolve(value)
          return
        }
        if (character === '\u0003') {
          process.stdout.write('\n')
          process.exit(130)
        }
        if (character === '\u007f') value = value.slice(0, -1)
        else value += character
      }
    }
    process.stdin.on('data', onData)
  })
}

async function main() {
  if (command === 'list') {
    const rows = await users.list()
    if (rows.length === 0) {
      console.log('Nog geen accounts. Maak er een met: uurwerk-users add <naam> <rol>')
      return
    }
    for (const row of rows) {
      console.log(`${row.username.padEnd(20)} ${ROLE_LABELS[row.role] ?? row.role}`)
    }
    return
  }

  if (command === 'remove') {
    const [username] = positional
    if (!username) throw new Error('Usage: uurwerk-users remove <naam>')
    const gone = await users.remove(username)
    console.log(gone ? `${username} verwijderd.` : `${username} bestond niet.`)
    return
  }

  if (command === 'add' || command === 'passwd') {
    const [username, role] = positional
    if (!username) throw new Error(`Usage: uurwerk-users ${command} <naam> <rol>`)

    const existing = (await users.list()).find((user) => user.username === username)
    const chosenRole = role ?? existing?.role
    if (!chosenRole || !ROLES.includes(chosenRole)) {
      throw new Error(`Give a role: ${ROLES.join(' or ')}.`)
    }

    let password = flag('password')
    if (!password) {
      password = await askHidden('Wachtwoord: ')
      const again = await askHidden('Nog een keer: ')
      if (password !== again) throw new Error('De wachtwoorden zijn niet gelijk.')
    }

    await users.upsert({ username, role: chosenRole, password })
    console.log(`${username} opgeslagen als ${ROLE_LABELS[chosenRole]}.`)
    console.log(`Accounts staan in ${config.usersFile}`)
    return
  }

  console.log(`uurwerk-users add <naam> <supervisor|teacher> [--password …]
uurwerk-users passwd <naam>
uurwerk-users remove <naam>
uurwerk-users list

Accounts: ${config.usersFile}`)
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
