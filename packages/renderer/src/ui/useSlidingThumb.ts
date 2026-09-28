import { useCallback, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react'

export interface ThumbRect {
  x: number
  y: number
  width: number
  height: number
}

interface Options {
  /** Finds the active item inside the container. Default: the child marked `data-active="true"`. */
  selector?: string
  /** Transition duration in ms. 500 for segmented controls, 550 for navigation. */
  duration?: number
  /** Easing variable: 'bouncy' (default, like the spec's thumbs and pills) or 'soft'. */
  spring?: 'bouncy' | 'soft'
}

/**
 * A light thumb that slides to the active item of a segmented control, tab bar or rail,
 * instead of the highlight jumping from button to button.
 *
 *   const { containerRef, thumbStyle } = useSlidingThumb<HTMLDivElement>(view)
 *   <div ref={containerRef} className="relative ...">
 *     <span aria-hidden className="absolute rounded-[10px] bg-text" style={thumbStyle} />
 *     {options.map((o) => (
 *       <button data-active={o === view} className="relative z-[1] ..." />
 *     ))}
 *   </div>
 *
 * `activeKey` is whatever identifies the selection; the hook re-measures when it changes and
 * whenever the container resizes. The thumb is positioned from the container's top-left
 * corner with a transform (plus width/height, so it can follow items of different widths).
 * The very first placement is instant, so the thumb does not fly in from the corner.
 *
 * `rect` is exposed for callers that want to draw something else there (a centred glow
 * circle, say); `thumbStyle` is null-safe and hides the thumb while nothing is active.
 */
export function useSlidingThumb<T extends HTMLElement = HTMLElement>(
  activeKey: unknown,
  { selector = '[data-active="true"]', duration = 500, spring = 'bouncy' }: Options = {}
): { containerRef: RefObject<T | null>; rect: ThumbRect | null; thumbStyle: CSSProperties; measure: () => void } {
  const containerRef = useRef<T | null>(null)
  const [rect, setRect] = useState<ThumbRect | null>(null)
  // Off for the first placement, on for every move after it.
  const [animate, setAnimate] = useState(false)

  const measure = useCallback((): void => {
    const container = containerRef.current
    const active = container?.querySelector<HTMLElement>(selector)
    if (!container || !active) {
      setRect(null)
      return
    }
    const outer = container.getBoundingClientRect()
    const inner = active.getBoundingClientRect()
    // Scroll offset keeps the thumb right inside a scrolling container (the side rail).
    const next = {
      x: inner.left - outer.left + container.scrollLeft - container.clientLeft,
      y: inner.top - outer.top + container.scrollTop - container.clientTop,
      width: inner.width,
      height: inner.height
    }
    setRect((previous) =>
      previous &&
      previous.x === next.x &&
      previous.y === next.y &&
      previous.width === next.width &&
      previous.height === next.height
        ? previous
        : next
    )
  }, [selector])

  useLayoutEffect(() => {
    measure()
  }, [activeKey, measure])

  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => measure())
    observer.observe(container)
    return () => observer.disconnect()
  }, [measure])

  // Turn the transition on only after the first placement has been painted.
  useLayoutEffect(() => {
    if (!rect || animate) return
    const frame = requestAnimationFrame(() => setAnimate(true))
    return () => cancelAnimationFrame(frame)
  }, [rect, animate])

  const easing = spring === 'soft' ? 'var(--spring-soft)' : 'var(--spring-bouncy)'
  const thumbStyle: CSSProperties = {
    position: 'absolute',
    left: 0,
    top: 0,
    width: rect?.width ?? 0,
    height: rect?.height ?? 0,
    transform: `translate(${rect?.x ?? 0}px, ${rect?.y ?? 0}px)`,
    opacity: rect ? 1 : 0,
    pointerEvents: 'none',
    transition: animate
      ? `transform ${duration}ms ${easing}, width ${duration}ms ${easing}, height ${duration}ms ${easing}, opacity 200ms var(--ease-out)`
      : 'none'
  }

  return { containerRef, rect, thumbStyle, measure }
}
