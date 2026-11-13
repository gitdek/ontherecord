// The topic river: every discussion topic from the notes gets a lane along the meeting's timeline, grouped
// by the notes' sections, under a strip of talk density and a film strip of the video's average colours.
// Phases shade the background, action items plant flags, and a playhead follows the video.
import { clamp, esc, fmtT, rangeText, topicColor } from './util.js'

const AXIS = 36
const PULSE = 44
const STRIP = 16
const GROUP = 24
const LANE = 24
const FLAGS = 30

export function createRiver(host, o) {
  let W = 0
  let G = 0
  let H = 0
  let X = (t) => t
  let Tof = (x) => x
  let now = null
  let hits = []
  let active = ''
  let drawn = false

  host.classList.add('river')
  host.innerHTML = '<svg class="river-svg" role="img" aria-label="Topic timeline"></svg><div class="river-tip" hidden></div>'
  const svg = host.querySelector('svg')
  const tip = host.querySelector('.river-tip')

  const [a, b] = o.axis
  const span = Math.max(1, b - a)
  const topics = o.topics ?? []
  const autoOnly = topics.length > 0 && topics.every((t) => t.auto)
  const groups = []
  for (const t of topics) {
    const g = autoOnly ? 'Auto-detected chapters (no notes yet)' : t.group
    let grp = groups.find((x) => x.name === g)
    if (!grp) groups.push((grp = { name: g, topics: [] }))
    grp.topics.push(t)
  }

  // talk density from the transcript itself, finer than the summary's 96 bins
  function density(bins) {
    const out = new Array(bins).fill(0)
    const w = span / bins
    for (const s of o.segments ?? []) {
      if (s.q || s.e < a || s.s > b) continue
      const n = s.t.split(/\s+/).length
      const i0 = clamp(Math.floor((s.s - a) / w), 0, bins - 1)
      const i1 = clamp(Math.floor((Math.max(s.s, s.e - 0.01) - a) / w), 0, bins - 1)
      for (let i = i0; i <= i1; i++) out[i] += n / (i1 - i0 + 1)
    }
    const sm = out.map((v, i) => (out[i - 1] ?? v) * 0.25 + v * 0.5 + (out[i + 1] ?? v) * 0.25)
    const max = Math.max(1, ...sm)
    return sm.map((v) => v / max)
  }

  function ticks() {
    const steps = [30, 60, 120, 300, 600, 900, 1200, 1800, 3600]
    const room = (W - G - 16) / 74
    const step = steps.find((s) => span / s <= room) ?? 3600
    const out = []
    for (let t = Math.ceil(a / step) * step; t <= b; t += step) out.push(t)
    return out
  }

  function draw() {
    W = host.clientWidth
    if (!W) return
    const compact = W < 640
    G = compact ? 112 : clamp(W * 0.26, 170, 260)
    const R = 14
    X = (t) => G + ((t - a) / span) * (W - G - R)
    Tof = (x) => a + ((x - G) / (W - G - R)) * span
    const chars = Math.floor((G - 40) / (compact ? 5.9 : 6.5))
    const cut = (s) => (s.length > chars ? `${s.slice(0, chars - 1).trimEnd()}…` : s)

    let y = AXIS
    const parts = []
    const label = (text, yy, cls = '') => `<text class="row-label ${cls}" x="14" y="${yy}">${esc(text)}</text>`

    // talk density
    const bins = Math.max(24, Math.floor((W - G - R) / 5))
    const dens = density(bins)
    const base = y + PULSE - 4
    let d = `M${X(a)} ${base}`
    dens.forEach((v, i) => {
      const t = a + ((i + 0.5) / bins) * span
      d += ` L${X(t).toFixed(1)} ${(base - v * (PULSE - 10)).toFixed(1)}`
    })
    d += ` L${X(b)} ${base} Z`
    parts.push(`<g class="r-pulse">${label('Talk', y + PULSE / 2 + 4)}<path d="${d}" class="pulse-area"/><path d="${d.replace(/ L[\d.]+ [\d.]+ Z$/, '')}" class="pulse-line"/><g class="hits"></g></g>`)
    const pulseY = y
    y += PULSE

    // film strip: average colour of each sampled frame
    if (o.strip?.colors?.length && o.stripAt) {
      const cells = o.strip.colors
        .map((c, i) => {
          const t0 = o.stripAt(i)
          const t1 = o.stripAt(i + 1)
          if (t1 < a || t0 > b) return ''
          const x0 = X(clamp(t0, a, b))
          return `<rect x="${x0.toFixed(1)}" y="${y + 1}" width="${Math.max(0.6, X(clamp(t1, a, b)) - x0 + 0.4).toFixed(1)}" height="${STRIP - 3}" fill="${c}"/>`
        })
        .join('')
      parts.push(`<g class="r-strip">${label('Screen', y + 12)}${cells}</g>`)
      y += STRIP + 4
    }
    const contentTop = y

    // topic lanes, grouped by the notes' sections
    let k = 0
    const lanes = []
    for (const g of groups) {
      parts.push(`<g class="r-group"><line x1="14" x2="${W - R}" y1="${y + GROUP - 3}" y2="${y + GROUP - 3}" class="group-rule"/><text class="group-label" x="14" y="${y + 15}">${esc(g.name.toUpperCase())}</text></g>`)
      y += GROUP
      if (autoOnly) {
        const pills = g.topics
          .map((t) => {
            const [s, e] = t.ranges[0]
            const x0 = X(s)
            const w = Math.max(3, X(e) - x0 - 2)
            const text = w > 70 ? `<text class="pill-text" x="${(x0 + 8).toFixed(1)}" y="${y + LANE / 2 + 4}">${esc(t.title.slice(0, Math.floor(w / 6.4)))}</text>` : ''
            return `<g class="pill-g" data-k="${esc(t.key)}"><rect class="pill" data-k="${esc(t.key)}" data-r="0" x="${x0.toFixed(1)}" y="${y + 4}" width="${w.toFixed(1)}" height="${LANE - 8}" rx="${(LANE - 8) / 2}" fill="${topicColor(t.color)}" style="--i:${k++}"/>${text}</g>`
          })
          .join('')
        parts.push(`<g class="lane" data-k="auto">${label('Chapters', y + LANE / 2 + 4)}${pills}</g>`)
        y += LANE
        continue
      }
      for (const t of g.topics) {
        const c = topicColor(t.color)
        const pills = t.ranges
          .map(([s, e], r) => {
            const x0 = X(clamp(s, a, b))
            const w = Math.max(4, X(clamp(e, a, b)) - x0)
            return `<rect class="pill" data-k="${esc(t.key)}" data-r="${r}" x="${x0.toFixed(1)}" y="${y + 5}" width="${w.toFixed(1)}" height="${LANE - 10}" rx="${(LANE - 10) / 2}" fill="${c}" style="--i:${k++}"/>`
          })
          .join('')
        parts.push(`<g class="lane" data-k="${esc(t.key)}" style="--c:${c}">
          <rect class="lane-hl" x="0" y="${y}" width="${W}" height="${LANE}"/>
          <circle cx="22" cy="${y + LANE / 2}" r="8.5" fill="${c}" class="lane-dot"/>
          <text class="lane-num" x="22" y="${y + LANE / 2 + 3.6}" text-anchor="middle">${t.n ?? '•'}</text>
          <text class="lane-label" x="38" y="${y + LANE / 2 + 4}" data-k="${esc(t.key)}">${esc(cut(t.title))}<title>${esc(t.title)}</title></text>
          ${pills}</g>`)
        lanes.push(t.key)
        y += LANE
      }
    }

    // action items as flags where they were agreed
    if (o.actions?.length) {
      y += 4
      const flags = o.actions
        .filter((x) => x.ranges?.length)
        .map((x) => {
          const t = clamp(x.ranges[0][0], a, b)
          return `<g class="flag ${x.lane} ${x.done ? 'done' : x.canceled ? 'canceled' : ''}" data-a="${esc(x.id)}" transform="translate(${X(t).toFixed(1)} ${y + 4})"><line x1="0" y1="0" x2="0" y2="20"/><path d="M0 1h11l-3.5 4.5L11 10H0z"/><rect x="-6" y="-2" width="20" height="24" fill="transparent"/></g>`
        })
        .join('')
      parts.push(`<g class="r-flags">${label('Actions', y + 16)}${flags}</g>`)
      y += FLAGS
    }
    H = y + 8

    // phases shade everything below the axis
    const phases = (o.phases ?? [])
      .map((p, i) => {
        const x0 = X(clamp(p.start, a, b))
        const x1 = X(clamp(p.end, a, b))
        return `<rect class="phase ${i % 2 ? 'odd' : ''}" x="${x0.toFixed(1)}" y="${AXIS - 4}" width="${Math.max(1, x1 - x0).toFixed(1)}" height="${H - AXIS}"/><text class="phase-label" x="${(x0 + 6).toFixed(1)}" y="${AXIS - 9}">${esc(p.label)}</text>`
      })
      .join('')

    const tickMarks = ticks()
      .map((t) => `<g class="tick"><line x1="${X(t).toFixed(1)}" x2="${X(t).toFixed(1)}" y1="${AXIS - 4}" y2="${H}"/><text x="${X(t).toFixed(1)}" y="12" text-anchor="middle">${fmtT(t, o.base).replace(/:00$/, o.base === 'clock' ? '' : ':00')}</text></g>`)
      .join('')

    svg.setAttribute('viewBox', `0 0 ${W} ${H}`)
    svg.setAttribute('height', H)
    svg.innerHTML = `
      <rect class="plot-bg" x="${G}" y="${AXIS - 4}" width="${W - G - R}" height="${H - AXIS}" rx="8"/>
      ${phases}${tickMarks}
      <rect class="hit-area" x="${G}" y="0" width="${W - G - R}" height="${H}"/>
      ${parts.join('')}
      <g class="hover-x" visibility="hidden"><line y1="${AXIS - 4}" y2="${H}"/></g>
      <g class="playhead" visibility="hidden"><line y1="${AXIS - 6}" y2="${H}"/><circle cy="${AXIS - 6}" r="4.5"/></g>`
    svg.dataset.pulseY = pulseY
    svg.dataset.contentTop = contentTop
    if (!drawn) host.classList.add('enter')
    drawn = true
    paintHits()
    if (now != null) setTime(now, true)
  }

  function paintHits() {
    const g = svg.querySelector('.hits')
    if (!g) return
    const y = Number(svg.dataset.pulseY)
    g.innerHTML = hits
      .filter((t) => t >= a && t <= b)
      .map((t) => `<line x1="${X(t).toFixed(1)}" x2="${X(t).toFixed(1)}" y1="${y + 2}" y2="${y + PULSE - 4}"/>`)
      .join('')
  }

  function topicsAt(t) {
    return topics.filter((x) => x.ranges.some(([s, e]) => t >= s && t <= e))
  }

  function setTime(t, force = false) {
    now = t
    const ph = svg.querySelector('.playhead')
    if (!ph) return
    if (t == null || t < a || t > b) {
      ph.setAttribute('visibility', 'hidden')
      return
    }
    ph.setAttribute('visibility', 'visible')
    ph.setAttribute('transform', `translate(${X(t).toFixed(1)} 0)`)
    const keys = topicsAt(t)
      .map((x) => x.key)
      .join(' ')
    if (keys !== active || force) {
      active = keys
      const on = new Set(keys.split(' '))
      for (const lane of svg.querySelectorAll('.lane')) lane.classList.toggle('on', on.has(lane.dataset.k))
      for (const p of svg.querySelectorAll('.pill')) {
        const [s, e] = topics.find((x) => x.key === p.dataset.k)?.ranges[Number(p.dataset.r)] ?? [0, 0]
        p.classList.toggle('now', t >= s && t <= e)
      }
    }
  }

  // ---------- pointer ----------

  const place = (e, html) => {
    tip.innerHTML = html
    tip.hidden = false
    const r = host.getBoundingClientRect()
    const x = e.clientX - r.left
    const y = e.clientY - r.top
    const w = tip.offsetWidth
    tip.style.left = `${clamp(x - w / 2, 4, r.width - w - 4)}px`
    const above = y - tip.offsetHeight - 14
    tip.style.top = `${above >= 4 ? above : y + 18}px`
  }

  function onMove(e) {
    const r = svg.getBoundingClientRect()
    const x = ((e.clientX - r.left) / r.width) * W
    const hover = svg.querySelector('.hover-x')
    const pill = e.target.closest('.pill, .pill-g')
    const flag = e.target.closest('.flag')
    if (x < G || x > W - 14) {
      hover?.setAttribute('visibility', 'hidden')
      if (!pill && !flag) tip.hidden = true
      return
    }
    const t = Tof(x)
    hover?.setAttribute('visibility', 'visible')
    hover?.setAttribute('transform', `translate(${x.toFixed(1)} 0)`)
    if (flag) {
      const act = o.actions.find((z) => z.id === flag.dataset.a)
      if (act)
        return place(
          e,
          `<b class="tip-k">${act.lane === 'us' ? 'On us' : 'On them'} · ${esc(rangeText(act.ranges[0], o.base))}</b><p><b>${esc(act.owner || 'Unassigned')}:</b> ${esc(act.text)}</p>${act.done ? `<p class="tip-done">✓ done · ${esc(act.done.by)}</p>` : act.canceled ? `<p class="tip-canceled">✕ canceled · ${esc(act.canceled.by)}${act.canceled.reason ? `: ${esc(act.canceled.reason)}` : ''}</p>` : ''}`,
        )
    }
    if (pill) {
      const tp = topics.find((z) => z.key === pill.dataset.k)
      if (tp) {
        const rr = tp.ranges.map((x) => rangeText(x, o.base)).join(' · ')
        return place(
          e,
          `<b class="tip-k" style="color:${topicColor(tp.color)}">${tp.n ? `${tp.n} · ` : ''}${esc(tp.group)}</b><h4>${esc(tp.title)}</h4><p class="tip-t">${esc(rr)}</p>${(tp.bullets ?? [])
            .slice(0, 2)
            .map((bl) => `<p class="tip-b">${esc(bl.text.length > 150 ? `${bl.text.slice(0, 148)}…` : bl.text)}</p>`)
            .join('')}${o.thumb ? o.thumb(t) : ''}`,
        )
      }
    }
    const here = topicsAt(t)
    place(e, `${o.thumb ? o.thumb(t) : ''}<b class="tip-time">${fmtT(t, o.base)}</b>${here.map((z) => `<p class="tip-here" style="--c:${topicColor(z.color)}">${esc(z.title)}</p>`).join('')}`)
  }

  function onLeave() {
    svg.querySelector('.hover-x')?.setAttribute('visibility', 'hidden')
    tip.hidden = true
  }

  function onClick(e) {
    const flag = e.target.closest('.flag')
    if (flag) {
      const act = o.actions.find((z) => z.id === flag.dataset.a)
      if (act) o.onSeek(act.ranges[0][0], { action: act.id })
      return
    }
    const pill = e.target.closest('.pill')
    if (pill) {
      const tp = topics.find((z) => z.key === pill.dataset.k)
      if (tp) o.onSeek(tp.ranges[Number(pill.dataset.r)][0], { topic: tp.key })
      return
    }
    const label = e.target.closest('.lane-label, .lane-dot, .lane-num')
    if (label) {
      const tp = topics.find((z) => z.key === e.target.closest('.lane')?.dataset.k)
      if (tp) o.onSeek(tp.ranges[0][0], { topic: tp.key })
      return
    }
    const r = svg.getBoundingClientRect()
    const x = ((e.clientX - r.left) / r.width) * W
    if (x >= G && x <= W - 14) o.onSeek(clamp(Tof(x), a, b), {})
  }

  svg.addEventListener('pointermove', onMove)
  svg.addEventListener('pointerleave', onLeave)
  svg.addEventListener('click', onClick)
  let frame = 0
  const ro = new ResizeObserver(() => {
    cancelAnimationFrame(frame)
    frame = requestAnimationFrame(draw)
  })
  ro.observe(host)
  draw()

  return {
    setTime,
    setHits(times) {
      hits = times
      paintHits()
    },
    update(next) {
      Object.assign(o, next)
      draw()
    },
    topicsAt,
    destroy() {
      ro.disconnect()
      cancelAnimationFrame(frame)
    },
  }
}
