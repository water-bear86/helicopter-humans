// Scroll guides the route; elapsed active time adds an independent idle patrol.
// Coordinates named "units" are the hero SVG's 400x320 viewBox.
export const HELI_CENTER = { x: 120, y: 70 }
export const FLYER_BOX = { x: 0, y: 0, w: 264, h: 136 }
// Bounds include the larger chopper, rotor words, hover and a ten-degree bank.
export const FLYER_EXTENT = { left: 134, right: 158, up: 96, down: 90 }
const EDGE = 8
const MAX_FLYER_PX = 240
export const MIN_GUTTER = 136

export interface Pose {
  cx: number
  cy: number
  /** Px per SVG unit. */
  k: number
  /** Bank, degrees. */
  r: number
}

export interface Metrics {
  vw: number
  vh: number
  gutter: number
  art: { left: number; top: number; k: number }
  span: number
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const smoothstep = (t: number) => t * t * (3 - 2 * t)

/** A looping patrol above the bedroom door, also used on narrow screens. */
export function sceneOffset(u: number, scrollY: number, seconds = 0) {
  const t = clamp(u, 0, 1)
  return {
    dx: 64 * Math.sin(Math.PI * t) + 34 * (1 - Math.cos(seconds * 0.7)),
    dy: 5 * (1 - Math.cos(seconds * 1.4)) + 3 * Math.sin(seconds * 0.7) - 3 * Math.sin(2 * Math.PI * t) + Math.sin(scrollY / 45),
    r: 6 * Math.sin(seconds * 0.7) + 2 * Math.sin(2 * Math.PI * t),
  }
}

export function laneWidth(gutter: number) {
  return clamp(gutter - 2 * EDGE, 0, MAX_FLYER_PX)
}

/** A wide vertical patrol, banking as it changes direction. */
export function lanePose(scrollY: number, m: Metrics, seconds = 0): Pose {
  const k = laneWidth(m.gutter) / (FLYER_EXTENT.left + FLYER_EXTENT.right)
  const left = m.vw - m.gutter + EDGE + FLYER_EXTENT.left * k
  const right = m.vw - EDGE - FLYER_EXTENT.right * k
  const phase = scrollY / 320 + seconds * 0.7
  const top = EDGE + FLYER_EXTENT.up * k
  const bottom = m.vh - EDGE - FLYER_EXTENT.down * k
  return {
    cx: lerp(left, right, (Math.sin(phase) + 1) / 2),
    cy: clamp(m.vh * (0.5 + 0.28 * Math.sin(scrollY / 610 + seconds * 0.45)), top, bottom),
    k,
    r: 10 * Math.sin(phase),
  }
}

/** Leave the bedroom early enough to keep the whole flight clear of page content. */
export function flightPose(scrollY: number, m: Metrics, seconds = 0): Pose {
  const b = smoothstep(clamp(scrollY / m.span, 0, 1))
  const bx = smoothstep(clamp(scrollY / (m.span * 0.6), 0, 1))
  const drift = sceneOffset(0, 0, seconds)
  const home: Pose = {
    cx: m.art.left + (HELI_CENTER.x + drift.dx) * m.art.k,
    cy: m.art.top - scrollY + (HELI_CENTER.y + drift.dy) * m.art.k,
    k: m.art.k,
    r: drift.r,
  }
  const lane = lanePose(scrollY, m, seconds)
  const swoop = Math.sin(Math.PI * b)
  return {
    cx: lerp(home.cx, lane.cx, bx),
    cy: lerp(home.cy, lane.cy, b) - 40 * swoop,
    k: lerp(home.k, lane.k, bx),
    r: lerp(home.r, lane.r, b) + 8 * swoop,
  }
}
