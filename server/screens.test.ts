import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { indexScreens, selectFrames } from '../scripts/index-screens.ts'
import { createApp, type App } from './app.ts'
import { configFrom } from './config.ts'
import { fixtureDir, requestApp, RouteResponse } from './fixtures.test-helper.ts'
import { buildLibrary, scanFiles } from './library.ts'
import { runTool, type Ctx } from './mcp-tools.ts'
import { run } from './media.ts'
import { Notebook } from './notebook.ts'
import { GeminiScreenEmbeddings, readScreenSnapshot, ScreenSearch, SCREEN_DIMENSIONS, SCREEN_REFERENCE, writeScreenSnapshot } from './screens.ts'
import { SearchIndex } from './search.ts'
import { Reranker, Semantic } from './semantic.ts'
import { Store } from './state.ts'

const modelURL = 'https://openrouter.ai/api/v1/embeddings'
const recording = 'Screen Recording 2026-10-02 at 9.15.00 AM compressed.mp4'
const meeting = '2026-10-02-launch'
const vector = (axis = 0) => Float32Array.from({ length: SCREEN_DIMENSIONS }, (_, i) => Number(i === axis))
const reply = (axis = 0) => Response.json({ data: [{ index: 0, embedding: [...vector(axis)] }] })
const settings = (dir: string, data: string) => ({
  PORT: '8798', MEETINGS_DIR: dir, DATA_DIR: data, CREW: 'Ada Byron,Grace Hopper',
  LOCAL_USER: 'Ada', DIARIZE_PYTHON: '', SCREEN_SEARCH: '1', OPENROUTER_API_KEY: 'fixture',
})
const searchPath = (q: string, typing = false) => `/api/search?q=${encodeURIComponent(q)}${typing ? '' : '&typing=0'}`
const mcp = async (app: App, name: string, args: object) =>
  (await requestApp(app, '/mcp/readonly', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })).json().result

async function scratch(t: TestContext, prefix: string) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

test('screen indexing previews real scene frames and sends only selected JPEGs when explicitly enabled', async (t) => {
  if (!(await run('ffmpeg', ['-version'], 5000).catch(() => undefined)) || !(await run('ffprobe', ['-version'], 5000).catch(() => undefined))) {
    // CI installs FFmpeg, so there a missing one is a broken install step, and this test fails rather than hide
    if (process.env.CI) assert.fail('ffmpeg and ffprobe are required for the frame fixture, and CI installs them')
    return t.skip('ffmpeg and ffprobe are required for the frame fixture')
  }
  const dir = await scratch(t, 'screens-media-')
  const data = await scratch(t, 'screens-data-')
  const video = join(dir, 'Demo - 2026-10-02.mp4')
  await run('ffmpeg', [
    '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=320x180:d=4:r=5',
    '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:d=4:r=5', '-filter_complex', 'concat=n=2:v=1:a=0',
    '-c:v', 'mpeg4', video,
  ], 15_000)
  const past = Math.floor(Date.now() / 1000) - 60 + 0.000125
  await utimes(video, past, past)
  const mtime = (await stat(video)).mtimeMs
  assert.notEqual(mtime, Math.round(mtime), 'the recording fixture must have a fractional-millisecond timestamp')
  await writeFile(join(dir, 'meetings-index.json'), JSON.stringify({ sessions: [{ id: meeting, date: '2026-10-02', title: 'Demo', videos: ['Demo - 2026-10-02.mp4'] }] }))
  const original = await readFile(video)
  const bodies: unknown[] = []
  t.mock.method(globalThis, 'fetch', async (url: string, req: RequestInit) => {
    assert.equal(url, modelURL)
    assert.equal(new Headers(req.headers).get('authorization'), 'Bearer fixture')
    assert.equal(req.redirect, 'error')
    const body = JSON.parse(String(req.body))
    bodies.push(body)
    assert.equal(body.model, 'google/gemini-embedding-2')
    assert.equal(body.dimensions, SCREEN_DIMENSIONS)
    assert.equal(body.encoding_format, 'float')
    assert.equal(body.input.length, 1)
    assert.equal(body.input[0].content.length, 1)
    const image = body.input[0].content[0]
    assert.equal(image.type, 'image_url')
    assert.match(image.image_url.url, /^data:image\/jpeg;base64,/)
    assert.deepEqual([...Buffer.from(image.image_url.url.split(',')[1], 'base64').subarray(0, 2)], [0xff, 0xd8])
    return reply(bodies.length - 1)
  })
  const env = settings(dir, data)
  assert.deepEqual(await indexScreens([meeting], env), { frames: 2, uploaded: 0 })
  assert.equal(bodies.length, 0)
  assert.deepEqual(await indexScreens([meeting, '--send-to-gemini'], env), { frames: 2, uploaded: 2 })
  assert.deepEqual(await indexScreens([meeting, '--send-to-gemini'], env), { frames: 2, uploaded: 0 })
  assert.equal(bodies.length, 2)
  const [file] = (await scanFiles(dir)).filter((f) => f.kind === 'video')
  const snapshot = await readScreenSnapshot(data, file)
  assert.deepEqual(snapshot?.map((frame) => frame.t), [0, 4])
  assert.equal(await readScreenSnapshot(data, { ...file, mtimeMs: file.mtimeMs + 1 }), undefined)
  await assert.rejects(selectFrames({ ...file, mtimeMs: file.mtimeMs - 1000 }, data), /changed/)
  assert.equal((await stat(join(data, 'screens', `${file.id}.json`))).mode & 0o777, 0o600)
  assert.deepEqual(await readFile(video), original)
})

// The consent gate runs before any frame is picked, so this needs no FFmpeg and runs everywhere the tests do.
// Without the gate, these runs would go on to FFprobe and fail with another message.
test('frames go to Gemini only with SCREEN_SEARCH=1 and an OpenRouter key, refused before any frame is picked', async (t) => {
  const dir = await realpath(await fixtureDir({ index: true }))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const data = await scratch(t, 'screens-gate-')
  const past = new Date(Date.now() - 60_000)
  for (const f of (await scanFiles(dir)).filter((x) => x.kind === 'video')) await utimes(f.path, past, past)
  const sent: string[] = []
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    sent.push(String(url))
    throw new Error('nothing may be sent')
  })
  const env = settings(dir, data)
  for (const without of [{ SCREEN_SEARCH: '0' }, { SCREEN_SEARCH: undefined }, { SCREEN_SEARCH: 'yes' }, { OPENROUTER_API_KEY: '' }, { OPENROUTER_API_KEY: undefined }]) {
    await assert.rejects(indexScreens([meeting, '--send-to-gemini'], { ...env, ...without }), /^Error: set SCREEN_SEARCH=1 and OPENROUTER_API_KEY before sending frames to Gemini/, JSON.stringify(without))
  }
  assert.deepEqual(sent, [])
  await assert.rejects(stat(join(data, 'screens')), { code: 'ENOENT' })
})

test('Gemini response validation requires a finite, nonzero vector of the configured size', async (t) => {
  let values: unknown = [1]
  const mock = t.mock.method(globalThis, 'fetch', async () => Response.json({ data: [{ index: 0, embedding: values }] }))
  const gemini = new GeminiScreenEmbeddings('fixture')
  await assert.rejects(gemini.query('something on screen'), /dimensions/)
  values = [...vector()].fill(0)
  await assert.rejects(gemini.query('something on screen'), /norm/)
  values = [...vector()]
  ;(values as unknown[])[0] = '1'
  await assert.rejects(gemini.query('something on screen'), /values/)
  values = [...vector()]
  assert.deepEqual(await gemini.query('something on screen'), vector())
  assert.equal(mock.mock.callCount(), 4)
})

test('OpenRouter must return exactly the requested embedding', async (t) => {
  let data: unknown
  t.mock.method(globalThis, 'fetch', async () => Response.json({ data }))
  const gemini = new GeminiScreenEmbeddings('fixture')
  const embedding = { index: 0, embedding: [...vector()] }
  for (data of [undefined, [], [{ ...embedding, index: 1 }], [embedding, embedding]]) {
    await assert.rejects(gemini.query('a synthetic slide'), /invalid OpenRouter embedding response/)
  }
  data = [embedding]
  assert.deepEqual(await gemini.query('a synthetic slide'), vector())
})

test('screen search, Follow, Ask and MCP use exact frame citations and respect explicit opt-in', async (t) => {
  const dir = await realpath(await fixtureDir({ index: true }))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const data = await scratch(t, 'screens-routes-')
  const past = new Date(Date.now() - 60_000)
  await utimes(join(dir, recording), past, past)
  const file = (await scanFiles(dir)).find((f) => f.name === recording)!
  const cache = join(data, 'cache')
  const probe = { duration: 70, width: 320, height: 180, fps: 5, vcodec: 'mpeg4' }
  await mkdir(join(cache, 'thumbs'), { recursive: true })
  await writeFile(join(cache, 'media.json'), JSON.stringify({ [file.rel]: { key: `${file.size}:${file.mtimeMs}`, probe } }))
  const thumb = join(cache, 'thumbs', `${file.id}-${file.size.toString(36)}-${file.mtimeMs.toString(36)}`)
  await writeFile(`${thumb}.strip.json`, JSON.stringify({ interval: 6, count: 1, cols: 1, rows: 1, tileW: 192, tileH: 108, colors: ['#000000'] }))
  // the reference searches point along axis 2; a frame halfway toward them resembles every search (a camera view)
  const hub = Float32Array.from({ length: SCREEN_DIMENSIONS }, (_, i) => (i === 1 || i === 2 ? Math.SQRT1_2 : 0))
  await writeScreenSnapshot(data, file, [
    { t: 4.125, ocr: 'Launch checklist with three gates', vector: vector() },
    { t: 20, ocr: '', vector: vector(1) },
    { t: 40, ocr: '', vector: hub },
  ])
  const env = { ...settings(dir, data), ASK_URL: 'http://ask.invalid' }
  const questions: string[] = []
  let down = false
  let block: ReturnType<typeof Promise.withResolvers<AbortSignal>> | undefined
  let vectorAxis = 0
  t.mock.method(globalThis, 'fetch', async (url: string, req: RequestInit) => {
    if (url === 'http://ask.invalid/v1/chat/completions') {
      return new Response('data: {"choices":[{"delta":{"content":"See [1]."}}]}\n\ndata: [DONE]\n\n')
    }
    assert.equal(url, modelURL)
    assert.equal(new Headers(req.headers).get('authorization'), 'Bearer fixture')
    const { model, input, dimensions, encoding_format } = JSON.parse(String(req.body))
    assert.equal(model, 'google/gemini-embedding-2')
    assert.equal(dimensions, SCREEN_DIMENSIONS)
    assert.equal(encoding_format, 'float')
    assert.equal(typeof input, 'string')
    const text: string = input
    assert.match(text, /^task: search result \| query: /)
    assert.doesNotMatch(text, /in:|after:|person:/)
    if (SCREEN_REFERENCE.some((r) => text.endsWith(`query: ${r}`))) return reply(2)
    questions.push(text)
    if (block) {
      const signal = req.signal!
      block.resolve(signal)
      await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    }
    return down ? new Response(null, { status: 503 }) : reply(vectorAxis)
  })
  const off = await createApp(configFrom({ ...env, SCREEN_SEARCH: '0' }), { watch: false, backups: false })
  await off.start()
  t.after(() => off.close())
  assert.equal((await requestApp(off, '/api/library')).json().screenSearch, undefined)
  assert.deepEqual((await requestApp(off, searchPath('in:screen project kickoff'))).json().fused, [])
  await off.close()

  const app = await createApp(configFrom(env), { watch: false, backups: false })
  await app.start()
  t.after(() => app.close())
  assert.equal((await requestApp(app, '/api/library')).json().screenSearch, true)
  await requestApp(app, searchPath('project kickoff'))
  await requestApp(app, searchPath('in:screen project kickoff', true))
  await requestApp(app, searchPath('in:screen after:2026-99-01 project kickoff'))
  await requestApp(app, searchPath('in:screen after:2026-11-01 project kickoff'))
  await requestApp(app, searchPath('in:screen person:never-seen project kickoff'))
  assert.deepEqual(questions, [])

  const q = 'in:screen person:ada project kickoff'
  const link = `/m/${meeting}?video=${file.id}&vt=4.125`
  const results = (await requestApp(app, searchPath(q))).json()
  assert.deepEqual(results.fused.map(({ kind, link }: { kind: string; link: string }) => ({ kind, link })), [{ kind: 'screen', link }])
  assert.equal(results.hits[0].evidence, undefined)
  const following = (await requestApp(app, `/api/follow?q=${encodeURIComponent(q)}`)).json()
  assert.equal(following.meetings[0].moments[0].link, link)
  const [ask] = (await requestApp(app, '/api/ask', { question: q })).events()
  assert.deepEqual(ask.sources.map((s: { text: string; link: string }) => [s.text, s.link]), [['Launch checklist with three gates', link]])
  assert.equal(ask.sources[0].videoId, file.id)
  const result = await mcp(app, 'search', { query: q })
  // a moment on screen that matches is a result like any other, with its time, and its text is given once
  assert.deepEqual(result.structuredContent.results.map((r: { kind: string; at: string; text: string; link: string }) => [r.kind, r.at, r.text, r.link]), [['screen', '0:04', 'Launch checklist with three gates', `http://127.0.0.1:8798${link}`]])
  assert.equal(result.structuredContent.total, 1)
  assert.deepEqual(result.structuredContent.related_by_meaning, [])
  assert.equal(result.structuredContent.results[0].ocr, undefined)
  const before = questions.length
  await mcp(app, 'gather_context', { topic: 'project kickoff' })
  assert.equal(questions.length, before)
  const context = await mcp(app, 'gather_context', { topic: 'project kickoff', meeting_ids: [meeting], include_screen: true })
  assert.match(context.content[0].text, /What was on screen/)
  assert.match(context.content[0].text, /On-screen OCR: Launch checklist/)
  assert.equal(JSON.parse(context.content[1].text).screens[0].at, 4.125)

  vectorAxis = 1
  const pictures = (await requestApp(app, searchPath('in:screen graphic'))).json().fused
  // the frame halfway toward every search scores 0.71 but sits no higher above its own baseline: not a match
  assert.deepEqual(pictures.map((row: { t: number }) => row.t), [20])
  const [onlyImage] = pictures
  assert.equal(onlyImage.t, 20)
  assert.match(onlyImage.text, /inspect this frame/)
  assert.deepEqual((await requestApp(app, '/api/ask', { question: 'in:screen graphic' })).events()[0].sources, [])

  down = true
  const [fallback] = (await requestApp(app, searchPath('in:screen "launch checklist"'))).json().fused
  assert.equal(fallback.link, link)
  // one word in common out of three (the small ones don't count) is not a match on screen text
  assert.equal((await requestApp(app, searchPath('in:screen the checklist for the budget plan'))).json().fused.length, 0)
  assert.equal((await requestApp(app, searchPath('in:screen checklist -gates'))).json().fused.length, 0)

  down = false
  block = Promise.withResolvers<AbortSignal>()
  const res = new RouteResponse()
  const pending = requestApp(app, searchPath('in:screen project kickoff'), undefined, res)
  const signal = await block.promise
  res.destroy()
  await pending
  assert.equal(signal.aborted, true)
  assert.equal(res.payload, '')
})

test('small words in a screen search do not count, whatever their stem', async (t) => {
  const dir = await realpath(await fixtureDir({ index: true }))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const data = await scratch(t, 'screens-stopwords-')
  const past = new Date(Date.now() - 60_000)
  for (const f of (await scanFiles(dir)).filter((x) => x.kind === 'video')) await utimes(f.path, past, past)
  const lib = await buildLibrary(await scanFiles(dir), () => ({}), ['Ada Byron', 'Grace Hopper'], new Map())
  const file = lib.files.get(lib.byId.get(meeting)!.videos.find((v) => v.isDefault)!.fileId)!
  await writeScreenSnapshot(data, file, [{ t: 12, ocr: 'Q3 revenue by region', vector: vector() }])
  t.mock.method(globalThis, 'fetch', async () => assert.fail('no key: frame text only, nothing is sent'))
  // hosted mode without a key matches on frame text alone
  const screens = new ScreenSearch({ mode: 'gemini', key: '' }, data, () => lib)
  const index = new SearchIndex(lib)
  const found = async (q: string) => (await screens.find(() => index.prepare(q), 10)).map(({ chunk }) => chunk.t)
  // two words that count, one of them on screen: half, so a match
  assert.deepEqual(await found('in:screen quarter revenue'), [12])
  // "this", "does", "during" and "something" stem to "thi", "doe", "dur" and "someth", and are still small words
  assert.deepEqual(await found('in:screen this quarter revenue'), [12])
  assert.deepEqual(await found('in:screen what does the revenue slide say'), [12])
  assert.deepEqual(await found('in:screen revenue during the quarter'), [12])
  assert.deepEqual(await found('in:screen something about revenue this quarter'), [12])
  // one word on screen out of three that count is still not a match
  assert.deepEqual(await found('in:screen this is the budget plan for the quarter'), [])
})

test('find_connections never runs a screen search, so pasted work that mentions in:screen stays on this Mac', async (t) => {
  const dir = await realpath(await fixtureDir({ index: true }))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const data = await scratch(t, 'screens-connections-')
  const past = new Date(Date.now() - 60_000)
  await utimes(join(dir, recording), past, past)
  const lib = await buildLibrary(await scanFiles(dir), () => ({}), ['Ada Byron', 'Grace Hopper'], new Map())
  const video = lib.byId.get(meeting)!.videos.find((v) => v.isDefault)!
  await writeScreenSnapshot(data, lib.files.get(video.fileId)!, [{ t: 12, ocr: 'Launch checklist', vector: vector() }])
  const sent: string[] = []
  t.mock.method(globalThis, 'fetch', async (url: string, req: RequestInit) => {
    sent.push(`${url} ${String(req.body).slice(0, 120)}`)
    return reply(1)
  })
  const ctx = {
    lib: () => lib, index: () => new SearchIndex(lib, [], []), publicUrl: 'https://example.test', store: new Store(join(data, 'state.json')),
    semantic: new Semantic(data, { url: '', model: '', key: '' }), reranker: new Reranker({ url: '', key: '' }),
    notebook: new Notebook(join(data, 'notes.json')), screens: new ScreenSearch({ mode: 'gemini', key: 'fixture' }, data, () => lib),
  } as Ctx
  const viewer = { name: 'Synthetic agent', email: 'agent@example.test', local: false, scope: 'read' as const }
  const call = (name: string, args: object) => runTool({ name, arguments: args }, viewer, ctx)
  const work = 'Plan for the client renewal, private pricing: 40% off for Acme until March. Remember the search page has an in:screen filter now.'
  await call('find_connections', { text: work })
  assert.equal(sent.length, 0, `the pasted work was sent to OpenRouter: ${sent.join(' | ')}`)
  // an explicit screen search on the same archive does go out, so the silence above is the tool's own
  await call('search', { query: 'in:screen launch checklist' })
  assert.ok(sent.length > 0 && sent.every((s) => s.startsWith(modelURL)))
})
