import { describe, expect, it } from 'vitest'
import { FLYER_BOX, HELI_CENTER, MIN_GUTTER, flightPose, laneWidth, sceneOffset, type Metrics } from './flight'

function metrics(vw: number, vh: number, gutter: number): Metrics {
  return { vw, vh, gutter, art: { left: vw / 2, top: 360, k: 1.3 }, span: 640 }
}

describe('flightPose', () => {
  it('starts exactly on the helicopter in the bedroom scene', () => {
    const m = metrics(1440, 900, 150)
    const { pose, caption } = flightPose(0, m)
    expect(pose).toEqual({ cx: m.art.left + HELI_CENTER.x * m.art.k, cy: m.art.top + HELI_CENTER.y * m.art.k, k: m.art.k, r: 0 })
    expect(caption).toEqual({ x: 200, y: 118, size: 12, chip: 0 })
  })

  it('retraces the same pose when scrolling back', () => {
    const m = metrics(1440, 900, 150)
    const there = flightPose(1234, m)
    flightPose(4000, m)
    expect(flightPose(1234, m)).toEqual(there)
  })

  it('keeps the helicopter and its caption inside the gutter and viewport once clear of the scene', () => {
    for (const [vw, vh] of [[1440, 900], [1920, 1080], [2560, 1440], [1366, 600]]) {
      for (const gutter of [MIN_GUTTER, 150, 320]) {
        const m = metrics(vw, vh, gutter)
        for (let y = m.span; y < 20000; y += 37) {
          const { pose, caption } = flightPose(y, m)
          // Rotation slack: a 7 degree bank moves the far corners by at most ~15 units.
          const slack = 15 * pose.k
          const heliLeft = pose.cx - 90 * pose.k - slack
          const heliRight = pose.cx + 112 * pose.k + slack
          const captionHalf = (caption.size * 8.6 * pose.k) / 2
          const captionCx = pose.cx + (caption.x - HELI_CENTER.x) * pose.k
          const captionBottom = pose.cy + (caption.y - HELI_CENTER.y + caption.size * 0.4) * pose.k
          expect(Math.min(heliLeft, captionCx - captionHalf)).toBeGreaterThanOrEqual(vw - gutter)
          expect(Math.max(heliRight, captionCx + captionHalf)).toBeLessThanOrEqual(vw)
          expect(pose.cy - 46 * pose.k - slack).toBeGreaterThanOrEqual(0)
          expect(captionBottom + slack).toBeLessThanOrEqual(vh)
          expect(caption.size * pose.k).toBeGreaterThanOrEqual(10)
        }
      }
    }
  })

  it('fits the flyer within the lane width', () => {
    expect(laneWidth(MIN_GUTTER)).toBeGreaterThan(0)
    expect(laneWidth(1000)).toBeLessThanOrEqual(FLYER_BOX.w)
  })
})

describe('sceneOffset', () => {
  it('rests at home at the top of the page', () => {
    expect(sceneOffset(0, 0)).toEqual({ dx: 0, dy: 0, r: 0 })
  })

  it('keeps the helicopter and caption inside the 400x320 scene', () => {
    for (let u = 0; u <= 1; u += 0.01) {
      for (const y of [0, 70, 140, 211]) {
        const { dx, dy } = sceneOffset(u, y)
        expect(30 + dx).toBeGreaterThanOrEqual(0)
        expect(254 + dx).toBeLessThanOrEqual(400) // caption's right edge
        expect(24 + dy).toBeGreaterThanOrEqual(0)
      }
    }
  })
})
