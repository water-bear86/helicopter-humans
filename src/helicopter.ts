import { FLYER_BOX, HELI_CENTER, MIN_GUTTER, flightPose, sceneOffset, type Metrics } from './flight'

// Scroll-linked flight for the hero helicopter. Decorative only: the flyer is
// aria-hidden and ignores the pointer. With reduced motion, or without JS, the
// helicopter stays put in its scene.

const SVG_NS = 'http://www.w3.org/2000/svg'
const SHADOW = 8 // px of box-shadow on windows and cards, kept clear of the flyer
const ORIGIN = { x: HELI_CENTER.x - FLYER_BOX.x, y: HELI_CENTER.y - FLYER_BOX.y }

const round = (n: number) => Math.round(n * 100) / 100

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string>) {
  const el = document.createElementNS(SVG_NS, tag)
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value)
  return el
}

function buildFlyer(heli: SVGGElement) {
  const root = document.createElement('div')
  root.className = 'flyer'
  root.setAttribute('aria-hidden', 'true')
  const svg = svgEl('svg', { viewBox: `${FLYER_BOX.x} ${FLYER_BOX.y} ${FLYER_BOX.w} ${FLYER_BOX.h}`, focusable: 'false' })
  const chip = svgEl('rect', { class: 'flyer-chip', 'stroke-width': '3' })
  const caption = svgEl('text', { class: 'whup', 'text-anchor': 'middle', 'font-family': 'monospace', 'font-weight': '900', fill: '#c6ff00' })
  caption.textContent = 'WHUP WHUP WHUP'
  svg.append(heli.cloneNode(true), chip, caption)
  root.append(svg)
  document.body.append(root)
  return { root, chip, caption }
}

function fly(art: HTMLElement, scene: SVGSVGElement, flight: SVGGElement) {
  const found = flight.querySelector<SVGGElement>('.heli')
  if (!found) return () => {}
  const heli: SVGGElement = found
  const hero = art.closest<HTMLElement>('.hero') ?? art
  let metrics: Metrics
  let sceneStart = 0
  let sceneEnd = 1
  let flyer: ReturnType<typeof buildFlyer> | null = null
  let onStage = true
  let frame = 0

  function measure() {
    const vw = document.documentElement.clientWidth
    const vh = window.innerHeight
    const y = window.scrollY
    let contentRight = 0
    for (const section of document.querySelectorAll<HTMLElement>('main > .section')) {
      const rect = section.getBoundingClientRect()
      contentRight = Math.max(contentRight, rect.right - parseFloat(getComputedStyle(section).paddingRight))
    }
    for (const pill of document.querySelectorAll<HTMLElement>('.availability li')) {
      contentRight = Math.max(contentRight, pill.getBoundingClientRect().right)
    }
    const rect = scene.getBoundingClientRect()
    const heroBottom = hero.getBoundingClientRect().bottom + y
    metrics = {
      vw,
      vh,
      gutter: vw - contentRight - SHADOW,
      art: { left: rect.left, top: rect.top + y, k: rect.width / 400 },
      span: Math.max(240, heroBottom - 0.3 * vh),
    }
    // Scene drift starts once the helicopter scrolls into view and ends as the scene leaves.
    sceneStart = Math.max(0, rect.top + y + rect.height / 3 - vh)
    sceneEnd = Math.max(sceneStart + 1, rect.bottom + y)

    const lane = metrics.gutter >= MIN_GUTTER
    if (lane && !flyer) flyer = buildFlyer(heli)
    if (!lane && flyer) {
      flyer.root.remove()
      flyer = null
    }
    art.classList.toggle('is-flown', lane)
    if (lane) flight.removeAttribute('transform')
  }

  function render() {
    frame = 0
    const y = window.scrollY
    if (flyer) {
      const { pose, caption } = flightPose(y, metrics)
      flyer.root.style.transform = `translate(${round(pose.cx - ORIGIN.x)}px, ${round(pose.cy - ORIGIN.y)}px) scale(${round(pose.k * 1000) / 1000}) rotate(${round(pose.r)}deg)`
      const w = caption.size * 8.6
      const h = caption.size * 1.45
      flyer.caption.setAttribute('x', `${round(caption.x)}`)
      flyer.caption.setAttribute('y', `${round(caption.y)}`)
      flyer.caption.setAttribute('font-size', `${round(caption.size)}`)
      flyer.chip.setAttribute('x', `${round(caption.x - w / 2)}`)
      flyer.chip.setAttribute('y', `${round(caption.y - caption.size * 1.08)}`)
      flyer.chip.setAttribute('width', `${round(w)}`)
      flyer.chip.setAttribute('height', `${round(h)}`)
      flyer.chip.setAttribute('opacity', `${round(caption.chip)}`)
    } else if (onStage) {
      const { dx, dy, r } = sceneOffset((y - sceneStart) / (sceneEnd - sceneStart), y)
      flight.setAttribute('transform', `translate(${round(dx)} ${round(dy)}) rotate(${round(r)} ${HELI_CENTER.x} ${HELI_CENTER.y})`)
    }
  }

  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(render)
  }
  const remeasure = () => {
    measure()
    schedule()
  }

  // Pause the scene's own loops, and skip transform writes, while it is off screen.
  const stage = new IntersectionObserver((entries) => {
    onStage = entries[entries.length - 1].isIntersecting
    art.classList.toggle('is-offstage', !onStage)
    if (onStage) schedule()
  })
  // Covers resizes, orientation changes and scrollbars appearing.
  const layout = new ResizeObserver(remeasure)

  measure()
  render()
  window.addEventListener('scroll', schedule, { passive: true })
  stage.observe(art)
  layout.observe(document.body)

  return () => {
    window.removeEventListener('scroll', schedule)
    stage.disconnect()
    layout.disconnect()
    cancelAnimationFrame(frame)
    flyer?.root.remove()
    art.classList.remove('is-flown', 'is-offstage')
    flight.removeAttribute('transform')
  }
}

export function initHelicopter() {
  const visibility = () => document.documentElement.classList.toggle('is-page-hidden', document.hidden)
  visibility()
  document.addEventListener('visibilitychange', visibility)

  const art = document.querySelector<HTMLElement>('.hero-art')
  const scene = art?.querySelector('svg')
  const flight = scene?.querySelector<SVGGElement>('.flight')
  if (!art || !scene || !flight || !('IntersectionObserver' in window) || !('ResizeObserver' in window)) return

  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)')
  let stop: (() => void) | null = null
  const apply = () => {
    stop?.()
    stop = reduce.matches ? null : fly(art, scene, flight)
  }
  apply()
  reduce.addEventListener('change', apply)
}
