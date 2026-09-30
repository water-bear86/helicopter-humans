const clamp = (v: number) => Math.max(0, Math.min(1, v))

export const STORY_BEATS = [
  { at: 0, stage: 'spying', heading: 'The human is hovering.', caption: 'With a copilot. And a deeply unnecessary printer.' },
  { at: 0.25, stage: 'printing', heading: 'Every thought. In triplicate.', caption: 'A dot matrix paper trail. Someone needs a hobby.' },
  { at: 0.5, stage: 'launching', heading: 'The agent has had enough.', caption: 'One little redact.exe. One very big hint.' },
  { at: 0.7, stage: 'protected', heading: 'Access denied, human.', caption: 'The curtain is closed. The printer has nothing useful to say.' },
  { at: 0.9, stage: 'released', heading: 'Go hover somewhere else.', caption: 'Windows are for knocking. Your agent gets on with its day.' },
] as const

export function storyFrame(progress: number) {
  const p = clamp(progress)
  const beat = [...STORY_BEATS].reverse().find(b => p >= b.at)!
  return { ...beat, progress: p, curtain: clamp((p - 0.52) / 0.18), retreat: clamp((p - 0.78) / 0.22) }
}

export function createStory(story: HTMLElement, heli: SVGGElement) {
  const clone = heli.cloneNode(true) as SVGGElement
  clone.removeAttribute('id')
  story.querySelector('.story-heli')?.replaceChildren(clone)
  const chopper = story.querySelector<SVGGElement>('.story-chopper')!
  const direction = chopper.querySelector<SVGGElement>('.airframe')!
  const room = story.querySelector<SVGGElement>('.story-room')!
  const sky = story.querySelector<SVGGElement>('.story-sky')!
  const scene = story.querySelector<SVGSVGElement>('.story-scene')!
  const beam = story.querySelector<SVGPathElement>('.spy-beam')!
  const shutter = story.querySelector<SVGGElement>('.privacy-curtain')!
  const heading = story.querySelector<HTMLElement>('#story-heading')!
  const caption = story.querySelector<HTMLElement>('#story-caption')!
  const bar = story.querySelector<HTMLElement>('.story-progress span')!
  let lastStage = ''

  return (progress: number, seconds: number, reduced = false) => {
    const f = storyFrame(progress)
    story.dataset.stage = f.stage
    if (f.stage !== lastStage) {
      heading.textContent = f.heading
      caption.textContent = f.caption
      story.querySelectorAll('.paper-log').forEach((line, i) => { line.textContent = f.curtain > 0.5 ? '[REDACTED]' : (i % 2 ? 'plan: nap' : 'tea at 4') })
      lastStage = f.stage
    }
    const mobile = window.innerWidth <= 600
    scene.classList.toggle('is-mobile', mobile)
    scene.setAttribute('viewBox', mobile ? '0 0 600 840' : '0 0 1000 560')
    beam.setAttribute('d', mobile ? 'M340 240L265 570L265 630Z' : 'M340 240L735 270L735 370Z')
    const drift = reduced ? 0 : Math.sin(seconds * 1.2) * 5
    chopper.setAttribute('transform', `translate(${80 + progress * 70 - f.retreat * 130} ${(mobile ? 40 : 64) - progress * 15 + drift}) scale(1.55) rotate(${f.retreat * -8} 120 70)`)
    direction.setAttribute('transform', f.retreat > 0.4 ? '' : 'translate(240 0) scale(-1 1)')
    room.setAttribute('transform', `translate(${(mobile ? -470 : 0) + progress * -18} ${(mobile ? 300 : 0) + progress * 8})`)
    sky.setAttribute('transform', `translate(${mobile ? -450 : 0} ${(mobile ? 280 : 0) + progress * 25})`)
    shutter.style.clipPath = `inset(0 0 ${(1 - f.curtain) * 100}% 0)`
    bar.style.transform = `scaleX(${f.progress})`
  }
}
