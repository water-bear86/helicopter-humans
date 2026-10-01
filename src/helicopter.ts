import { FLYER_BOX, HELI_CENTER } from './flight'
import { advanceFlyer, crossingHeight, type FlyerState, type Rect } from './roam'
import { createStory } from './story'

const SVG_NS = 'http://www.w3.org/2000/svg'
const ORIGIN = { x: HELI_CENTER.x - FLYER_BOX.x, y: HELI_CENTER.y - FLYER_BOX.y }
const round = (n: number) => Math.round(n * 100) / 100

function buildFlyer(heli: SVGGElement) {
  const root = document.createElement('div')
  root.className = 'flyer'
  root.hidden = true
  root.setAttribute('aria-hidden', 'true')
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', `${FLYER_BOX.x} ${FLYER_BOX.y} ${FLYER_BOX.w} ${FLYER_BOX.h}`)
  svg.setAttribute('focusable', 'false')
  const clone = heli.cloneNode(true) as SVGGElement
  clone.removeAttribute('id')
  svg.append(clone)
  root.append(svg)
  document.body.append(root)
  return { root, direction: clone.querySelector<SVGGElement>('.airframe')! }
}

export function initHelicopter() {
  const story = document.querySelector<HTMLElement>('.privacy-story')
  const art = document.querySelector<HTMLElement>('.hero-art')
  const heli = art?.querySelector<SVGGElement>('.heli')
  if (!story || !art || !heli || !('IntersectionObserver' in window) || !('ResizeObserver' in window)) return
  const updateStory = createStory(story, heli)
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)')
  let stop: (() => void) | undefined
  let paused = false
  const toggle = document.querySelector<HTMLButtonElement>('.motion-toggle')!

  function animate() {
    const flyer = buildFlyer(heli!)
    let frame = 0, previous = 0, seconds = 0
    let vw = 0, vh = 0, k = 1, storyTop = 0, storyHeight = 0, pinHeight = 0
    let rectangles: Array<Rect & { el?: HTMLElement }> = []
    let state: FlyerState = { x: 0, y: 0, vx: -170, vy: 65, bumps: 0 }
    let started = false
    let blocked = false
    let onStage = true
    let lastProgress = -1
    let bumpUntil = 0

    const measure = () => {
      vw = document.documentElement.clientWidth
      vh = window.innerHeight
      k = Math.min(180, Math.max(96, vw * 0.115)) / FLYER_BOX.w
      storyTop = story!.getBoundingClientRect().top + window.scrollY
      storyHeight = story!.offsetHeight
      pinHeight = story!.querySelector<HTMLElement>('.story-pin')!.offsetHeight
      rectangles = Array.from(document.querySelectorAll<HTMLElement>('.window, .card, .hero-copy, .section-head, .availability li, .faq, .footer p, .topbar, .section > .fineprint')).map(el => {
        const r = el.getBoundingClientRect()
        // Include the incumbent eight-pixel window shadows in the collision boundary.
        return { el, left: r.left - 2, right: r.right + 10, top: r.top + window.scrollY - 2, bottom: r.bottom + window.scrollY + 10 }
      })
      blocked = false
      schedule()
    }

    const render = (now: number) => {
      frame = 0
      if (document.hidden) { previous = 0; return }
      const dt = previous && !paused ? Math.min((now - previous) / 1000, 0.04) : 0
      previous = now
      seconds += dt
      const y = window.scrollY
      const p = Math.max(0, Math.min(1, (y - storyTop) / Math.max(1, storyHeight - pinHeight)))
      if (onStage || p !== lastProgress) updateStory(p, seconds)
      lastProgress = p
      const storyBottom = storyTop + storyHeight - y
      const released = p === 1 && storyBottom < vh * 0.65
      if (!released) {
        flyer.root.hidden = true
        art!.classList.remove('is-flown')
        started = false
      } else if (!blocked) {
        const obstacles = rectangles.filter(r => r.bottom > y && r.top < y + vh).map(r => ({ ...r, top: r.top - y, bottom: r.bottom - y }))
        if (storyBottom > 0) obstacles.push({ left: 0, right: vw, top: 0, bottom: storyBottom })
        const rx = 154 * k, ry = 94 * k
        if (!started) {
          state = { x: vw - rx - 12, y: vh * 0.2, vx: -Math.min(185, vw * 0.23), vy: 65, bumps: 0 }
          started = true
        }
        const world = { width: vw, height: vh, rx, ry, obstacles }
        const corridor = crossingHeight(world, state.y)
        if (!paused) {
          if (corridor !== null) state.vy = Math.abs(corridor - state.y) < 2 ? 0 : Math.sign(corridor - state.y) * Math.min(100, Math.max(35, Math.abs(corridor - state.y)))
          else if (state.vy === 0) state.vy = 65
          // Climb out of a narrow side gap before accelerating across the page.
          // This avoids rapid facing flips between a window and the viewport edge.
          const climbing = corridor !== null && Math.abs(corridor - state.y) > ry * 0.4
          const speed = Math.min(185, vw * 0.23) * (climbing ? 0.15 : corridor === null ? 0.3 : 1)
          state.vx = Math.sign(state.vx) * speed
        }
        const next = advanceFlyer(state, dt, world)
        if (next) {
          if (next.bumps > state.bumps) bumpUntil = now + 180
          const hit = next.hit === undefined ? undefined : obstacles[next.hit]?.el
          if (hit?.matches('.window') && !hit.classList.contains('is-knocked')) {
            hit.classList.add('is-knocked')
            hit.addEventListener('animationend', () => hit.classList.remove('is-knocked'), { once: true })
          }
          state = next
          flyer.root.hidden = false
          flyer.root.classList.toggle('is-bopping', now < bumpUntil)
          flyer.root.dataset.facing = state.vx < 0 ? 'left' : 'right'
          flyer.root.dataset.bumps = `${state.bumps}`
          flyer.direction.setAttribute('transform', state.vx < 0 ? '' : 'translate(240 0) scale(-1 1)')
          const bank = Math.max(-8, Math.min(8, state.vy / 12)) * (state.vx < 0 ? 1 : -1)
          flyer.root.style.transform = `translate(${round(state.x - ORIGIN.x)}px, ${round(state.y - ORIGIN.y)}px) scale(${k}) rotate(${round(bank)}deg)`
          art!.classList.add('is-flown')
        } else {
          flyer.root.hidden = true
          art!.classList.remove('is-flown')
          blocked = true
        }
      }
      if (!paused && (onStage || (released && !blocked))) schedule()
    }

    function schedule() {
      if (!frame && !document.hidden) frame = requestAnimationFrame(render)
    }
    const scroll = () => { blocked = false; schedule() }
    const visibility = () => { cancelAnimationFrame(frame); frame = 0; previous = 0; schedule() }
    const stage = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const target = entry.target as HTMLElement
        target.classList.toggle('is-offstage', !entry.isIntersecting)
        if (target === story) onStage = entry.isIntersecting
      }
      schedule()
    })
    const layout = new ResizeObserver(measure)
    document.documentElement.classList.add('motion-ready')
    measure()
    stage.observe(story!)
    stage.observe(art!)
    layout.observe(document.body)
    // Expanding FAQ details changes obstacle geometry even without a body resize.
    document.addEventListener('toggle', measure, true)
    window.addEventListener('scroll', scroll, { passive: true })
    window.addEventListener('resize', measure)
    document.addEventListener('visibilitychange', visibility)
    toggle.addEventListener('click', visibility)
    return () => {
      window.removeEventListener('scroll', scroll)
      window.removeEventListener('resize', measure)
      document.removeEventListener('toggle', measure, true)
      document.removeEventListener('visibilitychange', visibility)
      toggle.removeEventListener('click', visibility)
      stage.disconnect(); layout.disconnect()
      cancelAnimationFrame(frame)
      flyer.root.remove()
      art!.classList.remove('is-flown', 'is-offstage')
      document.querySelectorAll('.is-knocked').forEach(el => el.classList.remove('is-knocked'))
      story!.classList.remove('is-offstage')
      document.documentElement.classList.remove('motion-ready')
    }
  }

  const visibility = () => document.documentElement.classList.toggle('is-page-hidden', document.hidden)
  const apply = () => {
    stop?.()
    if (reduce.matches) updateStory(0.8, 0, true)
    else stop = animate()
    toggle.hidden = reduce.matches
  }
  toggle.addEventListener('click', () => {
    paused = !paused
    toggle.setAttribute('aria-pressed', `${paused}`)
    toggle.textContent = paused ? 'Resume motion' : 'Pause motion'
    document.documentElement.classList.toggle('is-motion-paused', paused)
  })
  document.addEventListener('visibilitychange', visibility)
  visibility()
  apply()
  reduce.addEventListener('change', apply)
}
