import { StrictMode, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { Priority } from '@core/contract/types.js'
import { api } from './api/client.js'
import { PriorityDot } from './ui/PriorityDot.js'
import './styles/globals.css'

const PRIORITIES: Priority[] = ['high', 'medium', 'low']

/**
 * The Ctrl+Alt+T window: one field, three dots, Enter.
 *
 * Its whole reason to exist is that capturing a task must not cost you your train of
 * thought — no window switch, no project picker, no due date. Details can be filled in
 * later on the Tasks screen; the thought cannot be recovered later.
 */
function QuickAdd() {
  const [title, setTitle] = useState('')
  const [priority, setPriority] = useState<Priority>('medium')
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const submit = async (): Promise<void> => {
    const trimmed = title.trim()
    if (!trimmed || busy) return
    setBusy(true)
    try {
      await api.tasks.create({ title: trimmed, priority })
      setTitle('')
      await api.window.closeQuickAdd()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="drag-region flex h-full items-center gap-3 border border-border bg-card px-4">
      <input
        ref={inputRef}
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') void submit()
          if (event.key === 'Escape') void api.window.closeQuickAdd()
        }}
        placeholder="Add a task..."
        className="no-drag min-w-0 flex-1 bg-transparent text-[15px] text-text outline-none placeholder:text-text-faint"
      />

      <div className="no-drag flex items-center gap-2">
        {PRIORITIES.map((option) => (
          <button
            key={option}
            onClick={() => setPriority(option)}
            aria-label={option}
            className={`flex h-6 w-6 items-center justify-center rounded-full transition-all
              ${priority === option ? 'bg-bg ring-1 ring-border-strong' : 'opacity-45 hover:opacity-80'}`}
          >
            <PriorityDot priority={option} size={9} />
          </button>
        ))}
      </div>

      <kbd className="no-drag shrink-0 font-mono text-[11px] text-text-faint">Ctrl+Alt+T</kbd>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QuickAdd />
  </StrictMode>
)
