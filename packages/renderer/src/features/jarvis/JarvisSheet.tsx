import { useCallback, useEffect, useRef, useState } from 'react'
import type { JarvisStatus } from '@core/contract/api.js'
import { api } from '../../api/client.js'
import { CloseIcon, MicIcon, SendIcon } from '../../ui/icons.js'
import { askJarvis } from './ask.js'

/**
 * Talking to Jarvis: his replies as text and in his own voice, yours typed or dictated.
 *
 * Opened from the Jarvis tab or button, or by the 08:30 and 21:00 notifications — then with
 * a moment, and Jarvis speaks first. The conversation runs on the server; this is only the
 * window onto it.
 */

interface Line {
  from: 'jarvis' | 'hidde'
  text: string
}

/** Set by the phone app: pauses Spotify or Apple Music while Jarvis speaks. */
declare global {
  interface Window {
    audioFocus?: {
      take(): Promise<void>
      release(): Promise<void>
      /** Phone only: keep the screen on during a live call. */
      keepAwake?(options: { on: boolean }): Promise<void>
      /** Phone only: conversation audio, with the AirPods' microphone when they are in. */
      voiceSession?(options: { on: boolean }): Promise<{ input?: string }>
    }
    webkitSpeechRecognition?: new () => SpeechRecognitionLike
    SpeechRecognition?: new () => SpeechRecognitionLike
  }
}

interface SpeechRecognitionLike {
  lang: string
  interimResults: boolean
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null
  onend: (() => void) | null
  onerror: (() => void) | null
  start(): void
  stop(): void
}

const Recognition = typeof window !== 'undefined' ? (window.SpeechRecognition ?? window.webkitSpeechRecognition) : undefined

async function play(audio: string | null, text: string, type = 'audio/mpeg'): Promise<void> {
  await window.audioFocus?.take().catch(() => undefined)
  const release = (): void => void window.audioFocus?.release().catch(() => undefined)
  if (audio) {
    const player = new Audio(`data:${type};base64,${audio}`)
    player.onended = release
    player.onerror = release
    await player.play().catch(release)
    return
  }
  // No voice on the server: the device's own Dutch voice rather than silence.
  if ('speechSynthesis' in window) {
    const utterance = new SpeechSynthesisUtterance(text)
    utterance.lang = 'nl-NL'
    utterance.onend = release
    utterance.onerror = release
    window.speechSynthesis.speak(utterance)
  } else release()
}

export function JarvisSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [lines, setLines] = useState<Line[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [listening, setListening] = useState(false)
  const [status, setStatus] = useState<JarvisStatus | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const conversation = useRef<string | null>(null)
  const recognition = useRef<SpeechRecognitionLike | null>(null)
  const bottom = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' })
  }, [lines, busy])

  const ask = useCallback(async (input: { text?: string; moment?: 'morning' | 'evening' }) => {
    setBusy(true)
    setProblem(null)
    if (input.text) setLines((current) => [...current, { from: 'hidde', text: input.text! }])
    try {
      const reply = await askJarvis({
        conversationId: input.moment ? null : conversation.current,
        ...(input.text ? { text: input.text } : {}),
        ...(input.moment ? { moment: input.moment } : {}),
        speak: true
      })
      conversation.current = reply.conversationId
      setLines((current) => [...current, { from: 'jarvis', text: reply.text }])
      void play(reply.audio, reply.text, reply.audioType ?? undefined)
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    void api.jarvis
      .status()
      .then((next) => {
        setStatus(next)
        // The first contact of the day opens the day.
        if (next.ready && next.openingDue && conversation.current === null) void ask({ moment: 'morning' })
      })
      .catch((error: unknown) => setProblem(error instanceof Error ? error.message : String(error)))
  }, [open, ask])

  const send = (): void => {
    const text = draft.trim()
    if (!text || busy) return
    setDraft('')
    void ask({ text })
  }

  const listen = (): void => {
    if (!Recognition) return
    if (listening) {
      recognition.current?.stop()
      return
    }
    const rec = new Recognition()
    rec.lang = 'nl-NL'
    rec.interimResults = false
    rec.onresult = (event) => {
      const heard = Array.from(event.results)
        .map((result) => result[0]?.transcript ?? '')
        .join(' ')
        .trim()
      if (heard) void ask({ text: heard })
    }
    rec.onend = () => setListening(false)
    rec.onerror = () => setListening(false)
    recognition.current = rec
    setListening(true)
    rec.start()
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[70] flex items-end justify-center bg-scrim wide:items-center wide:p-6">
      <section
        aria-label="Jarvis"
        className="flex h-full w-full flex-col bg-bg pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] wide:h-[640px] wide:max-w-[520px] wide:rounded-modal wide:bg-card wide:pt-0 wide:pb-0"
      >
        <header className="flex items-center gap-3 border-b border-border px-5 py-3.5">
          <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${status?.ready ? 'bg-accent' : 'bg-text-faint'}`} />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <h2 className="font-display text-[28px] leading-none font-bold tracking-[-0.4px] text-text">Jarvis</h2>
            <span className="truncate text-[13px] font-semibold text-text-dim tabular-nums">
              {status
                ? status.ready
                  ? `${status.model}${status.spend ? ` · ${status.spend.usd.toFixed(2)} / ${status.spend.capUsd} deze maand` : ''}`
                  : status.problem
                : 'Verbinden…'}
            </span>
          </div>
          <button
            onClick={onClose}
            aria-label="Sluiten"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-input text-text-dim transition-colors hover:text-text"
          >
            <CloseIcon size={18} />
          </button>
        </header>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4">
          {lines.length === 0 && !busy && (
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => void ask({ text: 'Hoe ziet mijn dag eruit?' })}
                className="h-9 rounded-pill bg-rail-active px-3.5 text-[13px] font-bold text-accent-soft transition-[filter] hover:brightness-125"
              >
                Hoe ziet mijn dag eruit?
              </button>
              <button
                onClick={() => void ask({ text: 'Ik wil een afspraak toevoegen.' })}
                className="h-9 rounded-pill bg-rail-active px-3.5 text-[13px] font-bold text-accent-soft transition-[filter] hover:brightness-125"
              >
                Afspraak toevoegen
              </button>
              <button
                onClick={() => void ask({ text: 'Ik wil een taak toevoegen.' })}
                className="h-9 rounded-pill bg-rail-active px-3.5 text-[13px] font-bold text-accent-soft transition-[filter] hover:brightness-125"
              >
                Taak toevoegen
              </button>
            </div>
          )}
          {lines.map((line, index) => (
            <div
              key={index}
              className={`max-w-[85%] rounded-[20px] px-3.5 py-[11px] text-[15px] leading-[1.42] whitespace-pre-wrap ${
                line.from === 'jarvis'
                  ? 'self-start rounded-bl-[6px] bg-card font-medium text-text wide:bg-input'
                  : 'self-end rounded-br-[6px] bg-accent font-semibold text-accent-ink'
              }`}
            >
              {line.text}
            </div>
          ))}
          {busy && (
            <div className="flex items-center gap-2 self-start pl-1 text-[14px] font-semibold text-text-dim">
              <span className="flex gap-1" aria-hidden="true">
                <span className="h-1.5 w-1.5 rounded-full bg-text-faint" />
                <span className="h-1.5 w-1.5 rounded-full bg-text-dim" />
                <span className="h-1.5 w-1.5 rounded-full bg-text-faint" />
              </span>
              Jarvis denkt na…
            </div>
          )}
          {problem && (
            <div className="rounded-input bg-warn-soft px-3.5 py-2.5 text-[13px] font-semibold text-warn">
              {problem}
            </div>
          )}
          <div ref={bottom} />
        </div>

        <footer className="flex items-end gap-2 border-t border-border px-3.5 py-3">
          {Recognition && (
            <button
              onClick={listen}
              aria-label={listening ? 'Stop met luisteren' : 'Praat tegen Jarvis'}
              className={`flex h-[46px] w-[46px] shrink-0 items-center justify-center rounded-full transition-colors ${
                listening ? 'animate-pulse bg-danger text-text' : 'bg-input text-text hover:bg-secondary-hover'
              }`}
            >
              <MicIcon size={20} />
            </button>
          )}
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                send()
              }
            }}
            rows={1}
            placeholder="Zeg of typ iets…"
            aria-label="Bericht aan Jarvis"
            className="max-h-32 min-h-[46px] flex-1 resize-none rounded-[23px] bg-input px-4 py-3 text-[15px] leading-[1.4] font-medium text-text outline-none placeholder:text-text-faint focus:ring-2 focus:ring-accent/40"
          />
          <button
            onClick={send}
            disabled={busy || !draft.trim()}
            aria-label="Versturen"
            className="flex h-[46px] w-[46px] shrink-0 items-center justify-center rounded-full bg-accent text-accent-ink transition-colors hover:bg-accent-soft disabled:opacity-40"
          >
            <SendIcon size={18} />
          </button>
        </footer>
      </section>
    </div>
  )
}
