// The tape deck: a <video> dressed as a cassette deck. Its reels turn with playback and wind tape from
// one side to the other, the LCD shows time and the topic under discussion, and the VU meters read the
// actual audio through Web Audio. Custom scrubber with topic bands and sprite-sheet hover previews.
import { icon } from './art.js'
import { clamp, esc, fmtT, local, reducedMotion, topicColor } from './util.js'

// how far the skip buttons and their keys (j and l) jump, in seconds
export const SKIP = 10
const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3]
const CC_MODES = ['off', 'over', 'under']
const CC_TITLE = { off: 'Captions off (c)', over: 'Captions on the video (c)', under: 'Captions under the video (c)' }

function reel(side) {
  let spokes = ''
  for (let i = 0; i < 3; i++) spokes += `<rect x="-1.6" y="-12.5" width="3.2" height="9" rx="1.4" transform="rotate(${i * 120})"/>`
  return `<svg class="lcd-reel ${side}" viewBox="-30 -30 60 60" aria-hidden="true">
    <circle r="27" class="reel-rim"/><circle r="10" class="reel-tape" data-tape/>
    <g class="reel-spin"><circle r="13.5" class="reel-hub"/><circle r="4.2" class="reel-axle"/>${spokes}</g>
  </svg>`
}

export function createDeck(host, o) {
  // o: { meeting, variant, base, toAxis, toVideo, canSeek(), topicAt(axisT), captionAt(axisT), onTime(videoT), bands: [{s,e,color,title}] (video time) }
  const m = o.meeting
  let v = o.variant
  const pos = local.get(`pos:${m.id}`, null)
  // times read on the meeting's clock, the one its notes use: a copy trimmed at the start joins it partway in
  const shown = (t) => (m.timeBase === 'offset' ? o.toAxis(t) : t)
  host.innerHTML = `
  <div class="deck" style="--hue:${m.hue}">
    <div class="lcd">
      ${reel('left')}
      <div class="lcd-screen">
        <div class="lcd-row">
          <span class="lcd-state">■ STOP</span>
          <span class="lcd-time"><b class="lcd-now">${fmtT(shown(0))}</b><i>/</i><span class="lcd-dur">${fmtT(shown(v?.probe?.duration ?? m.duration))}</span></span>
          <span class="lcd-speed">1×</span>
        </div>
        <div class="lcd-topic"><span class="lcd-marquee">${esc(m.title)}</span></div>
        <div class="vu" aria-hidden="true"><div class="vu-row"><i>L</i><span class="vu-bar"><span class="vu-lit" data-ch="0"></span></span></div><div class="vu-row"><i>R</i><span class="vu-bar"><span class="vu-lit" data-ch="1"></span></span></div></div>
      </div>
      ${reel('right')}
    </div>
    <div class="screen">
      <video preload="metadata" playsinline ${v ? `src="${esc(v.url)}"` : ''} ${o.poster ? `poster="${esc(o.poster)}"` : ''}></video>
      <div class="cc" hidden><span></span></div>
      <button class="big-play" type="button" aria-label="Play">${icon.play}<i></i></button>
      ${pos?.t > 30 && o.startAt == null ? `<button class="resume" type="button">↻ Resume at ${fmtT(shown(pos.t))}</button>` : ''}
      ${!v ? '<div class="no-video"><p>No video on this tape yet.</p></div>' : ''}
      ${v && v.probe && !v.probe.hasAudio ? '<span class="silent-tag">silent film · no audio track</span>' : ''}
    </div>
    <div class="prompter" hidden aria-live="off"><p class="pr-prev"></p><p class="pr-now"></p><p class="pr-next"></p></div>
    <div class="controls">
      <button class="c-play" type="button" aria-label="Play">${icon.play}</button>
      <button class="c-back" type="button" aria-label="Back ${SKIP} seconds" title="Back ${SKIP}s (j)">${icon.back}</button>
      <button class="c-fwd" type="button" aria-label="Forward ${SKIP} seconds" title="Forward ${SKIP}s (l)">${icon.fwd}</button>
      <div class="scrub" role="slider" tabindex="0" aria-label="Seek" aria-valuemin="0">
        <div class="scrub-track"><div class="scrub-bands"></div><div class="scrub-buf"></div><div class="scrub-fill"></div><div class="scrub-marks"></div></div>
        <div class="scrub-knob"></div>
        <div class="scrub-tip" hidden><div class="scrub-thumb"></div><b></b><span></span></div>
      </div>
      <span class="c-time">0:00</span>
      <div class="speed-wrap">
        <button class="c-speed" type="button" title="Playback speed ([ and ])" aria-haspopup="true">1×</button>
        <div class="speed-menu" role="menu" hidden>${SPEEDS.map((s) => `<button type="button" role="menuitemradio" data-rate="${s}">${s}×</button>`).join('')}</div>
      </div>
      <button class="c-cc" type="button" title="Captions (c)">${icon.cc}<i class="cc-mode"></i></button>
      <button class="c-vol" type="button" title="Mute (m) · scroll for volume">${icon.vol}</button>
      <button class="c-rot" type="button" title="Rotate the picture" hidden>${icon.rotate}</button>
      <button class="c-pip" type="button" title="Picture in picture">${icon.pip}</button>
      <button class="c-full" type="button" title="Fullscreen (f)">${icon.full}</button>
    </div>
  </div>`

  const deck = host.querySelector('.deck')
  const video = deck.querySelector('video')
  const q = (s) => deck.querySelector(s)
  const scrub = q('.scrub')
  let dur = v?.probe?.duration ?? m.duration ?? 0
  let rotation = 0
  const savedCc = local.get('captions', 'off')
  let captions = CC_MODES.includes(savedCc) ? savedCc : savedCc === true ? 'over' : 'off'
  let rate = SPEEDS.includes(local.get('speed', 1)) || (local.get('speed', 1) >= 0.5 && local.get('speed', 1) <= 3) ? local.get('speed', 1) : 1
  let prompterIdx = -2
  let audio
  let meterRaf = 0
  let lastSave = 0
  let dragging = false
  let lastTopic = ''

  // ---------- audio meters (needs a user gesture before an AudioContext may start) ----------
  function ensureAudio() {
    if (audio !== undefined || !v?.probe?.hasAudio) return
    try {
      const ctx = new AudioContext()
      const src = ctx.createMediaElementSource(video)
      const split = ctx.createChannelSplitter(2)
      const an = [ctx.createAnalyser(), ctx.createAnalyser()]
      for (const x of an) x.fftSize = 1024
      src.connect(ctx.destination)
      src.connect(split)
      split.connect(an[0], 0)
      split.connect(an[1], 1)
      audio = { ctx, an, buf: new Float32Array(1024), peak: [0, 0], hold: [0, 0] }
    } catch {
      audio = null
    }
  }

  const lit = [...deck.querySelectorAll('.vu-lit')]
  function meter() {
    meterRaf = requestAnimationFrame(meter)
    if (!audio || video.paused) return
    const lv = [0, 0]
    audio.an.forEach((an, ch) => {
      an.getFloatTimeDomainData(audio.buf)
      let sum = 0
      for (const x of audio.buf) sum += x * x
      const rms = Math.sqrt(sum / audio.buf.length)
      const db = 20 * Math.log10(rms || 1e-6)
      lv[ch] = clamp((db + 54) / 50, 0, 1)
    })
    // mono recordings leave the right channel empty: mirror the left with a little life
    if (lv[1] < 0.02 && lv[0] > 0.05) lv[1] = lv[0] * (0.9 + Math.random() * 0.1)
    lv.forEach((x, ch) => {
      audio.peak[ch] = Math.max(x, audio.peak[ch] * 0.9)
      lit[ch].style.setProperty('--lvl', audio.peak[ch].toFixed(3))
    })
  }

  // ---------- state painting ----------
  const tapeL = q('.lcd-reel.left [data-tape]')
  const tapeR = q('.lcd-reel.right [data-tape]')
  function paintTime() {
    const t = video.currentTime || 0
    const p = dur ? clamp(t / dur, 0, 1) : 0
    q('.lcd-now').textContent = fmtT(shown(t))
    q('.c-time').textContent = `${fmtT(shown(t))} / ${fmtT(shown(dur))}`
    q('.scrub-fill').style.width = `${p * 100}%`
    q('.scrub-knob').style.left = `${p * 100}%`
    scrub.setAttribute('aria-valuenow', String(Math.floor(t)))
    scrub.setAttribute('aria-valuetext', fmtT(shown(t)))
    tapeL.setAttribute('r', (10 + 16 * (1 - p)).toFixed(1))
    tapeR.setAttribute('r', (10 + 16 * p).toFixed(1))
    const at = o.canSeek() ? o.toAxis(t) : null
    const topic = at != null ? o.topicAt(at) : null
    const label = topic ? `${topic.n ? `${topic.n} · ` : ''}${topic.title}` : m.title
    if (label !== lastTopic) {
      lastTopic = label
      const mq = q('.lcd-marquee')
      mq.textContent = label
      mq.style.setProperty('--c', topic ? topicColor(topic.color) : 'var(--lcd)')
      mq.classList.toggle('scroll', mq.scrollWidth > mq.parentElement.clientWidth + 4)
    }
    if (captions === 'over') {
      const seg = at != null ? o.captionAt(at) : null
      const cc = q('.cc')
      cc.hidden = !seg
      if (seg) cc.firstElementChild.innerHTML = `${seg.sp ? `<b>${esc(seg.sp)}</b> ` : ''}${esc(seg.t)}`
    } else if (captions === 'under') paintPrompter(at)
    if (Date.now() - lastSave > 4000 && t > 5) {
      lastSave = Date.now()
      local.set(`pos:${m.id}`, { t, at: Date.now() })
    }
    o.onTime?.(t)
  }

  // the teleprompter under the picture: the line before, the line being said, the line coming up
  function paintPrompter(at) {
    const lines = at != null ? o.linesAt?.(at) : null
    const box = q('.prompter')
    if (!lines) {
      box.classList.add('idle')
      q('.pr-now').textContent = o.canSeek() ? '' : 'Captions follow the video once the transcript is lined up with it.'
      return
    }
    box.classList.remove('idle')
    if (lines.index === prompterIdx) return
    const forward = lines.index > prompterIdx
    prompterIdx = lines.index
    const fill = (sel, seg) => {
      const p = q(sel)
      p.innerHTML = seg ? `${seg.sp ? `<b>${esc(seg.sp)}</b> ` : ''}${esc(seg.t)}` : ''
    }
    fill('.pr-prev', lines.prev)
    fill('.pr-now', lines.now)
    fill('.pr-next', lines.next)
    box.classList.remove('roll', 'rollback')
    void box.offsetWidth
    box.classList.add(forward ? 'roll' : 'rollback')
  }

  function paintBuffer() {
    const b = video.buffered
    if (!b.length || !dur) return
    q('.scrub-buf').style.width = `${(b.end(b.length - 1) / dur) * 100}%`
  }

  function paintState() {
    const playing = !video.paused && !video.ended
    deck.classList.toggle('playing', playing)
    q('.lcd-state').textContent = playing ? '▶ PLAY' : video.currentTime > 0 ? '❚❚ PAUSE' : '■ STOP'
    q('.c-play').innerHTML = playing ? icon.pause : icon.play
    q('.c-play').setAttribute('aria-label', playing ? 'Pause' : 'Play')
    deck.style.setProperty('--spin', `${(2.4 / (video.playbackRate || 1)).toFixed(2)}s`)
  }

  function paintBands() {
    q('.scrub-bands').innerHTML = (o.bands ?? [])
      .filter((x) => dur && x.e > 0 && x.s < dur)
      .map((x) => `<i style="left:${(clamp(x.s, 0, dur) / dur) * 100}%;width:${Math.max(0.3, ((clamp(x.e, 0, dur) - clamp(x.s, 0, dur)) / dur) * 100)}%;--c:${x.color}" title="${esc(x.title)}"></i>`)
      .join('')
  }

  // ---------- controls ----------
  const toggle = () => {
    if (!v) return
    if (video.paused || video.ended) {
      ensureAudio()
      audio?.ctx.resume()
      void video.play().catch(() => {})
    } else video.pause()
  }
  const seek = (t, play) => {
    if (!v) return
    video.currentTime = clamp(t, 0, dur || t)
    paintTime()
    if (play && video.paused) toggle()
  }
  const nudge = (d) => seek((video.currentTime || 0) + d)
  const setRate = (next) => {
    rate = Math.round(clamp(next, 0.5, 3) * 100) / 100
    video.defaultPlaybackRate = rate
    video.playbackRate = rate
    local.set('speed', rate)
    q('.c-speed').textContent = `${rate}×`
    q('.lcd-speed').textContent = `${rate}×`
    q('.c-speed').classList.toggle('on', rate !== 1)
    for (const b of deck.querySelectorAll('.speed-menu [data-rate]')) b.setAttribute('aria-checked', String(Number(b.dataset.rate) === rate))
    paintState()
  }
  const speed = (dir) => {
    if (dir === 0) {
      q('.speed-menu').hidden = !q('.speed-menu').hidden
      return
    }
    setRate(rate + dir * 0.25)
  }
  const setCaptions = (mode) => {
    captions = mode
    local.set('captions', mode)
    q('.c-cc').classList.toggle('on', mode !== 'off')
    q('.c-cc').title = CC_TITLE[mode]
    q('.c-cc').setAttribute('aria-label', CC_TITLE[mode])
    q('.cc-mode').textContent = mode === 'over' ? '▣' : mode === 'under' ? '▤' : ''
    q('.cc').hidden = mode !== 'over'
    q('.prompter').hidden = mode !== 'under'
    prompterIdx = -2
    paintTime()
  }
  const cycleCaptions = () => setCaptions(CC_MODES[(CC_MODES.indexOf(captions) + 1) % CC_MODES.length])
  const fullscreen = () => {
    if (document.fullscreenElement) return void document.exitFullscreen()
    if (deck.requestFullscreen) return void deck.requestFullscreen().catch(() => {})
    video.webkitEnterFullscreen?.()
  }

  q('.c-play').onclick = toggle
  q('.big-play').onclick = toggle
  video.addEventListener('click', toggle)
  q('.c-back').onclick = () => nudge(-SKIP)
  q('.c-fwd').onclick = () => nudge(SKIP)
  q('.c-speed').onclick = () => speed(0)
  q('.speed-menu').addEventListener('click', (e) => {
    const b = e.target.closest('[data-rate]')
    if (!b) return
    setRate(Number(b.dataset.rate))
    q('.speed-menu').hidden = true
  })
  const closeMenu = (e) => !e.target.closest('.speed-wrap') && (q('.speed-menu').hidden = true)
  document.addEventListener('pointerdown', closeMenu)
  q('.c-cc').onclick = cycleCaptions
  q('.c-vol').onclick = () => {
    video.muted = !video.muted
    q('.c-vol').innerHTML = video.muted ? icon.mute : icon.vol
  }
  q('.c-vol').addEventListener(
    'wheel',
    (e) => {
      e.preventDefault()
      video.volume = clamp(video.volume - Math.sign(e.deltaY) * 0.05, 0, 1)
      q('.c-vol').title = `Volume ${Math.round(video.volume * 100)}%`
    },
    { passive: false },
  )
  q('.c-rot').onclick = () => {
    rotation = (rotation + 90) % 360
    video.style.setProperty('--rot', `${rotation}deg`)
    video.classList.toggle('rotated', rotation % 180 !== 0)
  }
  q('.c-pip').hidden = !document.pictureInPictureEnabled
  q('.c-pip').onclick = () => (document.pictureInPictureElement ? document.exitPictureInPicture() : video.requestPictureInPicture?.().catch(() => {}))
  q('.c-full').onclick = fullscreen
  q('.resume')?.addEventListener('click', (e) => {
    seek(pos.t, true)
    e.currentTarget.remove()
  })
  setTimeout(() => q('.resume')?.classList.add('fade'), 9000)
  setCaptions(captions)
  setRate(rate)

  // scrubber: drag to seek, hover for a sprite thumbnail and the topic at that moment
  const tAt = (e) => {
    const r = q('.scrub-track').getBoundingClientRect()
    return clamp((e.clientX - r.left) / r.width, 0, 1) * dur
  }
  const tipFor = (e) => {
    const t = tAt(e)
    const tipEl = q('.scrub-tip')
    tipEl.hidden = false
    const r = scrub.getBoundingClientRect()
    const x = clamp(e.clientX - r.left, 80, r.width - 80)
    tipEl.style.left = `${x}px`
    tipEl.querySelector('b').textContent = fmtT(shown(t))
    const at = o.canSeek() ? o.toAxis(t) : null
    const topic = at != null ? o.topicAt(at) : null
    tipEl.querySelector('span').textContent = topic ? topic.title : ''
    const th = tipEl.querySelector('.scrub-thumb')
    const style = o.thumbStyle?.(t, 168)
    th.hidden = !style
    if (style) th.setAttribute('style', style)
  }
  scrub.addEventListener('pointerdown', (e) => {
    if (!v) return
    dragging = true
    scrub.setPointerCapture(e.pointerId)
    seek(tAt(e))
  })
  scrub.addEventListener('pointermove', (e) => {
    tipFor(e)
    if (dragging) seek(tAt(e))
  })
  scrub.addEventListener('pointerup', () => (dragging = false))
  scrub.addEventListener('pointerleave', () => !dragging && (q('.scrub-tip').hidden = true))
  scrub.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault()
      e.stopPropagation()
      nudge(e.key === 'ArrowLeft' ? -5 : 5)
    }
  })

  video.addEventListener('loadedmetadata', () => {
    dur = video.duration || dur
    video.playbackRate = rate
    q('.lcd-dur').textContent = fmtT(shown(dur))
    scrub.setAttribute('aria-valuemax', String(Math.floor(dur)))
    paintBands()
    if (o.startAt != null) {
      seek(o.startAt)
      o.startAt = null
    }
  })
  video.addEventListener('timeupdate', paintTime)
  video.addEventListener('seeking', paintTime)
  video.addEventListener('progress', paintBuffer)
  for (const ev of ['play', 'pause', 'ended', 'ratechange']) video.addEventListener(ev, paintState)
  video.addEventListener('play', () => {
    deck.classList.add('started')
    if (!meterRaf && !reducedMotion()) meter()
  })
  video.addEventListener('pause', () => local.set(`pos:${m.id}`, { t: video.currentTime, at: Date.now() }))
  video.addEventListener('error', () => {
    if (!v) return
    deck.classList.add('errored')
    q('.screen').insertAdjacentHTML('beforeend', `<div class="no-video"><p>This browser couldn't play <b>${esc(v.name)}</b>.</p><p>Try another copy under Files, or download it.</p></div>`)
  })

  // t: where to pick up in the new copy (null starts it from the top)
  function setVariant(next, t = null) {
    const wasPlaying = !video.paused
    v = next
    deck.classList.remove('errored')
    deck.querySelector('.no-video')?.remove()
    q('.c-rot').hidden = !v?.probe?.rotation
    video.src = v.url
    dur = v.probe?.duration ?? dur
    video.addEventListener(
      'loadedmetadata',
      () => {
        if (t != null) video.currentTime = clamp(t, 0, video.duration || t)
        if (wasPlaying) void video.play().catch(() => {})
      },
      { once: true },
    )
  }
  q('.c-rot').hidden = !v?.probe?.rotation
  paintState()
  paintTime()

  return {
    el: deck,
    video,
    seek,
    toggle,
    nudge,
    speed,
    fullscreen,
    setCaptions: cycleCaptions,
    mute: () => q('.c-vol').click(),
    setVariant,
    get variant() {
      return v
    },
    get time() {
      return video.currentTime || 0
    },
    get playing() {
      return !video.paused
    },
    setBands(bands) {
      o.bands = bands
      paintBands()
    },
    setMarks(times) {
      q('.scrub-marks').innerHTML = dur ? times.filter((t) => t >= 0 && t <= dur).map((t) => `<i style="left:${(t / dur) * 100}%"></i>`).join('') : ''
    },
    refresh: paintTime,
    destroy() {
      document.removeEventListener('pointerdown', closeMenu)
      cancelAnimationFrame(meterRaf)
      if (video.currentTime > 5) local.set(`pos:${m.id}`, { t: video.currentTime, at: Date.now() })
      video.pause()
      video.removeAttribute('src')
      video.load()
      audio?.ctx.close()
    },
  }
}
