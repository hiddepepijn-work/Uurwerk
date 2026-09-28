/**
 * One-shot motion from script, for what a CSS class cannot do on its own: a block settling
 * after a drag, sparks flying off a checkbox, a card sliding out while its successor slides
 * in. Everything that can be a class or a transition stays one (styles/globals.css).
 *
 * The Web Animations API is not covered by the global reduced-motion rule, so `play` checks
 * it itself and does nothing when motion is reduced — the element simply is in its end state.
 */

export type EasingName = '--spring-soft' | '--spring-bouncy' | '--ease-out'

const EASE_OUT = 'cubic-bezier(0.2, 0.8, 0.2, 1)'

export const prefersReducedMotion = (): boolean =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true

/** A timing function from tokens.css, resolved to its value (the API cannot read `var()`). */
export function easing(name: EasingName): string {
  if (typeof document === 'undefined') return EASE_OUT
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || EASE_OUT
}

/**
 * Runs `keyframes` on `element` once. Null when there is nothing to run it on, motion is
 * reduced, or the platform has no animation API (tests). A `linear()` spring the engine
 * does not know falls back to a plain ease-out rather than to nothing.
 */
export function play(
  element: Element | null | undefined,
  keyframes: Keyframe[],
  options: Omit<KeyframeAnimationOptions, 'easing'> & { easing?: EasingName | string }
): Animation | null {
  if (!element || prefersReducedMotion() || typeof element.animate !== 'function') return null
  const timing = options.easing?.startsWith('--') ? easing(options.easing as EasingName) : (options.easing ?? EASE_OUT)
  try {
    return element.animate(keyframes, { ...options, easing: timing })
  } catch {
    try {
      return element.animate(keyframes, { ...options, easing: EASE_OUT })
    } catch {
      return null
    }
  }
}
