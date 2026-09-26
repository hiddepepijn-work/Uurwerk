import { useCallback, useEffect, useRef, useState } from 'react'
import { api, events } from '../../api/client.js'
import { CloseIcon, SendIcon } from '../../ui/icons.js'
import { JarvisOrb, type OrbState } from './JarvisOrb.js'

/**
 * Talking to Jarvis, the way a phone call works: it opens listening, sends what you said
 * when you pause, speaks the answer, and listens again — until you close it. Tap the orb to
 * cut in: while he talks it stops him and listens; while you talk it sends right away.
 *
 * Listening is the phone's own speech recognition (window.jarvisListen, set by the phone
 * app). Without it — on the laptop — the same screen takes typed questions and still speaks.
 */

export interface ListenBridge {
  start(): Promise<void>
  stop(): Promise<void>
  onPartial(handler: (text: string) => void): () => void
  onLevel(handler: (level: number) => void): () => void
  onEnd(handler: (text: string) => void): () => void
}

declare global {
  interface Window {
    jarvisListen?: ListenBridge
  }
}

const LABEL: Record<OrbState, string> = {
  idle: 'Tik op de bol om te praten',
  listening: 'Ik luister…',
  thinking: 'Even denken…',
  speaking: ''
}

export function JarvisVoice({
  open,
  onClose,
  onKeyboard
}: {
  open: boolean
  onClose: () => void
  /** Switch to the typed conversation. */
  onKeyboard: () => void
}) {
  const [phase, setPhase] = useState<OrbState>('idle')
  const [heard, setHeard] = useState('')
  const [reply, setReply] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const level = useRef(0)
  const conversation = useRef<string | null>(null)
  const player = useRef<{ stop: () => void } | null>(null)
  const alive = useRef(false)
  const bridge = typeof window !== 'undefined' ? window.jarvisListen : undefined

  // ------------------------------------------------------------ speaking

  const speak = useCallback(async (audio: string | null, text: string, type = 'audio/mpeg'): Promise<void> => {
    await window.audioFocus?.take().catch(() => undefined)
    const release = (): void => void window.audioFocus?.release().catch(() => undefined)

    if (!audio) {
      // No voice from the server: the device's own, with a gentle made-up level.
      await new Promise<void>((resolve) => {
        if (!('speechSynthesis' in window)) return resolve()
        const utterance = new SpeechSynthesisUtterance(text)
        utterance.lang = 'nl-NL'
        const pulse = setInterval(() => (level.current = 0.35 + Math.random() * 0.4), 90)
        const done = (): void => {
          clearInterval(pulse)
          level.current = 0
          resolve()
        }
        utterance.onend = done
        utterance.onerror = done
        player.current = { stop: () => (window.speechSynthesis.cancel(), done()) }
        window.speechSynthesis.speak(utterance)
      })
      release()
      return
    }

    // Measure the voice as it plays: the orb moves with what you hear.
    await new Promise<void>((resolve) => {
      const element = new Audio(`data:${type};base64,${audio}`)
      const context = new AudioContext()
      const source = context.createMediaElementSource(element)
      const analyser = context.createAnalyser()
      analyser.fftSize = 512
      source.connect(analyser)
      analyser.connect(context.destination)
      const samples = new Uint8Array(analyser.fftSize)
      let frame = 0
      const measure = (): void => {
        analyser.getByteTimeDomainData(samples)
        let sum = 0
        for (const sample of samples) sum += ((sample - 128) / 128) ** 2
        level.current = Math.min(1, Math.sqrt(sum / samples.length) * 4)
        frame = requestAnimationFrame(measure)
      }
      const done = (): void => {
        cancelAnimationFrame(frame)
        level.current = 0
        void context.close().catch(() => undefined)
        resolve()
      }
      element.onended = done
      element.onerror = done
      player.current = {
        stop: () => {
          element.pause()
          done()
        }
      }
      void context.resume().then(() => element.play()).catch(done)
      measure()
    })
    release()
  }, [])

  // ----------------------------------------------------------- the loop

  const listen = useCallback(async (): Promise<void> => {
    if (!bridge || !alive.current) {
      setPhase('idle')
      return
    }
    setHeard('')
    setPhase('listening')
    try {
      await bridge.start()
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
      setPhase('idle')
    }
  }, [bridge])

  const ask = useCallback(
    async (input: { text?: string; moment?: 'morning' | 'evening' }): Promise<void> => {
      setPhase('thinking')
      setProblem(null)
      try {
        const answer = await api.jarvis.ask({
          conversationId: input.moment ? null : conversation.current,
          ...(input.text ? { text: input.text } : {}),
          ...(input.moment ? { moment: input.moment } : {}),
          speak: true
        })
        if (!alive.current) return
        conversation.current = answer.conversationId
        setReply(answer.text)
        setPhase('speaking')
        await speak(answer.audio, answer.text, answer.audioType ?? undefined)
        if (alive.current) void listen()
      } catch (error) {
        setProblem(error instanceof Error ? error.message : String(error))
        setPhase('idle')
      }
    },
    [listen, speak]
  )

  // The phone's recognizer: words as they come, loudness, and the finished sentence.
  useEffect(() => {
    if (!bridge) return
    const offPartial = bridge.onPartial((text) => setHeard(text))
    const offLevel = bridge.onLevel((value) => (level.current = value))
    const offEnd = bridge.onEnd((text) => {
      level.current = 0
      if (!alive.current) return
      if (text.trim()) void ask({ text: text.trim() })
      else setPhase('idle')
    })
    return () => {
      offPartial()
      offLevel()
      offEnd()
    }
  }, [bridge, ask])

  // A moment from a notification: Jarvis opens the conversation himself.
  const pendingMoment = useRef<'morning' | 'evening' | null>(null)
  useEffect(
    () =>
      events.on('jarvis:open', ({ moment }) => {
        pendingMoment.current = moment
      }),
    []
  )

  // Opening: straight into the conversation.
  useEffect(() => {
    if (!open) return
    alive.current = true
    conversation.current = null
    setReply('')
    setHeard('')
    setProblem(null)
    const moment = pendingMoment.current
    pendingMoment.current = null
    if (moment) void ask({ moment })
    else void listen()
    return () => {
      alive.current = false
      player.current?.stop()
      void bridge?.stop().catch(() => undefined)
      level.current = 0
    }
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const tapOrb = (): void => {
    if (phase === 'speaking') {
      player.current?.stop()
      return // the loop moves on to listening once the voice has stopped
    }
    if (phase === 'listening') {
      void bridge?.stop()
      return
    }
    if (phase === 'idle') void listen()
  }

  const sendTyped = (): void => {
    const text = draft.trim()
    if (!text || phase === 'thinking') return
    setDraft('')
    setHeard(text)
    void ask({ text })
  }

  if (!open) return null

  const caption = phase === 'listening' && heard ? heard : phase === 'speaking' ? reply : LABEL[phase]

  return (
    <div className="fixed inset-0 z-[70] flex flex-col bg-bg pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
      <header className="flex items-center justify-between px-4 py-3">
        <button
          onClick={onKeyboard}
          className="h-11 rounded-full bg-card px-4 text-[14px] text-text-dim"
          aria-label="Typen in plaats van praten"
        >
          Typen
        </button>
        <span className="text-[15px] font-semibold text-text">Jarvis</span>
        <button
          onClick={onClose}
          aria-label="Sluiten"
          className="flex h-11 w-11 items-center justify-center rounded-full bg-card text-text"
        >
          <CloseIcon size={20} />
        </button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-8 px-6">
        <button
          onClick={tapOrb}
          aria-label={phase === 'speaking' ? 'Onderbreek Jarvis' : phase === 'listening' ? 'Klaar met praten' : 'Praat tegen Jarvis'}
          className="rounded-full"
        >
          <JarvisOrb state={phase} level={level} size={280} />
        </button>

        <p
          className={`max-w-md text-center leading-snug transition-opacity duration-300 ${
            phase === 'speaking' || (phase === 'listening' && heard) ? 'text-[19px] text-text' : 'text-[15px] text-text-dim'
          }`}
        >
          {caption}
        </p>

        {problem && (
          <p className="max-w-md rounded-[12px] border border-prio-med/40 bg-prio-med/10 px-4 py-3 text-center text-[13px] text-prio-med">
            {problem}
          </p>
        )}
      </div>

      {!bridge && (
        <footer className="flex items-end gap-2 px-4 pb-4">
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && sendTyped()}
            placeholder="Vraag het Jarvis…"
            aria-label="Bericht aan Jarvis"
            className="h-12 flex-1 rounded-full border border-border bg-card px-5 text-[15px] text-text outline-none placeholder:text-text-faint focus:border-accent"
          />
          <button
            onClick={sendTyped}
            aria-label="Versturen"
            className="flex h-12 w-12 items-center justify-center rounded-full bg-accent text-bg"
          >
            <SendIcon size={18} />
          </button>
        </footer>
      )}
    </div>
  )
}
