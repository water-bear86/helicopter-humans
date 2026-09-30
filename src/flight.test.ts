import { describe, expect, it } from 'vitest'
import { advanceFlyer, crossingHeight, freePosition, overlaps, type FlightWorld, type FlyerState } from './roam'
import { storyFrame } from './story'

const world: FlightWorld = { width: 1440, height: 900, rx: 80, ry: 48, obstacles: [] }
const initial: FlyerState = { x: 1300, y: 110, vx: -180, vy: 65, bumps: 0 }

describe('free flight', () => {
  it('crosses both sides of the screen and reverses facing at its edges', () => {
    let s = initial
    let left = s.x, right = s.x
    const directions = new Set()
    for (let i=0; i<1800; i++) {
      s = advanceFlyer(s, 1/60, world)!
      directions.add(Math.sign(s.vx))
      left = Math.min(left, s.x); right = Math.max(right, s.x)
      expect(s.x - world.rx).toBeGreaterThanOrEqual(8)
      expect(s.x + world.rx).toBeLessThanOrEqual(world.width - 8)
      expect(s.y - world.ry).toBeGreaterThanOrEqual(8)
      expect(s.y + world.ry).toBeLessThanOrEqual(world.height - 8)
    }
    expect(right-left).toBeGreaterThan(1200)
    expect(directions.size).toBe(2)
  })

  it('bops a window border without entering the window, even at high speed', () => {
    const w = { ...world, obstacles: [{ left: 400, right: 1100, top: 200, bottom: 700 }] }
    let s = { ...initial, x: 1230, y: 400, vx: -700, vy: 0 }
    for(let i=0; i<120; i++) {
      s = advanceFlyer(s, .064, w)!
      expect(overlaps(s.x, s.y, w.obstacles[0], w.rx, w.ry)).toBe(false)
    }
    expect(s.bumps).toBeGreaterThan(0)
  })

  it('does not tunnel through a thin border', () => {
    const w = { ...world, obstacles: [{ left: 710, right: 714, top: 0, bottom: 900 }] }
    let s = { ...initial, x: 500, y: 400, vx: 1200, vy: 0 }
    for(let i=0; i<60; i++) {
      s = advanceFlyer(s, .04, w)!
      expect(s.x + w.rx).toBeLessThanOrEqual(710)
    }
    expect(s.bumps).toBeGreaterThan(0)
  })

  it('relocates safely if scrolling moves a window over the flyer', () => {
    const w = { ...world, obstacles: [{ left: 100, right: 1340, top: 150, bottom: 750 }] }
    const next = advanceFlyer({ ...initial, x: 500, y: 400 }, 0, w)!
    expect(next).not.toBeNull()
    expect(overlaps(next.x, next.y, w.obstacles[0], w.rx, w.ry)).toBe(false)
  })

  it('hides gracefully when a crowded phone viewport offers no safe space', () => {
    const w = { width: 390, height: 844, rx: 56, ry: 35, obstacles: [{ left: 16, right: 374, top: 0, bottom: 844 }] }
    expect(freePosition(300, 200, w)).toBeNull()
    expect(advanceFlyer(initial, .04, w)).toBeNull()
  })

  it('finds a clear crossing above a window and refuses a passage through it', () => {
    const w = { ...world, obstacles: [{ left: 100, right: 1300, top: 250, bottom: 900 }] }
    const y = crossingHeight(w, 400)!
    expect(y + w.ry).toBeLessThan(250)
    expect(crossingHeight({ ...w, obstacles: [{ left: 100, right: 1300, top: 0, bottom: 900 }] }, 400)).toBeNull()
  })

  it('can recover into a newly available gap after scroll or resize', () => {
    const w = { width: 390, height: 844, rx: 56, ry: 35, obstacles: [{ left: 16, right: 374, top: 170, bottom: 844 }] }
    const next = advanceFlyer(initial, 0, w)!
    expect(next.y + w.ry).toBeLessThanOrEqual(170)
  })
})

describe('scroll story', () => {
  it('moves from spying through printing and software launch to a closed curtain and release', () => {
    expect([0, .3, .55, .8, 1].map(p => storyFrame(p).stage)).toEqual(['spying','printing','launching','protected','released'])
    expect(storyFrame(.3).curtain).toBe(0)
    expect(storyFrame(.8).curtain).toBe(1)
    expect(storyFrame(1).retreat).toBeCloseTo(1)
  })
  it('can rewind with scrolling and clamps deep links outside the story', () => {
    expect(storyFrame(-4)).toEqual(storyFrame(0))
    expect(storyFrame(2)).toEqual(storyFrame(1))
    const before = storyFrame(.3)
    storyFrame(.9)
    expect(storyFrame(.3)).toEqual(before)
  })
})
