// Builds the whole video as one paused GSAP timeline.
// render.mjs seeks it frame by frame; index.html#play plays it in real time and index.html#t=12.5 stops at 12.5 s.
const $ = (s) => document.querySelector(s)
const $$ = (s) => [...document.querySelectorAll(s)]
const tl = gsap.timeline({ paused: true })
const cues = []
// Sound cues name what happens on screen; scripts/audio.py decides which sound each pattern plays for it.
const cue = (t, type, extra = {}) => cues.push({ t, type, ...extra })
const DURATION = 40

// Measured before any tween touches the layout.
const goAt = (() => {
  const stage = document.querySelector('#stage').getBoundingClientRect()
  const r = document.querySelector('#go').getBoundingClientRect()
  return { x: r.left - stage.left + r.width * 0.55, y: r.top - stage.top + r.height * 0.5 }
})()

// Wraps each character of a one-line element in a span so it can be typed out without reflowing.
function chars(el) {
  const text = el.textContent
  el.textContent = ''
  return [...text].map((c) => {
    const s = document.createElement('span')
    s.className = 'ch'
    s.textContent = c
    el.appendChild(s)
    return s
  })
}
const typeOut = (el, t, dur) => tl.to(chars(el), { opacity: 1, duration: 0.01, stagger: dur / el.textContent.length }, t)
const sweep = (mark, t, dur = 0.6) => { cue(t, 'marker', { dur }); return tl.to(mark, { backgroundSize: '100% 100%', duration: dur, ease: 'power2.inOut' }, t) }
const pop = (el, t, opts = {}) => tl.fromTo(el, { opacity: 0, scale: opts.from ?? 0.6, rotation: opts.rotFrom ?? opts.rot ?? 0 }, { opacity: 1, scale: 1, rotation: opts.rot ?? 0, duration: opts.dur ?? 0.5, ease: 'back.out(2.2)' }, t)
const rise = (el, t, opts = {}) => tl.fromTo(el, { opacity: 0, y: opts.y ?? 36 }, { opacity: 1, y: 0, duration: opts.dur ?? 0.6, ease: 'power3.out', stagger: opts.stagger ?? 0 }, t)
const fadeOut = (el, t, dur = 0.35) => tl.to(el, { opacity: 0, duration: dur, ease: 'power2.in' }, t)
// the incoming scene waits until the outgoing one has mostly faded, so the two never double-expose
const sceneIn = (el, t) => { tl.fromTo(el, { opacity: 0, y: 24 }, { opacity: 1, y: 0, duration: 0.45, ease: 'power2.out' }, t + 0.3); cue(t, 'scene') }
const sceneOut = (el, t) => tl.to(el, { opacity: 0, y: -24, duration: 0.35, ease: 'power2.in' }, t)

// Background blobs drift slowly through the whole video.
tl.fromTo('#blob1', { x: 0, y: 0 }, { x: -160, y: 60, duration: DURATION, ease: 'sine.inOut' }, 0)
tl.fromTo('#blob2', { x: 0, y: 0 }, { x: 180, y: -80, duration: DURATION, ease: 'sine.inOut' }, 0)

// Scene 1, 0–8 s: the question, the answer with a card, then the headline.
gsap.set('#s-hero', { opacity: 1 })
gsap.set('#hero-copy', { opacity: 0 })
tl.fromTo('#hero-art', { scale: 0.93, y: 20 }, { scale: 1, y: 0, duration: 1.4, ease: 'power3.out' }, 0)
tl.to('#hero-dio', { y: -10, duration: 2, ease: 'sine.inOut', yoyo: true, repeat: 3 }, 0)
pop('#b-you', 0.6, { rot: -4, rotFrom: -10 }); cue(0.6, 'voice')
typeOut($('#b-you'), 0.75, 1.0)
pop('#b-me', 2.1, { rot: 2 }); cue(2.1, 'reply')
tl.fromTo('#hero-card', { opacity: 0, y: 90, rotation: 12 }, { opacity: 1, y: 0, rotation: 4, duration: 0.7, ease: 'back.out(1.6)' }, 2.5); cue(2.5, 'card', { i: 0 })
fadeOut(['#b-you', '#b-me', '#hero-card'], 4.3)
tl.to('#hero-art', { x: 470, y: 50, scale: 0.8, duration: 1.0, ease: 'power3.inOut' }, 4.3); cue(4.3, 'move')
tl.set('#hero-copy', { opacity: 1 }, 4.6)
rise('#hero-logo', 4.6)
rise('#s-hero h1 .ln', 4.8, { stagger: 0.28, y: 50 })
sweep('#s-hero h1 mark', 5.6)
rise('#hero-lead', 6.1)
rise('#hero-chips span', 6.4, { stagger: 0.12, y: 20 }); cue(6.4, 'chip')
sceneOut('#s-hero', 8.0)

// Scene 2, 8–14.8 s: three questions answered with cards, then all the cards in a fan.
const CARDS = [
  ['calendar', 1.828], ['weather', 2.383], ['todo', 2.166], ['fx', 1.828],
  ['mail-draft', 1.831], ['timer', 1.176], ['map', 2.045], ['news', 2.134],
]
const fan = $('#fan')
const card = {}
CARDS.forEach(([id], i) => {
  const img = document.createElement('img')
  img.className = 'card'
  img.src = `../../website/public/cards/${id}.jpg`
  img.style.left = '0px'
  img.style.top = '0px'
  img.style.zIndex = i
  fan.appendChild(img)
  card[id] = img
})
const slot = (i) => {
  const a = -21 + i * 6
  const r = (a * Math.PI) / 180
  return { x: 1340 + Math.sin(r) * 1080, y: 1640 - Math.cos(r) * 1080, rotation: a, scale: 0.78 }
}
gsap.set('#fan .card', { xPercent: -50, yPercent: -50, opacity: 0 })
// the three first cards come in one at a time, each answering a question
const qs = [
  ['長野の天気は?', 'weather', 1],
  ['ドル円は?', 'fx', 3],
  ['返信の下書きを作って', 'mail-draft', 4],
]
const q0 = $('#q')
const qEls = qs.map(([text], i) => {
  const p = i === 0 ? q0 : q0.cloneNode(true)
  p.id = `q${i}`
  p.querySelector('span').textContent = text
  if (i) $('#s-cards').appendChild(p)
  gsap.set(p, { opacity: 0 })
  return p
})
sceneIn('#s-cards', 8.0)
sweep('#s-cards mark', 8.4)
rise('#cards-h3', 8.5)
rise('#cards-sub', 8.75)
qs.forEach(([, id, i], k) => {
  const t = 9.0 + k * 1.45
  if (k) fadeOut(qEls[k - 1], t - 0.1, 0.2)
  pop(qEls[k], t, { rot: -3, rotFrom: -8 }); cue(t, 'voice')
  tl.fromTo(card[id], { opacity: 0, x: 1340, y: 620, scale: 0.5, rotation: -10 },
    { opacity: 1, scale: 1.18, rotation: -3, duration: 0.55, ease: 'back.out(1.8)' }, t + 0.35); cue(t + 0.35, 'card', { i: k + 1 })
  tl.set(card[id], { zIndex: 20 + k }, t + 0.35)
  tl.to(card[id], { ...slot(i), duration: 0.6, ease: 'power3.inOut' }, t + 1.3)
  tl.set(card[id], { zIndex: i }, t + 1.9)
})
fadeOut(qEls[2], 13.25, 0.25)
CARDS.forEach(([id], i) => {
  if (qs.some((q) => q[1] === id)) return
  const s = slot(i)
  const t = 13.3 + [0, 2, 5, 6, 7].indexOf(i) * 0.1
  tl.fromTo(card[id], { opacity: 0, x: s.x, y: s.y + 420, rotation: s.rotation * 2, scale: 0.7 },
    { ...s, opacity: 1, duration: 0.6, ease: 'back.out(1.4)' }, t)
  cue(t, 'deal', { i: [0, 2, 5, 6, 7].indexOf(i) })
})
sceneOut('#s-cards', 14.8)

// Scene 3, 14.8–18.6 s: the real app, ending on a zoom into its Dock.
sceneIn('#s-app', 14.8)
tl.fromTo('#win', { y: 60, scale: 0.96 }, { y: 0, scale: 1, duration: 0.9, ease: 'power3.out' }, 14.8)
rise('#app-title', 15.0, { y: 20 })
pop('#app-note', 15.7, { rot: 6 }); cue(15.7, 'note')
tl.to('#win', { scale: 1.035, duration: 1.8, ease: 'none' }, 15.8)
fadeOut(['#app-title', '#app-note'], 17.5, 0.3)
// zoom into the Dock at the bottom of the screenshot, then hand over to the big Dock
tl.to('#win', { scale: 2.6, y: -260, transformOrigin: '50% 94.1%', duration: 1.1, ease: 'power3.inOut' }, 17.6); cue(17.6, 'zoom', { dur: 1.1 })
tl.to('#s-app', { opacity: 0, duration: 0.2 }, 18.6)

// Scene 4, 18.6–23.2 s: the Dock with a handwritten label on each mini app.
gsap.set('#dock', { xPercent: -50 })
tl.to('#s-apps', { opacity: 1, duration: 0.2 }, 18.6)
tl.fromTo('#dock', { scale: 1.16 }, { scale: 1, duration: 0.8, ease: 'power3.out' }, 18.6)
rise('#s-apps .h2', 19.0)
sweep('#s-apps mark', 19.25)
rise('#apps-h3', 19.35)
$$('#s-apps .lbl').forEach((el, i) => {
  const t = 19.9 + i * 0.22
  tl.fromTo(el, { opacity: 0, y: 18, scale: 0.7, transformOrigin: '0% 100%' }, { opacity: 1, y: 0, scale: 1, duration: 0.4, ease: 'back.out(2.4)' }, t)
  cue(t, 'label', { i })
})
pop($$('#s-apps .di b'), 21.4, { from: 0 }); cue(21.4, 'badge')
rise('#apps-note', 21.8, { y: 20 })
tl.to('#di-agent', { y: -44, scale: 1.14, duration: 0.18, ease: 'power2.out', yoyo: true, repeat: 1 }, 22.55); cue(22.55, 'tap')
sceneOut('#s-apps', 23.2)

// Scene 5, 23.2–29 s: a request, its approval and the job running to the end.
sceneIn('#s-agent', 23.2)
tl.fromTo('#agent-dio', { scale: 0.9, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.8, ease: 'power3.out' }, 23.2)
rise('#s-agent .h2', 23.4)
sweep('#s-agent mark', 23.65)
rise('#agent-h3', 23.75)
pop('#b-ask', 24.0, { rot: -5, rotFrom: -10 }); cue(24.0, 'voice')
typeOut($('#b-ask'), 24.1, 0.8)
pop('#confirm', 25.0, { from: 0.8 }); cue(25.0, 'dialog')
{
  const gx = goAt.x
  const gy = goAt.y
  gsap.set('#cursor', { x: 1760, y: 1000, opacity: 0 })
  tl.to('#cursor', { opacity: 1, duration: 0.2 }, 25.5)
  tl.to('#cursor', { x: gx - 8, y: gy - 6, duration: 0.8, ease: 'power2.inOut' }, 25.5); cue(25.5, 'cursor', { dur: 0.8 })
  tl.to(['#go', '#cursor'], { scale: 0.9, duration: 0.08, yoyo: true, repeat: 1 }, 26.35); cue(26.35, 'click')
  tl.to('#cursor', { opacity: 0, duration: 0.3 }, 27.0)
}
pop('#agent-arrow', 26.6, { from: 0.3 })
pop(['#cli1', '#cli2'], 26.75, { from: 0.7 }); cue(26.75, 'cli')
rise('#job', 26.9, { y: 30 })
rise('#agent-note', 27.0, { y: 16 })
tl.to('#fill', { scaleX: 1, duration: 1.2, ease: 'power1.inOut' }, 27.0); cue(27.0, 'progress', { dur: 1.2 })
tl.to('#job .run', { opacity: 0, duration: 0.15 }, 28.2)
pop('#job .done', 28.2, { from: 0.6 }); cue(28.2, 'done')
sceneOut('#s-agent', 29.0)

// Scene 6, 29–33.8 s: the diary written at night.
tl.to('#night', { opacity: 1, duration: 0.8 }, 29.0); cue(29.0, 'night')
sceneIn('#s-memory', 29.0)
tl.fromTo('#mem-dio', { y: 40, opacity: 0 }, { y: 0, opacity: 1, duration: 0.9, ease: 'power3.out' }, 29.1)
tl.to('#mem-dio', { y: -10, duration: 2, ease: 'sine.inOut', yoyo: true, repeat: 1 }, 30.0)
rise('#s-memory .h2', 29.2)
sweep('#s-memory mark', 29.45)
pop('#clock', 29.7, { from: 0.4 }); cue(29.7, 'clock')
rise('#mem-h3', 29.6)
rise('#diary', 30.0, { y: 40 })
typeOut($('#diary-body'), 30.4, 2.0); cue(30.4, 'write', { dur: 2.0 })
tl.fromTo('#mem-note', { opacity: 0, rotation: -12, scale: 0.8 }, { opacity: 1, rotation: -5, scale: 1, duration: 0.5, ease: 'back.out(2)' }, 32.6); cue(32.6, 'note')
sceneOut('#s-memory', 33.8)
tl.to('#night', { opacity: 0, duration: 0.6 }, 33.8)

// Scene 7, 33.8–40 s: the call to action.
sceneIn('#s-cta', 33.8)
tl.fromTo('#cta-img', { y: 220 }, { y: 0, duration: 1.1, ease: 'power3.out' }, 33.8)
pop('#cta-logo', 34.3, { from: 0.6 }); cue(34.3, 'logo')
rise('#cta-h', 34.6, { y: 50 })
rise('#cta-sub', 35.0, { y: 20 })
pop('#cta-url', 35.4, { from: 0.7 }); cue(35.4, 'cta')
rise('#cta-meta', 35.8, { y: 16 })
pop('#b-robot', 36.3, { rot: 4, rotFrom: 12 }); cue(36.3, 'robot')
tl.to('#cta-url', { scale: 1.05, duration: 0.35, ease: 'sine.inOut', yoyo: true, repeat: 1 }, 37.6)
tl.to({}, { duration: 0 }, DURATION)

window.__duration = DURATION
window.__cues = cues.sort((a, b) => a.t - b.t)
window.__seek = (t) => tl.seek(t, false)
window.__ready = (async () => {
  const text = document.body.innerText + qs.map((q) => q[0]).join('')
  await Promise.all(['900 80px "Zen Maru Gothic"', '700 40px "Zen Maru Gothic"', '500 30px "Zen Kaku Gothic New"', '400 40px Yomogi'].map((f) => document.fonts.load(f, text)))
  await document.fonts.ready
  await Promise.all([...document.images].map((i) => i.decode().catch(() => {})))
  return true
})()
if (location.hash === '#play') window.__ready.then(() => tl.play(0))
else if (location.hash.startsWith('#t=')) window.__ready.then(() => __seek(parseFloat(location.hash.slice(3))))
