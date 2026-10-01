/** A decorative flyer that collides with real page rectangles. No DOM or timers. */
export interface Rect { left: number; right: number; top: number; bottom: number }
export interface FlyerState { x: number; y: number; vx: number; vy: number; bumps: number; hit?: number }
export interface FlightWorld { width: number; height: number; rx: number; ry: number; obstacles: Rect[] }

export function overlaps(x: number, y: number, r: Rect, rx: number, ry: number) {
  return x + rx > r.left && x - rx < r.right && y + ry > r.top && y - ry < r.bottom
}

/** Find an open horizontal passage, so the helicopter can escape a side margin. */
export function crossingHeight(w: FlightWorld, y: number) {
  const lo = w.ry + 8, hi = w.height - w.ry - 8
  const spans = w.obstacles.map(r => ({ top: Math.max(lo, r.top - w.ry - 3), bottom: Math.min(hi, r.bottom + w.ry + 3) })).filter(r => r.bottom > r.top).sort((a, b) => a.top - b.top)
  const candidates: number[] = []
  let edge = lo
  for (const r of spans) {
    if (r.top > edge + 4) candidates.push(Math.max(edge + 2, Math.min(r.top - 2, y)))
    edge = Math.max(edge, r.bottom)
  }
  if (hi > edge + 4) candidates.push(Math.max(edge + 2, Math.min(hi - 2, y)))
  candidates.sort((a, b) => Math.abs(a - y) - Math.abs(b - y))
  return candidates[0] ?? null
}

/** Resolve scroll/resize overlap by finding the closest free point beside an obstacle. */
export function freePosition(x: number, y: number, w: FlightWorld) {
  const minX = w.rx + 8, maxX = w.width - w.rx - 8
  const minY = w.ry + 8, maxY = w.height - w.ry - 8
  const clampX = (v: number) => Math.max(minX, Math.min(maxX, v))
  const clampY = (v: number) => Math.max(minY, Math.min(maxY, v))
  const candidates = [{ x: clampX(x), y: clampY(y) }]
  const xs = [minX, maxX], ys = [minY, maxY]
  for (const r of w.obstacles) {
    xs.push(clampX(r.left - w.rx - 1), clampX(r.right + w.rx + 1))
    ys.push(clampY(r.top - w.ry - 1), clampY(r.bottom + w.ry + 1))
  }
  for (const cx of xs) for (const cy of ys) candidates.push({ x: cx, y: cy })
  const clear = candidates.filter(p => !w.obstacles.some(r => overlaps(p.x, p.y, r, w.rx, w.ry)))
  clear.sort((a, b) => Math.hypot(a.x - x, a.y - y) - Math.hypot(b.x - x, b.y - y))
  return clear[0] ?? null
}

/** Short substeps prevent a fast flyer from tunnelling through a thin window border. */
export function advanceFlyer(state: FlyerState, dt: number, w: FlightWorld): FlyerState | null {
  const s = { ...state }
  s.hit = undefined
  if (w.width < 2 * w.rx + 16 || w.height < 2 * w.ry + 16) return null
  if (w.obstacles.some(r => overlaps(s.x, s.y, r, w.rx, w.ry)) || s.x < w.rx + 8 || s.x > w.width - w.rx - 8 || s.y < w.ry + 8 || s.y > w.height - w.ry - 8) {
    const p = freePosition(s.x, s.y, w)
    if (!p) return null
    s.x = p.x; s.y = p.y
  }
  const steps = Math.max(1, Math.ceil(Math.min(dt, 0.064) / 0.008))
  const step = Math.min(dt, 0.064) / steps
  for (let i = 0; i < steps; i++) {
    const x = s.x + s.vx * step
    const hitX = w.obstacles.findIndex(r => overlaps(x, s.y, r, w.rx, w.ry))
    if (x < w.rx + 8 || x > w.width - w.rx - 8 || hitX >= 0) {
      s.vx = -s.vx
      s.bumps++
      if (hitX >= 0) s.hit = hitX
    } else s.x = x
    const y = s.y + s.vy * step
    const hitY = w.obstacles.findIndex(r => overlaps(s.x, y, r, w.rx, w.ry))
    if (y < w.ry + 8 || y > w.height - w.ry - 8 || hitY >= 0) {
      s.vy = -s.vy
      s.bumps++
      if (hitY >= 0) s.hit = hitY
    } else s.y = y
  }
  return s
}
