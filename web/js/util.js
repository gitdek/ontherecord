// Small DOM, formatting and time helpers shared by every view.

export const $ = (sel, root = document) => root.querySelector(sel)
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)]

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c])

// html`<p>${text}</p>` escapes what it interpolates; nested html`` and raw() pass through untouched
class Raw {
  constructor(s) {
    this.s = s
  }
  toString() {
    return this.s
  }
}
export const raw = (s) => new Raw(String(s))
const render = (v) => (v == null || v === false ? '' : v instanceof Raw ? v.s : Array.isArray(v) ? v.map(render).join('') : esc(v))
export function html(strings, ...vals) {
  let out = strings[0]
  for (let i = 0; i < vals.length; i++) out += render(vals[i]) + strings[i + 1]
  return new Raw(out)
}

// What sort of recording an entry is, as a small label ("Demo"); nothing for a meeting, which most entries are.
export const kindLabel = (kind) => (kind && kind !== 'meeting' ? html`<i class="chip kind" title="What sort of recording this is">${kind[0].toUpperCase() + kind.slice(1)}</i>` : '')

export function el(markup) {
  const t = document.createElement('template')
  t.innerHTML = String(markup).trim()
  return t.content.firstElementChild
}

export const pad = (n) => String(n).padStart(2, '0')
export const clamp = (x, a, b) => Math.min(b, Math.max(a, x))

// recording offsets as m:ss / h:mm:ss; wall-clock seconds-since-midnight as HH:MM:SS
export function fmtT(sec, base = 'offset') {
  if (sec == null || !Number.isFinite(sec)) return '–:––'
  sec = Math.max(0, sec)
  const h = Math.floor(sec / 3600)
  const m = Math.floor(sec / 60) % 60
  const s = Math.floor(sec % 60)
  if (base === 'clock') return `${pad(h % 24)}:${pad(m)}:${pad(s)}`
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

export function fmtDur(sec) {
  if (!sec) return '—'
  const m = Math.round(sec / 60)
  if (m < 60) return `${m} min`
  return `${Math.floor(m / 60)}h ${pad(m % 60)}m`
}

export const fmtHours = (sec) => (sec / 3600).toFixed(sec >= 36000 ? 0 : 1)

export function fmtBytes(n) {
  if (!n && n !== 0) return '—'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  while (n >= 1000 && i < u.length - 1) {
    n /= 1000
    i++
  }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}`
}

export const fmtNum = (n) => Math.round(n).toLocaleString()

const day = (iso) => new Date(`${iso}T12:00:00`)
export const fmtDate = (iso, o = { weekday: 'short', month: 'short', day: 'numeric' }) => day(iso).toLocaleDateString(undefined, o)
export const fmtLong = (iso) => day(iso).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })

export function relDay(iso) {
  const today = new Date()
  today.setHours(12, 0, 0, 0)
  const d = Math.round((today - day(iso)) / 86_400_000)
  if (d === 0) return 'today'
  if (d === 1) return 'yesterday'
  if (d > 1 && d < 7) return `${d} days ago`
  if (d >= 7 && d < 14) return 'last week'
  if (d >= 14 && d < 45) return `${Math.round(d / 7)} weeks ago`
  if (d >= 45) return `${Math.round(d / 30)} months ago`
  return 'upcoming'
}

export const fmtClockOfDay = (sec) => {
  if (sec == null) return ''
  const h = Math.floor(sec / 3600)
  const m = Math.floor(sec / 60) % 60
  return `${((h + 11) % 12) + 1}:${pad(m)} ${h >= 12 ? 'PM' : 'AM'}`
}

// the same timestamp grammar as the server: 3 parts are h:m:s; 2 parts are m:ss for offsets, h:mm on a clock
const TIME = String.raw`(\d{1,2}):(\d{2})(?::(\d{2}))?(?:[.,](\d{1,3}))?`
const RANGE = new RegExp(String.raw`(?<![\d:.])${TIME}(?:\s*[-–—]+\s*${TIME})?(?![\d:])(?!\s*[AP]\.?M\b)`, 'g')
const secs = (a, b, c, f, clock) =>
  c !== undefined ? +a * 3600 + +b * 60 + +c + (f ? +`0.${f}` : 0) : clock ? +a * 3600 + +b * 60 : +a * 60 + +b + (f ? +`0.${f}` : 0)

// Escape text and turn its timestamps into seek buttons.
export function linkTimes(text, base = 'offset') {
  const clock = base === 'clock'
  let out = ''
  let last = 0
  for (const m of String(text).matchAll(RANGE)) {
    out += esc(text.slice(last, m.index))
    const start = secs(m[1], m[2], m[3], m[4], clock)
    const end = m[5] !== undefined ? secs(m[5], m[6], m[7], m[8], clock) : start
    out += `<button type="button" class="ts" data-t="${start}" data-end="${end}">${esc(m[0])}</button>`
    last = m.index + m[0].length
  }
  return raw(out + esc(String(text).slice(last)))
}

export const rangeText = ([a, b], base) => (b > a ? `${fmtT(a, base)}–${fmtT(b, base)}` : fmtT(a, base))

export function debounce(fn, ms) {
  let t
  const later = (...args) => {
    clearTimeout(t)
    t = setTimeout(() => fn(...args), ms)
  }
  // drop a call that is still waiting
  later.cancel = () => clearTimeout(t)
  return later
}

// A burst of calls becomes one trailing call (at most maxWait later); every caller's promise settles with it.
export function coalesce(fn, ms = 300, maxWait = 2000) {
  let timer
  let waiting = []
  let first = 0
  return () =>
    new Promise((resolve, reject) => {
      if (!waiting.length) first = Date.now()
      waiting.push({ resolve, reject })
      clearTimeout(timer)
      timer = setTimeout(
        async () => {
          const batch = waiting
          waiting = []
          try {
            const v = await fn()
            for (const w of batch) w.resolve(v)
          } catch (err) {
            for (const w of batch) w.reject(err)
          }
        },
        Math.max(0, Math.min(ms, first + maxWait - Date.now())),
      )
    })
}

// decodeURIComponent that leaves a malformed escape as it is instead of throwing
export const decode = (s) => {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

export function hashStr(s) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

// mulberry32: the same seed always draws the same creature
export function seeded(seed) {
  let a = hashStr(String(seed))
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// localStorage that never throws (private windows, blocked storage). Several people can share one browser
// profile, so each key belongs to the person signed in ("@Ada/speed"); theme.js reads "viewer" to find theirs.
let mine = ''
export const local = {
  // Called once the server says who is signed in. What was saved before keys had an owner moves to the
  // first person to sign in here, once, so nobody loses their place or their settings.
  viewer(name) {
    if (!name) return
    mine = `@${name}/`
    try {
      localStorage.setItem('viewer', JSON.stringify(name))
      for (const k of Object.keys(localStorage)) {
        if (k === 'viewer' || k.startsWith('@')) continue
        if (localStorage.getItem(mine + k) == null) localStorage.setItem(mine + k, localStorage.getItem(k))
        localStorage.removeItem(k)
      }
    } catch {}
  },
  get(k, d) {
    try {
      const v = localStorage.getItem(mine + k)
      return v == null ? d : JSON.parse(v)
    } catch {
      return d
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(mine + k, JSON.stringify(v))
    } catch {}
  },
}

export const TOPIC = ['#ff6b3d', '#ffd447', '#36e2c4', '#59c8ff', '#9b87ff', '#ff5c9a', '#a5e65a', '#ff9f43', '#4ee1ff', '#e879f9']
export const topicColor = (i) => TOPIC[((i ?? 0) % TOPIC.length + TOPIC.length) % TOPIC.length]

export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches

export function greeting(name) {
  const h = new Date().getHours()
  const part = h < 5 ? 'Up late' : h < 12 ? 'Morning' : h < 17 ? 'Afternoon' : h < 22 ? 'Evening' : 'Up late'
  return `${part}, ${name}.`
}

export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

// first index whose segment ends after t (segments sorted by start)
export function segmentAt(segs, t) {
  let lo = 0
  let hi = segs.length - 1
  let ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (segs[mid].s <= t) {
      ans = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  return ans
}
