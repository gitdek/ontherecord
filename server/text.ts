// Small text helpers shared by the parsers: names, slugs, hashes and timestamps.
import { createHash } from 'node:crypto'

export type Range = [number, number]

// macOS puts a narrow no-break space before AM/PM in screen-recording names; notes type a plain one.
export const normName = (s: string) =>
  s.normalize('NFC').replace(/[    ]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase()

export const baseName = (path: string) => path.split('/').pop() ?? path

export const stripExt = (name: string) => name.replace(/\.[a-z0-9]{1,5}$/i, '')

export const slug = (s: string, max = 64) =>
  normName(s)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/, '')

// What sort of recording an entry is ("demo", "training", "site visit"): a short free label, read from the index or
// the notes. Lowercase words of letters, digits and hyphens, one space apart, at most 24 characters; undefined
// when nothing usable is left, so the caller falls back to the next source and in the end to "meeting".
export const KIND_MAX = 24
export function normKind(v: unknown): string | undefined {
  if (typeof v !== 'string') return
  const k = v
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N} -]+/gu, ' ')
    .replace(/(^|\s)-+|-+(?=\s|$)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, KIND_MAX)
    .replace(/[\s-]+$/, '')
  return k || undefined
}

export const shortHash = (s: string, len = 12) => createHash('sha1').update(s).digest('base64url').slice(0, len)

export const ISO_DATE = /\b(20\d\d)-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b/

// A date the way file names carry one: 2026-10-02, and 2026_10_02 or 2026.10.02 as exports and downloads write it.
export const NAME_DATE = /(?<!\d)(20\d\d)([-_.])(0[1-9]|1[0-2])\2(0[1-9]|[12]\d|3[01])(?!\d)/
export const nameDate = (name: string) => {
  const m = NAME_DATE.exec(name)
  return m ? `${m[1]}-${m[3]}-${m[4]}` : undefined
}

// The calendar day a moment falls on by this Mac's clock (in UTC an evening is already the next day).
export const localDay = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']

// "November 9, 2026" → "2026-11-09"
export function parseLongDate(s: string): string | undefined {
  const m = /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(20\d\d)\b/i.exec(s)
  if (!m) return
  const month = MONTHS.indexOf(m[1].toLowerCase()) + 1
  return `${m[3]}-${String(month).padStart(2, '0')}-${m[2].padStart(2, '0')}`
}

// "Screen Recording 2026-10-06 at 2.15.30 PM" → { date: '2026-10-06', seconds: 51330 }
export function recordingStamp(name: string): { date: string; seconds: number } | undefined {
  const m = /(20\d\d-\d\d-\d\d) at (\d{1,2})\.(\d\d)\.(\d\d) ?([AP]M)/i.exec(normName(name).toUpperCase())
  if (!m) return
  let h = Number(m[2]) % 12
  if (m[5] === 'PM') h += 12
  return { date: m[1], seconds: h * 3600 + Number(m[3]) * 60 + Number(m[4]) }
}

// One timestamp: "02:18", "1:02:03", "00:00:29.980". Two parts mean m:ss for recording offsets
// and h:mm for wall-clock notes ("12:59-13:39").
const TIME = String.raw`(\d{1,2}):(\d{2})(?::(\d{2}))?(?:[.,](\d{1,3}))?`
export const TIME_RANGE_RE = new RegExp(String.raw`(?<![\d:.])${TIME}(?:\s*[-–—]+\s*${TIME})?(?![\d:])`, 'g')

function toSeconds(a: string, b: string, c: string | undefined, frac: string | undefined, clock: boolean) {
  const f = frac ? Number(`0.${frac}`) : 0
  if (c !== undefined) return Number(a) * 3600 + Number(b) * 60 + Number(c) + f
  return clock ? Number(a) * 3600 + Number(b) * 60 : Number(a) * 60 + Number(b) + f
}

export function parseTime(s: string, clock = false): number | undefined {
  const m = new RegExp(`^${TIME}$`).exec(s.trim())
  return m ? toSeconds(m[1], m[2], m[3], m[4], clock) : undefined
}

// Every time or time range in a string, in seconds.
export function findRanges(text: string, clock = false): Range[] {
  const out: Range[] = []
  for (const m of text.matchAll(TIME_RANGE_RE)) {
    // a time followed by AM/PM is a wall-clock mention ("began approximately 11:00 AM"), not a timestamp
    if (/^\s*[AP]\.?M\b/i.test(text.slice(m.index + m[0].length))) continue
    const start = toSeconds(m[1], m[2], m[3], m[4], clock)
    const end = m[5] !== undefined ? toSeconds(m[5], m[6], m[7], m[8], clock) : start
    out.push(end >= start ? [start, end] : [start, start])
  }
  return out
}

export const words = (s: string) => s.match(/[\p{L}\p{N}'’]+/gu)?.length ?? 0

// ALL-CAPS headings in sentence case, borrowing the body's casing for names and acronyms:
// "SEPARATE ACME BILLING PLATFORM" → "Separate Acme billing platform",
// "WIDGET FLOWS / OPERATIONAL DEPENDENCIES" → "Widget Flows / operational dependencies".
export function prettyHeading(heading: string, body: string): string {
  const WORD = /\p{L}[\p{L}\p{M}\p{N}'’]*/gu
  const forms = new Map<string, Map<string, number>>()
  const tally = (key: string, form: string) => {
    const m = forms.get(key) ?? new Map<string, number>()
    m.set(form, (m.get(form) ?? 0) + 1)
    forms.set(key, m)
  }
  const bodyWords = body.match(WORD) ?? []
  for (const [i, w] of bodyWords.entries()) {
    tally(w.toLowerCase(), w)
    if (i > 0) tally(`${bodyWords[i - 1].toLowerCase()} ${w.toLowerCase()}`, `${bodyWords[i - 1]} ${w}`)
  }
  // a word ever written in lowercase is an ordinary word; otherwise use its most common written form
  const formOf = (key: string): string | undefined => {
    const m = forms.get(key)
    if (!m || m.has(key)) return
    return [...m.entries()].sort((a, b) => b[1] - a[1])[0][0]
  }

  const tokens = [...heading.matchAll(WORD)]
  const out = tokens.map((t) => t[0].toLowerCase())
  const fixed = out.map(() => false)
  for (let i = 0; i + 1 < tokens.length; i++) {
    const between = heading.slice(tokens[i].index + tokens[i][0].length, tokens[i + 1].index)
    if (!/^\s+$/.test(between)) continue
    const form = formOf(`${out[i]} ${out[i + 1]}`)
    if (form) [out[i], out[i + 1]] = form.split(' ')
    if (form) fixed[i] = fixed[i + 1] = true
  }
  for (let i = 0; i < out.length; i++) if (!fixed[i]) out[i] = formOf(out[i]) ?? out[i]
  if (out.length && out[0] === out[0].toLowerCase()) out[0] = out[0][0].toUpperCase() + out[0].slice(1)

  let k = 0
  return heading.replace(WORD, () => out[k++])
}

// A document cut into passages for search: its paragraphs, with a long one split at sentence ends near `max`
// words. A single sentence longer than that stays whole.
export function passagesOf(text: string, max = 120): string[] {
  const out: string[] = []
  for (const para of text.replace(/\r\n?/g, '\n').split(/\n\s*\n/)) {
    const p = para.replace(/\s+/g, ' ').trim()
    if (!p) continue
    if (words(p) <= max) {
      out.push(p)
      continue
    }
    let cur = ''
    for (const s of p.match(/[^.!?]+(?:[.!?]+|$)\s*/g) ?? [p]) {
      if (cur && words(cur + s) > max) {
        out.push(cur.trim())
        cur = ''
      }
      cur += s
    }
    if (cur.trim()) out.push(cur.trim())
  }
  return out.slice(0, 2000)
}

// A moment as people read it: 4:05 or 1:02:03 into a recording, 13:00:02 on a wall clock.
export const fmtTime = (sec: number, clock: boolean) => {
  const s = Math.max(0, Math.floor(sec))
  const h = Math.floor(s / 3600)
  const m = Math.floor(s / 60) % 60
  const ss = String(s % 60).padStart(2, '0')
  if (clock) return `${String(h % 24).padStart(2, '0')}:${String(m).padStart(2, '0')}:${ss}`
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}
