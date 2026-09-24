import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'

/**
 * A panel anchored to a control.
 *
 * Positioned `fixed` from the anchor's rectangle rather than absolutely inside it, because
 * every place these are used — the task editor, the day planner — sits inside a modal that
 * scrolls, and an absolutely positioned panel gets clipped by the first ancestor with
 * `overflow: auto`. Fixed escapes that entirely.
 *
 * Flips above the anchor when there is no room below, so a field near the bottom of a
 * dialog does not open a calendar off the edge of the window.
 */
export function Popover({
  anchor,
  open,
  onClose,
  children,
  width = 280
}: {
  anchor: RefObject<HTMLElement | null>
  open: boolean
  onClose: () => void
  children: ReactNode
  width?: number
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null)

  useLayoutEffect(() => {
    if (!open || !anchor.current) return

    const place = (): void => {
      const rect = anchor.current?.getBoundingClientRect()
      if (!rect) return

      const height = panelRef.current?.offsetHeight ?? 320
      const room = window.innerHeight - rect.bottom
      const top = room < height + 12 ? Math.max(8, rect.top - height - 6) : rect.bottom + 6
      const left = Math.min(Math.max(8, rect.left), window.innerWidth - width - 8)

      setPosition({ top, left })
    }

    place()
    // The dialog behind this can scroll while the panel is open; follow the anchor.
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open, anchor, width])

  useEffect(() => {
    if (!open) return

    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    const onDown = (event: MouseEvent): void => {
      const target = event.target as Node
      if (panelRef.current?.contains(target)) return
      if (anchor.current?.contains(target)) return
      onClose()
    }

    // Capture, so Escape closes the picker without also closing the dialog behind it.
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('mousedown', onDown)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('mousedown', onDown)
    }
  }, [open, onClose, anchor])

  if (!open) return null

  return (
    <div
      ref={panelRef}
      role="dialog"
      style={{
        position: 'fixed',
        top: position?.top ?? -9999,
        left: position?.left ?? -9999,
        width
      }}
      className="z-50 rounded-[12px] border border-border-strong bg-card p-3 shadow-2xl"
    >
      {children}
    </div>
  )
}
