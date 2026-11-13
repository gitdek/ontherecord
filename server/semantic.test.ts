import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { Reranker, Semantic, type Chunk } from './semantic.ts'

const cfg = { url: 'http://127.0.0.1:9999', key: '', model: 'fixture' }
const chunks: Chunk[] = ['a', 'b'].map((letter) => ({ key: letter.repeat(22), kind: 'notes', title: letter, text: letter }))
const data = (...vectors: number[][]) => vectors.map((embedding, index) => ({ embedding, index }))

async function directory(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'meetings-semantic-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

test('reranking accepts a scored permutation and rejects duplicates and invalid scores', async (t) => {
  const reranker = new Reranker(cfg)
  let body = '{"results":[{"index":0,"relevance_score":0.3},{"index":1,"relevance_score":0.8}]}'
  t.mock.method(globalThis, 'fetch', async () => new Response(body))
  assert.deepEqual(await reranker.order('sample', ['a', 'b']), [1, 0])
  for (const invalid of [
    '{"results":[{"index":0,"relevance_score":0.3},{"index":0,"relevance_score":0.8}]}',
    '{"results":[{"index":0,"relevance_score":0.3},{"index":2,"relevance_score":0.8}]}',
    '{"results":[{"index":0,"relevance_score":0.3},{"index":1,"relevance_score":1e999}]}',
    '{"results":[{"index":0,"relevance_score":0.3},{"index":1,"relevance_score":"0.8"}]}',
    '{"results":[{"index":0,"relevance_score":0.3}]}',
  ]) {
    body = invalid
    assert.equal(await reranker.order('sample', ['a', 'b']), undefined)
  }
})

test('embedding batches reject malformed data atomically and order valid vectors by index', async (t) => {
  const dir = await directory(t)
  const semantic = new Semantic(dir, cfg)
  let reply: unknown
  t.mock.method(globalThis, 'fetch', async () => Response.json({ data: reply }))
  for (const invalid of [
    data([1, 0]),
    [data([1, 0])[0], data([0, 1])[0]],
    data([1, 0], [1]),
    data([1, 0], [0, 0]),
    data([1, 0], [1e200, 1e200]),
    [{ embedding: [1, 0], index: 0 }, { embedding: ['1', 0], index: 1 }],
  ]) {
    reply = invalid
    await semantic.sync(chunks)
    assert.equal(semantic.status().embedded, 0)
    assert.ok(semantic.status().error)
  }
  reply = data([1, 0], [0, 1]).reverse()
  await semantic.sync(chunks)
  assert.equal(semantic.status().embedded, 2)
  assert.equal(semantic.status().error, undefined)
  reply = data([1, 0])
  assert.deepEqual((await semantic.query('sample')).map((hit) => hit.chunk.key), chunks.map((c) => c.key))
  reply = data([1, 0, 0])
  assert.deepEqual(await semantic.query('sample'), [])
  assert.match(semantic.status().error!, /dimensions/)
})

test('a failed vector-cache save retries without re-embedding and corrupt loads publish no prefix', async (t) => {
  const dir = await directory(t)
  const file = join(dir, 'vectors', 'fixture.vec')
  await mkdir(`${file}.tmp`, { recursive: true })
  const semantic = new Semantic(dir, cfg)
  const embed = t.mock.method(globalThis, 'fetch', async () => Response.json({ data: data([1, 0], [0, 1]) }))
  await semantic.sync(chunks)
  assert.equal(semantic.status().embedded, 2)
  assert.ok(semantic.status().error)
  await rm(`${file}.tmp`, { recursive: true })
  await semantic.sync(chunks)
  assert.equal(embed.mock.callCount(), 1)
  assert.equal(semantic.status().error, undefined)
  const buf = await readFile(file)
  const intact = new Semantic(dir, cfg)
  await intact.load()
  await intact.sync(chunks)
  assert.equal(embed.mock.callCount(), 1)
  buf.writeFloatLE(NaN, buf.length - 4)
  await writeFile(file, buf)
  const corrupt = new Semantic(dir, cfg)
  await corrupt.load()
  await corrupt.sync(chunks)
  assert.equal(embed.mock.callCount(), 2, 'a malformed second record cannot leave the first cached')
  assert.equal(corrupt.status().embedded, 2)
})

test('model retrieval forwards aborts without marking the index unhealthy', async (t) => {
  const dir = await directory(t)
  const semantic = new Semantic(dir, cfg)
  let abortable = false
  const waitForAbort = async (_url: unknown, options?: RequestInit) => {
    if (!abortable) return Response.json({ data: data([1, 0], [0, 1]) })
    const signal = options!.signal!
    signal.throwIfAborted()
    return new Promise<Response>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  }
  t.mock.method(globalThis, 'fetch', waitForAbort)
  await semantic.sync(chunks)
  abortable = true
  const controller = new AbortController()
  const embedded = semantic.query('sample', { signal: controller.signal })
  const reranked = new Reranker(cfg).order('sample', ['a', 'b'], controller.signal)
  controller.abort()
  await Promise.all([assert.rejects(embedded, { name: 'AbortError' }), assert.rejects(reranked, { name: 'AbortError' })])
  assert.equal(semantic.status().error, undefined)
})

test('a passage the embedding server refuses is set aside, and every passage around it is embedded', async (t) => {
  const dir = await directory(t)
  const inputs: string[][] = []
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    const { input } = JSON.parse(String(init.body)) as { input: string[] }
    inputs.push(input)
    // a server that can't take an input this long answers the whole request with an error
    if (input.some((text) => text.length > 5000)) return new Response('{"error":{"message":"input is too large to process"}}', { status: 500 })
    return Response.json({ data: data(...input.map(() => [1, 0])) })
  })
  const semantic = new Semantic(dir, cfg)
  const passage = (i: number, text = `passage ${i}`, key = `${i}`.padStart(22, 'k')): Chunk => ({ key, kind: 'kb', noteId: `n${i}`, title: `note ${i}`, text })
  // 20 passages, a long table pasted into the notebook as one paragraph, then 40 more (later notes, the board)
  const table = passage(20, '| item | status |\n'.repeat(400))
  const passages = [...Array.from({ length: 20 }, (_, i) => passage(i)), table, ...Array.from({ length: 40 }, (_, i) => passage(21 + i))]
  await semantic.sync(passages)
  assert.deepEqual(semantic.status(), { enabled: true, model: 'fixture', total: 61, embedded: 60, pending: 0, refused: 1 })
  const asked = inputs.length
  for (let change = 0; change < 4; change++) await semantic.sync(passages)
  assert.equal(inputs.length, asked, 'the refused passage is not sent again while it is unchanged')
  assert.equal(semantic.status().refused, 1)
  // edited, it is a new passage (a key is a hash of the text), and goes in
  await semantic.sync(passages.map((c) => (c === table ? passage(20, 'The table, split into its own notes.', 'edited'.padStart(22, 'k')) : c)))
  assert.deepEqual(semantic.status(), { enabled: true, model: 'fixture', total: 61, embedded: 61, pending: 0, refused: 0 })
})

test('a server that refuses everything sets nothing aside, and the passages go in once it recovers', async (t) => {
  const dir = await directory(t)
  let status = 500
  let requests = 0
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    requests++
    const { input } = JSON.parse(String(init.body)) as { input: string[] }
    if (status !== 200) return new Response('{"error":{"message":"failed"}}', { status })
    return Response.json({ data: data(...input.map(() => [1, 0])) })
  })
  const semantic = new Semantic(dir, cfg)
  // failing every request: each passage alone fails, and so does a single word
  await semantic.sync(chunks)
  assert.deepEqual(semantic.status(), { enabled: true, model: 'fixture', total: 2, embedded: 0, pending: 2, refused: 0, error: 'embedding server answered 500' })
  // still loading its model: no passage is tried on its own
  status = 503
  requests = 0
  await semantic.sync(chunks)
  assert.equal(requests, 1)
  assert.deepEqual(semantic.status(), { enabled: true, model: 'fixture', total: 2, embedded: 0, pending: 2, refused: 0, error: 'embedding server answered 503' })
  status = 200
  await semantic.sync(chunks)
  assert.deepEqual(semantic.status(), { enabled: true, model: 'fixture', total: 2, embedded: 2, pending: 0, refused: 0 })
})

test('only the current passages keep a vector in memory', async (t) => {
  const dir = await directory(t)
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    const { input } = JSON.parse(String(init.body)) as { input: string[] }
    if (input.some((text) => text.length > 5000)) return new Response('{"error":{"message":"input is too large to process"}}', { status: 500 })
    return Response.json({ data: data(...input.map(() => [1, 0])) })
  })
  const semantic = new Semantic(dir, cfg)
  const held = semantic as unknown as { vectors: Map<string, Float32Array>; refused: Set<string> }
  const passage = (key: string, text: string): Chunk => ({ key: key.padStart(22, 'k'), kind: 'kb', noteId: 'n1', title: 'note', text })
  // the same passage, edited 50 times (a board note rewritten, a notebook entry appended to, a speaker renamed)
  for (let edit = 0; edit < 50; edit++) await semantic.sync([passage(`${edit}`, `version ${edit}`)])
  assert.deepEqual([semantic.status().total, held.vectors.size], [1, 1])
  // one refused, then both gone: nothing about them stays behind
  await semantic.sync([passage('49', 'version 49'), passage('long', 'x'.repeat(6000))])
  assert.deepEqual([held.vectors.size, held.refused.size], [1, 1])
  await semantic.sync([])
  assert.deepEqual([held.vectors.size, held.refused.size], [0, 0])
})

test('a cache with the previous model dimension rebuilds when valid responses change shape', async (t) => {
  const dir = await directory(t)
  let dim = 2
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    const input = (JSON.parse(String(init.body)) as { input: string[] }).input
    const vector = dim === 2 ? [1, 0] : [1, 0, 0]
    return Response.json({ data: data(...input.map(() => vector)) })
  })
  await new Semantic(dir, cfg).sync(chunks)
  const semantic = new Semantic(dir, cfg)
  await semantic.load()
  await semantic.sync(chunks)
  dim = 3
  assert.deepEqual(await semantic.query('sample'), [])
  // Query starts rebuilding in the background. Let the temporary file promotion complete.
  const file = join(dir, 'vectors', 'fixture.vec')
  for (let i = 0; (await readFile(file)).readUInt32LE(5) !== 3 && i < 100; i++)
    await new Promise((resolve) => setTimeout(resolve, 1))
  assert.equal((await readFile(file)).readUInt32LE(5), 3)
  assert.equal((await semantic.query('sample')).length, 2)
  assert.equal(semantic.status().error, undefined)
})
