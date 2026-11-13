// Two kinds of topics computed from text alone:
//   threads   names and acronyms that keep coming up across meetings ("Widget Flows", "Acme", "SOC 2")
//   chapters  a rough topic split of one transcript, for meetings that don't have reviewed notes yet
import type { Segment } from './transcripts.ts'

export const STOPWORDS = new Set(
  `a about above after again against all also am an and any are as at be because been before being below between both but by
  can could did do does doing down during each few for from further had has have having he her here hers him his how i if in into
  is it its itself just me more most my no nor not now of off on once only or other our ours out over own same she should so some
  such than that the their theirs them then there these they this those through to too under until up very was we were what when
  where which while who whom why will with would you your yours yeah yes okay ok oh um uh like know think mean kind sort thing
  things really actually basically pretty right gonna wanna gotta lot going get got go goes want say said says see thats dont
  im youre theyre were weve ive id ill well cool good great sure just maybe something anything everything stuff guys way probably
  little bit much many one two three also even still back make made let lets need needs come came take look looking talk talking
  i'm don't that's it's you're they're we're can't won't didn't doesn't isn't there's what's let's i've i'll we'll you'll
  hmm mm alright anyway kinda sorta totally definitely exactly literally honestly obviously absolutely`.split(/\s+/),
)

const GENERIC = new Set(
  `I A An The This That These Those No Not If When Where What Why How It Its They We You He She Our Their There Here Some All Any Each
  Both Either Neither One Two Three Monday Tuesday Wednesday Thursday Friday Saturday Sunday January February March April May June
  July August September October November December AM PM UTC GMT Recording Notes Participants Timestamps Source Transcript Meeting
  Machine Prepared Speaker Unknown Team Teams All Action Items Summary Separate Internal OK Okay Yes Screen Uncertainties
  Recommended Related Local Primary Cross-check Users`.split(/\s+/),
)

export type Thread = { term: string; meetings: { id: string; count: number }[]; total: number }

type TextOf = { id: string; notes: string; transcript: string }

// Capitalised phrases and acronyms in the notes, counted overall and mid-sentence. A word only ever
// capitalised at the start of a sentence ("Obtain", "Assess") is an ordinary word, not a name.
function candidates(notes: string): Map<string, { n: number; mid: number }> {
  const out = new Map<string, { n: number; mid: number }>()
  const text = notes.replace(/"[^"\n]*\.(?:txt|mp4|json|mov)"|(?:^|\s)\/\S+/g, ' ')
  for (const sentence of text.split(/(?<=[.!?:;])\s+|\n+|\s+-\s+/)) {
    const tokens = sentence.match(/[\p{L}\p{N}][\p{L}\p{N}'’&-]*/gu) ?? []
    for (let i = 0; i < tokens.length; i++) {
      const at = i
      const t = tokens[i].replace(/['’]s$/, '')
      if (!/^\p{Lu}/u.test(t) || GENERIC.has(t)) continue
      const phrase = [t]
      while (i + 1 < tokens.length && phrase.length < 3 && /^\p{Lu}/u.test(tokens[i + 1]) && !GENERIC.has(tokens[i + 1])) {
        phrase.push(tokens[++i].replace(/['’]s$/, ''))
      }
      // "SOC 2": an acronym followed by a number belongs together
      if (i + 1 < tokens.length && /^[A-Z]{2,}$/.test(t) && /^\d$/.test(tokens[i + 1])) phrase.push(tokens[++i])
      // "APIs" and "SDKs" count toward "API" and "SDK"
      const term = phrase.join(' ').replace(/^([A-Z]{2,})s$/, '$1')
      const c = out.get(term) ?? { n: 0, mid: 0 }
      c.n++
      if (at > 0) c.mid++
      out.set(term, c)
    }
  }
  return out
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const isAcronym = (term: string) => /^[A-Z][A-Z0-9 ]+$/.test(term)

// Acronyms match case-sensitively ("IT" is not "it") and take a plural ("APIs"); names ignore case,
// since transcripts write "widget flows" as often as "Widget Flows".
export function termPattern(term: string): RegExp {
  const body = escapeRe(term) + (isAcronym(term) ? 's?' : '')
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, isAcronym(term) ? 'gu' : 'giu')
}

export function countMentions(term: string, text: string): number {
  return text.match(termPattern(term))?.length ?? 0
}

export function findThreads(texts: TextOf[], personWords: Set<string>, limit = 24): Thread[] {
  const df = new Map<string, Set<string>>()
  const notesCount = new Map<string, number>()
  const midCount = new Map<string, number>()
  for (const t of texts) {
    for (const [term, c] of candidates(t.notes)) {
      if (term.split(/[\s/]+/).some((w) => personWords.has(w.toLowerCase()))) continue
      if (!df.has(term)) df.set(term, new Set())
      df.get(term)!.add(t.id)
      notesCount.set(term, (notesCount.get(term) ?? 0) + c.n)
      midCount.set(term, (midCount.get(term) ?? 0) + c.mid)
    }
  }
  const allText = texts.map((t) => `${t.notes}\n${t.transcript}`).join('\n')
  const lowercase = (w: string) => allText.match(new RegExp(`(?<![\\p{L}])${escapeRe(w)}(?![\\p{L}])`, 'gu'))?.length ?? 0
  const threads: (Thread & { score: number })[] = []
  for (const [term, ids] of df) {
    const special = /^[A-Z0-9 ]{2,}$|[a-z][A-Z]/.test(term) // acronym or CamelCase
    if (!special && !midCount.get(term)) continue
    // a single word people also write in lowercase is an ordinary word ("Widget" vs "widget")
    if (!special && !term.includes(' ') && lowercase(term.toLowerCase()) > (notesCount.get(term) ?? 0) / 2) continue
    if (ids.size < 2 && (notesCount.get(term) ?? 0) < 3) continue
    const meetings = texts
      .map((t) => ({ id: t.id, count: countMentions(term, t.notes) + countMentions(term, t.transcript) }))
      .filter((m) => m.count > 0)
    const total = meetings.reduce((n, m) => n + m.count, 0)
    threads.push({ term, meetings, total, score: meetings.length * 2 + Math.log2(1 + total) })
  }
  // drop a phrase swallowed by a longer one with the same reach ("Widget" inside "Widget Flows")
  const kept = threads
    .sort((a, b) => b.score - a.score)
    .filter((t, _, all) => !all.some((o) => o !== t && o.term.includes(t.term) && o.meetings.length >= t.meetings.length && o.total >= t.total * 0.8))
  return kept.slice(0, limit).map(({ score: _, ...t }) => t)
}

export type Chapter = { start: number; end: number; label: string; terms: string[] }

const stem = (w: string) => w.replace(/(ing|ed|es|s)$/, '')

// TextTiling-lite: bag-of-words blocks, cosine similarity across each gap, cut at the deepest valleys.
export function autoChapters(segments: Segment[], idf: Map<string, number>, minLength = 150): Chapter[] {
  const speech = segments.filter((s) => !s.q)
  if (!speech.length) return []
  const start = speech[0].s
  const end = speech[speech.length - 1].e
  const blockLen = 45
  // one block per 45 s: a span of more than a day is a broken file, not a meeting
  if (!(end - start <= 86_400)) return []
  const blocks: Map<string, number>[] = []
  const surface = new Map<string, Map<string, number>>()
  for (const seg of speech) {
    const b = Math.floor((seg.s - start) / blockLen)
    if (!(b >= 0)) continue
    while (blocks.length <= b) blocks.push(new Map())
    for (const raw of seg.t.toLowerCase().match(/[\p{L}][\p{L}'’]+/gu) ?? []) {
      if (raw.length < 3 || STOPWORDS.has(raw)) continue
      const k = stem(raw)
      blocks[b].set(k, (blocks[b].get(k) ?? 0) + 1)
      const forms = surface.get(k) ?? new Map<string, number>()
      forms.set(raw, (forms.get(raw) ?? 0) + 1)
      surface.set(k, forms)
    }
  }
  if (blocks.length < 4) return [{ start, end, label: labelFor(blocks, surface, idf), terms: [] }]

  const window = (from: number, to: number) => {
    const v = new Map<string, number>()
    for (let i = Math.max(0, from); i < Math.min(blocks.length, to); i++) for (const [k, n] of blocks[i]) v.set(k, (v.get(k) ?? 0) + n * (idf.get(k) ?? 1))
    return v
  }
  const cos = (a: Map<string, number>, b: Map<string, number>) => {
    let dot = 0
    let na = 0
    let nb = 0
    for (const [k, x] of a) {
      na += x * x
      dot += x * (b.get(k) ?? 0)
    }
    for (const x of b.values()) nb += x * x
    return na && nb ? dot / Math.sqrt(na * nb) : 0
  }
  const k = 3
  const sims: number[] = []
  for (let g = 1; g < blocks.length; g++) sims.push(cos(window(g - k, g), window(g, g + k)))
  const depth = sims.map((s, i) => {
    let l = s
    for (let j = i; j >= 0 && sims[j] >= l; j--) l = sims[j]
    let r = s
    for (let j = i; j < sims.length && sims[j] >= r; j++) r = sims[j]
    return l - s + (r - s)
  })
  const mean = depth.reduce((a, b) => a + b, 0) / depth.length
  const sd = Math.sqrt(depth.reduce((a, b) => a + (b - mean) ** 2, 0) / depth.length)
  const minBlocks = Math.ceil(minLength / blockLen)
  const cuts: number[] = []
  for (const g of depth.map((d, i) => ({ d, gap: i + 1 })).sort((a, b) => b.d - a.d)) {
    if (g.d < mean + sd / 2) break
    if (cuts.every((c) => Math.abs(c - g.gap) >= minBlocks) && g.gap >= minBlocks && blocks.length - g.gap >= minBlocks) cuts.push(g.gap)
  }
  cuts.sort((a, b) => a - b)
  const edges = [0, ...cuts, blocks.length]
  const chapters: Chapter[] = []
  for (let i = 0; i + 1 < edges.length; i++) {
    const slice = blocks.slice(edges[i], edges[i + 1])
    const terms = topTerms(slice, surface, idf, 3)
    chapters.push({
      start: start + edges[i] * blockLen,
      end: Math.min(end, start + edges[i + 1] * blockLen),
      label: terms.join(' · ') || 'chatter',
      terms,
    })
  }
  return chapters
}

function topTerms(blocks: Map<string, number>[], surface: Map<string, Map<string, number>>, idf: Map<string, number>, n: number) {
  const tf = new Map<string, number>()
  for (const b of blocks) for (const [k, c] of b) tf.set(k, (tf.get(k) ?? 0) + c)
  return [...tf.entries()]
    .filter(([, c]) => c >= 2)
    .map(([k, c]) => ({ k, score: c * (idf.get(k) ?? 1) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, n)
    .map(({ k }) => [...(surface.get(k) ?? new Map([[k, 1]])).entries()].sort((a, b) => b[1] - a[1])[0][0])
}

const labelFor = (blocks: Map<string, number>[], surface: Map<string, Map<string, number>>, idf: Map<string, number>) =>
  topTerms(blocks, surface, idf, 3).join(' · ') || 'chatter'

// Inverse document frequency over 45-second blocks of every transcript, so chapter labels favour distinctive words.
export function blockIdf(transcripts: Segment[][]): Map<string, number> {
  const df = new Map<string, number>()
  let n = 0
  for (const segs of transcripts) {
    const blocks = new Map<number, Set<string>>()
    for (const seg of segs) {
      if (seg.q) continue
      const b = Math.floor(seg.s / 45)
      const set = blocks.get(b) ?? new Set<string>()
      for (const raw of seg.t.toLowerCase().match(/[\p{L}][\p{L}'’]+/gu) ?? []) if (raw.length >= 3 && !STOPWORDS.has(raw)) set.add(stem(raw))
      blocks.set(b, set)
    }
    for (const set of blocks.values()) {
      n++
      for (const k of set) df.set(k, (df.get(k) ?? 0) + 1)
    }
  }
  const idf = new Map<string, number>()
  for (const [k, d] of df) idf.set(k, Math.log((n + 1) / (d + 0.5)))
  return idf
}
