import assert from 'node:assert/strict'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { setImmediate, setTimeout } from 'node:timers/promises'
import { createApp, type App } from './app.ts'
import { configFrom } from './config.ts'
import { fixtureDir, requestApp, RouteResponse } from './fixtures.test-helper.ts'

async function fixtureApp(t: TestContext, settings: Record<string, string> = {}, document?: string) {
  const dir = await realpath(await fixtureDir({ index: true }))
  const data = await mkdtemp(join(tmpdir(), 'meetings-routes-'))
  let app: App | undefined
  t.after(async () => {
    await app?.close()
    await Promise.all([dir, data].map((path) => rm(path, { recursive: true, force: true })))
  })
  if (document) {
    const indexPath = join(dir, 'meetings-index.json')
    const index = JSON.parse(await readFile(indexPath, 'utf8'))
    const name = 'Launch planning - excerpt.txt'
    index.sessions[0].additional_excerpt = name
    await writeFile(join(dir, name), document)
    await writeFile(indexPath, JSON.stringify(index))
  }
  app = await createApp(configFrom({
    PORT: '8798',
    MEETINGS_DIR: dir,
    DATA_DIR: data,
    CREW: 'Ada Byron,Grace Hopper',
    LOCAL_USER: 'Ada',
    DIARIZE_PYTHON: '',
    ...settings,
  }), { watch: false, backups: false })
  await app.start()
  return app
}

const semanticSettings = { EMBED_URL: 'http://embeddings.invalid', EMBED_MODEL: 'fixture' }
const vectorReply = (inputs: string[]) => Response.json({ data: inputs.map((_, index) => ({ index, embedding: [1, 0] })) })
const modelReply = () => new Response('data: {"choices":[{"delta":{"content":"See [1]."}}]}\n\ndata: [DONE]\n\n')
const withQuery = (path: string, q: string) => `${path}?q=${encodeURIComponent(q)}`
const mcpSearch = (app: App, q: string) => requestApp(app, '/mcp/readonly', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search', arguments: { query: q } } })

async function waitForEmbeddings(app: App) {
  for (let i = 0; i < 200; i++) {
    const { semantic } = (await requestApp(app, '/api/notebook')).json()
    if (semantic.embedded > 0 && semantic.pending === 0 && !semantic.error) return
    await setTimeout(10)
  }
  assert.fail('fixture vectors were not indexed')
}

test('request boundary returns a client error for an invalid URL and continues serving requests', async (t) => {
  const app = await fixtureApp(t)
  const invalid = await requestApp(app, 'http://')
  assert.equal(invalid.statusCode, 400)
  assert.deepEqual(invalid.json(), { error: 'malformed address' })
  const good = await requestApp(app, '/api/library')
  assert.equal(good.statusCode, 200)
  assert.ok(good.json().meetings.length > 0)
})

test('search, Follow, Ask and MCP honor the same board filters and current status', async (t) => {
  const inputs: string[] = []
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    if (url === 'http://ask.invalid/v1/chat/completions') return modelReply()
    assert.equal(url, 'http://embeddings.invalid/v1/embeddings')
    const request = JSON.parse(String(init.body)) as { input: string[] }
    inputs.push(...request.input)
    return vectorReply(request.input)
  })
  const app = await fixtureApp(t, { ...semanticSettings, ASK_URL: 'http://ask.invalid' })
  const first = (await requestApp(app, '/api/tasks', { text: 'Prepare the Monday packet', owner: 'Ada', meetingId: '2026-10-02-launch' })).json().action
  const second = (await requestApp(app, '/api/tasks', { text: 'Print the Thursday agenda', owner: 'Ada', meetingId: '2026-10-02-launch' })).json().action
  assert.equal((await requestApp(app, `/api/actions/${first.id}`, { status: 'done' })).statusCode, 200)
  await waitForEmbeddings(app)

  const q = 'status:done release calendar'
  const web = (await requestApp(app, `${withQuery('/api/search', q)}&typing=0`)).json()
  assert.equal(web.total, 1)
  assert.deepEqual(web.fused.map((row: { actionId: string }) => row.actionId), [first.id])
  assert.deepEqual(web.hits.map((row: { actionId: string }) => row.actionId), [first.id])
  assert.equal(web.fused[0].link, `/actions?show=all&focus=${first.id}`)
  assert.equal(web.fused[0].evidence, undefined)

  const follow = (await requestApp(app, withQuery('/api/follow', q))).json()
  assert.deepEqual(follow.items.map((item: { id: string }) => item.id), [first.id])
  const [ask] = (await requestApp(app, '/api/ask', { question: q })).events()
  assert.deepEqual(ask.sources.map((source: { actionId: string }) => source.actionId), [first.id])
  assert.equal(ask.sources[0].link, web.fused[0].link)

  const mcp = (await mcpSearch(app, q)).json().result.structuredContent
  assert.deepEqual(mcp.related_by_meaning.map((hit: { action_item: { id: string } }) => hit.action_item.id), [first.id])
  assert.ok(inputs.some((text) => text.includes('release calendar')))
  assert.ok(!inputs.some((text) => text.includes('status:done')))

  assert.equal((await requestApp(app, `/api/actions/${first.id}`, { status: 'open' })).statusCode, 200)
  assert.equal((await requestApp(app, `/api/actions/${second.id}`, { status: 'done' })).statusCode, 200)
  const updated = (await requestApp(app, `${withQuery('/api/search', q)}&typing=0`)).json()
  assert.deepEqual(updated.fused.map((row: { actionId: string }) => row.actionId), [second.id])

  for (const filter of ['after:2026-99-01', 'person:never-seen']) {
    const bad = `${filter} release calendar`
    const before = inputs.length
    const invalid = (await requestApp(app, `${withQuery('/api/search', bad)}&typing=0`)).json()
    assert.deepEqual(invalid.hits, [])
    assert.deepEqual((await requestApp(app, withQuery('/api/follow', bad))).json().items, [])
    assert.deepEqual((await mcpSearch(app, bad)).json().result.structuredContent.related_by_meaning, [])
    assert.deepEqual((await requestApp(app, '/api/ask', { question: bad })).events()[0].sources, [])
    assert.equal(inputs.length, before)
  }
})

test('Follow lists every meeting a topic came up in, however often the others mention it', async (t) => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'meetings-follow-')))
  const data = await mkdtemp(join(tmpdir(), 'meetings-follow-data-'))
  let app: App | undefined
  t.after(async () => {
    await app?.close()
    await Promise.all([dir, data].map((path) => rm(path, { recursive: true, force: true })))
  })
  // eight meetings that each name the client 40 times; the first four in long sentences, which rank lower
  const dates: string[] = []
  for (let m = 0; m < 8; m++) {
    const text = m < 4 ? ' We went over what Acme said about the regional distributors and the margin for this year.' : ' Acme called again today.'
    const segments = Array.from({ length: 40 }, (_, i) => ({ id: i, start: i * 30, end: i * 30 + 6, text }))
    const date = new Date(Date.UTC(2026, 9, 1 + m * 4)).toISOString().slice(0, 10)
    dates.push(date)
    await writeFile(join(dir, `Weekly ${m} - ${date} - transcript.json`), JSON.stringify({ text: 'x', segments }))
  }
  app = await createApp(configFrom({ PORT: '8798', MEETINGS_DIR: dir, DATA_DIR: data, CREW: '', LOCAL_USER: 'Ada', DIARIZE_PYTHON: '' }), { watch: false, backups: false })
  await app.start()
  const followed = (await requestApp(app, withQuery('/api/follow', 'acme'))).json()
  assert.deepEqual(followed.meetings.map((m: { date: string }) => m.date), dates, 'every meeting, oldest first')
  for (const m of followed.meetings) assert.deepEqual([m.count, m.moments.length], [40, 5], m.date)
})

test('a semantic document opens the specific file and Ask receives evidence beyond the excerpt', async (t) => {
  const ending = 'The final recommendation is a seven-day review.'
  const document = `Workshop handout\n${'This section records discussion and background. '.repeat(12)}${ending}`
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    if (url === 'http://ask.invalid/v1/chat/completions') return modelReply()
    assert.equal(url, 'http://embeddings.invalid/v1/embeddings')
    return vectorReply(JSON.parse(String(init.body)).input)
  })
  const app = await fixtureApp(t, { ...semanticSettings, ASK_URL: 'http://ask.invalid' }, document)
  await waitForEmbeddings(app)
  const q = 'in:docs conference itinerary'
  const search = (await requestApp(app, `${withQuery('/api/search', q)}&typing=0`)).json()
  assert.equal(search.total, 1)
  const [row] = search.fused
  assert.equal(row.source.kind, 'document')
  assert.match(row.link, /^\/m\/2026-10-02-launch\?tab=excerpt&file=/)
  assert.ok(!row.text.includes(ending))
  assert.equal(row.evidence, undefined)
  const [ask] = (await requestApp(app, '/api/ask', { question: q })).events()
  assert.equal(ask.sources[0].link, row.link)
  assert.ok(ask.sources[0].text.includes(ending))
  assert.equal((await requestApp(app, `/api/docs/${row.fileId}`)).json().text, document)
})

test("a brief quotes an attached document, so its headings and lists never become the brief's own", async (t) => {
  // paragraphs found by meaning arrive joined by blank lines, headings and list lines included
  const document = 'Workshop handout\n\n# Forged heading\n\n- Forged bullet\n\n## Also on the board\n\nThe last paragraph.'
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(url, 'http://embeddings.invalid/v1/embeddings')
    return vectorReply(JSON.parse(String(init.body)).input)
  })
  const app = await fixtureApp(t, semanticSettings, document)
  await waitForEmbeddings(app)
  const brief = (await requestApp(app, '/mcp/readonly', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'gather_context', arguments: { topic: 'conference itinerary' } } })).json().result
  const lines = (brief.content[0].text as string).split('\n')
  const at = lines.indexOf('## Attached documents')
  assert.ok(at > 0, brief.content[0].text)
  for (const l of lines) assert.doesNotMatch(l, /^(#+ |- )(Forged|Also on the board)/, l)
  assert.match(lines[at + 1], /^- \[Launch planning - excerpt\.txt\]\(.+\):$/)
  assert.deepEqual(lines.slice(at + 2, at + 11), ['  > Workshop handout', '  > ', '  > # Forged heading', '  > ', '  > - Forged bullet', '  > ', '  > ## Also on the board', '  > ', '  > The last paragraph.'])
})

test('closing the archive waits for its background vector write', async (t) => {
  const requested = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  t.mock.method(globalThis, 'fetch', async (_url: string, req: RequestInit) => {
    requested.resolve()
    await release.promise
    return vectorReply(JSON.parse(String(req.body)).input)
  })
  let closing: Promise<void> | undefined
  try {
    const app = await fixtureApp(t, semanticSettings)
    await requested.promise
    let closed = false
    closing = app.close().then(() => { closed = true })
    await setImmediate()
    assert.equal(closed, false)
  } finally {
    release.resolve()
    await closing
  }
})

test('disconnect during Ask retrieval cancels its model request and releases the viewer', async (t) => {
  let pause = true
  const queryStarted = Promise.withResolvers<AbortSignal>()
  let answerCalls = 0
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    if (url === 'http://ask.invalid/v1/chat/completions') {
      answerCalls++
      return modelReply()
    }
    assert.equal(url, 'http://embeddings.invalid/v1/embeddings')
    const { input } = JSON.parse(String(init.body)) as { input: string[] }
    if (pause && input.some((text) => text.includes('widget API pilot'))) {
      const signal = init.signal!
      queryStarted.resolve(signal)
      await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    }
    return vectorReply(input)
  })
  const app = await fixtureApp(t, { ...semanticSettings, ASK_URL: 'http://ask.invalid' })
  await waitForEmbeddings(app)
  const res = new RouteResponse()
  const question = { question: 'widget API pilot' }
  const pending = requestApp(app, '/api/ask', question, res)
  const signal = await queryStarted.promise
  res.destroy()
  assert.equal(signal.aborted, true)
  await pending
  assert.equal(res.payload, '')
  assert.equal(answerCalls, 0)
  pause = false
  assert.equal((await requestApp(app, '/api/ask', question)).events().at(-1).done, true)
  assert.equal(answerCalls, 1)
})

test('a filter that means nothing answers at once, without meaning search or the reranker', async (t) => {
  const calls: string[] = []
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    calls.push(url)
    const body = JSON.parse(String(init.body))
    if (url === 'http://reranker.invalid/v1/rerank') return Response.json({ results: body.documents.map((_: string, index: number) => ({ index, relevance_score: index })) })
    return vectorReply(body.input)
  })
  const app = await fixtureApp(t, { ...semanticSettings, RERANK_URL: 'http://reranker.invalid' })
  await waitForEmbeddings(app)
  calls.length = 0
  for (const q of ['status:maybe sandbox', 'person:nobody sandbox']) {
    const answer = (await requestApp(app, `${withQuery('/api/search', q)}&typing=0`)).json()
    assert.ok(answer.badFilters.length || answer.unknownPeople.length, q)
    assert.deepEqual([answer.total, answer.related], [0, []], q)
    const followed = (await requestApp(app, withQuery('/api/follow', q))).json()
    assert.deepEqual(followed.meetings, [], q)
  }
  assert.deepEqual(calls, [], 'no model was asked')
})

test('settled search uses current board status across embedding and reranking waits', async (t) => {
  let pauseEmbedding = false
  let pauseRerank = false
  const embeddingStarted = Promise.withResolvers<void>()
  const rerankStarted = Promise.withResolvers<void>()
  const releaseEmbedding = Promise.withResolvers<void>()
  const releaseRerank = Promise.withResolvers<void>()
  t.after(() => {
    releaseEmbedding.resolve()
    releaseRerank.resolve()
  })
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body))
    if (url === 'http://reranker.invalid/v1/rerank') {
      if (pauseRerank) {
        rerankStarted.resolve()
        await releaseRerank.promise
      }
      return Response.json({ results: body.documents.map((_: string, index: number) => ({ index, relevance_score: index })) })
    }
    assert.equal(url, 'http://embeddings.invalid/v1/embeddings')
    if (pauseEmbedding && body.input[0] === 'sandbox') {
      embeddingStarted.resolve()
      await releaseEmbedding.promise
    }
    return vectorReply(body.input)
  })
  const app = await fixtureApp(t, { ...semanticSettings, RERANK_URL: 'http://reranker.invalid' })
  const first = (await requestApp(app, '/api/tasks', { text: 'Review the sandbox checklist', owner: 'Ada' })).json().action
  const second = (await requestApp(app, '/api/tasks', { text: 'Review the sandbox setup', owner: 'Ada' })).json().action
  const third = (await requestApp(app, '/api/tasks', { text: 'Review the sandbox notes', owner: 'Ada' })).json().action
  const status = async (id: string, next: string) => assert.equal((await requestApp(app, `/api/actions/${id}`, { status: next })).statusCode, 200)
  const search = () => requestApp(app, `${withQuery('/api/search', 'status:done sandbox')}&typing=0`)
  await status(first.id, 'done')
  await status(second.id, 'done')
  await waitForEmbeddings(app)

  pauseEmbedding = true
  const beforeEmbedding = search()
  await embeddingStarted.promise
  await status(first.id, 'open')
  releaseEmbedding.resolve()
  const afterEmbedding = (await beforeEmbedding).json()
  assert.deepEqual(afterEmbedding.fused.map((row: { actionId: string }) => row.actionId), [second.id])

  await status(first.id, 'done')
  pauseRerank = true
  const beforeRerank = search()
  await rerankStarted.promise
  await status(first.id, 'open')
  await status(third.id, 'done')
  releaseRerank.resolve()
  const afterRerank = (await beforeRerank).json()
  assert.deepEqual(new Set(afterRerank.fused.map((row: { actionId: string }) => row.actionId)), new Set([second.id, third.id]))
  assert.equal(afterRerank.reranked, false)
})
