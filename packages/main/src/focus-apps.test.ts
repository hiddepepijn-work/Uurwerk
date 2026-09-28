import { describe, expect, it } from 'vitest'
import { isSystemProcess, parseProcessLines, planAllowListClose, siteKey, siteList, type RunningProcess } from './focus-apps.js'

const proc = (pid: number, name: string, windowed = true): RunningProcess => ({ pid, name, windowed })

const plan = (running: RunningProcess[], pending: Map<number, string> = new Map()) =>
  planAllowListClose({
    running,
    allowed: ['Code', 'chrome.exe', ' spotify '],
    pending,
    ownPids: new Set([4242]),
    ownNames: new Set(['uurwerk'])
  })

describe('focus apps', () => {
  it('parses the PowerShell listing', () => {
    const out = '1234,True,Discord\r\n88,False,svchost\r\nnoise\r\n7,True,Foo, Bar \r\n'
    expect(parseProcessLines(out)).toEqual([proc(1234, 'discord'), proc(88, 'svchost', false), proc(7, 'foo, bar')])
  })

  it('closes windowed programs that are not allowed', () => {
    const { close, kill } = plan([proc(1, 'discord'), proc(2, 'code'), proc(3, 'chrome'), proc(4, 'spotify')])
    expect(close.map((p) => p.name)).toEqual(['discord'])
    expect(kill).toEqual([])
  })

  it('leaves windowless background processes alone', () => {
    expect(plan([proc(1, 'steamservice', false)]).close).toEqual([])
  })

  it('never touches Windows, NVIDIA or itself', () => {
    const running = [
      proc(1, 'explorer'),
      proc(2, 'taskmgr'),
      proc(3, 'windowsterminal'),
      proc(4, 'nvidia overlay'),
      proc(5, 'nvidia share'),
      proc(6, 'rtkuwp'),
      proc(4242, 'whatever'),
      proc(7, 'uurwerk')
    ]
    expect(plan(running)).toEqual({ close: [], kill: [] })
    expect(isSystemProcess('SearchHost.exe')).toBe(true)
  })

  it('kills a program asked last time that is still there, even hidden to the tray', () => {
    const pending = new Map([
      [1, 'discord'],
      [2, 'steam'],
      [9, 'gone']
    ])
    const { close, kill } = plan([proc(1, 'discord', false), proc(2, 'steamwebhelper'), proc(3, 'epicgameslauncher')], pending)
    expect(kill.map((p) => p.pid)).toEqual([1])
    // A reused pid under another name is a new program: asked first, not killed.
    expect(close.map((p) => p.pid)).toEqual([2, 3])
  })

  it('does not kill an allowed program even if it was pending', () => {
    expect(plan([proc(1, 'code')], new Map([[1, 'code']])).kill).toEqual([])
  })

  it('reads sites loosely', () => {
    expect(siteKey('https://www.YouTube.com/watch?v=1')).toBe('www.youtube.com')
    expect(siteKey('*.x.com')).toBe('x.com')
    expect(siteList(['x.com', 'X.com ', '', 'nonsense', 'twitter.com:443'])).toEqual(['x.com', 'twitter.com'])
  })
})
