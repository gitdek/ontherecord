// The one list a settled search shows: keyword hits and passages close in meaning, ranked together.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fuse, rerank, rrf } from './fuse.ts'
import type { Hit, Results } from './search.ts'
import type { Chunk, Reranker } from './semantic.ts'

const hit = (h: Partial<Hit>): Hit => ({ meetingId: 'm1', kind: 'transcript', text: '', marks: [[0, 3]], score: 1, ...h })
const results = (hits: Hit[], more: Partial<Results> = {}): Results => ({ query: 'q', total: hits.length, hits, meetings: [], terms: [], fuzzy: {}, loose: false, unknownPeople: [], badFilters: [], ...more })
const chunk = (c: Partial<Chunk>): Chunk => ({ key: 'k', kind: 'transcript', title: 'Launch planning (transcript)', text: '', meetingId: 'm1', ...c })

test('fuse: a passage that holds a keyword hit lends it its vote; one that holds none gets a row of its own', () => {
  const kw = results([hit({ text: 'the sandbox is ready', t: 70 }), hit({ text: 'a SOC 2 report', t: 250 }), hit({ kind: 'kb', noteId: 'n-1', meetingId: '', text: 'carrier rates' })])
  const near = [
    { chunk: chunk({ t: 240, end: 300, text: 'Acme wants a SOC 2 report before the pilot.' }), score: 0.7 },
    { chunk: chunk({ kind: 'notes', t: 600, title: 'Launch planning: Pricing', text: 'Pricing for the pilot clinic.' }), score: 0.6 },
    { chunk: chunk({ kind: 'kb', noteId: 'n-1', meetingId: undefined, text: 'carrier rates and terms' }), score: 0.5 },
    { chunk: chunk({ t: 900, text: 'too far off to count' }), score: 0.2 },
  ]
  const rows = fuse(kw, near, 0.42)
  assert.equal(rows.length, 4, 'three keyword hits and one passage found by meaning alone')
  // the SOC 2 line was found both ways, so it now leads
  assert.deepEqual([rows[0].text, rows[0].exact, rows[0].meaning], ['a SOC 2 report', true, true])
  assert.equal(rows[0].score, rrf(1) + rrf(0))
  const alone = rows.find((r) => r.title)!
  assert.deepEqual([alone.kind, alone.meaning, alone.exact, alone.marks.length, alone.t], ['note', true, false, 0, 600])
  assert.ok(rows.find((r) => r.noteId === 'n-1')!.meaning, 'the same notebook entry is one row')
  assert.ok(!rows.some((r) => r.text === 'too far off to count'))
})

test('fuse: nothing is called exact when the search had to loosen or guess at a typo', () => {
  assert.equal(fuse(results([hit({ text: 'x' })], { loose: true }), [], 0.42)[0].exact, false)
  assert.equal(fuse(results([hit({ text: 'x' })], { fuzzy: { sandbx: ['sandbox'] } }), [], 0.42)[0].exact, false)
})

test('fuse: the reranker’s order is one more vote, and the list is sorted again', async () => {
  const rows = fuse(results([hit({ text: 'first' }), hit({ text: 'second' }), hit({ text: 'third' })]), [], 0.42)
  // the reranker puts the third first: one vote lifts it past the second, not past the first
  const reranker = { order: async () => [2, 0, 1] } as unknown as Reranker
  assert.equal(await rerank('q', rows, reranker), true)
  assert.deepEqual(rows.map((r) => r.text), ['first', 'third', 'second'])
  const off = { order: async () => undefined } as unknown as Reranker
  assert.equal(await rerank('q', rows, off), false)
})

test('fuse: action wording and board update parts retain separate evidence and share a target', () => {
  const action = { meetingId: 'm1', actionId: 'a1', board: true } as const
  const keyword = results([
    hit({ ...action, kind: 'action', text: 'Order conference badges' }),
    hit({ ...action, kind: 'update', part: 'note', text: 'Badges ship from Leeds' }),
    hit({ ...action, kind: 'update', part: 'evidence', text: 'Badges received' }),
  ])
  const near = [
    { chunk: chunk({ ...action, kind: 'board', text: 'Order conference badges\nNote: Badges ship from Leeds' }), score: 0.8 },
    { chunk: chunk({ ...action, kind: 'board', searchKind: 'action', text: 'Order conference badges' }), score: 0.7 },
  ]
  const rows = fuse(keyword, near, 0.42)
  assert.equal(rows.length, 3)
  assert.deepEqual(rows.map((r) => r.source).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))), [
    { kind: 'action', id: 'a1', part: 'board-wording' },
    { kind: 'action', id: 'a1', part: 'evidence' },
    { kind: 'action', id: 'a1', part: 'note' },
  ])
  assert.deepEqual([...new Set(rows.map((r) => r.link))], ['/actions?show=all&focus=a1'])
  assert.deepEqual(rows.filter((r) => r.meaning).map((r) => r.kind).sort(), ['action', 'update'])
})
