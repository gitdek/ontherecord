// Full-text search over notes, action items, transcripts, the documents attached to meetings, the notebook
// and what the board says about each action item: an in-memory inverted index with BM25 ranking, light
// stemming, prefix matching while typing, typo tolerance and a few filters:
//   "exact phrase"  -exclude  person:ada  @grace  in:notes|transcript|actions|updates|docs|notebook|screen
//   after:2026-10-15  before:…  on:…  meeting:…  kind:demo  -kind:demo  status:open|on_hold|done|canceled  owner:ada
import { offsetIn, type Library, type Meeting } from './library.ts'
import { versionOf, type Note } from './notebook.ts'
import { sourceOf, sourceKey, sourceLink } from './retrieval-source.ts'
import { boardPassage, chunkKind, type Chunk } from './semantic.ts'
import { onHold, type ActionView } from './tasks.ts'
import { normKind, passagesOf } from './text.ts'
import { STOPWORDS } from './topics.ts'

// "kb" is a notebook entry (title or paragraph) saved by a person or an agent; "update" is something written
// on an action item after the meeting (why it was canceled, the evidence, what it waits on, a note)
export type Kind = 'meeting' | 'summary' | 'topic' | 'note' | 'action' | 'next' | 'caveat' | 'transcript' | 'doc' | 'kb' | 'update' | 'screen'
// which part of an item an update is
export type Part = 'reason' | 'evidence' | 'note' | 'hold' | 'checked'
const WEIGHT: Record<Kind, number> = { meeting: 3, topic: 2.2, summary: 1.8, action: 1.8, note: 1.4, next: 1.1, doc: 1, caveat: 0.8, transcript: 1, kb: 1.7, update: 1.6, screen: 1 }
const AREA: Record<string, Kind[]> = {
  notes: ['meeting', 'summary', 'topic', 'note', 'next', 'caveat'],
  note: ['meeting', 'summary', 'topic', 'note', 'next', 'caveat'],
  actions: ['action', 'update'],
  action: ['action', 'update'],
  todo: ['action', 'update'],
  board: ['action', 'update'],
  updates: ['update'],
  update: ['update'],
  transcript: ['transcript'],
  transcripts: ['transcript'],
  said: ['transcript'],
  docs: ['doc'],
  doc: ['doc'],
  documents: ['doc'],
  notebook: ['kb'],
  kb: ['kb'],
  screen: ['screen'],
}

type Doc = {
  meetingId: string
  kind: Kind
  text: string
  t?: number
  transcriptId?: string
  segIndex?: number
  section?: string
  topicKey?: string
  actionId?: string
  noteId?: string
  // an attached document's file id
  fileId?: string
  // from the board rather than the notes: an added task, corrected wording, or an update
  board?: true
  part?: Part
  // searchable but not shown: the notes section a line sits in, a notebook entry's tags
  extra?: string
  len: number
}

export type Hit = {
  meetingId: string
  kind: Kind
  text: string
  marks: [number, number][]
  t?: number
  videoId?: string
  transcriptId?: string
  segIndex?: number
  section?: string
  topicKey?: string
  actionId?: string
  noteId?: string
  noteTitle?: string
  fileId?: string
  board?: true
  part?: Part
  before?: string
  after?: string
  link?: string
  score: number
}

export type Results = {
  query: string
  total: number
  hits: Hit[]
  meetings: { id: string; count: number; best: number }[]
  terms: string[]
  fuzzy: Record<string, string[]>
  loose: boolean
  unknownPeople: string[]
  // names in person: that fit several people, with the person: form that names each one
  ambiguousPeople?: { name: string; ids: string[] }[]
  // filters that can't mean anything ("after:notadate", "status:maybe"): they match nothing, and say so
  badFilters: string[]
  notebookCount?: number
  boardCount?: number
}

const fold = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[’']/g, "'")
const TOKEN = /[\p{L}\p{N}]+(?:'[\p{L}]+)?/gu

export function stem(w: string): string {
  w = w.replace(/'s$/, '')
  if (w.length <= 3 || /^\d/.test(w)) return w
  if (w.endsWith('ies') && w.length > 4) return `${w.slice(0, -3)}y`
  if (w.endsWith('ing') && w.length > 5) return w.slice(0, -3)
  if (w.endsWith('ed') && w.length > 4) return w.slice(0, -2)
  if (w.endsWith('es') && /(ss|x|ch|sh)es$/.test(w)) return w.slice(0, -2)
  if (w.endsWith('s') && !w.endsWith('ss') && w.length > 3) return w.slice(0, -1)
  if (w.endsWith('ly') && w.length > 5) return w.slice(0, -2)
  return w
}

// Folding can change a text's length: "…" becomes "...", "ﬁ" becomes "fi", and an accent written as a mark of
// its own goes. For each character of the folded text, where the character of the original it came from starts
// and ends, so offsets point into the text as written. Nothing when the two line up, as plain ASCII does.
function origins(text: string, folded: string): { start: number[]; end: number[] } | undefined {
  if (!/[^\x00-\x7f]/.test(text)) return
  const start: number[] = []
  const end: number[] = []
  let at = 0
  for (const ch of text) {
    const width = ch < '\x80' ? 1 : fold(ch).length
    for (let i = 0; i < width; i++) {
      start.push(at)
      end.push(at + ch.length)
    }
    // a mark that folds away stays with the letter before it
    if (!width && end.length) end[end.length - 1] = at + ch.length
    at += ch.length
  }
  // folding goes character by character, so the lengths agree; if they ever didn't, the folded offsets stand
  return start.length === folded.length ? { start, end } : undefined
}

// The words of a text, folded and stemmed, with where each one is in the text as written.
export function tokenize(text: string): { stem: string; start: number; end: number }[] {
  const out: { stem: string; start: number; end: number }[] = []
  const folded = fold(text)
  const at = origins(text, folded)
  for (const m of folded.matchAll(TOKEN)) {
    const end = m.index + m[0].length
    out.push({ stem: stem(m[0]), start: at ? at.start[m.index] : m.index, end: at ? at.end[end - 1] : end })
  }
  return out
}

function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    let best = i
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
      best = Math.min(best, cur[j])
    }
    if (best > max) return max + 1
    prev = cur
  }
  return prev[b.length]
}

export class SearchIndex {
  private docs: Doc[] = []
  private postings = new Map<string, Map<number, number[]>>()
  private vocab: string[] = []
  private avgLen = 1
  private lib: Library
  private notes = new Map<string, Note>()
  private alias: (id: string) => string
  // The notebook and then the board sit at the end of the index, so a change to either swaps only that part
  // without reading the notes and transcripts again: where each starts, each [term, doc] the tail posted, and
  // the terms it brought.
  private tailStart = Infinity
  private boardStart = Infinity
  private tailRefs: [string, number][] = []
  private fresh = new Set<string>()
  private total = 0
  private board: ActionView[] = []
  private authoritativeBoard: boolean
  // what the board says about each item now, for status: and owner:
  private items = new Map<string, ActionView>()
  // transcript lines by place (transcript id # line), so a line can be read together with its neighbours
  private lines = new Map<string, number>()

  // `alias` gives the id an action item answers to on the board (a reworded item keeps its old one)
  constructor(lib: Library, notes: Note[] = [], board?: ActionView[], alias: (id: string) => string = (id) => id) {
    this.lib = lib
    this.alias = alias
    for (const m of lib.meetings) this.addMeeting(m)
    // a wall-clock transcript shared by two meetings: each line belongs to the meeting whose window is nearest
    const owners = new Map<string, Meeting[]>()
    for (const m of lib.meetings) for (const t of m.transcripts) owners.set(t.id, [...(owners.get(t.id) ?? []), m])
    for (const [id, ms] of owners) {
      const src = lib.transcripts.get(id)
      if (!src) continue
      for (const [i, seg] of src.parsed.segments.entries()) {
        if (seg.q) continue
        const owner =
          ms.length === 1
            ? ms[0]
            : ms.reduce((best, m) => (gap(m.axis, seg.s + offsetIn(m, id)) < gap(best.axis, seg.s + offsetIn(best, id)) ? m : best))
        // a meeting with two cuts of one recording only indexes the transcript it plays by default
        if (owner.primaryTranscript && owner.primaryTranscript !== id && owner.transcripts.length > 1) continue
        this.lines.set(`${id}#${i}`, this.docs.length)
        this.add({ meetingId: owner.id, kind: 'transcript', text: seg.t, t: seg.s + offsetIn(owner, id), transcriptId: id, segIndex: i, len: 0 })
      }
    }
    this.vocab = [...this.postings.keys()].sort()
    this.tailStart = this.docs.length
    this.authoritativeBoard = board !== undefined
    this.board = board ?? []
    this.setNotes(notes)
  }

  private add(doc: Doc) {
    const tokens = tokenize(doc.extra ? `${doc.text}\n${doc.extra}` : doc.text)
    doc.len = tokens.length
    this.total += doc.len
    const id = this.docs.push(doc) - 1
    const tail = id >= this.tailStart
    for (const [pos, tok] of tokens.entries()) {
      let p = this.postings.get(tok.stem)
      if (!p) {
        this.postings.set(tok.stem, (p = new Map()))
        if (tail) this.fresh.add(tok.stem)
      }
      const list = p.get(id)
      if (list) list.push(pos)
      else {
        p.set(id, [pos])
        if (tail) this.tailRefs.push([tok.stem, id])
      }
    }
  }

  // Drops every doc from `from` on, with what it posted. Returns the terms that left the index with them.
  private cut(from: number) {
    const gone = new Set<string>()
    const kept: [string, number][] = []
    for (const [term, id] of this.tailRefs) {
      if (id < from) {
        kept.push([term, id])
        continue
      }
      const p = this.postings.get(term)
      p?.delete(id)
      if (p && !p.size) {
        this.postings.delete(term)
        gone.add(term)
      }
    }
    this.tailRefs = kept
    for (let id = from; id < this.docs.length; id++) this.total -= this.docs[id].len
    this.docs.length = from
    this.fresh = new Set()
    return gone
  }

  // prefix and typo matching walk the sorted vocabulary, which only moves when the tail's words do
  private settle(gone: Set<string>) {
    if (gone.size !== this.fresh.size || [...gone].some((t) => !this.fresh.has(t))) this.vocab = [...this.postings.keys()].sort()
    this.avgLen = this.total / Math.max(1, this.docs.length)
  }

  // Replaces the notebook's part of the index (and the board's, which comes after it). Call it after every
  // notebook change.
  setNotes(notes: Note[]) {
    const gone = this.cut(this.tailStart)
    this.notes = new Map()
    for (const n of notes) this.addNote(n)
    this.boardStart = this.docs.length
    this.addBoard(this.board)
    this.settle(gone)
  }

  // Replaces everything indexed from the board: tasks added there, wording it corrected, and what people and
  // agents wrote on items since the meeting. Call it after every board change.
  setBoard(actions: ActionView[]) {
    // the notebook's new terms are already in the vocabulary; only the board's come and go here
    this.authoritativeBoard = true
    const gone = this.cut(this.boardStart)
    this.addBoard(actions)
    this.settle(gone)
  }

  private addBoard(actions: ActionView[]) {
    this.board = actions
    this.items = new Map(actions.map((a) => [a.id, a]))
    for (const a of actions) {
      const base = { meetingId: a.meeting?.id ?? '', actionId: a.id, board: true as const, len: 0 }
      // the notes' own line is indexed with its meeting; the board adds what only it knows
      if (a.source === 'added' || a.original) this.add({ ...base, kind: 'action', text: [a.owner, a.text].filter(Boolean).join(': '), t: a.ranges[0]?.[0] })
      const update = (part: Part, text?: string) => {
        if (text) this.add({ ...base, kind: 'update', part, text, section: a.text, extra: a.owner })
      }
      update('reason', a.canceled?.reason)
      update('evidence', (a.canceled ?? a.done)?.evidence)
      update('note', a.note?.text)
      update('hold', a.hold?.on)
      update('checked', a.checked?.text)
    }
  }

  private addMeeting(m: Meeting) {
    const base = { meetingId: m.id, len: 0 }
    this.add({ ...base, kind: 'meeting', text: [m.title, m.blurb].filter(Boolean).join(' — ') })
    // the meeting's other text files (an agenda, an excerpt), in passages, each linked to its file
    for (const f of m.docs) for (const text of passagesOf(this.lib.docText.get(f.id) ?? '')) this.add({ ...base, kind: 'doc', text, fileId: f.id, section: f.name })
    const n = m.notes
    if (!n) return
    for (const s of n.sections) {
      const kind: Kind = s.role === 'summary' ? 'summary' : s.role === 'actions' ? 'action' : s.role === 'next' ? 'next' : s.role === 'caveats' || s.role === 'source' ? 'caveat' : 'note'
      for (const b of s.blocks) {
        if (b.kind === 'item') {
          const topic = m.topics.find((t) => t.n === b.n)
          this.add({ ...base, kind: 'topic', text: b.title, t: b.ranges[0]?.[0], section: s.title, topicKey: topic?.key, extra: s.title })
          for (const l of b.bullets) this.add({ ...base, kind, text: l.text, t: l.ranges[0]?.[0] ?? b.ranges[0]?.[0], section: b.title, topicKey: topic?.key, extra: `${b.title} ${s.title}` })
        } else {
          // action bullets keep their "Owner: " prefix, so "grace send" finds "Grace: Send the bundle…"
          const action = kind === 'action' && b.kind === 'bullet' ? b.action : undefined
          this.add({ ...base, kind, text: b.text, t: b.ranges[0]?.[0], section: s.title, actionId: action ? this.alias(action) : undefined, extra: s.title })
        }
      }
    }
  }

  // A notebook entry: its title, then each paragraph, so a hit lands on the passage that matched.
  private addNote(n: Note) {
    this.notes.set(n.id, n)
    const base = { meetingId: '', noteId: n.id, len: 0 }
    this.add({ ...base, kind: 'kb', text: n.title, extra: n.tags.join(' ') })
    const paras = n.body.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).slice(0, 400)
    for (const p of paras) this.add({ ...base, kind: 'kb', text: p, section: n.title })
  }

  // `plain` reads the text as words only (see plainQuery), for text that was never written as a query.
  prepare(input: string | PreparedQuery, scope: { kinds?: Kind[]; meetingIds?: string[]; plain?: boolean } = {}): PreparedQuery {
    const raw = typeof input === 'string' ? input : input.raw
    let q = typeof input === 'string' ? (scope.plain ? plainQuery(input) : parseQuery(input)) : input.q
    // a kind no entry has can't mean anything here, like status:maybe; "meeting" always can
    if (typeof input === 'string') {
      const known = new Set(['meeting', ...this.lib.meetings.map((m) => kindKey(m.kind))])
      const unknown = [...q.kinds.map((k) => `kind:${k}`), ...q.notKinds.map((k) => `-kind:${k}`)].filter((f) => !known.has(f.slice(f.indexOf(':') + 1)))
      if (unknown.length) q = { ...q, bad: [...q.bad, ...unknown] }
    }
    // each name in person: is one or more people, each of them written one or more ways in the notes
    const named = q.people.map((p) => this.lib.people.named(p))
    const people = named.map(({ ids }) => ids)
    const unknownPeople = q.people.filter((_, i) => !named[i].ids.length && !named[i].ambiguous.length)
    const ambiguousPeople = named.flatMap(({ ambiguous }) => ambiguous)
    const owners = q.owners.map((o) => ({ ids: this.lib.people.mentioned(o), name: o.toLowerCase() }))
    const items = q.status.length > 0 || owners.length > 0
    const areas = q.areas.length ? new Set(q.areas.flatMap((a) => AREA[a])) : undefined
    const kinds = scope.kinds ? new Set(scope.kinds) : undefined
    const meetings = scope.meetingIds ? new Set(scope.meetingIds) : undefined
    const restrictMeetings = Boolean(meetings || q.after || q.before || q.meeting || people.length || q.kinds.length || q.notKinds.length)
    const valid = !q.bad.length && !unknownPeople.length && !ambiguousPeople.length
    const checkMeeting = (id: string) => {
      const m = this.lib.byId.get(id)
      if (!m || (meetings && !meetings.has(id))) return false
      if (q.after && m.date < q.after) return false
      if (q.before && m.date > q.before) return false
      if (q.meeting && !m.id.includes(q.meeting)) return false
      if (q.kinds.length && !q.kinds.includes(kindKey(m.kind))) return false
      if (q.notKinds.includes(kindKey(m.kind))) return false
      return people.every((persons) => persons.every((ids) => ids.some((id) => m.participants.includes(id))))
    }
    const eligibleMeetings = new Map<string, boolean>()
    const meetingOk = (id: string) => {
      if (!eligibleMeetings.has(id)) eligibleMeetings.set(id, checkMeeting(id))
      return eligibleMeetings.get(id)!
    }
    const metadataOk = (row: Candidate) => {
      if (!valid || (areas && !areas.has(row.kind)) || (kinds && !kinds.has(row.kind))) return false
      const note = row.noteId ? this.notes.get(row.noteId) : undefined
      if (row.noteId && !note) return false
      const actionId = row.actionId ? this.alias(row.actionId) : undefined
      const action = actionId ? this.items.get(actionId) : undefined
      if (actionId && this.authoritativeBoard && !action) return false
      const meetingId = action ? action.meeting?.id : row.meetingId
      if (meetingId && !this.lib.byId.has(meetingId)) return false
      if (restrictMeetings && !(note ? note.meetingIds.some(meetingOk) : meetingId && meetingOk(meetingId))) return false
      if (!items) return true
      if (!action || (q.status.length && !q.status.some((s) => (s === 'on_hold' ? onHold(action) : action.status === s)))) return false
      return owners.every(({ ids, name }) => ids.length ? ids.some((id) => action.people.includes(id)) : action.owner.toLowerCase().includes(name))
    }
    const phrases = q.phrases.map((p) => tokenize(p).map((t) => t.stem)).filter((p) => p.length)
    // -decaf leaves out a row that holds the word, and -"cold brew" one that holds the phrase
    const excluded = new Set(q.exclude.filter((x) => !x.includes(' ')).map(stem))
    const excludedPhrases = q.exclude.filter((x) => x.includes(' ')).map((x) => x.split(' ').map(stem))
    const passesExclusions = (text: string) => {
      if (!q.exclude.length) return true
      const stems = tokenize(text).map((t) => t.stem)
      return !stems.some((s, i) => excluded.has(s) || excludedPhrases.some((p) => p.every((x, j) => stems[i + j] === x)))
    }
    // `around` gives a transcript line's neighbours, [before, after]: a line also holds a phrase that runs on
    // into them (people finish a sentence on the next caption), when every phrase is found in the lines read
    // together and one of them takes words from this line.
    const accepts = (row: Candidate, around?: () => [string | undefined, string | undefined]) => {
      if (!metadataOk(row) || !passesExclusions(row.text)) return false
      if (!phrases.length) return true
      const words = tokenize(row.extra ? `${row.text}\n${row.extra}` : row.text).map((t) => t.stem)
      if (phrases.every((phrase) => phrase.length <= words.length && words.some((word, i) => word === phrase[0] && phrase.every((stem, j) => words[i + j] === stem)))) return true
      if (!around) return false
      const [before, after] = around().map((text) => (text ? tokenize(text).map((t) => t.stem) : []))
      const all = [...before, ...words, ...after]
      const at = (phrase: string[], i: number) => phrase.every((stem, j) => all[i + j] === stem)
      return phrases.every((phrase) => all.some((_, i) => at(phrase, i))) &&
        phrases.some((phrase) => all.some((_, i) => i < before.length + words.length && i + phrase.length > before.length && at(phrase, i)))
    }
    const chunk = (c: Chunk): Chunk | undefined => {
      const note = c.noteId ? this.notes.get(c.noteId) : undefined
      if (c.noteVersion !== undefined && (!note || versionOf(note) !== c.noteVersion)) return
      const actionId = c.actionId ? this.alias(c.actionId) : undefined
      const action = actionId ? this.items.get(actionId) : undefined
      let text = c.evidence ?? c.text
      const meetingId = action ? action.meeting?.id : c.meetingId
      if (c.fileId && !this.lib.byId.get(meetingId ?? '')?.docs.some((f) => f.id === c.fileId)) return
      if (c.kind === 'board' && c.searchKind) {
        const current = action && boardPassage(action)
        if (!current || current.kind !== c.searchKind) return
        const withoutOwner = (line: string, owner?: string) => owner && line.startsWith(`${owner}: `) ? line.slice(owner.length + 2) : line
        if (withoutOwner(current.text, action.owner) !== withoutOwner(text, c.searchExtra)) return
        text = current.text
      }
      if (!accepts({ kind: chunkKind(c), meetingId, noteId: c.noteId, actionId, text: c.spoken ?? text, extra: c.kind === 'board' ? action?.owner ?? c.searchExtra : c.searchExtra })) return
      if (text !== (c.evidence ?? c.text)) return { ...c, actionId, meetingId, text, searchExtra: action?.owner ?? c.searchExtra, evidence: undefined }
      return actionId === c.actionId && meetingId === c.meetingId ? c : { ...c, actionId, meetingId }
    }
    return { raw, q, valid, unknownPeople, ambiguousPeople, items, restrictMeetings, phrases, embeddingText: valid ? q.embeddingText : '', metadataOk, accepts, passesExclusions, chunk }
  }

  search(input: string | PreparedQuery, opts: { limit?: number; typing?: boolean; kinds?: Kind[] } = {}): Results {
    const prepared = typeof input === 'string' ? this.prepare(input) : input
    const { raw, q, unknownPeople, ambiguousPeople, items } = prepared
    if (!prepared.valid) return { query: raw, total: 0, hits: [], meetings: [], terms: [], fuzzy: {}, loose: false, unknownPeople, ambiguousPeople, badFilters: q.bad }
    // Every caller gets at most 200 displayed hits.
    // Follow alone takes them all (limit: Infinity), and shows each meeting's best few.
    const limit = opts.limit === Infinity ? Infinity : Math.min(200, Math.max(1, Math.trunc(opts.limit ?? 60) || 60))

    // expand each query word into index terms: exact stem, prefix (last word while typing), typo neighbours
    const fuzzy: Record<string, string[]> = {}
    const expand = (word: string, isLast: boolean): Map<string, number> => {
      const s = stem(word)
      const terms = new Map<string, number>()
      if (this.postings.has(s)) terms.set(s, 1)
      if (this.postings.has(word)) terms.set(word, 1)
      if (isLast && opts.typing !== false && word.length >= 2) {
        for (const v of this.prefixed(word)) if (!terms.has(v)) terms.set(v, 0.8)
      }
      if (!terms.size && word.length >= 4) {
        const max = word.length >= 8 ? 2 : 1
        const near = this.vocab.filter((v) => Math.abs(v.length - s.length) <= max && editDistance(v, s, max) <= max)
        for (const v of near) terms.set(v, 0.6)
        if (near.length) fuzzy[word] = near.slice(0, 5)
      }
      return terms
    }

    // Small words ("the", "to") are left out of a search; one made only of them ("one on one", "to do") looks for
    // them as they are, when nothing else in it (a phrase, a filter) would find anything.
    const content = q.words.filter((w) => !STOPWORDS.has(w) || q.words.length === 1)
    const alone = !prepared.phrases.length && !items && !q.areas.length && !q.exclude.length && !prepared.restrictMeetings
    const words = content.length || !alone ? content : q.words
    const groups = [...new Set(words)].map((w) => expand(w, w === words.at(-1) && !raw.endsWith(' ')))
    const phraseStems = prepared.phrases
    const kinds = opts.kinds ? new Set(opts.kinds) : undefined
    const eligibility = new Map<number, boolean>()
    const eligible = (id: number) => {
      const cached = eligibility.get(id)
      if (cached !== undefined) return cached
      const d = this.docs[id]
      const ok = (!kinds || kinds.has(d.kind)) && prepared.accepts(d, prepared.phrases.length && d.kind === 'transcript' ? () => this.around(id, prepared) : undefined)
      eligibility.set(id, ok)
      return ok
    }

    const scored = new Map<number, number>()
    const N = this.docs.length
    const bm25 = (term: string, weight: number, into: Map<number, number>) => {
      const p = this.postings.get(term)
      if (!p) return
      const idf = Math.log(1 + (N - p.size + 0.5) / (p.size + 0.5))
      for (const [id, positions] of p) {
        const d = this.docs[id]
        const tf = positions.length
        const s = (idf * tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * (d.len / this.avgLen)))
        into.set(id, Math.max(into.get(id) ?? 0, s * weight))
      }
    }

    let candidates: Map<number, number> | undefined
    let loose = false
    const perGroup = groups.map((g) => {
      const m = new Map<number, number>()
      for (const [term, w] of g) bm25(term, w, m)
      return m
    })
    // A transcript line holds a word itself, or through the line just before or after it (people finish a
    // sentence on the next caption), at a little less weight.
    const near = (g: Map<number, number>, id: number) =>
      g.get(id) ?? Math.max(0, ...this.neighbours(id).filter((n) => !q.exclude.length || prepared.passesExclusions(this.docs[n].text)).map((n) => (g.get(n) ?? 0) * 0.6))
    if (perGroup.length) {
      // every word must appear; if nothing has them all, fall back to any of them
      candidates = new Map([...perGroup[0]].filter(([id]) => eligible(id)))
      for (const g of perGroup.slice(1)) for (const id of candidates.keys()) if (!g.has(id)) candidates.delete(id)
      if (perGroup.length > 1) {
        // a few lines of transcript that hold every word between them are one hit, on a line holding some,
        // unless a line there already holds them all
        const taken = new Set<number>()
        const take = (id: number) => [id, ...this.neighbours(id)].forEach((n) => taken.add(n))
        for (const id of candidates.keys()) take(id)
        for (const g of perGroup)
          for (const id of g.keys()) {
            if (taken.has(id) || !eligible(id) || this.docs[id].kind !== 'transcript' || !perGroup.every((h) => near(h, id) > 0)) continue
            candidates.set(id, 0)
            take(id)
          }
      }
      if (!candidates.size && perGroup.length > 1) {
        loose = true
        candidates = new Map()
        for (const g of perGroup) for (const [id] of g) candidates.set(id, 0)
      }
      for (const [id] of candidates) candidates.set(id, perGroup.reduce((n, g) => n + near(g, id), 0))
    }
    if (phraseStems.length && !candidates) {
      candidates = new Map()
      for (const id of this.postings.get(phraseStems[0][0])?.keys() ?? []) candidates.set(id, 1)
    }
    if (!candidates) {
      candidates = new Map()
      if (items) {
        // filters only on items ("status:open owner:ada"): one line per item, the board's wording when it has one
        const listed = new Set<string>()
        for (const kind of ['action', 'update']) {
          for (let id = this.docs.length - 1; id >= 0; id--) {
            const d = this.docs[id]
            if (d.kind !== kind || !d.actionId || listed.has(d.actionId) || !eligible(id)) continue
            listed.add(d.actionId)
            candidates.set(id, 1)
          }
        }
      } else if (q.areas.length || q.exclude.length) {
        for (const [id] of this.docs.entries()) if (eligible(id)) candidates.set(id, 1)
      } else if (prepared.restrictMeetings) {
        // filters only ("person:ada"): list that person's meetings
        for (const [id, d] of this.docs.entries()) if (d.kind === 'meeting') candidates.set(id, 1)
      }
    }

    for (const [id, base] of candidates) {
      const d = this.docs[id]
      if (!eligible(id)) continue
      scored.set(id, (base + 2 * phraseStems.length) * WEIGHT[d.kind])
    }

    const markTerms = new Set([...groups.flatMap((g) => [...g.keys()]), ...phraseStems.flat()])
    const ranked = [...scored.entries()].sort((a, b) => b[1] - a[1])
    const seen: KeywordSources = { keys: new Set(), transcripts: new Map() }
    const distinct = opts.typing === false ? ranked.filter(([id]) => {
      const d = this.docs[id]
      const key = sourceKey(sourceOf({ ...d, actionId: d.actionId ? this.alias(d.actionId) : undefined }))
      if (seen.keys.has(key)) return false
      seen.keys.add(key)
      if (d.kind === 'transcript') {
        const lines = seen.transcripts.get(d.meetingId) ?? []
        lines.push(d)
        seen.transcripts.set(d.meetingId, lines)
      }
      return true
    }) : ranked
    const perMeeting = new Map<string, { count: number; best: number }>()
    let notebookCount = 0
    let boardCount = 0
    for (const [id, s] of distinct) {
      const d = this.docs[id]
      if (d.noteId) notebookCount++
      if (d.board && !d.meetingId) boardCount++
      if (!d.meetingId) continue
      const m = perMeeting.get(d.meetingId) ?? { count: 0, best: 0 }
      m.count++
      m.best = Math.max(m.best, s)
      perMeeting.set(d.meetingId, m)
    }
    const hits = distinct.slice(0, limit).map(([id, score]) => {
      const hit = this.hit(id, score, markTerms)
      if (hit.before && !prepared.passesExclusions(hit.before)) delete hit.before
      if (hit.after && !prepared.passesExclusions(hit.after)) delete hit.after
      return hit
    })
    const result: Results = {
      query: raw,
      total: distinct.length,
      notebookCount,
      boardCount,
      hits,
      meetings: [...perMeeting.entries()].map(([id, v]) => ({ id, ...v })).sort((a, b) => b.best - a.best),
      terms: [...markTerms],
      fuzzy,
      loose,
      unknownPeople,
      ambiguousPeople,
      badFilters: [],
    }
    if (opts.typing === false) keywordSources.set(result, seen)
    return result
  }

  // The text of the lines just before and after a transcript line, [before, after], where near() reads them
  // with it and nothing in them is left out.
  private around(id: number, prepared: PreparedQuery): [string | undefined, string | undefined] {
    const d = this.docs[id]
    const side = (k: number) => {
      const n = this.neighbours(id).find((n) => this.docs[n].segIndex === d.segIndex! + k)
      return n === undefined || !prepared.passesExclusions(this.docs[n].text) ? undefined : this.docs[n].text
    }
    return [side(-1), side(1)]
  }

  // The transcript lines just before and after one, in the same transcript and meeting, and close in time:
  // across a long pause the next caption starts something else.
  private neighbours(id: number): number[] {
    const d = this.docs[id]
    if (d.kind !== 'transcript' || d.segIndex === undefined) return []
    return [-1, 1].flatMap((k) => {
      const n = this.lines.get(`${d.transcriptId}#${d.segIndex! + k}`)
      return n !== undefined && this.docs[n].meetingId === d.meetingId && Math.abs((this.docs[n].t ?? 0) - (d.t ?? 0)) <= 20 ? [n] : []
    })
  }

  // Which parts of the archive a chunk of free text connects to: its most distinctive words (by how rare
  // they are here), scored like a search where any word may match, grouped by meeting and notebook entry.
  // A query of filters alone, or one no longer than the search box takes (300 characters) that holds a quoted
  // phrase, is answered by search() instead. A long text never is: search() would be a slow AND over every word.
  related(input: string | PreparedQuery, opts: { kinds?: Kind[]; limit?: number; maxTerms?: number } = {}) {
    const prepared = typeof input === 'string' ? this.prepare(input, { kinds: opts.kinds }) : input
    const text = prepared.embeddingText
    if (!prepared.valid) return { terms: [], hits: [] }
    if (!text || (prepared.phrases.length && prepared.raw.length <= 300)) {
      const r = this.search(prepared, { limit: opts.limit, typing: false, kinds: opts.kinds })
      return { terms: r.terms, hits: r.hits.map((h) => ({ ...h, terms: r.terms })) }
    }
    const N = Math.max(1, this.docs.length)
    const counts = new Map<string, number>()
    const surface = new Map<string, string>()
    for (const tok of tokenize(text.slice(0, 200_000))) {
      if (tok.stem.length < 3 || STOPWORDS.has(tok.stem) || /^\d+$/.test(tok.stem)) continue
      counts.set(tok.stem, (counts.get(tok.stem) ?? 0) + 1)
      if (!surface.has(tok.stem)) surface.set(tok.stem, text.slice(tok.start, tok.end))
    }
    const terms = [...counts.entries()]
      .filter(([t]) => this.postings.has(t))
      .map(([t, c]) => ({ t, w: Math.log(1 + c) * Math.log(1 + (N - this.postings.get(t)!.size + 0.5) / (this.postings.get(t)!.size + 0.5)) }))
      .filter((x) => x.w > 0)
      .sort((a, b) => b.w - a.w)
      .slice(0, opts.maxTerms ?? 30)
    const kinds = opts.kinds ? new Set(opts.kinds) : undefined
    const scores = new Map<number, { score: number; terms: Set<string> }>()
    const eligible = new Map<number, boolean>()
    for (const { t, w } of terms) {
      const p = this.postings.get(t)!
      const idf = Math.log(1 + (N - p.size + 0.5) / (p.size + 0.5))
      for (const [id, positions] of p) {
        const d = this.docs[id]
        if (kinds && !kinds.has(d.kind)) continue
        if (!eligible.has(id)) eligible.set(id, prepared.accepts(d))
        if (!eligible.get(id)) continue
        const tf = positions.length
        const bm = (idf * tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * (d.len / this.avgLen)))
        const cur = scores.get(id) ?? { score: 0, terms: new Set<string>() }
        cur.score += bm * Math.min(2, w) * WEIGHT[d.kind]
        cur.terms.add(surface.get(t) ?? t)
        scores.set(id, cur)
      }
    }
    // a doc that shares several distinctive words is a much better connection than one sharing a single word
    const ranked = [...scores.entries()].map(([id, v]) => ({ id, score: v.score * (1 + 0.5 * (v.terms.size - 1)), terms: [...v.terms] })).sort((a, b) => b.score - a.score)
    const hits: (Hit & { terms: string[] })[] = []
    const limit = Math.min(200, Math.max(1, Math.trunc(opts.limit ?? 80) || 80))
    const seen = new Set<string>()
    const marks = new Set(terms.map((x) => x.t))
    for (const r of ranked) {
      if (hits.length >= limit) break
      const d = this.docs[r.id]
      const key = sourceKey(sourceOf({ ...d, actionId: d.actionId ? this.alias(d.actionId) : undefined }))
      if (seen.has(key)) continue
      seen.add(key)
      const h = this.hit(r.id, r.score, marks)
      if (h.before && !prepared.passesExclusions(h.before)) delete h.before
      if (h.after && !prepared.passesExclusions(h.after)) delete h.after
      hits.push({ ...h, terms: r.terms })
    }
    return { terms: terms.map((x) => surface.get(x.t) ?? x.t), hits }
  }

  private prefixed(prefix: string): string[] {
    // vocab is sorted: binary search to the first candidate, then walk while it still matches
    let lo = 0
    let hi = this.vocab.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (this.vocab[mid] < prefix) lo = mid + 1
      else hi = mid
    }
    const out: string[] = []
    for (let i = lo; i < this.vocab.length && this.vocab[i].startsWith(prefix) && out.length < 40; i++) out.push(this.vocab[i])
    return out
  }

  private hit(id: number, score: number, terms: Set<string>, prefixes = [...terms].filter((x) => x.length >= 3)): Hit {
    const d = this.docs[id]
    const marks: [number, number][] = tokenize(d.text)
      .filter((t) => terms.has(t.stem) || prefixes.some((x) => t.stem.startsWith(x)))
      .map((t) => [t.start, t.end])
    const out: Hit = { meetingId: d.meetingId, kind: d.kind, text: d.text, marks, score: Math.round(score * 100) / 100 }
    if (d.t !== undefined) out.t = d.t
    if (d.section) out.section = d.section
    if (d.topicKey) out.topicKey = d.topicKey
    if (d.actionId) out.actionId = this.alias(d.actionId)
    if (d.fileId) out.fileId = d.fileId
    if (d.noteId) {
      out.noteId = d.noteId
      out.noteTitle = this.notes.get(d.noteId)?.title
    }
    if (d.board) out.board = true
    if (d.part) out.part = d.part
    if (d.transcriptId) {
      out.transcriptId = d.transcriptId
      out.segIndex = d.segIndex
      const segs = this.lib.transcripts.get(d.transcriptId)?.parsed.segments ?? []
      const prev = segs[d.segIndex! - 1]
      const next = segs[d.segIndex! + 1]
      if (prev && !prev.q) out.before = prev.t
      if (next && !next.q) out.after = next.t
    }
    out.link = sourceLink(out)
    return out
  }
}

const gap = ([a, b]: [number, number], t: number) => (t < a ? a - t : t > b ? t - b : 0)


type Candidate = { kind: Kind; meetingId?: string; actionId?: string; noteId?: string; text: string; extra?: string }

export type PreparedQuery = {
  raw: string
  q: Query
  valid: boolean
  unknownPeople: string[]
  ambiguousPeople: { name: string; ids: string[] }[]
  items: boolean
  restrictMeetings: boolean
  phrases: string[][]
  embeddingText: string
  metadataOk: (row: Candidate) => boolean
  accepts: (row: Candidate, around?: () => [string | undefined, string | undefined]) => boolean
  passesExclusions: (text: string) => boolean
  chunk: (row: Chunk) => Chunk | undefined
}

// Track all settled keyword identities for accurate merged counts when only the leading rows are returned.
type KeywordSources = {
  keys: Set<string>
  transcripts: Map<string, Pick<Hit, 'kind' | 'meetingId' | 'transcriptId' | 't'>[]>
}
export const keywordSources = new WeakMap<Results, KeywordSources>()

export type Query = {
  words: string[]
  embeddingText: string
  phrases: string[]
  // what a row must not hold: words (-decaf) and phrases (-"cold brew")
  exclude: string[]
  people: string[]
  areas: string[]
  after?: string
  before?: string
  meeting?: string
  // what sort of recording an entry must be (kind:demo, any of them) or must not be (-kind:demo), as kindKey writes it
  kinds: string[]
  notKinds: string[]
  // board items only: their status now (on_hold is open and waiting), and whose they are
  status: ('open' | 'on_hold' | 'done' | 'canceled')[]
  owners: string[]
  // filters as typed that can't mean anything
  bad: string[]
}

// Text that was never written as a query, such as the work an agent pastes into find_connections: all of it
// is words, and all of it is what meaning search reads. A quotation, a "Status: …" line, a -flag or an @name
// in it is never a phrase, a filter, an exclusion or a person.
export function plainQuery(raw: string): Query {
  const words = [...fold(raw).matchAll(TOKEN)].map((m) => m[0])
  return { words, phrases: [], exclude: [], people: [], areas: [], kinds: [], notKinds: [], status: [], owners: [], bad: [], embeddingText: words.length ? raw : '' }
}

// A real calendar day, written the one way the archive writes dates.
const isDay = (v: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false
  const date = new Date(`${v}T00:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === v
}
// A kind as a filter compares it: normalised the way the library does, a space written as a hyphen (kind:site-visit).
const kindKey = (v: string) => (normKind(v) ?? '').replace(/ /g, '-')
const STATUS: Record<string, Query['status'][number]> = { open: 'open', done: 'done', canceled: 'canceled', cancelled: 'canceled', on_hold: 'on_hold', hold: 'on_hold', held: 'on_hold', waiting: 'on_hold' }

export function parseQuery(raw: string): Query {
  const q: Query = { words: [], phrases: [], exclude: [], people: [], areas: [], kinds: [], notKinds: [], status: [], owners: [], bad: [], embeddingText: '' }
  // A filter takes a value. "Status: waiting on legal" is words; only a bare "owner:" at the very end, a filter
  // still being typed, is a filter with nothing in it.
  const clauses = /"([^"]*)"?|(?:^|\s)(?:(-?kind|person|who|with|in|after|before|since|until|meeting|on|status|owner):(\S+|$)|@(\p{L}+)|-"([^"]*)"?|-(\p{L}[\p{L}\p{N}]*))/giu
  const plain: string[] = []
  const positive: string[] = []
  let at = 0
  for (const m of raw.matchAll(clauses)) {
    const [whole, phrase, key, value, person, notPhrase, exclude] = m
    const between = raw.slice(at, m.index)
    plain.push(between)
    positive.push(between)
    at = m.index + whole.length
    if (phrase !== undefined) {
      if (phrase.trim()) q.phrases.push(phrase)
      positive.push(phrase)
    } else if (person) q.people.push(person)
    else if (notPhrase !== undefined) {
      // kept as its words, so -"decaf" leaves out what -decaf does
      const words = [...fold(notPhrase).matchAll(TOKEN)].map((w) => w[0])
      if (words.length) q.exclude.push(words.join(' '))
    } else if (exclude) q.exclude.push(fold(exclude))
    else {
      const k = key.toLowerCase()
      const bad = () => q.bad.push(`${k}:${value}`)
      if (!value) bad()
      else if (k === 'person' || k === 'who' || k === 'with') q.people.push(value)
      else if (k === 'in') {
        const area = value.toLowerCase()
        if (Object.hasOwn(AREA, area)) q.areas.push(area)
        else bad()
      } else if (k === 'status') {
        const status = value.toLowerCase().replace(/-/g, '_')
        if (Object.hasOwn(STATUS, status)) q.status.push(STATUS[status])
        else bad()
      } else if (k === 'kind' || k === '-kind') {
        const kind = kindKey(value)
        if (kind) (k === 'kind' ? q.kinds : q.notKinds).push(kind)
        else bad()
      } else if (k === 'owner') q.owners.push(value)
      else if (k === 'meeting') q.meeting = value.toLowerCase()
      else if (!isDay(value)) bad()
      else {
        if (k === 'after' || k === 'since' || k === 'on') q.after = value
        if (k === 'before' || k === 'until' || k === 'on') q.before = value
      }
    }
  }
  plain.push(raw.slice(at))
  positive.push(raw.slice(at))
  for (const m of fold(plain.join(' ')).matchAll(TOKEN)) q.words.push(m[0])
  if (q.words.length || q.phrases.some((p) => tokenize(p).length)) q.embeddingText = positive.join(' ').replace(/\s+/g, ' ').trim()
  return q
}
