import { useCallback, useEffect, useRef, useState } from 'react'
import { api, events } from '../../api/client.js'
import { CloseIcon, SendIcon } from '../../ui/icons.js'
import { askJarvis } from './ask.js'
import { JarvisOrb, type OrbState } from './JarvisOrb.js'
import { LiveCall } from './live.js'

/**
 * Talking to Jarvis, the way a phone call works. First choice is live (live.ts): the voice
 * streams both ways and either side can cut in. When live is not there — no connection,
 * budget spent — it falls back to turns: listen, send what you said when you pause, speak
 * the answer, listen again. Tap the orb to cut in: while he talks it stops him.
 *
 * The turn-based listening is the phone's own speech recognition (window.jarvisListen, set
 * by the phone app). Without it — on the laptop — that mode takes typed questions.
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
  const live = useRef<LiveCall | null>(null)
  const [isLive, setIsLive] = useState(false)
  /** What Jarvis cost this month, shown in the header so it stays in sight. */
  const [spent, setSpent] = useState<string | null>(null)
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
        const answer = await askJarvis({
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
  const pendingPrompt = useRef<string | null>(null)
  useEffect(
    () =>
      events.on('jarvis:open', ({ moment, prompt }) => {
        pendingMoment.current = moment
        pendingPrompt.current = prompt ?? null
      }),
    []
  )

  const startLive = useCallback(
    async (moment: 'morning' | 'evening' | null): Promise<boolean> => {
      try {
        const call = await LiveCall.start(moment, level, {
          onPhase: (next) => alive.current && setPhase(next),
          onHeard: (text) => alive.current && setHeard(text),
          onReply: (text) => alive.current && setReply(text),
          onEnd: (trouble) => {
            live.current = null
            if (!alive.current) return
            setIsLive(false)
            setProblem(trouble)
            setPhase('idle')
          }
        })
        if (!alive.current) {
          void call.end()
          return true
        }
        live.current = call
        setIsLive(true)
        return true
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.info(`[jarvis] live lukt niet: ${message}`)
        if (alive.current) setProblem(`Live lukt niet (${message}), dus even op de oude manier.`)
        return false
      }
    },
    []
  )

  // Opening: straight into the conversation — live when it can.
  useEffect(() => {
    if (!open) return
    alive.current = true
    conversation.current = null
    setReply('')
    setHeard('')
    setProblem(null)
    const asked = pendingMoment.current
    pendingMoment.current = null
    const prompt = pendingPrompt.current
    pendingPrompt.current = null
    void api.jarvis
      .status()
      .then((status) => status.spend && setSpent(`${status.spend.usd.toFixed(2)} / ${status.spend.capUsd} deze maand`))
      .catch(() => undefined)
    // The first contact of the day opens the day, whatever it was opened for.
    // A situation to open with (a check-in) goes first: the day's opening can wait for it.
    void (prompt ? Promise.resolve(null) : asked ? Promise.resolve(asked) : api.jarvis.status().then((status) => (status.openingDue ? 'morning' : null)).catch(() => null))
      .then((moment) => {
        if (!alive.current) return
        return startLive(moment).then((ok) => {
          if (!alive.current) return
          if (ok) {
            if (prompt) live.current?.say(prompt)
            return
          }
          if (prompt) void ask({ text: prompt })
          else if (moment) void ask({ moment })
          else void listen()
        })
      })
    return () => {
      alive.current = false
      void live.current?.end()
      live.current = null
      setIsLive(false)
      player.current?.stop()
      void bridge?.stop().catch(() => undefined)
      level.current = 0
    }
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const tapOrb = (): void => {
    if (live.current) {
      if (phase === 'speaking') live.current.interrupt()
      return
    }
    if (isLive || phase === 'thinking') return
    if (phase === 'idle') {
      setProblem(null)
      void startLive(null).then((ok) => {
        if (!ok) void listen()
      })
      return
    }
    if (phase === 'speaking') {
      player.current?.stop()
      return // the loop moves on to listening once the voice has stopped
    }
    if (phase === 'listening') {
      void bridge?.stop()
      return
    }
  }

  const sendTyped = (): void => {
    const text = draft.trim()
    if (!text || phase === 'thinking') return
    setDraft('')
    setHeard(text)
    if (live.current) live.current.say(text)
    else void ask({ text })
  }

  if (!open) return null

  const caption = phase === 'listening' && heard ? heard : phase === 'speaking' ? reply : LABEL[phase]

  return (
    <div className="fixed inset-0 z-[70] flex flex-col bg-bg pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
      <header className="grid grid-cols-[1fr_auto_1fr] items-center px-4 py-3">
        <div className="flex">
          <button
            onClick={onKeyboard}
            className="h-[38px] rounded-pill bg-input px-3.5 text-[14px] font-bold text-text transition-colors hover:bg-secondary-hover"
            aria-label="Typen in plaats van praten"
          >
            Typen
          </button>
        </div>
        <span className="flex flex-col items-center gap-0.5 leading-tight">
          <span className="font-display text-[20px] font-bold text-text">Jarvis</span>
          {spent && <span className="text-[12px] font-bold text-text-faint tabular-nums">{spent}</span>}
        </span>
        <div className="flex justify-end">
          <button
            onClick={onClose}
            aria-label="Sluiten"
            className="flex h-10 w-10 items-center justify-center rounded-full bg-input text-text-dim transition-colors hover:text-text"
          >
            <CloseIcon size={18} />
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-[30px] px-7 pb-10">
        <button
          onClick={tapOrb}
          aria-label={phase === 'speaking' ? 'Onderbreek Jarvis' : phase === 'listening' ? 'Klaar met praten' : 'Praat tegen Jarvis'}
          className="rounded-full"
        >
          <JarvisOrb state={phase} level={level} size={300} />
        </button>

        <p
          className={`max-w-md text-center transition-opacity duration-300 ${
            phase === 'speaking' || (phase === 'listening' && heard)
              ? 'text-[19px] leading-[1.4] font-medium text-text'
              : phase === 'idle'
                ? 'text-[15px] leading-snug font-semibold text-text-dim'
                : 'text-[13px] font-bold tracking-[1px] text-accent-soft'
          }`}
        >
          {caption}
        </p>

        {problem && (
          <p className="max-w-md rounded-input bg-warn-soft px-4 py-3 text-center text-[13px] font-semibold text-warn">
            {problem}
          </p>
        )}
      </div>

      {!bridge && (
        <footer className="flex items-end gap-2 px-3.5 pb-4">
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && sendTyped()}
            placeholder="Vraag het Jarvis…"
            aria-label="Bericht aan Jarvis"
            className="h-[46px] flex-1 rounded-pill bg-input px-4 text-[15px] font-medium text-text outline-none placeholder:text-text-faint focus:ring-2 focus:ring-accent/40"
          />
          <button
            onClick={sendTyped}
            aria-label="Versturen"
            className="flex h-[46px] w-[46px] shrink-0 items-center justify-center rounded-full bg-accent text-accent-ink transition-colors hover:bg-accent-soft"
          >
            <SendIcon size={18} />
          </button>
        </footer>
      )}
    </div>
  )
}
