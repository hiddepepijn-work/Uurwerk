import { useCallback, useEffect, useRef, useState } from 'react'
import type { JarvisStatus } from '@core/contract/api.js'
import { api } from '../../api/client.js'
import { CloseIcon, MicIcon, SendIcon } from '../../ui/icons.js'

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
    audioFocus?: { take(): Promise<void>; release(): Promise<void> }
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
      const reply = await api.jarvis.ask({
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
      .then(setStatus)
      .catch((error: unknown) => setProblem(error instanceof Error ? error.message : String(error)))
  }, [open])

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
    <div className="fixed inset-0 z-[70] flex items-end justify-center bg-black/60 wide:items-center wide:p-6">
      <section
        aria-label="Jarvis"
        className="flex h-full w-full flex-col bg-card pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] wide:h-[640px] wide:max-w-[520px] wide:rounded-[20px] wide:border wide:border-border wide:pt-0 wide:pb-0"
      >
        <header className="flex items-center gap-3 border-b border-border px-4 py-3">
          <span className={`h-2.5 w-2.5 rounded-full ${status?.ready ? 'bg-accent' : 'bg-text-faint'}`} />
          <div className="flex min-w-0 flex-1 flex-col">
            <h2 className="text-[17px] font-semibold">Jarvis</h2>
            <span className="truncate text-[12px] text-text-dim">
              {status ? (status.ready ? `${status.model}${status.voice ? ' · Orus' : ' · zonder stem'}` : status.problem) : 'Verbinden…'}
            </span>
          </div>
          <button
            onClick={onClose}
            aria-label="Sluiten"
            className="flex h-11 w-11 items-center justify-center rounded-full text-text-dim hover:bg-card-hover"
          >
            <CloseIcon size={20} />
          </button>
        </header>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4">
          {lines.length === 0 && !busy && (
            <div className="mt-8 flex flex-col items-center gap-3 text-center">
              <button
                onClick={() => void ask({ text: 'Hoe ziet mijn dag eruit?' })}
                className="rounded-full border border-border px-4 py-2.5 text-[14px] text-text"
              >
                Hoe ziet mijn dag eruit?
              </button>
              <button
                onClick={() => void ask({ text: 'Ik wil een afspraak toevoegen.' })}
                className="rounded-full border border-border px-4 py-2.5 text-[14px] text-text"
              >
                Afspraak toevoegen
              </button>
              <button
                onClick={() => void ask({ text: 'Ik wil een taak toevoegen.' })}
                className="rounded-full border border-border px-4 py-2.5 text-[14px] text-text"
              >
                Taak toevoegen
              </button>
            </div>
          )}
          {lines.map((line, index) => (
            <div
              key={index}
              className={`max-w-[85%] rounded-[16px] px-3.5 py-2.5 text-[15px] leading-snug whitespace-pre-wrap ${
                line.from === 'jarvis' ? 'self-start bg-bg text-text' : 'self-end bg-accent text-bg'
              }`}
            >
              {line.text}
            </div>
          ))}
          {busy && <div className="self-start text-[13px] text-text-dim">Jarvis denkt na…</div>}
          {problem && (
            <div className="rounded-[10px] border border-prio-med/40 bg-prio-med/10 px-3.5 py-2.5 text-[13px] text-prio-med">
              {problem}
            </div>
          )}
          <div ref={bottom} />
        </div>

        <footer className="flex items-end gap-2 border-t border-border px-3 py-3">
          {Recognition && (
            <button
              onClick={listen}
              aria-label={listening ? 'Stop met luisteren' : 'Praat tegen Jarvis'}
              className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full ${
                listening ? 'animate-pulse bg-prio-high text-bg' : 'bg-bg text-text'
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
            className="max-h-32 min-h-11 flex-1 resize-none rounded-[22px] border border-border bg-bg px-4 py-2.5 text-[15px] text-text outline-none placeholder:text-text-faint focus:border-accent"
          />
          <button
            onClick={send}
            disabled={busy || !draft.trim()}
            aria-label="Versturen"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-accent text-bg disabled:opacity-40"
          >
            <SendIcon size={18} />
          </button>
        </footer>
      </section>
    </div>
  )
}
