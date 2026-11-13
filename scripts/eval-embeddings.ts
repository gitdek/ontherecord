// Embedding bake-off on our own meetings: which local model finds "where did we talk about X"?
// Ground truth comes free from the reviewed notes: every topic and action item lists the time ranges
// where it was discussed, so its title (or first bullet, or the action text) should retrieve the
// transcript windows inside those ranges, searched across every meeting at once.
// Prints and saves aggregate scores only; no meeting text leaves this script.
//
//   node --env-file-if-exists=.env scripts/eval-embeddings.ts models.json [--passages] [--rerank reranker.gguf | --rerank-url URL --rerank-key FILE]
//
// models.json: [{ "name": "...", "gguf": "/path.gguf", "profile": "bge|embeddinggemma|qwen3", "args": ["--pooling", "last"] }]
// or, for a model that is already being served: { "name": "...", "url": "http://127.0.0.1:8799", "keyFile": "data/embed.key", "profile": "qwen3" }
// --passages runs every model over each way of cutting transcripts into passages (see PassageOptions in
// server/semantic.ts), on the same questions, so the cuts can be compared pair by pair; --cuts "as today,
// fixed windows" keeps only the ones named.
// --rerank reorders the top 20 of the two best hybrids (scores are cached per question and window, so the
// second pass only pays for windows the first didn't see). A paired bootstrap at the end says which gaps
// are bigger than the noise of ~150 questions.
//
// The numbers are a gate: a change to passages, ranking or models that scores lower than what runs today
// doesn't ship. Today (2026-11-10, 176 questions), R@1: keyword 45, Qwen3-Embedding-8B 61, with keywords 65,
// reranked 67.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { configFrom } from '../server/config.ts'
import { buildLibrary, scanFiles } from '../server/library.ts'
import { Media } from '../server/media.ts'
import { SearchIndex } from '../server/search.ts'
import { chunksOf, PASSAGES, type Chunk, type PassageOptions } from '../server/semantic.ts'
import type { Range } from '../server/text.ts'

type ModelSpec = { name: string; gguf?: string; url?: string; keyFile?: string; profile: 'bge' | 'embeddinggemma' | 'qwen3' | 'plain'; args?: string[] }
type Question = { set: 'topic' | 'paraphrase' | 'action'; text: string; meetingId: string; ranges: Range[] }
type Query = Question & { relevant: Set<number> }
type Endpoint = { url: string; key: string }

const QWEN_TASK = "Given a topic or action item from a business meeting's notes, retrieve the transcript passages where it was discussed"
const PROMPTS = {
  bge: { q: (s: string) => `Represent this sentence for searching relevant passages: ${s}`, d: (_t: string, s: string) => s },
  embeddinggemma: { q: (s: string) => `task: search result | query: ${s}`, d: (t: string, s: string) => `title: ${t || 'none'} | text: ${s}` },
  qwen3: { q: (s: string) => `Instruct: ${QWEN_TASK}\nQuery:${s}`, d: (_t: string, s: string) => s },
  plain: { q: (s: string) => s, d: (_t: string, s: string) => s },
}

const args = process.argv.slice(2)
const specs = JSON.parse(await readFile(args[0], 'utf8')) as ModelSpec[]
const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const rerankGguf = flag('--rerank')
const rerankUrl = flag('--rerank-url')
const rerankKeyFile = flag('--rerank-key')

// The cuts --passages compares. The topic a stretch belongs to is left out of the "in front" line: the
// questions are the notes' topics, so it would hand each passage its own answer.
const VARIANTS: [string, PassageOptions][] = args.includes('--passages')
  ? [
      ['as today', PASSAGES],
      ['fixed windows', { ...PASSAGES, turns: false, overlap: false }],
      ['speaker turns', { ...PASSAGES, turns: true, overlap: false }],
      ['title + date in front', { ...PASSAGES, context: true }],
    ]
  : [['', PASSAGES]]
const keep = flag('--cuts')?.split(',').map((s) => s.trim())
if (keep) VARIANTS.splice(0, VARIANTS.length, ...VARIANTS.filter(([name]) => keep.includes(name)))

// ---------- corpus and ground truth ----------
const config = configFrom(process.env)
const media = new Media(config.dataDir, () => {})
await media.load()
const lib = await buildLibrary(await scanFiles(config.meetingsDir), (f) => media.facts(f), config.crew, new Map())
const overlaps = (c: Chunk, [a, b]: Range) => c.t! <= b + 10 && (c.end ?? c.t!) >= a - 10

const questions: Question[] = []
for (const m of lib.meetings) {
  for (const t of m.topics) {
    if (t.auto || !t.ranges.length) continue
    questions.push({ set: 'topic', text: t.title, meetingId: m.id, ranges: t.ranges })
    if (t.bullets[0]) questions.push({ set: 'paraphrase', text: t.bullets[0].text, meetingId: m.id, ranges: t.ranges })
  }
  for (const a of m.actions) if (a.ranges.length) questions.push({ set: 'action', text: a.text, meetingId: m.id, ranges: a.ranges })
}

// Each cut, with the questions every cut can answer (so runs on different cuts compare question by question).
const cuts = VARIANTS.map(([name, passages]) => ({ name, corpus: chunksOf(lib, [], 'eval', { passages }).filter((c) => c.kind === 'transcript') }))
const relevant = (corpus: Chunk[], q: Question) => new Set(corpus.flatMap((c, i) => (c.meetingId === q.meetingId && q.ranges.some((r) => overlaps(c, r)) ? [i] : [])))
const asked = questions.filter((q) => cuts.every((c) => relevant(c.corpus, q).size))
for (const c of cuts) console.log(`${c.name ? `${c.name}: ` : ''}${c.corpus.length} transcript windows across ${lib.meetings.length} meetings`)
console.log(`${asked.length} queries (${['topic', 'paraphrase', 'action'].map((s) => `${asked.filter((q) => q.set === s).length} ${s}`).join(', ')})\n`)

// ---------- metrics ----------
type Scores = { r1: number; r5: number; r20: number; mrr: number; ndcg: number }
function score(queries: Query[], ranking: number[][], subset: Query[] = queries): Scores {
  let r1 = 0
  let r5 = 0
  let r20 = 0
  let mrr = 0
  let ndcg = 0
  for (const [qi, q] of queries.entries()) {
    if (!subset.includes(q)) continue
    const first = ranking[qi].slice(0, 20).findIndex((d) => q.relevant.has(d))
    if (first === 0) r1++
    if (first >= 0 && first < 5) r5++
    if (first >= 0) r20++
    if (first >= 0 && first < 10) mrr += 1 / (first + 1)
    let dcg = 0
    ranking[qi].slice(0, 10).forEach((d, i) => q.relevant.has(d) && (dcg += 1 / Math.log2(i + 2)))
    let ideal = 0
    for (let i = 0; i < Math.min(10, q.relevant.size); i++) ideal += 1 / Math.log2(i + 2)
    ndcg += dcg / ideal
  }
  const n = subset.length
  return { r1: r1 / n, r5: r5 / n, r20: r20 / n, mrr: mrr / n, ndcg: ndcg / n }
}
// per-question reciprocal rank (the terms of MRR@10), kept for the paired comparisons at the end
const rrOf = (queries: Query[], ranking: number[][]) =>
  queries.map((q, qi) => {
    const first = ranking[qi].slice(0, 10).findIndex((d) => q.relevant.has(d))
    return first >= 0 ? 1 / (first + 1) : 0
  })
const fmt = (s: Scores) => `R@1 ${(s.r1 * 100).toFixed(1).padStart(5)}  R@5 ${(s.r5 * 100).toFixed(1).padStart(5)}  R@20 ${(s.r20 * 100).toFixed(1).padStart(5)}  MRR ${s.mrr.toFixed(3)}  nDCG@10 ${s.ndcg.toFixed(3)}`

// ---------- keyword baseline: BM25 over transcript lines, mapped onto windows ----------
const index = new SearchIndex(lib)
const keywordHits = asked.map((q) => index.related(q.text, { kinds: ['transcript'], limit: 200 }).hits)
const keywordRanking = (corpus: Chunk[]) =>
  keywordHits.map((hits) => {
    const out: number[] = []
    for (const h of hits) {
      const i = corpus.findIndex((c) => c.meetingId === h.meetingId && h.t != null && h.t >= c.t! - 0.5 && h.t <= (c.end ?? c.t!) + 0.5)
      if (i >= 0 && !out.includes(i)) out.push(i)
    }
    return out
  })

// ---------- llama-server helpers ----------
const KEY = randomBytes(12).toString('hex')
async function serve(gguf: string, port: number, extra: string[]): Promise<ChildProcess> {
  const child = spawn('/opt/homebrew/bin/llama-server', ['--model', gguf, '--host', '127.0.0.1', '--port', String(port), '--api-key', KEY, '--no-webui', '--parallel', '4', ...extra], { stdio: ['ignore', 'ignore', 'pipe'] })
  let log = ''
  child.stderr!.on('data', (d) => (log = (log + d).slice(-4000)))
  for (let i = 0; i < 600; i++) {
    const ok = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok).catch(() => false)
    if (ok) return child
    if (child.exitCode !== null) throw new Error(`llama-server exited: ${log}`)
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('llama-server did not become healthy')
}
// A model this script starts for itself, or one that is already being served (with the key it was given).
async function endpointFor(spec: { gguf?: string; url?: string; keyFile?: string }, port: number, extra: string[]): Promise<{ at: Endpoint; child?: ChildProcess }> {
  if (spec.url) return { at: { url: spec.url.replace(/\/+$/, ''), key: spec.keyFile ? (await readFile(spec.keyFile, 'utf8')).trim() : '' } }
  const child = await serve(spec.gguf!, port, extra)
  return { at: { url: `http://127.0.0.1:${port}`, key: KEY }, child }
}
const headers = (at: Endpoint) => ({ 'content-type': 'application/json', ...(at.key ? { authorization: `Bearer ${at.key}` } : {}) })
// resident memory of a model server, the number that decides whether it can stay up all day
const rssGb = (child?: ChildProcess) => {
  if (!child) return NaN
  try {
    return Number(execFileSync('ps', ['-o', 'rss=', '-p', String(child.pid)], { encoding: 'utf8' }).trim()) / 1024 / 1024
  } catch {
    return NaN
  }
}
async function embed(at: Endpoint, texts: string[]): Promise<Float32Array[]> {
  const out: Float32Array[] = []
  for (let i = 0; i < texts.length; i += 16) {
    const res = await fetch(`${at.url}/v1/embeddings`, { method: 'POST', headers: headers(at), body: JSON.stringify({ input: texts.slice(i, i + 16) }) })
    if (!res.ok) throw new Error(`embeddings ${res.status}: ${await res.text()}`)
    const json = (await res.json()) as { data: { index: number; embedding: number[] }[] }
    for (const d of json.data.sort((a, b) => a.index - b.index)) {
      const v = Float32Array.from(d.embedding)
      const n = Math.hypot(...v) || 1
      out.push(v.map((x) => x / n))
    }
  }
  return out
}
const dot = (a: Float32Array, b: Float32Array) => {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}
const rrf = (lists: number[][]) => {
  const s = new Map<number, number>()
  for (const l of lists) l.forEach((d, r) => s.set(d, (s.get(d) ?? 0) + 1 / (60 + r)))
  return [...s.entries()].sort((a, b) => b[1] - a[1]).map(([d]) => d)
}

// ---------- run ----------
type Run = { cut: string; all: Scores; topic: Scores; paraphrase: Scores; action: Scores; seconds?: number; note?: string }
const runs: Record<string, Run> = {}
const rr: Record<string, number[]> = {}
const comparisons: { a: string; b: string; delta: number; lo: number; hi: number; verdict: string }[] = []
const report = (cut: (typeof cuts)[number], queries: Query[], name: string, ranking: number[][], seconds?: number, note?: string) => {
  const all = score(queries, ranking)
  const of = (set: Query['set']) => score(queries, ranking, queries.filter((q) => q.set === set))
  runs[name] = { cut: cut.name, all, topic: of('topic'), paraphrase: of('paraphrase'), action: of('action'), seconds, note }
  rr[name] = rrOf(queries, ranking)
  console.log(`${name.padEnd(56)} ${fmt(all)}${seconds != null ? `   (${seconds.toFixed(0)} s${note ? `, ${note}` : ''})` : ''}`)
}
const tag = (cut: (typeof cuts)[number], name: string) => (cut.name ? `${name} · ${cut.name}` : name)
const queriesOf = (corpus: Chunk[]): Query[] => asked.map((q) => ({ ...q, relevant: relevant(corpus, q) }))

const hybrids: Record<string, { cut: (typeof cuts)[number]; queries: Query[]; ranking: number[][] }> = {}
for (const cut of cuts) report(cut, queriesOf(cut.corpus), tag(cut, 'keyword (BM25)'), keywordRanking(cut.corpus))

let port = 8811
for (const spec of specs) {
  const p = PROMPTS[spec.profile]
  const { at, child } = await endpointFor(spec, port, ['--embedding', '--ctx-size', '8192', '--batch-size', '8192', '--ubatch-size', '2048', ...(spec.args ?? [])])
  try {
    const qs = await embed(at, asked.map((q) => p.q(q.text)))
    for (const cut of cuts) {
      const queries = queriesOf(cut.corpus)
      const t0 = performance.now()
      const docs = await embed(at, cut.corpus.map((c) => p.d(c.title, c.text)))
      const seconds = (performance.now() - t0) / 1000
      const ranking = qs.map((q) => docs.map((d, i) => [i, dot(q, d)] as const).sort((a, b) => b[1] - a[1]).map(([i]) => i))
      report(cut, queries, tag(cut, spec.name), ranking, seconds, `${docs[0].length} dims${child ? `, ${rssGb(child).toFixed(1)} GB resident` : ''}`)
      const keyword = keywordRanking(cut.corpus)
      const name = tag(cut, `${spec.name} + keyword (hybrid)`)
      hybrids[name] = { cut, queries, ranking: ranking.map((r, qi) => rrf([r.slice(0, 100), keyword[qi].slice(0, 100)])) }
      report(cut, queries, name, hybrids[name].ranking)
    }
  } finally {
    child?.kill('SIGTERM')
    port++
  }
}

if (rerankGguf || rerankUrl) {
  // rerank the top 20 of the two best hybrids (the second stage gather_context would use), and of today's cut
  // when it isn't one of them, so a new cut is measured against what runs now at every stage
  const ranked = Object.keys(hybrids).sort((a, b) => runs[b].all.mrr - runs[a].all.mrr)
  const today = ranked.filter((k) => hybrids[k].cut === cuts[0]).slice(0, 1)
  const best = [...new Set([...ranked.slice(0, 2), ...today])]
  const { at, child } = await endpointFor({ gguf: rerankGguf, url: rerankUrl, keyFile: rerankKeyFile }, port, ['--embedding', '--reranking', '--pooling', 'rank', '--ctx-size', '16384', '--batch-size', '8192', '--ubatch-size', '4096'])
  try {
    for (const name of best) {
      const { cut, queries, ranking: base } = hybrids[name]
      // scores are kept per question and passage text, so two cuts that share passages share the work
      const cache = new Map<string, number>()
      const t0 = performance.now()
      let pairs = 0
      const reranked: number[][] = []
      for (const [qi, q] of queries.entries()) {
        const top = base[qi].slice(0, 20)
        const key = (d: number) => `${qi}\0${cut.corpus[d].text}`
        const todo = top.filter((d) => !cache.has(key(d)))
        if (todo.length) {
          pairs += todo.length
          const res = await fetch(`${at.url}/v1/rerank`, { method: 'POST', headers: headers(at), body: JSON.stringify({ query: q.text, documents: todo.map((d) => cut.corpus[d].text) }) })
          if (!res.ok) throw new Error(`rerank ${res.status}: ${await res.text()}`)
          const json = (await res.json()) as { results: { index: number; relevance_score: number }[] }
          for (const r of json.results) cache.set(key(todo[r.index]), r.relevance_score)
        }
        reranked.push([...top.sort((a, b) => cache.get(key(b))! - cache.get(key(a))!), ...base[qi].slice(20)])
      }
      const seconds = (performance.now() - t0) / 1000
      const perQuestion = pairs ? `≈${(seconds / (pairs / 20)).toFixed(1)} s per 20-passage question, ` : ''
      report(cut, queries, name.replace(' + keyword (hybrid)', ' hybrid + rerank'), reranked, seconds, `${pairs} passages scored${child ? `, ${perQuestion}${rssGb(child).toFixed(1)} GB resident` : ''}`)
    }
  } finally {
    child?.kill('SIGTERM')
  }
}

// ---------- which gaps are real? ----------
// Paired bootstrap: resample the questions with replacement and see whether A's lead over B survives.
function compare(a: string, b: string) {
  const diffs = rr[a].map((v, i) => v - rr[b][i])
  const n = diffs.length
  let seed = 20261109
  const rand = () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const means: number[] = []
  for (let k = 0; k < 4000; k++) {
    let s = 0
    for (let i = 0; i < n; i++) s += diffs[Math.floor(rand() * n)]
    means.push(s / n)
  }
  means.sort((x, y) => x - y)
  const delta = diffs.reduce((s, d) => s + d, 0) / n
  const [lo, hi] = [means[100], means[3899]]
  const verdict = lo > 0 ? 'first is better' : hi < 0 ? 'second is better' : 'within noise'
  comparisons.push({ a, b, delta, lo, hi, verdict })
  console.log(`  ${a}\n    vs ${b}:  ΔMRR ${delta >= 0 ? '+' : ''}${delta.toFixed(3)}  (95% CI ${lo.toFixed(3)} to ${hi.toFixed(3)})  ${verdict}`)
}
const byMrr = (keys: string[]) => keys.sort((x, y) => runs[y].all.mrr - runs[x].all.mrr)
const names = Object.keys(runs)
const isKeyword = (k: string) => k.startsWith('keyword (BM25)')
const dense = byMrr(names.filter((k) => !isKeyword(k) && !k.includes('(hybrid)') && !k.includes('rerank')))
const hyb = byMrr(names.filter((k) => k.includes('(hybrid)')))
const rer = byMrr(names.filter((k) => k.includes('rerank')))
console.log('\npaired bootstrap on MRR@10 (4000 resamples of the questions):')
if (dense.length > 1) compare(dense[0], dense[1])
if (hyb.length > 1) compare(hyb[0], hyb[1])
if (hyb.length) compare(hyb[0], names.find((k) => isKeyword(k) && runs[k].cut === runs[hyb[0]].cut)!)
if (rer.length > 1) compare(rer[0], rer[1])
if (rer.length && hyb.length) compare(rer[0], hyb[0])
// every cut against today's, model by model and stage by stage
if (cuts.length > 1)
  for (const spec of specs)
    for (const stage of ['', ' + keyword (hybrid)', ' hybrid + rerank']) {
      const today = tag(cuts[0], `${spec.name}${stage}`)
      if (!runs[today]) continue
      for (const cut of cuts.slice(1)) if (runs[tag(cut, `${spec.name}${stage}`)]) compare(tag(cut, `${spec.name}${stage}`), today)
    }

await mkdir(join(config.dataDir, 'eval'), { recursive: true })
const file = join(config.dataDir, 'eval', `embeddings-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.json`)
await writeFile(file, JSON.stringify({ cuts: cuts.map((c) => ({ name: c.name, windows: c.corpus.length })), queries: asked.length, runs, comparisons, rr }, null, 2))
console.log(`\nsaved ${file}`)
