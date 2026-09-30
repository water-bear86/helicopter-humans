// Pure flight maths for the scroll-linked helicopter. Every pose is a function
// of scroll position alone, so scrolling back retraces the exact same path.
// Coordinates named "units" are the hero SVG's 400x320 viewBox.

export const HELI_CENTER = { x: 120, y: 70 }
// Flyer SVG viewBox: the helicopter's box inside the hero scene.
export const FLYER_BOX = { x: 24, y: 14, w: 216, h: 112 }
// Helicopter extents around HELI_CENTER, in units (rotor tip to tail, rotor to skid).
const HELI_EXTENT = { left: 90, right: 112, up: 46, down: 40 }
const SCENE_CAPTION = { x: 200, y: 118, size: 12 }
const LANE_CAPTION_X = FLYER_BOX.x + FLYER_BOX.w / 2
const CAPTION_EM_WIDTH = 8.6 // "WHUP WHUP WHUP" in a monospace face, plus chip padding
const EDGE = 8 // px kept clear of the content column and the viewport edge
const MAX_FLYER_PX = 132
const MIN_FLYER_PX = 92
const MAX_BANK = 7 // degrees
const CAPTION_GAP = 8 // units between the skid and the caption chip
const BANK_SLACK = 15 // units the far corners can swing at full bank

/** Narrowest gutter (px) that fits a legible helicopter and caption. */
export const MIN_GUTTER = MIN_FLYER_PX + 2 * EDGE

export interface Pose {
  /** Viewport px of the helicopter's centre. */
  cx: number
  cy: number
  /** Px per unit. */
  k: number
  /** Bank, degrees. */
  r: number
}

export interface CaptionPose {
  x: number
  y: number
  size: number
  /** Opacity of the dark chip that keeps the caption legible off the night sky. */
  chip: number
}

export interface Metrics {
  vw: number
  vh: number
  /** Free px between the content column's right edge and the viewport's right edge. */
  gutter: number
  /** Hero SVG position on the page (document px) and its px per unit. */
  art: { left: number; top: number; k: number }
  /** Scroll distance over which the helicopter leaves the scene for the gutter. */
  span: number
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const smoothstep = (t: number) => t * t * (3 - 2 * t)

/** Small vertical bob tied to scroll position, in the unit it is scaled by. */
const bob = (scrollY: number) => Math.sin(scrollY / 45)

/**
 * In-scene drift used where there is no gutter to fly in (phones, laptops):
 * the helicopter wanders right and back across the bedroom window while the
 * scene is on screen. `u` is 0 at the top of the page, 1 as the scene leaves.
 */
export function sceneOffset(u: number, scrollY: number) {
  const t = clamp(u, 0, 1)
  return {
    dx: 120 * Math.sin(Math.PI * t),
    dy: -12 * Math.sin(2 * Math.PI * t) + 6 * bob(scrollY),
    r: MAX_BANK * Math.sin(2 * Math.PI * t),
  }
}

export function laneWidth(gutter: number) {
  return clamp(gutter - 2 * EDGE, 0, MAX_FLYER_PX)
}

function captionPx(width: number) {
  return Math.min(11, (width - 4) / CAPTION_EM_WIDTH)
}

/** The weaving pose in the right-hand gutter, once clear of the scene. */
export function lanePose(scrollY: number, m: Metrics): Pose {
  const width = laneWidth(m.gutter)
  const k = width / FLYER_BOX.w
  const left = m.vw - m.gutter + EDGE + (HELI_EXTENT.left + BANK_SLACK) * k
  const right = m.vw - EDGE - (HELI_EXTENT.right + BANK_SLACK) * k
  const phase = Math.sin(scrollY / 320)
  const cx = lerp(left, right, (phase + 1) / 2)
  const top = EDGE + (HELI_EXTENT.up + BANK_SLACK) * k
  const bottom = m.vh - EDGE - ((HELI_EXTENT.down + CAPTION_GAP + BANK_SLACK) * k + captionPx(width) * 1.6)
  const cy = clamp(m.vh * (0.42 + 0.12 * Math.sin(scrollY / 610 + 1)) + 4 * bob(scrollY), top, bottom)
  return { cx, cy, k, r: MAX_BANK * Math.cos(scrollY / 320) }
}

/** Gutter mode: fly from the in-scene spot out to the gutter lane as the hero scrolls away. */
export function flightPose(scrollY: number, m: Metrics): { pose: Pose; caption: CaptionPose } {
  const b = smoothstep(clamp(scrollY / m.span, 0, 1))
  // Reach the gutter (position and size) early so the rest of the descent stays clear of the content.
  const bx = smoothstep(clamp(scrollY / (m.span * 0.6), 0, 1))
  const home: Pose = {
    cx: m.art.left + HELI_CENTER.x * m.art.k,
    cy: m.art.top - scrollY + HELI_CENTER.y * m.art.k,
    k: m.art.k,
    r: 0,
  }
  const lane = lanePose(scrollY, m)
  const swoop = Math.sin(Math.PI * b)
  const pose: Pose = {
    cx: lerp(home.cx, lane.cx, bx),
    cy: lerp(home.cy, lane.cy, b) - 40 * swoop,
    k: lerp(home.k, lane.k, bx),
    r: lerp(home.r, lane.r, b) + 10 * swoop,
  }
  const laneSize = captionPx(laneWidth(m.gutter)) / pose.k
  const size = lerp(SCENE_CAPTION.size, laneSize, b)
  const caption: CaptionPose = {
    x: lerp(SCENE_CAPTION.x, LANE_CAPTION_X, b),
    y: lerp(SCENE_CAPTION.y, HELI_CENTER.y + HELI_EXTENT.down + CAPTION_GAP + size * 1.1, b),
    size,
    chip: b,
  }
  return { pose, caption }
}
