import { describe, expect, it } from 'vitest'
import { FLYER_EXTENT, HELI_CENTER, MIN_GUTTER, flightPose, sceneOffset, type Metrics } from './flight'

function metrics(vw: number, vh: number, gutter: number): Metrics {
  return { vw, vh, gutter, art: { left: vw / 2, top: 360, k: 1.3 }, span: 640 }
}

describe('flightPose', () => {
  it('starts on the helicopter in the bedroom scene', () => {
    const m = metrics(1440, 900, 210)
    expect(flightPose(0, m)).toEqual({ cx: m.art.left + HELI_CENTER.x * m.art.k, cy: m.art.top + HELI_CENTER.y * m.art.k, k: m.art.k, r: 0 })
  })

  it('patrols without scrolling while keeping the scroll route deterministic at a given time', () => {
    const m = metrics(1440, 900, 210)
    const there = flightPose(1234, m, 4)
    expect(flightPose(1234, m, 8)).not.toEqual(there)
    flightPose(4000, m, 4)
    expect(flightPose(1234, m, 4)).toEqual(there)
    expect(flightPose(0, m, 4)).not.toEqual(flightPose(0, m, 0))
  })

  it('keeps the complete banked flyer inside the gutter and viewport throughout its patrol', () => {
    for (const [vw, vh] of [[1440, 900], [1920, 1080], [2560, 1440], [1366, 600]]) {
      for (const gutter of [MIN_GUTTER, 210, 450]) {
        const m = metrics(vw, vh, gutter)
        for (let y = m.span; y < 20000; y += 137) {
          for (const seconds of [0, 4, 8, 12, 18]) {
            const pose = flightPose(y, m, seconds)
            expect(pose.cx - FLYER_EXTENT.left * pose.k).toBeGreaterThanOrEqual(vw - gutter)
            expect(pose.cx + FLYER_EXTENT.right * pose.k).toBeLessThanOrEqual(vw)
            expect(pose.cy - FLYER_EXTENT.up * pose.k).toBeGreaterThanOrEqual(0)
            expect(pose.cy + FLYER_EXTENT.down * pose.k).toBeLessThanOrEqual(vh)
          }
        }
      }
    }
  })
})

describe('sceneOffset', () => {
  it('begins at home and explores the scene without scrolling', () => {
    expect(sceneOffset(0, 0)).toEqual({ dx: 0, dy: 0, r: 0 })
    expect(sceneOffset(0, 0, 4).dx).toBeGreaterThan(50)
    expect(sceneOffset(0, 0, 4).r).not.toBe(0)
  })

  it('keeps the enlarged chopper inside the scene and above the door sign', () => {
    for (let u = 0; u <= 1; u += 0.02) {
      for (let seconds = 0; seconds < 24; seconds += 0.4) {
        const { dx, dy, r } = sceneOffset(u, u * 1000, seconds)
        // Conservative rotated extents around the centre, including the enlarged art.
        const angle = Math.abs(r) * Math.PI / 180
        const left = 101 * Math.cos(angle) + 60 * Math.sin(angle)
        const right = 126 * Math.cos(angle) + 60 * Math.sin(angle)
        const up = 53 * Math.cos(angle) + 126 * Math.sin(angle)
        const down = 49 * Math.cos(angle) + 126 * Math.sin(angle)
        expect(HELI_CENTER.x + dx - left).toBeGreaterThanOrEqual(0)
        expect(HELI_CENTER.x + dx + right).toBeLessThanOrEqual(400)
        expect(HELI_CENTER.y + dy - up).toBeGreaterThanOrEqual(0)
        expect(HELI_CENTER.y + dy + down).toBeLessThan(150)
      }
    }
  })
})
