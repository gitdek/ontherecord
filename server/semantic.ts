// Meaning-based search over everything: notes, transcripts, the documents attached to meetings and the
// notebook, embedded by a local model (llama.cpp's llama-server on 127.0.0.1) so no meeting text ever leaves this Mac.
// Vectors are keyed by a hash of what was embedded, so only new or changed passages are ever re-embedded;
// changing the model just builds a fresh set in the background. Keyword search keeps working without it.
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { offsetIn, type Library } from './library.ts'
import { versionOf, type Note } from './notebook.ts'
import type { Kind } from './search.ts'
import type { ActionView } from './tasks.ts'
import { passagesOf } from './text.ts'

// board: what the board says about an item since the meeting (a reason, evidence, a note, a hold), or a task added there
export type ChunkKind = 'notes' | 'action' | 'transcript' | 'kb' | 'doc' | 'board' | 'screen'
export type Chunk = {
  key: string
  kind: ChunkKind
  meetingId?: string
  noteId?: string
  actionId?: string
  // an attached document's file id
  fileId?: string
  videoId?: string
  t?: number
  end?: number
  transcriptId?: string
  topicKey?: string
  searchKind?: Kind
  searchExtra?: string
  noteVersion?: number
  section?: string
  title: string
  text: string
  // Text past the embedding profile's input cap stays available to retrieval.
  evidence?: string
  // A transcript passage's words without the speakers' names, which filters read: a name matches where it was
  // said, and a phrase runs on across lines. Only `text`, names and all, is embedded.
  spoken?: string
}

const CHUNK_KIND: Record<ChunkKind, Kind> = { notes: 'note', action: 'action', transcript: 'transcript', kb: 'kb', doc: 'doc', board: 'update', screen: 'screen' }
export const chunkKind = (c: Chunk) => c.searchKind ?? CHUNK_KIND[c.kind]

// Screen hits arrive ranked by their own model and OCR. Local model cutoffs do not apply to them.
export const relatedMatch = ({ chunk, score }: { chunk: Chunk; score: number }, cutoff: number) =>
  chunk.kind === 'screen' || score > cutoff

export function boardPassage(a: ActionView): { kind: Kind; text: string } | undefined {
  const updates = [
    a.canceled?.reason && `Canceled: ${a.canceled.reason}`,
    (a.canceled ?? a.done)?.evidence && `Evidence: ${(a.canceled ?? a.done)!.evidence}`,
    a.note && `Note: ${a.note.text}`,
    a.hold?.on && `Waiting on: ${a.hold.on}`,
    a.checked && `Looked, found nothing: ${a.checked.text}`,
  ].filter(Boolean)
  if (a.source !== 'added' && !a.original && !updates.length) return
  return { kind: updates.length ? 'update' : 'action', text: [`${a.owner ? `${a.owner}: ` : ''}${a.text}`, ...updates].join('\n') }
}

// Each model family wants its own query/document framing, and scores similarity on its own scale:
// `related` is how close a passage must be to count as related by meaning. Qwen3-Embedding-8B won the
// bake-off on our meetings (scripts/eval-embeddings.ts). Its cutoff was measured on our archive: off-topic
// questions top out around 0.2-0.36, real topics score 0.5-0.7.
const QWEN_TASK = 'Given a question, topic or excerpt, retrieve the passages from business meeting notes, transcripts and research notes that discuss it'
type Profile = { query: (q: string) => string; doc: (title: string, text: string) => string; maxChars: number; related: number }
const PROFILES: Record<string, Profile> = {
  qwen3: { query: (q) => `Instruct: ${QWEN_TASK}\nQuery:${q}`, doc: (_title, text) => text, maxChars: 6000, related: 0.42 },
  embeddinggemma: { query: (q) => `task: search result | query: ${q}`, doc: (title, text) => `title: ${title || 'none'} | text: ${text}`, maxChars: 6000, related: 0.55 },
  bge: { query: (q) => `Represent this sentence for searching relevant passages: ${q}`, doc: (_title, text) => text, maxChars: 1600, related: 0.55 },
  plain: { query: (q) => q, doc: (_title, text) => text, maxChars: 1600, related: 0.55 },
}
const profileFor = (model: string) => (/qwen/i.test(model) ? 'qwen3' : /gemma/i.test(model) ? 'embeddinggemma' : /bge/i.test(model) ? 'bge' : 'plain')

const words = (s: string) => s.split(/\s+/).filter(Boolean).length

// How a transcript is cut into passages. A passage closes at `words` words or `seconds` seconds; with `turns`
// it closes earlier where the speaker changes, once it has enough to stand alone; with `overlap` the next one
// opens with the end of the last speaker's turn, so a thought cut in two is whole in one of them; `context`
// puts the meeting's title and date in front. The bake-off (scripts/eval-embeddings.ts --passages) measures
// each choice on the archive's own meetings. On 2026-11-10, 176 questions: turns with overlap put the right
// passage first 65% of the time with keywords (58% before) and 67% reranked (64%); turns alone scored lower,
// and so did the title in front (49% against 61% by meaning alone), so neither is used.
export type PassageOptions = { words: number; seconds: number; turns: boolean; overlap: boolean; context: boolean }
export const PASSAGES: PassageOptions = { words: 150, seconds: 90, turns: true, overlap: true, context: false }

type Line = { sp?: string; text: string; s: number; e: number }
const said = (lines: Line[]) => lines.map((l) => (l.sp ? `${l.sp}: ${l.text}` : l.text)).join(' ')

// Passages worth finding on their own: each notes topic with its bullets, each action, summaries and
// next steps, ~150-word windows of transcript, the documents attached to meetings, notebook entries split at
// paragraph boundaries, and what the board says about each item.
export function chunksOf(lib: Library, notes: Note[], model: string, opts: { passages?: PassageOptions; board?: ActionView[] } = {}): Chunk[] {
  const P = opts.passages ?? PASSAGES
  const out: Omit<Chunk, 'key'>[] = []
  for (const m of lib.meetings) {
    const n = m.notes
    if (n) {
      for (const s of n.sections) {
        if (s.role === 'source') continue
        if (s.role === 'discussion') {
          for (const b of s.blocks) {
            const base = { kind: 'notes' as const, meetingId: m.id, t: b.ranges[0]?.[0], section: s.title, searchExtra: s.title }
            if (b.kind === 'item') {
              const topicKey = m.topics.find((t) => t.n === b.n)?.key
              out.push({ ...base, topicKey, end: b.ranges[0]?.[1], title: `${m.title}: ${b.title}`, text: [b.title, ...b.bullets.map((l) => l.text)].join('\n') })
            } else out.push({ ...base, title: `${m.title}: ${s.title}`, text: b.text })
          }
        } else {
          const kind: ChunkKind = s.role === 'actions' ? 'action' : 'notes'
          const searchKind: Kind = s.role === 'actions' ? 'action' : s.role === 'summary' ? 'summary' : s.role === 'next' ? 'next' : 'caveat'
          for (const b of s.blocks) {
            const text = b.kind === 'item' ? b.title : b.text
            const actionId = kind === 'action' && b.kind === 'bullet' ? b.action : undefined
            out.push({ kind, searchKind, searchExtra: s.title, meetingId: m.id, t: b.ranges[0]?.[0], section: s.title, title: `${m.title}: ${s.title}`, text, ...(actionId ? { actionId } : {}) })
          }
        }
      }
    }
    const src = m.primaryTranscript ? lib.transcripts.get(m.primaryTranscript) : undefined
    if (src) {
      const [a, b] = m.axis
      const off = offsetIn(m, src.id)
      const segs = src.parsed.segments.filter((s) => !s.q && (m.timeBase === 'offset' || (s.e >= a && s.s <= b)))
      let cur: Line[] = []
      // how many of cur's lines were carried over from the passage before (it closes only once it has new ones)
      let carried = 0
      // what of the passage just closed the next one opens with: the last speaker's lines, up to ~40 words
      const tail = (lines: Line[]) => {
        const keep: Line[] = []
        for (let i = lines.length - 1; i >= 0 && lines[i].sp === lines.at(-1)!.sp && words(said([lines[i], ...keep])) <= 40; i--) keep.unshift(lines[i])
        return keep.length < lines.length ? keep : []
      }
      const flush = (last = false) => {
        if (cur.length > carried && words(said(cur)) >= 12) {
          const head = P.context ? `${m.title}, ${m.date}\n` : ''
          out.push({ kind: 'transcript', meetingId: m.id, transcriptId: src.id, t: cur[0].s, end: cur.at(-1)!.e, title: `${m.title} (transcript)`, text: head + said(cur), spoken: cur.map((l) => l.text).join(' ') })
        }
        cur = P.overlap && !last ? tail(cur) : []
        carried = cur.length
      }
      for (const s of segs) {
        const line: Line = { sp: s.sp, text: s.t, s: s.s + off, e: s.e + off }
        // a new speaker is a good place to close, once the passage can stand alone
        if (P.turns && cur.length > carried && line.sp !== cur.at(-1)!.sp && words(said(cur)) >= 60) flush()
        cur.push(line)
        if (words(said(cur)) >= P.words || cur.at(-1)!.e - cur[0].s >= P.seconds) flush()
      }
      flush(true)
    }
    // the meeting's other text files (an agenda, an excerpt), paragraphs gathered into ~200-word passages
    for (const f of m.docs) {
      let buf: string[] = []
      const flush = () => {
        if (buf.length) out.push({ kind: 'doc', meetingId: m.id, fileId: f.id, section: f.name, title: `${m.title}: ${f.name}`, text: buf.join('\n\n') })
        buf = []
      }
      for (const p of passagesOf(lib.docText.get(f.id) ?? '', 150)) {
        if (words([...buf, p].join(' ')) > 220) flush()
        buf.push(p)
      }
      flush()
    }
  }
  for (const note of notes) {
    const paras = note.body.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
    let buf: string[] = []
    const flush = () => {
      if (buf.length) out.push({ kind: 'kb', noteId: note.id, noteVersion: versionOf(note), searchExtra: [note.title, ...note.tags].join(' '), title: note.title, text: buf.join('\n\n') })
      buf = []
    }
    for (const p of paras) {
      if (words([...buf, p].join(' ')) > 220) flush()
      buf.push(p)
    }
    flush()
  }
  // A task added on the board, and every item the board has written on: the item, then what was written. The
  // status stays out, so a check-off alone doesn't send the passage back to the model.
  for (const a of opts.board ?? []) {
    const passage = boardPassage(a)
    if (!passage) continue
    out.push({
      kind: 'board',
      searchKind: passage.kind,
      searchExtra: a.owner,
      meetingId: a.meeting?.id,
      actionId: a.id,
      title: `${a.meeting?.title ?? 'The board'}: ${a.text}`,
      text: passage.text,
    })
  }
  const maxChars = PROFILES[profileFor(model)].maxChars
  return out
    .filter((c) => c.text.trim())
    .map((c) => {
      const text = c.text.length > maxChars ? c.text.slice(0, maxChars) : c.text
      return { ...c, text, ...(text !== c.text ? { evidence: c.text } : {}), key: createHash('sha1').update(`${model}\0${c.kind}\0${c.title}\0${text}`).digest('base64url').slice(0, 22) }
    })
}

export type SemanticConfig = { url: string; key: string; model: string }
export type RerankConfig = { url: string; key: string }

// A second opinion on a shortlist: a cross-encoder reads the question together with each passage. In the
// bake-off it put the right passage first 66% of the time, against 58% for the shortlist's own order, but
// it takes ~3 s for 20 passages, so it serves agents' context pulls, not search-as-you-type. order() gives
// the passages' indexes best first, or undefined when the reranker is off or down (callers keep their order).
export class Reranker {
  private cfg: RerankConfig
  constructor(cfg: RerankConfig) {
    this.cfg = cfg
  }

  get enabled() {
    return Boolean(this.cfg.url)
  }

  async order(query: string, texts: string[], signal?: AbortSignal): Promise<number[] | undefined> {
    signal?.throwIfAborted()
    if (!this.enabled || texts.length < 2) return
    try {
      const res = await fetch(`${this.cfg.url}/v1/rerank`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(this.cfg.key ? { authorization: `Bearer ${this.cfg.key}` } : {}) },
        body: JSON.stringify({ query: query.slice(0, 2000), documents: texts.map((t) => t.slice(0, 4000)) }),
        // the first call after a quiet spell also loads the model
        signal: deadline(90_000, signal),
      })
      if (!res.ok) return
      const json = (await res.json()) as { results?: { index: number; relevance_score: number }[] }
      signal?.throwIfAborted()
      const results = json.results
      if (!isPermutation(results, texts.length) || !results.every((r) => Number.isFinite(r.relevance_score))) return
      return [...results].sort((a, b) => b.relevance_score - a.relevance_score).map((r) => r.index)
    } catch {
      signal?.throwIfAborted()
      return
    }
  }
}
// refused: passages the embedding server won't take on their own (too long for it, say), left out until they change
export type SemanticStatus = { enabled: boolean; model: string; total: number; embedded: number; pending: number; refused: number; error?: string }

// The embedding server answered with an error, about one of the inputs or about every request.
class Refused extends Error {}

function isPermutation<T extends { index: number }>(rows: T[] | undefined, count: number): rows is T[] {
  if (!Array.isArray(rows) || rows.length !== count) return false
  const seen = new Set<number>()
  for (const row of rows) {
    if (!row || !Number.isInteger(row.index) || row.index < 0 || row.index >= count || seen.has(row.index)) return false
    seen.add(row.index)
  }
  return true
}

export function normalize(v: Float32Array): Float32Array {
  let sum = 0
  for (const x of v) sum += x * x
  const norm = Math.sqrt(sum)
  if (!Number.isFinite(norm) || norm === 0) throw new Error('invalid embedding norm')
  for (let i = 0; i < v.length; i++) v[i] /= norm
  return v
}

function deadline(ms: number, signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(ms)
  return signal ? AbortSignal.any([timeout, signal]) : timeout
}

const MAGIC = 'MTGV1'

export class Semantic {
  private cfg: SemanticConfig
  private dir: string
  private vectors = new Map<string, Float32Array>()
  // keys of passages the server refused on their own: skipped until their text (and so their key) changes
  private refused = new Set<string>()
  private chunks: Chunk[] = []
  private dims = 0
  private fromCache = false
  private running?: ReturnType<typeof Promise.withResolvers<void>>
  private again = false
  private lastError = ''
  private dirty = false
  private onProgress: () => void

  constructor(dataDir: string, cfg: SemanticConfig, onProgress: () => void = () => {}) {
    this.cfg = cfg
    this.dir = join(dataDir, 'vectors')
    this.onProgress = onProgress
  }

  get enabled() {
    return Boolean(this.cfg.url && this.cfg.model)
  }

  // how close a passage must be (cosine) to count as related by meaning, for this model
  get related() {
    return PROFILES[profileFor(this.cfg.model)].related
  }

  private file = () => join(this.dir, `${this.cfg.model.replace(/[^a-zA-Z0-9._-]+/g, '_')}.vec`)

  // Binary store: magic, dims, count, then (22-byte key, dims float32) records.
  async load() {
    if (!this.enabled) return
    try {
      const buf = await readFile(this.file())
      if (buf.length < 13 || buf.toString('latin1', 0, 5) !== MAGIC) throw new Error('not a vector file')
      const dims = buf.readUInt32LE(5)
      const count = buf.readUInt32LE(9)
      if (!dims || buf.length !== 13 + count * (22 + dims * 4)) throw new Error('invalid vector file size')
      const vectors = new Map<string, Float32Array>()
      let off = 13
      for (let i = 0; i < count; i++) {
        const key = buf.toString('latin1', off, off + 22)
        if (!/^[a-zA-Z0-9_-]{22}$/.test(key) || vectors.has(key)) throw new Error('invalid vector key')
        off += 22
        const v = new Float32Array(buf.buffer.slice(buf.byteOffset + off, buf.byteOffset + off + dims * 4))
        vectors.set(key, normalize(v))
        off += dims * 4
      }
      this.vectors = vectors
      this.dims = count ? dims : 0
      this.fromCache = Boolean(count)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`semantic: starting a fresh vector store (${(err as Error).message})`)
    }
  }

  private async persist() {
    if (!this.dirty || !this.dims) return
    const live = new Set(this.chunks.map((c) => c.key))
    const keep = [...this.vectors.entries()].filter(([k]) => live.has(k))
    const buf = Buffer.alloc(13 + keep.length * (22 + this.dims * 4))
    buf.write(MAGIC, 0, 'latin1')
    buf.writeUInt32LE(this.dims, 5)
    buf.writeUInt32LE(keep.length, 9)
    let off = 13
    for (const [k, v] of keep) {
      buf.write(k, off, 'latin1')
      off += 22
      Buffer.from(v.buffer, v.byteOffset, v.byteLength).copy(buf, off)
      off += this.dims * 4
    }
    await mkdir(this.dir, { recursive: true })
    const tmp = `${this.file()}.tmp`
    await writeFile(tmp, buf, { mode: 0o600 })
    await rename(tmp, this.file())
    this.dirty = false
  }

  status(): SemanticStatus {
    const embedded = this.chunks.filter((c) => this.vectors.has(c.key)).length
    const refused = this.chunks.filter((c) => this.refused.has(c.key)).length
    return { enabled: this.enabled, model: this.cfg.model, total: this.chunks.length, embedded, pending: this.chunks.length - embedded - refused, refused, ...(this.lastError ? { error: this.lastError } : {}) }
  }

  private async embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
    const res = await fetch(`${this.cfg.url}/v1/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(this.cfg.key ? { authorization: `Bearer ${this.cfg.key}` } : {}) },
      body: JSON.stringify({ input: texts, model: this.cfg.model }),
      signal: deadline(120_000, signal),
    })
    if (!res.ok) {
      const message = `embedding server answered ${res.status}`
      // 503 is a server still loading its model: that says nothing about these passages
      throw res.status === 503 ? new Error(message) : new Refused(message)
    }
    const json = (await res.json().catch(() => null)) as { data?: { index: number; embedding: number[] }[] } | null
    signal?.throwIfAborted()
    const data = json?.data
    if (!isPermutation(data, texts.length)) throw new Error('invalid embedding indices')
    const dims = data[0]?.embedding?.length
    const vectors: Float32Array[] = []
    for (const { index, embedding } of data) {
      if (!dims || !Array.isArray(embedding) || embedding.length !== dims || !embedding.every(Number.isFinite)) throw new Error('invalid embedding dimensions or values')
      vectors[index] = normalize(Float32Array.from(embedding))
    }
    return vectors
  }

  // A correctly formed response can reveal that a previously valid cache belongs to an older model
  // behind the same configured name. Never mix dimensions or discard vectors built in this process.
  private resetIfStale(dims: number) {
    if (this.dims === 0 || this.dims === dims) return false
    if (!this.fromCache) throw new Error('embedding dimensions changed during indexing')
    this.vectors.clear()
    this.dims = 0
    this.fromCache = false
    return true
  }

  // Bring the store in line with the current passages: embed what's missing, a batch at a time.
  async sync(chunks: Chunk[]) {
    this.chunks = chunks
    if (!this.enabled) return
    if (this.running) {
      this.again = true
      return
    }
    this.running = Promise.withResolvers<void>()
    try {
      do {
        this.again = false
        try {
          const profile = PROFILES[profileFor(this.cfg.model)]
          const missing = [...new Map(this.chunks.filter((c) => !this.vectors.has(c.key) && !this.refused.has(c.key)).map((c) => [c.key, c])).values()]
          const keep = (batch: Chunk[], vecs: Float32Array[]) => {
            const stale = this.resetIfStale(vecs[0].length)
            vecs.forEach((v, j) => this.vectors.set(batch[j].key, v))
            this.dims = vecs[0].length
            this.fromCache = false
            this.dirty = true
            if (stale) this.again = true
          }
          for (let i = 0; i < missing.length; i += 16) {
            const batch = missing.slice(i, i + 16)
            const texts = batch.map((c) => profile.doc(c.title, c.text))
            try {
              keep(batch, await this.embed(texts))
            } catch (err) {
              if (!(err instanceof Refused)) throw err
              // One passage the server can't take (too long for it, say) fails its whole batch. One at a time, the
              // others go in, and a passage refused on its own is set aside until it changes.
              const alone: Chunk[] = []
              for (const [j, c] of batch.entries()) {
                const vecs = await this.embed([texts[j]]).catch((e) => {
                  if (e instanceof Refused) return undefined
                  throw e
                })
                if (vecs) keep([c], vecs)
                else alone.push(c)
              }
              // every one refused, and a single word too: the server is failing, not the passages
              if (alone.length === batch.length && !(await this.embed(['ok']).then(() => true, () => false))) throw err
              for (const c of alone) {
                this.refused.add(c.key)
                const place = c.noteId ? `notebook entry ${c.noteId}` : c.kind === 'board' ? `board item ${c.actionId}` : `meeting ${c.meetingId}`
                console.warn(`semantic: the embedding server refused a passage of ${place} (${c.text.length} characters); it stays out of meaning search until it changes`)
              }
            }
            if (i % 160 === 0) this.onProgress()
            if (this.again) break
          }
          // a passage that changed or went leaves its old vector (16 KB with Qwen3) behind: only current ones stay
          const live = new Set(this.chunks.map((c) => c.key))
          for (const key of this.vectors.keys()) if (!live.has(key)) this.vectors.delete(key)
          for (const key of this.refused) if (!live.has(key)) this.refused.delete(key)
          await this.persist()
          this.lastError = ''
          this.onProgress()
        } catch (err) {
          this.lastError = (err as Error).message
          console.warn(`semantic: ${this.lastError} (keyword search still works; will retry on the next change)`)
          this.onProgress()
        }
      } while (this.again)
    } finally {
      this.running.resolve()
      this.running = undefined
    }
  }

  async waitForSync() {
    await this.running?.promise
  }

  // The passages closest in meaning to a query. Empty when the model isn't reachable.
  async query(text: string, opts: { k?: number; kinds?: ChunkKind[]; filter?: (c: Chunk) => boolean; select?: (c: Chunk) => Chunk | undefined; identity?: (c: Chunk) => string; signal?: AbortSignal } = {}): Promise<{ chunk: Chunk; score: number }[]> {
    opts.signal?.throwIfAborted()
    if (!this.enabled || !this.vectors.size) return []
    let q: Float32Array
    try {
      ;[q] = await this.embed([PROFILES[profileFor(this.cfg.model)].query(text.slice(0, 4000))], opts.signal)
      if (this.resetIfStale(q.length)) {
        void this.sync(this.chunks)
        return []
      }
    } catch (err) {
      opts.signal?.throwIfAborted()
      this.lastError = (err as Error).message
      return []
    }
    const kinds = opts.kinds ? new Set(opts.kinds) : undefined
    const scored: { chunk: Chunk; score: number }[] = []
    for (const original of this.chunks) {
      if (kinds && !kinds.has(original.kind)) continue
      if (opts.filter && !opts.filter(original)) continue
      const chunk = opts.select ? opts.select(original) : original
      if (!chunk) continue
      const v = this.vectors.get(original.key)
      if (!v || v.length !== q.length) continue
      let dot = 0
      for (let i = 0; i < v.length; i++) dot += v[i] * q[i]
      scored.push({ chunk, score: dot })
    }
    scored.sort((a, b) => b.score - a.score)
    if (!opts.identity) return scored.slice(0, opts.k ?? 20)
    const seen = new Set<string>()
    const ranked: typeof scored = []
    for (const hit of scored) {
      if (ranked.length >= (opts.k ?? 20)) break
      const key = opts.identity(hit.chunk)
      if (seen.has(key)) continue
      seen.add(key)
      ranked.push(hit)
    }
    return ranked
  }
}
