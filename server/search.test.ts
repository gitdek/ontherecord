// Keyword search on the synthetic archive: attached documents, words on neighbouring caption lines, filters
// that can't mean anything, the board's own filters, and the notebook swapped in place.
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { hitHref } from '../web/js/palette.js'
import { fuse, grouped } from './fuse.ts'
import { fixtureDir } from './fixtures.test-helper.ts'
import { buildLibrary, scanFiles, type Library } from './library.ts'
import { Notebook, type Note } from './notebook.ts'
import { runTool, type Ctx } from './mcp-tools.ts'
import { sourceLink } from './retrieval-source.ts'
import { meaning } from './retrieval.ts'
import { parseQuery, SearchIndex, tokenize } from './search.ts'
import { chunksOf, Reranker, Semantic, type Chunk } from './semantic.ts'
import { Store } from './state.ts'
import { addAction, allActions, reconcile, updateAction } from './tasks.ts'

const MEETING = '2026-10-02-launch'
let dir: string
let lib: Library
let store: Store

before(async () => {
  dir = await fixtureDir({ index: true })
  // an agenda next to the meeting, and two captions that finish one sentence across a line break
  await writeFile(join(dir, 'Launch planning - 2026-10-02 - agenda.txt'), 'Agenda for the launch.\n\nFirst, the pilot clinic. Then the quarterly roadmap and the holiday freeze.')
  await writeFile(
    join(dir, 'Ada Grace - Launch planning - 2026-10-02 - transcript.json'),
    JSON.stringify({
      text: 'x',
      segments: [
        { id: 0, start: 60, end: 64.2, text: ' Hi Linus, thanks for joining.' },
        { id: 1, start: 300, end: 304, text: ' We could hold the celebration' },
        { id: 2, start: 304.5, end: 308, text: ' party on Friday instead.' },
        { id: 3, start: 400, end: 404, text: ' Something else entirely, the party budget.' },
      ],
    }),
  )
  lib = await buildLibrary(await scanFiles(dir), () => ({}), ['Ada Byron', 'Grace Hopper'], new Map())
  store = new Store(join(await mkdtemp(join(tmpdir(), 'meetings-search-')), 'state.json'))
  await reconcile(lib, store)
})

after(() => rm(dir, { recursive: true, force: true }))

test('search: attached documents are found, each hit linked to its file', () => {
  const index = new SearchIndex(lib)
  const r = index.search('quarterly roadmap', { typing: false })
  const hit = r.hits.find((h) => h.kind === 'doc')!
  const doc = lib.byId.get(MEETING)!.docs[0]
  assert.equal(hit.fileId, doc.id)
  assert.equal(hit.section, doc.name)
  assert.equal(hit.meetingId, MEETING)
  assert.ok(index.search('roadmap in:docs', { typing: false }).hits.every((h) => h.kind === 'doc'))
})

test('search: words on two neighbouring captions are found together, once', () => {
  const index = new SearchIndex(lib)
  const r = index.search('celebration party', { typing: false })
  assert.equal(r.loose, false, 'no fallback to "any of the words"')
  assert.equal(r.total, 1)
  assert.equal(r.hits[0].kind, 'transcript')
  // a caption far away in time is something else, even when it is the next line
  assert.equal(index.search('celebration budget', { typing: false }).loose, true)
})

test('search: a date that is not a date, or a status that does not exist, is reported and matches nothing', () => {
  const index = new SearchIndex(lib)
  for (const [q, bad] of [
    ['pilot after:notadate', 'after:notadate'],
    ['pilot on:2026-02-30', 'on:2026-02-30'],
    ['pilot after:2026-99-01', 'after:2026-99-01'],
    ['pilot before:2026-00-01', 'before:2026-00-01'],
    ['pilot on:2026-02-29', 'on:2026-02-29'],
    ['pilot in:constructor', 'in:constructor'],
    ['pilot status:toString', 'status:toString'],
    ['pilot owner:', 'owner:'],
    ['before:20261001', 'before:20261001'],
    ['status:maybe', 'status:maybe'],
  ]) {
    const r = index.search(q, { typing: false })
    assert.deepEqual([r.total, r.badFilters], [0, [bad]], q)
  }
  assert.deepEqual(index.search('pilot after:2026-10-01', { typing: false }).badFilters, [])
  assert.deepEqual(index.search('on:2028-02-29').badFilters, [])
  assert.deepEqual(parseQuery('status:cancelled status:on-hold owner:ada').status, ['canceled', 'on_hold'])
})

test('search: a word with a colon in a sentence is a word; only a bare filter at the very end is one being typed', () => {
  const index = new SearchIndex(lib)
  for (const text of ['What did we agree on: the pilot scope?', 'Status: waiting on legal', 'Meeting: launch review', 'Who is the owner: Grace or Ada?', 'pricing in: October']) {
    // meaning search gets the whole sentence, and keyword search finds what the words without the colon find
    const query = index.prepare(text)
    assert.deepEqual([query.q.bad, query.valid, query.embeddingText], [[], true, text], text)
    const r = index.search(text, { typing: false })
    const words = index.search(text.replaceAll(':', ''), { typing: false })
    assert.deepEqual([r.badFilters, r.total, r.hits.map((h) => h.text)], [[], words.total, words.hits.map((h) => h.text)], text)
  }
  assert.ok(index.search('What did we agree on: the pilot scope?', { typing: false }).hits.some((h) => h.text === 'Pilot scope'))
  assert.deepEqual(parseQuery('Who is the owner: Grace or Ada?').words, ['who', 'is', 'the', 'owner', 'grace', 'or', 'ada'])
  assert.deepEqual(parseQuery('pilot owner:').bad, ['owner:'])
  assert.deepEqual(parseQuery('owner: Grace').owners, [])
})

test('search: status: and owner: find board items by where they stand now', async () => {
  const [ours, theirs] = allActions(lib, store)
  await store.change(theirs.id, { status: 'done' }, 'Grace')
  await store.change(ours.id, { hold: 'Until the contract is signed' }, 'Ada')
  const index = new SearchIndex(lib, [], allActions(lib, store), (id) => id)
  const done = index.search('status:done', { typing: false })
  assert.deepEqual([...new Set(done.hits.map((h) => h.actionId))], [theirs.id])
  const held = index.search('status:on_hold', { typing: false })
  assert.deepEqual([...new Set(held.hits.map((h) => h.actionId))], [ours.id])
  // owner names a person the way person: does; words still have to match
  const linus = index.search('sandbox owner:linus', { typing: false })
  assert.ok(linus.total > 0 && linus.hits.every((h) => h.actionId === theirs.id))
  assert.equal(index.search('requirements owner:linus', { typing: false }).total, 0)
  // with an item filter, what isn't an item drops out
  assert.ok(index.search('sandbox status:open', { typing: false }).hits.every((h) => h.actionId))
})

test('search: highlights land on the matched word when folding changes the text before it', () => {
  // "…" folds to three dots, "ﬁ" to two letters, and an accent written as a mark of its own folds away
  const texts = ['Wait… the sandbox is ready', 'ﬁnal sandbox', 'Café sandbox']
  const notes = texts.map((body, i): Note => ({ id: `n-000000000${i}`, title: `Entry ${i}`, body, tags: [], meetingIds: [], taskIds: [], author: 'Ada', createdAt: '', updatedAt: '', updatedBy: 'Ada', revisions: [] }))
  const index = new SearchIndex(lib, notes)
  const marked = (q: string) => {
    const hits = new Map(index.search(`${q} in:notebook`, { typing: false }).hits.map((h) => [h.noteId, h.marks.map(([a, b]) => h.text.slice(a, b))]))
    return notes.map((n) => hits.get(n.id))
  }
  assert.deepEqual(marked('sandbox'), [['sandbox'], ['sandbox'], ['sandbox']])
  assert.deepEqual(marked('final'), [undefined, ['ﬁnal'], undefined])
  assert.deepEqual(marked('cafe'), [undefined, undefined, ['Café']])
  // the words are the ones they always were: only where they sit in the text moved
  assert.deepEqual(texts.map((text) => tokenize(text).map((t) => [t.stem, text.slice(t.start, t.end)])), [
    [['wait', 'Wait'], ['the', 'the'], ['sandbox', 'sandbox'], ['is', 'is'], ['ready', 'ready']],
    [['final', 'ﬁnal'], ['sandbox', 'sandbox']],
    [['cafe', 'Café'], ['sandbox', 'sandbox']],
  ])
})

test('search: the notebook is swapped in place, and the board comes through it', async () => {
  const items = allActions(lib, store)
  const index = new SearchIndex(lib, [], items, (id) => id)
  const note: Note = { id: 'n-0000000001', title: 'Carrier comparison', body: 'Freight rates from three carriers.', tags: [], meetingIds: [], taskIds: [], author: 'Ada', createdAt: '', updatedAt: '', updatedBy: 'Ada', revisions: [] }
  assert.equal(index.search('freight', { typing: false }).total, 0)
  index.setNotes([note])
  assert.equal(index.search('freight', { typing: false }).hits[0].noteId, note.id)
  assert.ok(index.search('frei', { typing: true }).total > 0, 'its words are in the vocabulary for prefixes')
  index.setNotes([])
  assert.equal(index.search('freight', { typing: false }).total, 0)
  assert.ok(index.search('status:done', { typing: false }).total > 0, 'the board is still there')
})

test('meaning: what the board wrote on an item is a passage of its own; a plain item adds none', async () => {
  const [ours, theirs, team] = allActions(lib, store)
  await store.change(team.id, { status: 'canceled', reason: 'The follow-up became a standing weekly call' }, 'Grace')
  const board = chunksOf(lib, [], 'm', { board: allActions(lib, store) }).filter((c) => c.kind === 'board')
  const written = board.find((c) => c.actionId === team.id)!
  assert.match(written.text, /^Team: Book the follow-up call\.\nCanceled: The follow-up became a standing weekly call/)
  assert.equal(written.meetingId, MEETING)
  // the item put on hold earlier is there too; the one checked off without a word written on it is not
  assert.ok(board.some((c) => c.actionId === ours.id))
  assert.ok(!board.some((c) => c.actionId === theirs.id))
})

test('keyword and meaning share current board, note, scope, date and lexical filters before top-K', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'meetings-retrieval-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const [open, done, canceled] = allActions(lib, store)
  const note: Note = { id: 'n-filter', title: 'Carrier review', body: 'Blue crane freight.', tags: [], meetingIds: [MEETING], taskIds: [], author: 'Ada', createdAt: '', updatedAt: '', updatedBy: 'Ada', revisions: [] }
  const index = new SearchIndex(lib, [note], [open, done, canceled], (id) => id === 'alias-done' ? done.id : id)
  const document = lib.byId.get(MEETING)!.docs[0]
  const chunk = (key: string, fields: Partial<Chunk>): Chunk => ({ key: key.repeat(22), kind: 'action', title: key, text: 'Blue crane freight.', meetingId: MEETING, ...fields })
  const corpus = [
    chunk('a', { actionId: open.id }),
    chunk('b', { actionId: 'alias-done' }),
    chunk('c', { actionId: canceled.id }),
    chunk('d', { kind: 'kb', noteId: note.id, noteVersion: 1, meetingId: undefined }),
    chunk('e', { kind: 'doc', fileId: document.id }),
    chunk('f', { kind: 'transcript', t: 60, text: 'Blue crane freight and diesel.' }),
  ]
  const requests: string[][] = []
  t.mock.method(globalThis, 'fetch', async (_url: string, options: RequestInit) => {
    const body = JSON.parse(String(options.body)) as { input: string[] }
    requests.push(body.input)
    const vectors = [[1, 0], [0.9, 0.1], [0.8, 0.2], [0.7, 0.3], [0.6, 0.4], [0.5, 0.5]]
    return Response.json({ data: body.input.map((_, index) => ({ index, embedding: vectors[index] })) })
  })
  const semantic = new Semantic(dataDir, { url: 'http://127.0.0.1:9999', model: 'test', key: '' })
  await semantic.sync(corpus)
  const cases: [string, string | undefined][] = [
    ['"blue crane" -diesel status:done owner:linus on:2026-10-02 person:ada in:actions', 'b'],
    ['blue status:on_hold', 'a'],
    ['blue status:canceled', 'c'],
    ['blue status:open', 'a'],
    ['"blue crane" in:notebook after:2026-10-01', 'd'],
    ['"blue crane" in:docs meeting:launch', 'e'],
    ['blue in:transcript -diesel', undefined],
    ['"freight crane" in:docs', undefined],
    ['blue in:docs before:2026-10-01', undefined],
    ['blue in:docs', 'e'],
  ]
  for (const [raw, expected] of cases) {
    const hits = await meaning(semantic, index.prepare(raw), { k: 1 })
    assert.equal(hits[0]?.chunk.key[0], expected, raw)
  }
  assert.deepEqual(requests[1], ['blue crane'])
  const count = requests.length
  for (const raw of ['blue after:2026-99-01', 'blue person:madeup', 'blue in:madeup', 'status:done', 'in:notebook', '-diesel']) {
    assert.deepEqual(await meaning(semantic, index.prepare(raw)), [], raw)
  }
  assert.equal(requests.length, count, 'invalid and filter-only queries do not call the model')
  const aliased = await meaning(semantic, index.prepare('blue status:done'), { k: 1 })
  assert.equal(aliased[0].chunk.actionId, done.id)
  index.setBoard([{ ...open, status: 'done' }, { ...done, status: 'open' }, canceled])
  assert.equal((await meaning(semantic, index.prepare('blue status:done'), { k: 1 }))[0].chunk.actionId, open.id)
  assert.equal(index.search('status:done').hits[0].actionId, open.id)
  index.setNotes([{ ...note, version: 2, body: 'A replacement body.' }])
  assert.deepEqual(await meaning(semantic, index.prepare('blue in:notebook')), [])
  index.setNotes([])
  assert.deepEqual(await meaning(semantic, index.prepare('blue in:notebook')), [])
  index.setBoard([])
  assert.deepEqual(await meaning(semantic, index.prepare('blue in:actions')), [])
})

test('settled search counts semantic-only targets and retains full evidence and precise links', () => {
  const index = new SearchIndex(lib)
  const fileId = lib.byId.get(MEETING)!.docs[0].id
  const keyword = index.search('quarterly roadmap', { typing: false, limit: 1 })
  const text = 'A full synthetic passage. '.repeat(100)
  const chunks: Chunk[] = [
    { key: 'd', kind: 'doc', title: 'Agenda', text, meetingId: MEETING, fileId },
    { key: 'b', kind: 'board', title: 'Board', text, actionId: 'new id' },
    { key: 'n', kind: 'kb', title: 'Notebook', text, noteId: 'n-a' },
    { key: 't', kind: 'transcript', title: 'Meeting', text, t: 15.3, meetingId: MEETING },
  ]
  const rows = fuse(keyword, chunks.map((chunk) => ({ chunk, score: 1 })), 0.42, Infinity)
  assert.equal(rows.length, keyword.hits.length + 3)
  assert.equal(rows[0].link, `/m/${MEETING}?tab=excerpt&file=${fileId}`)
  const board = rows.find((row) => row.actionId)!
  assert.equal(board.board, true)
  assert.deepEqual(board.source, { kind: 'action', id: 'new id', part: 'updates' })
  assert.equal(board.link, '/actions?show=all&focus=new%20id')
  assert.ok(board.text.length <= 360)
  assert.equal(board.evidence, text)
  assert.equal(rows.find((row) => row.kind === 'transcript')!.link, `/m/${MEETING}?t=15.3&tab=transcript`)
  assert.equal(sourceLink({ kind: 'transcript', text: '', meetingId: MEETING, t: 70.04, transcriptId: 'alternate cut' }), `/m/${MEETING}?t=70.04&tab=transcript&transcript=alternate+cut`)
  assert.equal(sourceLink({ kind: 'summary', text: '', meetingId: MEETING }), `/m/${MEETING}?tab=notes`)
  const groups = grouped(keyword, rows, 1)
  assert.equal(groups.hits.length, 1)
  assert.equal(groups.total, keyword.total + 3)
  assert.equal(groups.notebookCount, 1)
  assert.equal(groups.boardCount, 1)
})

test('MCP retrieval shares invalid filters, document links and strict context exclusions', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'meetings-mcp-search-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const index = new SearchIndex(lib, [], allActions(lib, store))
  const semantic = new Semantic(dataDir, { url: '', model: '', key: '' })
  const notebook = new Notebook(join(dataDir, 'notes.json'))
  const ctx = { lib: () => lib, index: () => index, publicUrl: 'https://example.test', store, semantic, reranker: new Reranker({ url: '', key: '' }), notebook } as Ctx
  const viewer = { name: 'Synthetic agent', email: 'agent@example.test', local: false, scope: 'read' as const }
  const run = (name: string, args: Record<string, unknown>) => runTool({ name, arguments: args }, viewer, ctx)

  const malformed = await run('search', { query: 'sandbox on:2026-99-01' })
  assert.deepEqual(JSON.parse(malformed.content[0].text).bad_filters, ['on:2026-99-01'])
  // an agent's pasted work is not a query: a word shaped like a filter in it is a word
  const pasted = await run('find_connections', { text: 'sandbox person:nonexistent' })
  const suggestions = JSON.parse(pasted.content[0].text)
  assert.deepEqual([suggestions.unknown_people, suggestions.meetings.map((m: { id: string }) => m.id)], [undefined, [MEETING]])
  const docs = await run('search', { query: 'quarterly roadmap in:docs' })
  assert.match(JSON.parse(docs.content[0].text).results[0].link, /\?tab=excerpt&file=/)
  const brief = await run('gather_context', { topic: 'in:notes "one clinic" -billing' })
  assert.match(brief.content[0].text, /Start with one clinic/)
  assert.doesNotMatch(brief.content[0].text, /Keep billing out/)
  const documentBrief = await run('gather_context', { topic: 'quarterly roadmap in:docs' })
  assert.match(documentBrief.content[0].text, /\?tab=excerpt&file=/)
})

test('MCP search rechecks keyword and meaning eligibility when the board changes during embedding', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'meetings-mcp-current-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const board = new Store(join(dataDir, 'state.json'))
  await reconcile(lib, board)
  const [requirements, sandbox] = allActions(lib, board)
  await board.change(sandbox.id, { status: 'done' }, 'Grace')
  let index = new SearchIndex(lib, [], allActions(lib, board))
  const semantic = new Semantic(dataDir, { url: 'http://127.0.0.1:9999', model: 'test', key: '' })
  const corpus = chunksOf(lib, [], 'test').filter((c) => c.actionId === requirements.id || c.actionId === sandbox.id)
  let indexing = true
  t.mock.method(globalThis, 'fetch', async () => {
    if (indexing) return Response.json({ data: corpus.map((_, i) => ({ index: i, embedding: [1, 0] })) })
    await board.change(sandbox.id, { status: 'open' }, 'Grace')
    await board.change(requirements.id, { status: 'done' }, 'Grace')
    index = new SearchIndex(lib, [], allActions(lib, board))
    return Response.json({ data: [{ index: 0, embedding: [1, 0] }] })
  })
  await semantic.sync(corpus)
  indexing = false
  const ctx = {
    lib: () => lib, index: () => index, publicUrl: 'https://example.test', store: board,
    semantic, reranker: new Reranker({ url: '', key: '' }), notebook: new Notebook(join(dataDir, 'notes.json')),
  } as Ctx
  const viewer = { name: 'Synthetic agent', email: 'agent@example.test', local: false, scope: 'read' as const }
  const result = await runTool({ name: 'search', arguments: { query: 'sandbox status:done' } }, viewer, ctx)
  const out = JSON.parse(result.content[0].text)
  assert.equal(out.results.some((hit: { action_item?: { id: string } }) => hit.action_item?.id === sandbox.id), false)
  assert.deepEqual(out.related_by_meaning.map((hit: { action_item: { id: string; status: string } }) => hit.action_item), [{ id: requirements.id, status: 'done' }])
})

test('find_connections reads pasted work as plain text: a quotation, a label line, a flag or an @name in it changes nothing', async (t) => {
  // the archive, board and notebook the comparison with main ran on
  const fixture = await fixtureDir({ index: true })
  const dataDir = await mkdtemp(join(tmpdir(), 'meetings-connections-'))
  t.after(() => Promise.all([fixture, dataDir].map((path) => rm(path, { recursive: true, force: true }))))
  const archive = await buildLibrary(await scanFiles(fixture), () => ({}), ['Ada Byron', 'Grace Hopper'], new Map())
  const board = new Store(join(dataDir, 'state.json'))
  await reconcile(archive, board)
  const [first, second, third] = allActions(archive, board)
  await updateAction(archive, board, first.id, { status: 'done', evidence: 'Sent on Oct 4', sources: [{ meeting_id: MEETING, at: '02:10' }] }, 'Ada')
  await updateAction(archive, board, second.id, { status: 'canceled', reason: 'Linus left the project', replacedBy: third.id }, 'Ada')
  await updateAction(archive, board, third.id, { hold: 'Waiting for the sandbox keys' }, 'Ada')
  await addAction(archive, board, { text: 'Send the pilot contract', owner: 'Grace', meetingId: MEETING }, 'Ada')
  const notebook = new Notebook(join(dataDir, 'notes.json'))
  const lookups = { meeting: (id: string) => archive.byId.get(id)?.id, task: (id: string) => id }
  const note = await notebook.create({ title: 'Pilot pricing research', body: 'Acme wants per-clinic pricing.\n\nThe Widget API sandbox is free during the pilot.', meetingIds: [MEETING] }, 'Ada', lookups)
  const index = new SearchIndex(archive, notebook.list(), allActions(archive, board))
  const ctx = { lib: () => archive, index: () => index, publicUrl: 'https://example.test', store: board, semantic: new Semantic(dataDir, { url: '', model: '', key: '' }), reranker: new Reranker({ url: '', key: '' }), notebook } as Ctx
  const viewer = { name: 'Synthetic agent', email: 'agent@example.test', local: false, scope: 'read' as const }
  const connect = async (text: string) => JSON.parse((await runTool({ name: 'find_connections', arguments: { text } }, viewer, ctx)).content[0].text)
  const base = 'Research notes on the Widget API pilot with Acme: the sandbox and the SOC 2 report.'
  const every = allActions(archive, board).map((a) => a.id).sort()
  for (const text of [
    base,
    `${base} Their lead wrote "we can open the sandbox next week".`,
    `${base}\nStatus: waiting on legal.`,
    `${base} Posted for @here in the channel.`,
    'Widget API pilot follow-up\nOwner: Grace\nStatus: waiting on Acme\nNext: send the requirements and the sandbox credentials process.',
    'Acme asked for "per-clinic pricing" before the Widget API pilot, and wants the sandbox credentials process first.',
    'Ran ops/install.sh --dry-run for the Widget API pilot sandbox; note -Werror stays off. Acme sandbox credentials next.',
  ]) {
    const r = await connect(text)
    // what main suggested for each of these: the meeting, the note and every item on the board
    assert.deepEqual([r.meetings.map((m: { id: string }) => m.id), r.notebook.map((n: { id: string }) => n.id), r.action_items.map((a: { id: string }) => a.id).sort()], [[MEETING], [note.id], every], text)
    assert.deepEqual([r.bad_filters, r.unknown_people], [undefined, undefined], text)
  }
  // words a query would drop or require are matched like any other: a quoted word, a negated one, a label
  assert.ok((await connect('Their lead wrote "billing" and -billing twice')).matched_terms.includes('billing'))
})

test('a long paste holding a quotation costs what any long paste costs', async (t) => {
  // an archive of today's size: 8 meetings of 600 caption lines, 48,000 words, from a made-up vocabulary
  const dir = await mkdtemp(join(tmpdir(), 'meetings-cost-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  let seed = 7
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
  const made = () => Array.from({ length: 3 + Math.floor(rand() * 8) }, () => 'abcdefghijklmnopqrstuvwxyz'[Math.floor(rand() * 26)]).join('')
  const vocabulary = Array.from({ length: 9000 }, made)
  const word = () => vocabulary[Math.floor(vocabulary.length * rand() ** 3)]
  const words = (n: number) => Array.from({ length: n }, word).join(' ')
  for (let m = 0; m < 8; m++) {
    const segments = Array.from({ length: 600 }, (_, i) => ({ id: i, start: i * 5, end: i * 5 + 4.5, text: ` ${words(10)}` }))
    await writeFile(join(dir, `Meeting ${m} - 2026-10-0${m + 1} - transcript.json`), JSON.stringify({ text: 'x', segments }))
  }
  const big = await buildLibrary(await scanFiles(dir), () => ({}), [], new Map())
  const index = new SearchIndex(big, [], [])
  const ctx = { lib: () => big, index: () => index, publicUrl: 'https://example.test', store: new Store(join(dir, 'state.json')), semantic: new Semantic(dir, { url: '', model: '', key: '' }), reranker: new Reranker({ url: '', key: '' }), notebook: new Notebook(join(dir, 'notes.json')) } as Ctx
  const viewer = { name: 'Synthetic agent', email: 'agent@example.test', local: false, scope: 'read' as const }
  // a third of the paste is words the archive has never seen
  const paste = `The lead wrote "${words(5)}". ${Array.from({ length: 8000 }, (_, i) => (i % 3 ? word() : made())).join(' ')}`.slice(0, 45_000)
  assert.equal(paste.length, 45_000)
  const started = performance.now()
  const r = JSON.parse((await runTool({ name: 'find_connections', arguments: { text: paste } }, viewer, ctx)).content[0].text)
  const took = performance.now() - started
  assert.equal(r.meetings.length, 8)
  // about 5 ms here; reading every word of it as one search took seconds
  assert.ok(took < 250, `find_connections took ${Math.round(took)} ms`)
  // nor does a long text read as a query, phrase and all, go to the full search however it reaches related()
  const parsed = performance.now()
  index.related(index.prepare(paste), { limit: 150 })
  const tookRelated = performance.now() - parsed
  assert.ok(tookRelated < 250, `related() took ${Math.round(tookRelated)} ms`)
})

test('an action item from the notes links to the moment it was agreed; what the board holds links to its card', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'meetings-links-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const board = new Store(join(dataDir, 'state.json'))
  await reconcile(lib, board)
  const requirements = allActions(lib, board).find((a) => a.text.startsWith('Write the Widget API requirements'))!
  const credentials = allActions(lib, board).find((a) => a.text.startsWith('Share sandbox credentials'))!
  const added = await addAction(lib, board, { text: 'Rent the espresso cart', owner: 'Grace', meetingId: MEETING }, 'Ada')
  const index = new SearchIndex(lib, [], allActions(lib, board))
  const moment = `/m/${MEETING}?t=120&tab=notes`
  const card = (id: string) => `/actions?show=all&focus=${id}`
  // the palette while typing, and the search page once settled, by keyword or by meaning alone
  const typed = index.search('requirements', { typing: true }).hits.find((h) => h.kind === 'action')!
  assert.deepEqual([typed.actionId, typed.board, typed.t, typed.link, hitHref(typed, 'Widget API')], [requirements.id, undefined, 120, moment, moment])
  const byMeaning: Chunk = { key: 'k'.repeat(22), kind: 'action', searchKind: 'action', title: 'Launch planning: Action items', text: 'Linus: Share sandbox credentials process.', meetingId: MEETING, t: 300, actionId: credentials.id }
  const rows = fuse(index.search('requirements', { typing: false }), [{ chunk: byMeaning, score: 0.9 }], 0.42)
  const linked = new Map(rows.filter((r) => r.actionId).map((r) => [r.actionId, [r.meaning, r.link]]))
  assert.deepEqual([linked.get(requirements.id), linked.get(credentials.id)], [[false, moment], [true, `/m/${MEETING}?t=300&tab=notes`]])
  // a task added on the board, and what the board says about an item, open the item's card
  const task = index.search('espresso', { typing: false }).hits[0]
  assert.deepEqual([task.actionId, task.board, task.link, hitHref(task, 'espresso')], [added.id, true, card(added.id), card(added.id)])
  const boardRow = fuse(index.search('zzqvxjzwxxqv', { typing: false }), [{ chunk: { ...byMeaning, kind: 'board', searchKind: 'update', text: 'Linus: Share sandbox credentials process.\nNote: sent' }, score: 0.9 }], 0.42)[0]
  assert.equal(boardRow.link, card(credentials.id))

  // what agents get: the moment in link, the card in board_link, and both on the brief's line
  const semantic = new Semantic(dataDir, { url: 'http://127.0.0.1:9999', model: 'test', key: '' })
  t.mock.method(globalThis, 'fetch', async (_url: string, options: RequestInit) => Response.json({ data: (JSON.parse(String(options.body)).input as string[]).map((_, i) => ({ index: i, embedding: [1, 0] })) }))
  await semantic.sync(chunksOf(lib, [], 'test').filter((c) => c.actionId === requirements.id))
  const ctx = { lib: () => lib, index: () => index, publicUrl: 'https://example.test', store: board, semantic, reranker: new Reranker({ url: '', key: '' }), notebook: new Notebook(join(dataDir, 'notes.json')) } as Ctx
  const viewer = { name: 'Synthetic agent', email: 'agent@example.test', local: false, scope: 'read' as const }
  const run = async (name: string, args: Record<string, unknown>) => (await runTool({ name, arguments: args }, viewer, ctx)).content
  const found = JSON.parse((await run('search', { query: 'Widget API requirements' }))[0].text)
  const line = found.results.find((r: { action_item?: { id: string } }) => r.action_item?.id === requirements.id)
  assert.deepEqual([line.at, line.link, line.board_link], ['2:00', `https://example.test${moment}`, `https://example.test${card(requirements.id)}`])
  const near = found.related_by_meaning.find((r: { action_item?: { id: string } }) => r.action_item?.id === requirements.id)
  assert.deepEqual([near.link, near.board_link], [`https://example.test${moment}`, `https://example.test${card(requirements.id)}`])
  const cart = JSON.parse((await run('search', { query: 'espresso cart' }))[0].text).results[0]
  assert.deepEqual([cart.link, cart.board_link], [`https://example.test${card(added.id)}`, undefined])
  const [brief] = await run('gather_context', { topic: 'Widget API requirements' })
  assert.ok(brief.text.split('\n').includes(`- [open] Ada/Grace: Write the Widget API requirements and send them to Linus. ([2:00](https://example.test/m/${MEETING}?t=120), [board item](https://example.test${card(requirements.id)}))`), brief.text)
})

test('-"two words" leaves out what holds the phrase, by keyword, by meaning and in a brief', async (t) => {
  const fixture = await fixtureDir({ index: true })
  const dataDir = await mkdtemp(join(tmpdir(), 'meetings-not-phrase-'))
  t.after(() => Promise.all([fixture, dataDir].map((path) => rm(path, { recursive: true, force: true }))))
  const archive = await buildLibrary(await scanFiles(fixture), () => ({}), ['Ada Byron', 'Grace Hopper'], new Map())
  const index = new SearchIndex(archive)
  const texts = (q: string) => index.search(q, { typing: false }).hits.map((h) => h.text).sort()
  const without = ['Ada will write the requirements for the sandbox access.', 'Linus: Share sandbox credentials process.']
  assert.deepEqual(texts('sandbox -"widget api"'), without)
  assert.deepEqual(texts('sandbox -"Widget API'), without, 'an unclosed quote runs to the end, as a phrase does')
  assert.deepEqual([texts('sandbox -widget'), texts('sandbox -"widget"')], [without, without])
  assert.deepEqual(texts('sandbox "widget api"'), ['Start with one clinic and the Widget API sandbox.', 'The Widget API sandbox is ready next week.'])
  // the words have to come together, as in a phrase that is asked for
  const billing = index.prepare('pilot -"keep billing"')
  assert.deepEqual([billing.passesExclusions('Keep billing out of the pilot.'), billing.passesExclusions('Keep the billing out of the pilot.')], [false, true])
  // meaning search reads only the words, and drops a passage that holds the phrase
  const query = index.prepare('sandbox -"widget api"')
  assert.equal(query.embeddingText, 'sandbox')
  const passage = (text: string): Chunk => ({ key: 'p'.repeat(22), kind: 'transcript', title: 'Launch planning (transcript)', text, meetingId: MEETING, t: 70 })
  assert.equal(query.chunk(passage('Ada Byron: The Widget API sandbox is ready next week.')), undefined)
  assert.ok(query.chunk(passage('Ada Byron: The sandbox is ready, and the widget has an API.')))
  // and so does a brief
  const store = new Store(join(dataDir, 'state.json'))
  await reconcile(archive, store)
  const ctx = { lib: () => archive, index: () => index, publicUrl: 'https://example.test', store, semantic: new Semantic(dataDir, { url: '', model: '', key: '' }), reranker: new Reranker({ url: '', key: '' }), notebook: new Notebook(join(dataDir, 'notes.json')) } as Ctx
  const viewer = { name: 'Synthetic agent', email: 'agent@example.test', local: false, scope: 'read' as const }
  const [brief] = (await runTool({ name: 'gather_context', arguments: { topic: 'sandbox -"widget api"' } }, viewer, ctx)).content
  assert.match(brief.text, /Share sandbox credentials process/)
  assert.doesNotMatch(brief.text, /Widget API sandbox/)
})

test('a search made only of small words looks for them, and nothing else about a search changes', () => {
  const index = new SearchIndex(lib)
  const texts = (q: string) => index.search(q, { typing: false }).hits.map((h) => h.text).sort()
  // no line has all of "one on one", so the lines that hold some of them are found, and the answer says so
  const r = index.search('one on one', { typing: false })
  assert.deepEqual([r.loose, r.hits.map((h) => h.text).sort()], [true, ['Start with one clinic and the Widget API sandbox.', 'party on Friday instead.']])
  assert.ok(texts('to do').length > 0 && texts('to do').every((t) => /\bto\b|\bdo\b/i.test(t)))
  // with a filter, small words are left out as before, so the filter's own listing comes back
  assert.deepEqual(texts('one on one in:notes'), texts('in:notes'))
  assert.deepEqual(texts('to do person:ada'), texts('person:ada'))
  // a word that says something still outweighs the small ones
  assert.deepEqual(texts('one on one clinic'), texts('clinic'))
})

test('person: takes a full name or a last name, says who a shared name could be, and one person written two ways is one', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'meetings-people-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const notes = (title: string, date: string, who: string) => `MEETING NOTES: ${title}\n${date} | Recording: 20:00\nParticipants visible in recording: ${who}.\n\nSUMMARY\nThe pricing for the pilot was discussed.\n`
  await writeFile(join(dir, 'Pricing review - 2026-10-02 - notes.txt'), notes('Pricing review', 'October 2, 2026', 'Ada Byron, William Byron'))
  await writeFile(join(dir, 'Pilot sync - 2026-10-09 - notes.txt'), notes('Pilot sync', 'October 9, 2026', 'Ada Lovelace, Bill Byron'))
  await writeFile(join(dir, 'Launch - 2026-10-16 - notes.txt'), notes('Launch', 'October 16, 2026', 'Grace Hopper, Linus Pauling'))
  const archive = await buildLibrary(await scanFiles(dir), () => ({}), ['Grace Hopper'], new Map())
  const index = new SearchIndex(archive)
  const meetings = (q: string) => index.search(q, { typing: false }).meetings.map((m) => m.id).sort()
  const [review, sync] = ['2026-10-02-pricing-review', '2026-10-09-pilot-sync']
  // two people called Ada: the full name, or a last name nobody else has, names one of them
  assert.deepEqual([meetings('pricing person:ada-byron'), meetings('pricing person:Ada-Byron'), meetings('pricing person:lovelace')], [[review], [review], [sync]])
  // the first name alone could be either, so the answer says who they are and finds nothing until one is named
  const ada = index.search('pricing person:ada', { typing: false })
  assert.deepEqual([ada.total, ada.unknownPeople, ada.ambiguousPeople], [0, [], [{ name: 'ada', ids: ['ada-byron', 'ada-lovelace'] }]])
  assert.deepEqual([index.prepare('@ada pricing').ambiguousPeople, index.prepare('@ada pricing').valid], [ada.ambiguousPeople, false])
  // William Byron in one meeting and Bill Byron in the other are one person, by any of their names
  for (const q of ['pricing person:bill', 'pricing person:william', 'pricing person:bill-byron', 'pricing person:william-byron']) assert.deepEqual(meetings(q), [review, sync], q)
  // a name the archive has once still names that one person, and a name nobody has is still nobody
  assert.deepEqual([meetings('pricing person:grace'), index.search('pricing person:zed', { typing: false }).unknownPeople], [['2026-10-16-launch'], ['zed']])
  // agents get the same answer, with who each one is
  const dataDir = await mkdtemp(join(tmpdir(), 'meetings-people-data-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const ctx = { lib: () => archive, index: () => index, publicUrl: 'https://example.test', store: new Store(join(dataDir, 'state.json')), semantic: new Semantic(dataDir, { url: '', model: '', key: '' }), reranker: new Reranker({ url: '', key: '' }), notebook: new Notebook(join(dataDir, 'notes.json')) } as Ctx
  const viewer = { name: 'Synthetic agent', email: 'agent@example.test', local: false, scope: 'read' as const }
  const found = JSON.parse((await runTool({ name: 'search', arguments: { query: 'pricing person:ada' } }, viewer, ctx)).content[0].text)
  assert.deepEqual([found.total, found.unknown_people, found.ambiguous_people], [0, undefined, [{ name: 'ada', people: [{ id: 'ada-byron', name: 'Ada Byron' }, { id: 'ada-lovelace', name: 'Ada Lovelace' }] }]])
  const brief = JSON.parse((await runTool({ name: 'gather_context', arguments: { topic: 'pricing person:ada' } }, viewer, ctx)).content[1].text)
  assert.deepEqual(brief.ambiguous_people, found.ambiguous_people)
})

test('an archive lists its own nicknames in its index file, so a first name spelt two ways is one person', async (t) => {
  const notes = (title: string, date: string, who: string) => `MEETING NOTES: ${title}\n${date} | Recording: 20:00\nParticipants visible in recording: ${who}.\n\nSUMMARY\nThe pricing for the pilot was discussed.\n`
  const archiveWith = async (index?: object, first = 'Sonja Byron', second = 'Sonia Byron') => {
    const dir = await mkdtemp(join(tmpdir(), 'meetings-nicknames-'))
    t.after(() => rm(dir, { recursive: true, force: true }))
    await writeFile(join(dir, 'Pricing review - 2026-10-02 - notes.txt'), notes('Pricing review', 'October 2, 2026', `${first}, Grace Hopper`))
    await writeFile(join(dir, 'Pilot sync - 2026-10-09 - notes.txt'), notes('Pilot sync', 'October 9, 2026', `${second}, Grace Hopper`))
    if (index) await writeFile(join(dir, 'meetings-index.json'), JSON.stringify(index))
    const archive = await buildLibrary(await scanFiles(dir), () => ({}), ['Grace Hopper'], new Map())
    const search = new SearchIndex(archive)
    return { archive, meetings: (q: string) => search.search(q, { typing: false }).meetings.map((m) => m.id).sort() }
  }
  const [review, sync] = ['2026-10-02-pricing-review', '2026-10-09-pilot-sync']
  // nothing listed: two spellings are two people
  const plain = await archiveWith()
  assert.deepEqual([plain.meetings('pricing person:sonja'), plain.meetings('pricing person:sonia')], [[review], [sync]])
  // listed: either spelling finds both meetings, and what the index can't mean is left out without a fuss
  const listed = await archiveWith({ sessions: [], nicknames: { Sonja: ['Sonia', 'sonia', 'S0nia', 7], will: 5, 'two words': ['x'], michael: ['mick'] } })
  for (const q of ['pricing person:sonja', 'pricing person:sonia', 'pricing person:sonia-byron']) assert.deepEqual(listed.meetings(q), [review, sync], q)
  assert.deepEqual(listed.archive.people.byId.get('sonja-byron')?.aliases, ['sonja', 'sonia'])
  assert.deepEqual(listed.archive.cautions, plain.archive.cautions)
  // a listed name adds to the ones every archive knows
  const both = await archiveWith({ sessions: [], nicknames: { william: ['liam'] } }, 'William Byron', 'Liam Byron')
  assert.deepEqual(both.archive.people.byId.get('william-byron')?.aliases, ['william', 'bill', 'liam'])
  assert.deepEqual([both.meetings('pricing person:liam'), both.meetings('pricing person:bill')], [[review, sync], [review, sync]])
})

test('a quoted phrase runs on across a caption break, and filters read what was said, not who said it', async (t) => {
  const fixture = await fixtureDir({ index: true })
  t.after(() => rm(fixture, { recursive: true, force: true }))
  // a caption export where one speaker finishes the sentence on the next caption
  await writeFile(join(fixture, 'Ada Grace - Launch planning - 2026-10-02 - transcript.txt'), [
    '00:05:00.000 --> 00:05:04.000', 'Ada Byron: We could hold the launch celebration', '',
    '00:05:06.500 --> 00:05:09.000', 'Ada Byron: party on Friday instead, with the whole team and the customers.', '',
    '00:05:12.000 --> 00:05:16.000', 'Grace Hopper: Fine, and we invite the pilot clinic staff as well.', '',
  ].join('\n'))
  await rm(join(fixture, 'Ada Grace - Launch planning - 2026-10-02 - transcript.json'))
  const archive = await buildLibrary(await scanFiles(fixture), () => ({}), ['Ada Byron', 'Grace Hopper'], new Map())
  const index = new SearchIndex(archive)
  const [passage] = chunksOf(archive, [], 'm').filter((c) => c.kind === 'transcript')
  // what is embedded keeps the speakers' names
  assert.match(passage.text, /celebration Ada Byron: party/)
  // the phrase is found once by keyword, on the line where it starts, and the passage holds it
  assert.deepEqual(index.search('"celebration party"', { typing: false }).hits.map((h) => h.text), ['We could hold the launch celebration'])
  assert.deepEqual(index.search('friday "celebration party"', { typing: false }).hits.map((h) => h.text), ['party on Friday instead, with the whole team and the customers.'])
  assert.ok(index.prepare('"celebration party"').chunk(passage))
  // a name left out is a word nobody said here, on both sides: Grace's own line stays
  assert.deepEqual(index.search('pilot clinic -grace', { typing: false }).hits.filter((h) => h.kind === 'transcript').map((h) => h.text), ['Fine, and we invite the pilot clinic staff as well.'])
  assert.ok(index.prepare('pilot clinic -grace').chunk(passage))
  // a word that was said still leaves the line and the passage out
  assert.deepEqual([index.search('pilot clinic -staff', { typing: false }).hits.filter((h) => h.kind === 'transcript'), index.prepare('pilot clinic -staff').chunk(passage)], [[], undefined])
  // across a long pause the next caption is something else, for a phrase as for words
  const other = new SearchIndex(lib)
  assert.deepEqual([other.search('"celebration party"', { typing: false }).total, other.search('"instead something"', { typing: false }).total], [1, 0])
})
