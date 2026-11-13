// Hand-rolled SVG: cassettes for meetings, blob creatures for people, gauges, pins and flags.
import { clamp, esc, fmtDate, seeded } from './util.js'

const svgId = (s) => String(s).replace(/[^a-z0-9]/gi, '')

function wrap(text, width, lines) {
  const words = String(text).split(/\s+/)
  const out = ['']
  for (const w of words) {
    const cur = out[out.length - 1]
    if ((cur + ' ' + w).trim().length <= width) out[out.length - 1] = (cur + ' ' + w).trim()
    else if (out.length < lines) out.push(w)
    else {
      out[out.length - 1] = `${cur.replace(/[\s,;:—-]+$/, '')}…`
      break
    }
  }
  return out
}

function hub(cx, cy, r) {
  let teeth = ''
  for (let i = 0; i < 6; i++) {
    const a = (i * Math.PI) / 3
    const x = cx + Math.cos(a) * (r - 2.2)
    const y = cy + Math.sin(a) * (r - 2.2)
    teeth += `<rect x="${(x - 1.3).toFixed(2)}" y="${(y - 1.3).toFixed(2)}" width="2.6" height="2.6" rx=".6" transform="rotate(${i * 60} ${x.toFixed(2)} ${y.toFixed(2)})"/>`
  }
  return `<g class="hub" style="transform-origin:${cx}px ${cy}px"><circle cx="${cx}" cy="${cy}" r="${r}" class="hub-ring"/><circle cx="${cx}" cy="${cy}" r="${r - 3.4}" class="hub-hole"/>${teeth}</g>`
}

// A cassette for a meeting. progress (0–1) winds tape from the left reel onto the right one.
export function cassette(m, { progress = 0 } = {}) {
  const id = `c${svgId(m.id)}`
  const h = m.hue ?? 20
  const [l1, l2 = ''] = wrap(m.title, 25, 2)
  const mins = Math.max(1, Math.round((m.duration || 0) / 60))
  const p = clamp(progress, 0, 1)
  const rl = 8 + 15 * (1 - p)
  const rr = 8 + 15 * p
  return `<svg class="cassette" viewBox="0 0 320 204" role="img" aria-label="${esc(m.title)}">
  <defs>
    <linearGradient id="${id}s" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="hsl(${h} 78% 60%)"/><stop offset="1" stop-color="hsl(${(h + 38) % 360} 72% 40%)"/>
    </linearGradient>
  </defs>
  <rect class="shell" x="4" y="4" width="312" height="196" rx="16" fill="url(#${id}s)"/>
  <rect x="4" y="4" width="312" height="196" rx="16" fill="url(#gloss)"/>
  <g class="screws">${[18, 302].flatMap((x) => [18, 186].map((y) => `<circle cx="${x}" cy="${y}" r="4.2"/><path d="M${x - 2.4} ${y}h4.8"/>`)).join('')}</g>
  <rect class="label" x="22" y="14" width="276" height="126" rx="9"/>
  <path d="M22 36v-13a9 9 0 0 1 9-9h258a9 9 0 0 1 9 9v13z" fill="hsl(${h} 68% 74%)"/>
  <text class="side-a" x="38" y="30.5">A</text>
  <text class="date" x="284" y="30" text-anchor="end">${esc(fmtDate(m.date, { month: 'short', day: 'numeric', year: 'numeric' }).toUpperCase())}</text>
  <path class="rule" d="M36 60h248M36 80h248"/>
  <text class="hand" x="38" y="56">${esc(l1)}</text>
  <text class="hand" x="38" y="76">${esc(l2)}</text>
  <rect class="window" x="78" y="90" width="164" height="42" rx="21"/>
  <circle class="tape-l" cx="120" cy="111" r="${rl.toFixed(1)}" fill="url(#tape)"/>
  <circle class="tape-r" cx="200" cy="111" r="${rr.toFixed(1)}" fill="url(#tape)"/>
  <path class="tape-run" d="M${(120 - rl * 0.2).toFixed(1)} ${(111 + rl).toFixed(1)} L160 129 L${(200 + rr * 0.2).toFixed(1)} ${(111 + rr).toFixed(1)}"/>
  ${hub(120, 111, 9.5)}${hub(200, 111, 9.5)}
  <rect x="78" y="90" width="164" height="42" rx="21" fill="url(#glass)" class="glass"/>
  <text class="len" x="29" y="119">C-${mins}</text>
  <text class="len" x="291" y="119" text-anchor="end">${m.has?.notes ? 'NOTES' : 'RAW'}</text>
  <path class="foot" d="M72 200 L88 156 H232 L248 200 Z"/>
  <g class="holes"><circle cx="112" cy="182" r="6"/><circle cx="208" cy="182" r="6"/><rect x="146" y="172" width="10" height="10" rx="2"/><rect x="164" y="172" width="10" height="10" rx="2"/></g>
</svg>`
}

// Catmull-Rom through jittered points on a circle: a soft, seeded blob outline.
function blobPath(rnd, cx, cy, r, n, jitter) {
  const pts = []
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2
    const rr = r * (1 - jitter / 2 + rnd() * jitter)
    pts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr * 1.04])
  }
  let d = `M${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n]
    const p1 = pts[i]
    const p2 = pts[(i + 1) % n]
    const p3 = pts[(i + 2) % n]
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6]
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6]
    d += ` C${c1[0].toFixed(1)} ${c1[1].toFixed(1)} ${c2[0].toFixed(1)} ${c2[1].toFixed(1)} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`
  }
  return `${d}Z`
}

// Every person is a little seeded creature whose eyes follow the pointer. Crew wear headphones.
export function avatar(p, { size = 40, title = true } = {}) {
  if (!p) return ''
  const rnd = seeded(p.id)
  const id = `a${svgId(p.id)}${Math.floor(rnd() * 1e6)}`
  const hue = p.hue ?? 200
  const d1 = blobPath(rnd, 50, 54, 34, 8, 0.2)
  const d2 = blobPath(rnd, 50, 54, 34, 8, 0.2)
  const eyeY = 48 + rnd() * 5
  const gap = 11 + rnd() * 4
  const er = 6.4 + rnd() * 2
  const mouthKind = Math.floor(rnd() * 4)
  const my = eyeY + 15 + rnd() * 3
  const mouth = [
    `<path class="mouth" d="M${50 - 7} ${my} Q50 ${my + 7} ${50 + 7} ${my}"/>`,
    `<ellipse class="mouth-o" cx="50" cy="${my + 2}" rx="3.4" ry="4"/>`,
    `<path class="mouth" d="M${50 - 6} ${my + 1} Q50 ${my + 4} ${50 + 6} ${my - 1}"/>`,
    `<path class="mouth" d="M${50 - 9} ${my - 1} Q50 ${my + 10} ${50 + 9} ${my - 1} Z" fill="#2a1a2e"/>`,
  ][mouthKind]
  const eye = (cx) => `
    <g class="eye"><ellipse cx="${cx.toFixed(1)}" cy="${eyeY.toFixed(1)}" rx="${er.toFixed(1)}" ry="${(er * 1.12).toFixed(1)}" fill="#fff"/>
    <circle class="pupil" cx="${cx.toFixed(1)}" cy="${eyeY.toFixed(1)}" r="${(er * 0.5).toFixed(1)}"/>
    <circle cx="${(cx + er * 0.18).toFixed(1)}" cy="${(eyeY - er * 0.3).toFixed(1)}" r="${(er * 0.16).toFixed(1)}" fill="#fff" class="glint"/>
    <ellipse class="lid" cx="${cx.toFixed(1)}" cy="${eyeY.toFixed(1)}" rx="${(er + 0.8).toFixed(1)}" ry="${(er * 1.12 + 0.8).toFixed(1)}" fill="hsl(${hue} 75% 58%)"/></g>`
  const phones = p.crew
    ? `<path class="phones-band" d="M18 50 C18 12 82 12 82 50"/><rect class="phones-cup" x="9" y="44" width="13" height="22" rx="6"/><rect class="phones-cup" x="78" y="44" width="13" height="22" rx="6"/>`
    : ''
  return `<svg class="blob" viewBox="0 0 100 100" width="${size}" height="${size}" style="--blink:${(rnd() * 6).toFixed(2)}s;--bob:${(rnd() * 3).toFixed(2)}s" data-person="${esc(p.id)}">
  ${title ? `<title>${esc(p.name)}${p.crew ? ' (crew)' : ''}</title>` : ''}
  <defs><radialGradient id="${id}" cx=".36" cy=".3" r=".85"><stop offset="0" stop-color="hsl(${hue} 92% 74%)"/><stop offset="1" stop-color="hsl(${(hue + 28) % 360} 70% 44%)"/></radialGradient></defs>
  <g class="body">
    <path d="${d1}" fill="url(#${id})"><animate attributeName="d" dur="${(5 + rnd() * 4).toFixed(1)}s" repeatCount="indefinite" values="${d1};${d2};${d1}" calcMode="spline" keySplines=".45 0 .55 1;.45 0 .55 1"/></path>
    <ellipse cx="${50 - gap - 6}" cy="${my - 2}" rx="5" ry="3" fill="#ff7a9a" opacity=".35"/><ellipse cx="${50 + gap + 6}" cy="${my - 2}" rx="5" ry="3" fill="#ff7a9a" opacity=".35"/>
    ${eye(50 - gap)}${eye(50 + gap)}${mouth}
  </g>
  ${phones}
</svg>`
}

export const initials = (name) =>
  String(name)
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase()

// Streaming weight: a needle over 0–8 Mbit/s. The reading sits under the dial as text, so it keeps its size
// however small the dial is drawn.
export function gauge(bitrate) {
  const mbps = (bitrate ?? 0) / 1e6
  const f = clamp(mbps / 8, 0, 1)
  const a = Math.PI * (1 - f)
  const x = 50 + Math.cos(a) * 34
  const y = 50 - Math.sin(a) * 34
  const label = mbps < 1.5 ? 'feather' : mbps < 3.5 ? 'light' : mbps < 6 ? 'hefty' : 'chonky'
  return `<svg class="gauge" viewBox="0 0 100 55" role="img" aria-label="${mbps.toFixed(1)} megabits per second, ${label}">
  <defs><linearGradient id="gg" x1="0" x2="1"><stop offset="0" stop-color="#36e2c4"/><stop offset=".5" stop-color="#ffd447"/><stop offset="1" stop-color="#ff5c5c"/></linearGradient></defs>
  <path d="M12 50 A38 38 0 0 1 88 50" class="gauge-track"/>
  <path d="M12 50 A38 38 0 0 1 88 50" stroke="url(#gg)" class="gauge-arc"/>
  <line x1="50" y1="50" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" class="gauge-needle"/>
  <circle cx="50" cy="50" r="4" class="gauge-pin"/>
</svg><span class="gauge-label" aria-hidden="true">${mbps.toFixed(1)} Mb/s<br />${label}</span>`
}

export const pin = (hue) =>
  `<svg class="pin" viewBox="0 0 24 30" aria-hidden="true"><ellipse cx="12" cy="27" rx="5" ry="1.6" fill="rgba(0,0,0,.35)"/><path d="M12 14 L12 27" stroke="#c9c2b5" stroke-width="1.6"/><circle cx="12" cy="9" r="7.5" fill="hsl(${hue} 80% 55%)"/><circle cx="9.5" cy="6.5" r="2.4" fill="#fff" opacity=".55"/></svg>`

export const icon = {
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6.5" y="5" width="4" height="14" rx="1"/><rect x="13.5" y="5" width="4" height="14" rx="1"/></svg>',
  back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 6 4 12l7 6zM20 6l-7 6 7 6z"/></svg>',
  fwd: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m13 6 7 6-7 6zM4 6l7 6-7 6z"/></svg>',
  cc: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="3" fill="none" stroke="currentColor" stroke-width="2"/><path d="M10.5 10.2a2.5 2.5 0 1 0 0 3.6M17 10.2a2.5 2.5 0 1 0 0 3.6" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>',
  vol: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  mute: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z"/><path d="m16 9 5 6m0-6-5 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  full: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  pip: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><rect x="12" y="11" width="7" height="6" rx="1"/></svg>',
  rotate: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.3-5.7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M20 4v5h-5z"/></svg>',
  download: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 19.5h14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  link: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  target: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="7.5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="2.6"/></svg>',
  up: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 15 6-6 6 6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  down: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
  check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  x: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>',
  arrow: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14m-5-5 5 5-5 5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
}

// Action-item furniture the board and the meeting page share: the checkbox (a fixed ✕ once the item is
// canceled; reopening happens on the board) and the rubber stamp on a finished or canceled item.
export const tick = (a) =>
  a.canceled
    ? `<span class="tick canceled" role="img" aria-label="Canceled" title="Canceled"><span class="box">${icon.x}</span></span>`
    : `<label class="tick"><input type="checkbox" ${a.done ? 'checked' : ''} aria-label="Done" /><span class="box">${icon.check}</span></label>`
const stampDay = (iso) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
export const stamp = (a) => {
  const mark = a.done ?? a.canceled
  if (!mark) return ''
  return `<span class="stamp${a.done ? '' : ' canceled'}"><b>${a.done ? 'DONE' : 'CANCELED'}</b> <span>${esc(mark.by)} · ${esc(stampDay(mark.at))}</span></span>`
}

// Shared pointer for every creature on screen: pupils lean toward it, a few at a time per frame.
let pointer = { x: innerWidth / 2, y: innerHeight / 3 }
let queued = false
export function trackEyes() {
  const update = () => {
    queued = false
    for (const svg of document.querySelectorAll('svg.blob')) {
      const r = svg.getBoundingClientRect()
      if (r.bottom < 0 || r.top > innerHeight) continue
      const dx = pointer.x - (r.left + r.width / 2)
      const dy = pointer.y - (r.top + r.height * 0.48)
      const d = Math.hypot(dx, dy) || 1
      const k = Math.min(1, d / 260) * 2.8
      svg.style.setProperty('--px', `${((dx / d) * k).toFixed(2)}px`)
      svg.style.setProperty('--py', `${((dy / d) * k).toFixed(2)}px`)
    }
  }
  addEventListener(
    'pointermove',
    (e) => {
      pointer = { x: e.clientX, y: e.clientY }
      if (!queued) {
        queued = true
        requestAnimationFrame(update)
      }
    },
    { passive: true },
  )
  addEventListener('scroll', () => !queued && ((queued = true), requestAnimationFrame(update)), { passive: true })
}
