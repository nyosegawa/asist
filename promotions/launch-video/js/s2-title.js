// Scene 2, beat 7 to 15: the headline on the brand blue. It opens as a circle out of the calendar card
// of scene 1 and leaves by sliding up while scene 3 comes in from below.
scene(() => {
  const s = $('#s2')
  const cam = camera(s)
  const fx = overlay($('#s2-front'), -1)
  // The centre of scene 1's card on screen, after its camera has panned by -760 and zoomed to 1.03.
  const at = { x: 960 - 760 + 1.03 * (2255 - 960), y: 540 + 1.03 * (496 - 540) }
  show(s, B(6.85), B(15.6))
  gsap.set(s, { clipPath: `circle(0px at ${at.x}px ${at.y}px)` })
  tl.to(s, { clipPath: `circle(1900px at ${at.x}px ${at.y}px)`, duration: B(7.6) - B(6.9), ease: 'power3.in' }, B(6.9))
  const edge = svgEl('circle', { cx: at.x, cy: at.y, r: 10, fill: 'none', stroke: '#fff', 'stroke-width': 14, opacity: 0.9 }, overlay($('#stage'), 95))
  gsap.set(edge, { autoAlpha: 0 })
  tl.set(edge, { autoAlpha: 1 }, B(6.9))
  tl.fromTo(edge, { attr: { r: 0 } }, { attr: { r: 1900 }, duration: B(7.6) - B(6.9), ease: 'power3.in' }, B(6.9))
  tl.set(edge, { autoAlpha: 0 }, B(7.6))

  tl.fromTo('#s2-back .ringbg', { scale: 0.6, autoAlpha: 0 }, { scale: 1, autoAlpha: 1, duration: 1.4, ease: 'expo.out', stagger: 0.08 }, B(7.2))
  tl.to('#s2-back .ringbg', { scale: 1.12, duration: B(15.6) - B(8.5), ease: 'none' }, B(8.5))

  // The pill is centred by xPercent, which GSAP keeps apart from the x that pop animates.
  gsap.set('#s2-logo', { xPercent: -50 })
  pop('#s2-logo', B(7.5), { from: 0.3, yFrom: -90 })
  cue(B(7.5), 'pop', { i: 2 })

  // The underlines are measured before SplitText runs, because it moves the characters out of the
  // highlighted spans.
  const stage = $('#stage').getBoundingClientRect()
  const lines = [['#s2-hl1', 0], ['#s2-hl2', 1]].map(([id, i]) => {
    const r = $(id).getBoundingClientRect()
    const x0 = r.left - stage.left + 4
    const x1 = r.right - stage.left - 4
    const y = r.bottom - stage.top - 10
    const d = `M${x0},${y} C${x0 + (x1 - x0) * 0.3},${y + 14} ${x0 + (x1 - x0) * 0.6},${y - 12} ${x1},${y + 4}`
    return [svgEl('path', { d, fill: 'none', stroke: '#ffe08a', 'stroke-width': 13, 'stroke-linecap': 'round' }, fx), i]
  })
  for (const [p, i] of lines) draw(p, B(10) + i * 0.18, 0.4)
  const l1 = chars($('#s2-l1'))
  const l2 = chars($('#s2-l2'))
  kinetic(l1, B(8), 'pop', { stagger: 0.04, y: 90 })
  kinetic(l2, B(9), 'pop', { stagger: 0.04, y: 90 })
  cue(B(8), 'type', { n: l1.length, dur: 0.04 * l1.length })
  cue(B(9), 'type', { n: l2.length, dur: 0.04 * l2.length })

  cue(B(10), 'marker')

  pop('#s2-p-bubble', B(8), { from: 0, rotFrom: -50, rot: -10 })
  pop('#s2-p-cal', B(10), { from: 0, rotFrom: 40, rot: 8 })
  pop('#s2-p-mail', B(10.5), { from: 0, rotFrom: -40, rot: 10 })
  pop('#s2-p-check', B(11), { from: 0, rotFrom: 60, rot: -6, dur: 0.7 })
  const fx2 = overlay($('#s2-props'), 0)
  burst(fx2, 190, 215, B(8), { r: 130, color: '#fff' })
  burst(fx2, 155, 755, B(10), { r: 120, color: '#ffe08a' })
  burst(fx2, 1720, 215, B(10.5), { r: 120, color: '#ffe08a' })
  burst(fx2, 1820, 715, B(11), { r: 170, color: '#fff', sparks: 12, width: 10 })
  for (const [i, t] of [[0, B(8)], [1, B(10)], [2, B(10.5)], [3, B(11)]]) cue(t, 'pop', { i: 3 + i })
  for (const [el, a, k] of [['#s2-p-bubble', -16, 0], ['#s2-p-cal', 14, 1], ['#s2-p-mail', -12, 2], ['#s2-p-check', 16, 3]]) {
    bob(el, B(11.5) + k * 0.12, B(15.6), { amp: a, period: BEAT * 2 })
  }
  bump(cam, B(11) + 0.04)
  tl.to([...l1, ...l2], { y: -14, duration: 0.12, ease: 'power2.out', yoyo: true, repeat: 1, stagger: 0.012 }, B(11))

  tl.to([...l1, ...l2], { y: -16, duration: 0.18, ease: 'sine.out', yoyo: true, repeat: 1, stagger: 0.03 }, B(13))
  rise('#s2-sub', B(11.5), { y: 30 })
  pop($$('#s2-chips .pill'), B(12), { from: 0.4, stagger: 0.12 })
  cue(B(12), 'chip', { n: 2, dur: 0.12 })

  tl.to(cam, { s: 1.04, duration: B(14.5) - B(11), ease: 'none' }, B(11))
  tl.to(s, { yPercent: -100, duration: B(15.6) - B(14.6), ease: 'power3.inOut' }, B(14.6))
  cue(B(14.6), 'whoosh')
})
