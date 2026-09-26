import { useEffect, useRef, type MutableRefObject } from 'react'

/**
 * Jarvis's orb: three translucent layers in the app's green and teal, their edges moving on
 * slow sine waves so the shape is alive without ever jumping.
 *
 *   idle       breathes slowly
 *   listening  swells with Hidde's voice; loud moments send a ring outward
 *   thinking   the layers turn around each other and a violet sheen passes through
 *   speaking   the edge dances on the loudness of Jarvis's own voice
 *
 * The loudness comes in through `level` (0…1), a ref the caller writes every frame or so —
 * a ref, not a prop, so the orb never re-renders React to move. Everything eases: the state
 * changes the targets, the drawing follows at its own pace.
 */

export type OrbState = 'idle' | 'listening' | 'thinking' | 'speaking'

interface Tuning {
  /** How much the edge moves on its own. */
  wobble: number
  /** How much loudness grows the orb. */
  gain: number
  /** Turning speed of the layers. */
  spin: number
  /** Violet mixed in. */
  violet: number
}

const TUNING: Record<OrbState, Tuning> = {
  idle: { wobble: 0.025, gain: 0.0, spin: 0.12, violet: 0 },
  listening: { wobble: 0.04, gain: 0.22, spin: 0.25, violet: 0 },
  thinking: { wobble: 0.05, gain: 0.0, spin: 1.1, violet: 1 },
  speaking: { wobble: 0.06, gain: 0.3, spin: 0.45, violet: 0.25 }
}

const LAYERS = [
  { color: [62, 207, 115], alpha: 0.55, phase: 0, scale: 1 },
  { color: [95, 208, 197], alpha: 0.45, phase: 2.1, scale: 0.9 },
  { color: [155, 140, 255], alpha: 0.0, phase: 4.2, scale: 0.8 }
] as const

const lerp = (from: number, to: number, amount: number): number => from + (to - from) * amount

export function JarvisOrb({
  state,
  level,
  size = 260
}: {
  state: OrbState
  level: MutableRefObject<number>
  size?: number
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const target = useRef<Tuning>(TUNING[state])

  useEffect(() => {
    target.current = TUNING[state]
  }, [state])

  useEffect(() => {
    const element = canvas.current
    const context = element?.getContext('2d')
    if (!element || !context) return

    const ratio = Math.min(window.devicePixelRatio || 1, 3)
    element.width = size * ratio
    element.height = size * ratio
    context.scale(ratio, ratio)

    const current: Tuning = { ...target.current }
    let smoothLevel = 0
    let angle = 0
    let frame = 0
    const rings: Array<{ radius: number; alpha: number }> = []
    let lastRing = 0
    const start = performance.now()

    const draw = (now: number): void => {
      const t = (now - start) / 1000
      const goal = target.current
      current.wobble = lerp(current.wobble, goal.wobble, 0.05)
      current.gain = lerp(current.gain, goal.gain, 0.08)
      current.spin = lerp(current.spin, goal.spin, 0.04)
      current.violet = lerp(current.violet, goal.violet, 0.04)
      // Fast up, slow down: speech reads as punchy, silence as calm.
      const raw = Math.max(0, Math.min(1, level.current))
      smoothLevel = lerp(smoothLevel, raw, raw > smoothLevel ? 0.35 : 0.08)
      angle += current.spin * 0.016

      const center = size / 2
      const breathe = 1 + Math.sin(t * 1.4) * 0.02
      const base = size * 0.3 * breathe * (1 + current.gain * smoothLevel)

      context.clearRect(0, 0, size, size)

      // Rings outward on loud moments while listening.
      if (goal.gain > 0 && goal.violet === 0 && smoothLevel > 0.55 && t - lastRing > 0.35) {
        rings.push({ radius: base, alpha: 0.35 })
        lastRing = t
      }
      for (const ring of rings) {
        ring.radius += 1.6
        ring.alpha *= 0.955
        context.beginPath()
        context.arc(center, center, ring.radius, 0, Math.PI * 2)
        context.strokeStyle = `rgba(62, 207, 115, ${ring.alpha})`
        context.lineWidth = 2
        context.stroke()
      }
      while (rings.length > 0 && rings[0]!.alpha < 0.02) rings.shift()

      // Soft glow behind everything.
      // Round, and never past the canvas edge: a clipped gradient shows as a faint square.
      const glowRadius = Math.min(base * 1.9, center)
      const glow = context.createRadialGradient(center, center, base * 0.2, center, center, glowRadius)
      glow.addColorStop(0, `rgba(62, 207, 115, ${0.18 + smoothLevel * 0.2})`)
      glow.addColorStop(1, 'rgba(62, 207, 115, 0)')
      context.fillStyle = glow
      context.beginPath()
      context.arc(center, center, glowRadius, 0, Math.PI * 2)
      context.fill()

      context.globalCompositeOperation = 'lighter'
      for (const [index, layer] of LAYERS.entries()) {
        const alpha = index === 2 ? 0.5 * current.violet : layer.alpha
        if (alpha < 0.01) continue
        const radius = base * layer.scale
        const turn = angle * (index % 2 === 0 ? 1 : -1.3) + layer.phase
        const wobble = current.wobble + smoothLevel * current.gain * 0.35

        context.beginPath()
        const points = 96
        for (let step = 0; step <= points; step++) {
          const theta = (step / points) * Math.PI * 2
          const edge =
            1 +
            wobble *
              (Math.sin(theta * 3 + turn + t * 1.3) * 0.6 +
                Math.sin(theta * 5 - turn * 1.7 + t * 0.9) * 0.3 +
                Math.sin(theta * 2 + t * 2.1 + layer.phase) * 0.4)
          const x = center + Math.cos(theta) * radius * edge
          const y = center + Math.sin(theta) * radius * edge
          if (step === 0) context.moveTo(x, y)
          else context.lineTo(x, y)
        }
        context.closePath()

        const [r, g, b] = layer.color
        const offset = radius * 0.35
        const fill = context.createRadialGradient(
          center + Math.cos(turn) * offset,
          center + Math.sin(turn) * offset,
          radius * 0.1,
          center,
          center,
          radius * 1.15
        )
        fill.addColorStop(0, `rgba(${Math.min(255, r + 90)}, ${Math.min(255, g + 40)}, ${Math.min(255, b + 60)}, ${alpha})`)
        fill.addColorStop(0.6, `rgba(${r}, ${g}, ${b}, ${alpha * 0.75})`)
        fill.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`)
        context.fillStyle = fill
        context.fill()
      }
      context.globalCompositeOperation = 'source-over'

      // A small bright core, the part that reads as "alive" at a glance.
      const core = context.createRadialGradient(center, center, 0, center, center, base * 0.55)
      core.addColorStop(0, `rgba(235, 255, 244, ${0.35 + smoothLevel * 0.3})`)
      core.addColorStop(1, 'rgba(235, 255, 244, 0)')
      context.fillStyle = core
      context.beginPath()
      context.arc(center, center, base * 0.55, 0, Math.PI * 2)
      context.fill()

      frame = requestAnimationFrame(draw)
    }

    frame = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(frame)
  }, [size, level])

  return <canvas ref={canvas} aria-hidden="true" style={{ width: size, height: size }} />
}
