// Scene 1, 0 s to beat 7.5: she asks "ねぇ ASIST、今日の予定は?", the camera pans to the robot, which
// jumps in and answers with the calendar card. Beats 0-2 are the pickup of the music, so the
// question is the upbeat and the answer lands on the first bar.
scene(() => {
  const s = $('#s1')
  const cam = camera(s)
  const fx = overlay($('#s1-world'), 60)
  const PAN = -760
  show(s, 0, B(7.6))

  cam.x = 220
  tl.to(cam, { x: PAN, s: 1.03, duration: B(3.7) - B(2.3), ease: 'power3.inOut' }, B(2.3))

  // She is on screen from the first frame, which X shows as the still before the video plays.
  tl.fromTo('#s1-girl', { y: 26 }, { y: 0, duration: 0.5, ease: 'power2.out' }, 0)
  for (const k of [0, 1, 2]) tl.to('#s1-girl', { rotation: -2.2, duration: BEAT / 2, ease: 'sine.inOut', yoyo: true, repeat: 1 }, B(k))

  pop('#s1-ask', B(0), { from: 0.2, origin: '12% 110%', rotFrom: -8, rot: -2 })
  cue(B(0), 'voice')
  voiceBars($('#s1-bars'), B(0) + 0.1, B(2.7))
  typeOut($('#s1-ask .txt'), B(0) + 0.18, 1.25)
  tl.to('#s1-ask', { scale: 0.9, autoAlpha: 0.75, duration: 0.5, ease: 'power2.inOut' }, B(4))

  const land = B(3) + 0.27
  tl.fromTo('#s1-robot', { y: 760, scaleX: 0.9, scaleY: 1.14 }, { y: -95, duration: B(3) - B(2.5), ease: 'power2.out' }, B(2.5))
  tl.to('#s1-robot', { y: 0, duration: land - B(3), ease: 'power2.in' }, B(3))
  tl.to('#s1-robot', { keyframes: [
    { scaleX: 1.14, scaleY: 0.84, duration: 0.08, ease: 'power1.out' },
    { scaleX: 1, scaleY: 1, duration: 0.5, ease: 'elastic.out(1.2, 0.4)' },
  ] }, land)
  tl.fromTo('#s1-robot-shadow', { autoAlpha: 0, scale: 0.3 }, { autoAlpha: 1, scale: 1, duration: 0.3, ease: 'power2.out' }, land - 0.18)
  cue(B(2.5), 'jump')
  cue(land, 'land')
  bob('#s1-robot', B(5), B(7.6), { amp: -10, period: BEAT * 2 })

  pop('#s1-reply', B(3.5), { from: 0.3, origin: '88% 110%', rotFrom: 8, rot: 2 })
  cue(B(3.5), 'reply')

  // The open hand of robot-present sits at 93 % across and 47 % down the picture.
  const hand = { x: 1600 + 0.93 * 450, y: 470 + 0.47 * 572 }
  const cardC = { x: 2090 + 165, y: 196 + 300 }
  tl.fromTo('#s1-card', { autoAlpha: 0, x: hand.x - cardC.x, y: hand.y - cardC.y, scale: 0.12, rotation: -30 },
    { autoAlpha: 1, x: 0, y: 0, scale: 1, rotation: 4, duration: 0.7, ease: 'back.out(1.5)' }, B(4))
  tl.fromTo('#s1-card-in', { rotationY: -85 }, { rotationY: 0, duration: 0.8, ease: 'back.out(1.6)' }, B(4))
  cue(B(4), 'card')
  burst(fx, cardC.x, cardC.y, B(4) + 0.32, { r: 260, color: '#7aa0ff', sparks: 10, width: 8 })

  pop('#s1-p-cal', B(4.5), { from: 0, rotFrom: -40, rot: 12 })
  burst(fx, 2425, 185, B(4.5), { r: 110, color: '#b9a8f5' })
  pop('#s1-p-clock', B(5), { from: 0, rotFrom: 30, rot: -8 })
  burst(fx, 2445, 735, B(5), { r: 100, color: '#8fd6b4' })
  pop('#s1-p-spark', B(5.25), { from: 0, rotFrom: -90, rot: 0 })
  cue(B(4.5), 'pop', { i: 0 })
  cue(B(5), 'pop', { i: 1 })
  for (const [el, a] of [['#s1-p-cal', -14], ['#s1-p-clock', 12], ['#s1-p-spark', -9]]) bob(el, B(5.5), B(7.6), { amp: a, period: BEAT * 2 })
  tl.fromTo('#s1-f-cloud', { x: 120 }, { x: -60, duration: B(7.6), ease: 'none' }, 0)
  tl.fromTo('#s1-b-cloud', { x: 0 }, { x: -90, duration: B(7.6), ease: 'none' }, 0)
  bob('#s1-b-star', 0, B(7.6), { amp: -18, period: BEAT * 2 })
  tl.fromTo('#s1-b-star', { rotation: -10 }, { rotation: 25, duration: B(7.6), ease: 'none' }, 0)

  // Scene 2 opens as a circle from the centre of this card, so the push keeps that centre in place.
  refocus(cam, B(5.5), cardC.x, cardC.y, { x: PAN, y: 0, s: 1.03, ox: W / 2, oy: H / 2 })
  tl.to(cam, { s: 1.5, duration: B(7.5) - B(6.25), ease: 'expo.in' }, B(6.25))
  cue(B(6.9), 'whoosh')
})
