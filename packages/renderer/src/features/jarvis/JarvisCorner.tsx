import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'

import type { JarvisCard } from '@core/contract/types.js'

import { api, events } from '../../api/client.js'
import { CloseIcon } from '../../ui/icons.js'
import { JarvisOrb, type OrbState } from './JarvisOrb.js'
import { LiveCall } from './live.js'
import { WakeWord } from './wake.js'

/**
 * Jarvis in the corner of the laptop screen.
 *
 * "Jarvis" (the wake word) or Ctrl+Alt+J calls him: the orb springs out of the bottom-right
 * corner and the live conversation starts. What he adds or changes springs out of the orb
 * as cards — the appointment, the task, the planned block — and a click on one opens the
 * app there. He leaves by himself when the conversation has gone quiet, and the wake word
 * listens again.
 */

/** Quiet this long while listening, and he goes: half a minute of an open mic is enough. */
const QUIET_MS = 25_000
/** Cards stay this long after the conversation ended, to read them. */
const LINGER_MS = 9_000

interface ShownCard extends JarvisCard {
  key: number
}

/** Each kind in a muted Inkt colour: `color` for the icon and label, `tile` behind the icon. */
const KIND: Record<JarvisCard['kind'], { label: string; color: string; tile: string; icon: ReactNode }> = {
  afspraak: {
    label: 'Afspraak',
    color: '#6fb5ad',
    tile: '#172624',
    icon: (
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
        <rect x="3.5" y="5" width="17" height="15" rx="3" />
        <path d="M3.5 10h17M8 3v4M16 3v4" />
      </svg>
    )
  },
  planning: {
    label: 'Planning',
    color: '#5dae86',
    tile: '#1b2721',
    icon: (
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
        <circle cx="12" cy="12" r="8.5" />
        <path d="M12 7.5V12l3 2" />
      </svg>
    )
  },
  taak: {
    label: 'Taak',
    color: '#a997cf',
    tile: '#221e2c',
    icon: (
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
        <rect x="4" y="4" width="16" height="16" rx="4" />
        <path d="M8.5 12.5l2.5 2.5 4.5-5" />
      </svg>
    )
  },
  regel: {
    label: 'Regel',
    color: '#d1a55a',
    tile: '#2b2416',
    icon: (
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
        <path d="M6 4h12M6 20h12M8 4v5l4 3-4 3v5M16 4v5l-4 3 4 3v5" />
      </svg>
    )
  },
  timer: {
    label: 'Timer',
    color: '#5dae86',
    tile: '#1b2721',
    icon: (
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
        <circle cx="12" cy="13" r="7.5" />
        <path d="M12 9.5V13M9.5 3h5" />
      </svg>
    )
  }
}

const ACTION: Record<JarvisCard['action'], string> = {
  nieuw: 'Nieuw',
  gewijzigd: 'Gewijzigd',
  af: 'Af',
  weg: 'Weg'
}

/** The action chip's tint: new and done read as green, a change as amber, removed as red. */
const ACTION_TONE: Record<JarvisCard['action'], string> = {
  nieuw: 'bg-area-stage-tint text-accent-soft',
  gewijzigd: 'bg-warn-soft text-warn',
  af: 'bg-area-stage-tint text-accent-soft',
  weg: 'bg-danger-soft text-danger-text'
}

/** An error as a sentence: without Electron's "Error invoking remote method …" wrapping. */
const plain = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '')

/** The cards a confirm carried out, from its tool result. */
function cardsFrom(result: unknown): JarvisCard[] {
  const executed = (result as { executed?: Array<{ cards?: JarvisCard[] }> } | null)?.executed
  return Array.isArray(executed) ? executed.flatMap((entry) => entry.cards ?? []) : []
}

export function JarvisCorner() {
  const [shown, setShown] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const [phase, setPhase] = useState<OrbState>('idle')
  const [heard, setHeard] = useState('')
  const [reply, setReply] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [cards, setCards] = useState<ShownCard[]>([])
  const level = useRef(0)
  const call = useRef<LiveCall | null>(null)
  const wake = useRef<WakeWord | null>(null)
  const starting = useRef(false)
  const lastActivity = useRef(Date.now())
  const phaseRef = useRef<OrbState>('idle')
  const cardKey = useRef(0)
  const lingerTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** Cards on screen, for the call's handlers (made once, when the call starts). */
  const cardCount = useRef(0)
  cardCount.current = cards.length

  const touch = (): void => {
    lastActivity.current = Date.now()
  }

  // ------------------------------------------------------------- leaving

  const leave = useCallback(async (): Promise<void> => {
    if (lingerTimer.current) clearTimeout(lingerTimer.current)
    const ending = call.current
    call.current = null
    await ending?.end().catch(() => undefined)
    setLeaving(true)
    setTimeout(() => {
      setShown(false)
      setLeaving(false)
      setCards([])
      setHeard('')
      setReply('')
      setProblem(null)
      setPhase('idle')
      void api.window.jarvisInteractive(false)
      void api.window.jarvisHide()
      void wake.current?.resume().catch(() => undefined)
    }, 300)
  }, [])

  /** The conversation is over; the cards stay a moment to be read. */
  const lingerThenLeave = useCallback(
    (ms: number): void => {
      if (lingerTimer.current) clearTimeout(lingerTimer.current)
      lingerTimer.current = setTimeout(() => void leave(), ms)
    },
    [leave]
  )

  // ------------------------------------------------------------- calling

  const summon = useCallback(async (): Promise<void> => {
    if (call.current || starting.current) return
    starting.current = true
    if (lingerTimer.current) clearTimeout(lingerTimer.current)
    await wake.current?.pause().catch(() => undefined)
    await api.window.jarvisShow()
    setLeaving(false)
    setShown(true)
    setProblem(null)
    setHeard('')
    setReply('')
    setPhase('thinking')
    touch()
    try {
      const status = await api.jarvis.status().catch(() => null)
      call.current = await LiveCall.start(status?.openingDue ? 'morning' : null, level, {
        onPhase: (next) => {
          phaseRef.current = next
          setPhase(next)
          touch()
        },
        onHeard: (text) => {
          setHeard(text)
          setReply('')
          touch()
        },
        onReply: (text) => {
          setReply(text)
          touch()
        },
        onEnd: (trouble) => {
          call.current = null
          if (trouble) setProblem(plain(trouble))
          setPhase('idle')
          lingerThenLeave(trouble ? 7_000 : LINGER_MS)
        },
        // "Doei": gone as soon as he has said it, unless there are cards to read.
        onGoodbye: () => lingerThenLeave(cardCount.current > 0 ? LINGER_MS : 600),
        onToolResult: (name, result) => {
          if (name !== 'confirm') return
          const made = cardsFrom(result)
          if (made.length === 0) return
          touch()
          setCards((current) => [...made.map((card) => ({ ...card, key: (cardKey.current += 1) })), ...current].slice(0, 5))
        }
      })
    } catch (error) {
      setProblem(plain(error))
      setPhase('idle')
      lingerThenLeave(7_000)
    } finally {
      starting.current = false
    }
  }, [lingerThenLeave])

  // Quiet for a while: he goes, and takes the open microphone with him.
  useEffect(() => {
    const timer = setInterval(() => {
      if (!call.current) return
      // Someone talking is activity, even before any words come back.
      if (call.current.hearing) lastActivity.current = Date.now()
      if (phaseRef.current === 'listening' && Date.now() - lastActivity.current > QUIET_MS) {
        const ending = call.current
        call.current = null
        void ending.end()
        setPhase('idle')
        lingerThenLeave(cards.length > 0 ? LINGER_MS : 600)
      }
    }, 1000)
    return () => clearInterval(timer)
  }, [cards.length, lingerThenLeave])

  // The hotkey, and the wake word.
  useEffect(() => events.on('jarvis:summon', () => void summon()), [summon])

  // #demo: the corner as it looks mid-conversation, without a microphone or a model — for
  // checking the design (scripts/corner-preview.cjs takes screenshots of it).
  useEffect(() => {
    if (window.location.hash !== '#demo') return
    setShown(true)
    setPhase('speaking')
    setReply('Staat erin. BO afmaken morgen van zes tot zeven, en Wie betaald wat direct daarna.')
    const pulse = setInterval(() => (level.current = 0.25 + Math.random() * 0.6), 120)
    const sample: JarvisCard[] = [
      { kind: 'planning', action: 'nieuw', title: 'BO afmaken', when: 'ma 28/9 18:00–19:00', date: null },
      { kind: 'planning', action: 'nieuw', title: 'Wie betaald wat invullen', when: 'ma 28/9 19:00–20:00', date: null },
      { kind: 'afspraak', action: 'nieuw', title: 'Eten bij Juul', when: 'za 3/10 19:00–21:30', date: null }
    ]
    const timer = setTimeout(() => setCards(sample.map((card, index) => ({ ...card, key: index + 1 })).reverse()), 500)
    return () => {
      clearInterval(pulse)
      clearTimeout(timer)
    }
  }, [])
  // The wake word: on while the setting says so; switching it in Settings takes effect at once.
  useEffect(() => {
    if (window.location.hash === '#demo') return
    let stopped = false
    // One change at a time: a settings event during a start would otherwise open a second
    // capture, and two streams interleaved into the detector drown the wake word.
    let busy: Promise<void> = Promise.resolve()
    const sync = (): void => {
      busy = busy
        .then(async () => {
          const on = await api.window.wakeWordOn()
          if (stopped) return
          if (on && !wake.current) wake.current = await WakeWord.start()
          if (!on && wake.current) {
            await wake.current.stop()
            wake.current = null
          }
        })
        .catch((error: unknown) => console.warn('Wake word unavailable:', error))
    }
    sync()
    const off = events.on('data:invalidated', ({ domain }) => domain === 'settings' && sync())
    return () => {
      stopped = true
      off()
      void wake.current?.stop()
    }
  }, [])

  // ------------------------------------------------------------- drawing

  const interactive = (on: boolean) => () => void api.window.jarvisInteractive(on)
  const tapOrb = (): void => {
    if (call.current && phase === 'speaking') call.current.interrupt()
    else if (!call.current) void summon()
  }
  const open = (card: JarvisCard): void => {
    void api.window.openApp(card.kind === 'taak' ? 'tasks' : 'agenda')
    void leave()
  }

  if (!shown) return null

  const caption = problem ?? (reply || heard || (phase === 'listening' ? 'Ik luister…' : phase === 'thinking' ? 'Even denken…' : ''))

  return (
    <div className="pointer-events-none fixed inset-0 flex flex-col items-end justify-end gap-3 p-3 select-none">
      {/* Cards: newest nearest the orb, springing out of it. */}
      <div className={`flex w-[300px] flex-col-reverse gap-2 ${leaving ? 'corner-out' : ''}`}>
        {cards.map((card, index) => {
          const kind = KIND[card.kind]
          return (
            <button
              key={card.key}
              onClick={() => open(card)}
              onMouseEnter={interactive(true)}
              onMouseLeave={interactive(false)}
              className="corner-glass corner-card corner-card-in pointer-events-auto flex items-start gap-3 rounded-[18px] p-3 text-left"
              style={{ animationDelay: `${index * 90}ms` }}
            >
              <span
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-input"
                style={{ color: kind.color, background: kind.tile }}
              >
                {kind.icon}
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
                <span className="flex items-center gap-2 text-[11px] font-bold tracking-[1px] uppercase" style={{ color: kind.color }}>
                  {kind.label}
                  <span className={`rounded-pill px-2 py-0.5 text-[11px] font-bold tracking-normal normal-case ${ACTION_TONE[card.action]}`}>
                    {ACTION[card.action]}
                  </span>
                </span>
                <span
                  className={`truncate text-[15px] leading-[1.25] font-bold text-text ${card.action === 'weg' ? 'line-through opacity-70' : ''}`}
                >
                  {card.title}
                </span>
                {card.when && <span className="text-[13px] text-text-dim tabular-nums">{card.when}</span>}
              </span>
            </button>
          )
        })}
      </div>

      <div className={`flex items-end gap-3 ${leaving ? 'corner-out' : ''}`}>
        {caption && (
          <div
            key={caption.length > 0 ? 'caption' : 'none'}
            onMouseEnter={interactive(true)}
            onMouseLeave={interactive(false)}
            className={`corner-glass corner-caption-in pointer-events-auto mb-4 max-w-[250px] rounded-[20px] rounded-br-[6px] px-4 py-3 text-[15px] leading-[1.4] font-semibold ${
              problem ? 'text-warn' : reply ? 'text-text' : 'text-text-dim'
            }`}
          >
            {caption}
          </div>
        )}

        <div
          onMouseEnter={interactive(true)}
          onMouseLeave={interactive(false)}
          className="group corner-orb-in pointer-events-auto relative"
        >
          <button
            onClick={tapOrb}
            aria-label={phase === 'speaking' ? 'Onderbreek Jarvis' : 'Jarvis'}
            className={`corner-orb-shell flex h-[128px] w-[128px] items-center justify-center overflow-hidden rounded-full ${
              phase === 'listening' ? 'corner-listening' : ''
            }`}
          >
            <JarvisOrb state={phase} level={level} size={116} />
          </button>
          <button
            onClick={() => void leave()}
            aria-label="Jarvis wegsturen"
            className="corner-close absolute top-0.5 right-0.5 flex h-7 w-7 items-center justify-center rounded-full bg-input text-text-dim opacity-0 transition-opacity group-hover:opacity-100 hover:text-text"
          >
            <CloseIcon size={12} />
          </button>
        </div>
      </div>
    </div>
  )
}
