// The web routes, through the app's own handler: a server on a temp copy of the synthetic meetings folder,
// with a temp data folder, asked over HTTP the way the browser asks.
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { createServer, request, type Server } from 'node:http'
import { connect, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { createApp, type App } from './app.ts'
import { configFrom } from './config.ts'
import { fixtureDir } from './fixtures.test-helper.ts'
import { scanFiles } from './library.ts'

const MEETING = '2026-10-02-launch'

let dir: string
let data: string
let server: Server
let base: string
let app: App
let logged: string[] = []
const log = console.log

const settings = (port: number, dataDir: string) =>
  configFrom({ PORT: String(port), MEETINGS_DIR: dir, DATA_DIR: dataDir, CREW: 'Ada Byron,Grace Hopper,Zelda Fitz', LOCAL_USER: 'Ada', DIARIZE_PYTHON: '', EMBED_URL: '', RERANK_URL: '' })

before(async () => {
  // the temp folder's real path: the server refuses a meetings folder reached through a symlink
  dir = await realpath(await fixtureDir({ index: true }))
  data = await mkdtemp(join(tmpdir(), 'meetings-app-'))
  // recordings written an hour ago (a fresh one counts as still being written), each with a cached poster
  // and sprite, as if ffmpeg had made them
  await mkdir(join(data, 'cache', 'thumbs'), { recursive: true })
  for (const f of (await scanFiles(dir)).filter((x) => x.kind === 'video')) await utimes(f.path, new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000))
  for (const f of (await scanFiles(dir)).filter((x) => x.kind === 'video')) {
    const thumbs = join(data, 'cache', 'thumbs', `${f.id}-${f.size.toString(36)}-${f.mtimeMs.toString(36)}`)
    await writeFile(`${thumbs}.strip.json`, JSON.stringify({ interval: 6, count: 1, cols: 1, rows: 1, tileW: 192, tileH: 108, colors: ['#000000'] }))
    await writeFile(`${thumbs}.poster.jpg`, Buffer.from('poster'))
    await writeFile(`${thumbs}.sprite.jpg`, Buffer.from('sprite'))
  }
  await writeFile(join(data, 'state.json'), JSON.stringify({ actions: {}, tasks: [], trash: [], seen: {}, aliases: {}, sync: {}, prefs: {} }))
  server = createServer((req, res) => void app.handler(req, res))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address() as AddressInfo
  base = `http://127.0.0.1:${port}`
  app = await createApp(settings(port, data), { watch: false })
  console.log = (...args: unknown[]) => void logged.push(args.join(' '))
  await app.start()
})

after(async () => {
  console.log = log
  await app.close()
  server.close()
  await rm(dir, { recursive: true, force: true })
  await rm(data, { recursive: true, force: true })
})

const get = (path: string, headers: Record<string, string> = {}) => fetch(base + path, { headers })
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'meetings', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) })

test('routes: a malformed address answers 400 (404 for a page), never 500', async () => {
  assert.equal((await get('/api/meetings/%E0%A4%A')).status, 400)
  assert.equal((await get('/api/transcripts/%E0%A4%A')).status, 400)
  assert.equal((await post('/api/meetings/%E0%A4%A/sync', { offset: 1 })).status, 400)
  assert.equal((await get('/%E0%A4%A')).status, 404)
  assert.equal((await get('/js/%E0%A4%A.js')).status, 404)
})

test('routes: a page whose address holds a dot (a meeting id from the index) gets the app shell; a missing file is still 404', async () => {
  for (const page of ['/m/q3.review', '/m/v1.2-kickoff?t=120', '/m/report.html', `/m/${MEETING}`]) {
    const res = await get(page)
    assert.equal(res.status, 200, page)
    assert.match(res.headers.get('content-type') ?? '', /^text\/html/, page)
    assert.match(await res.text(), /<main id="app"/, page)
  }
  for (const file of ['/js/nope.js', '/js/views/nope.js', '/css/nope.css', '/nope.js', '/favicon.ico']) {
    const res = await get(file)
    assert.equal(res.status, 404, file)
    assert.match(res.headers.get('content-type') ?? '', /^application\/json/, file)
    await res.arrayBuffer()
  }
  const js = await get('/js/main.js')
  assert.equal(js.status, 200)
  assert.match(js.headers.get('content-type') ?? '', /^text\/javascript/)
  await js.arrayBuffer()
})

test('routes: a request target that is no address answers 400 and the server keeps serving', async () => {
  // fetch would refuse to send this, so it goes over a plain socket, as it would arrive from the tunnel
  const raw = (target: string, host: string) => new Promise<string>((resolve, reject) => {
    const socket = connect(Number(new URL(base).port), '127.0.0.1', () => socket.write(`GET ${target} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`))
    let reply = ''
    socket.on('data', (d) => (reply += d))
    socket.on('close', () => resolve(reply.split('\r\n')[0]))
    socket.on('error', reject)
    // a server that never answers fails this test instead of hanging it
    socket.setTimeout(5000, () => socket.destroy())
  })
  for (const host of [new URL(base).host, 'meetings-mcp.example.test']) {
    assert.equal(await raw('//a:99999/x', host), 'HTTP/1.1 400 Bad Request')
  }
  assert.equal((await get('/api/me')).status, 200)
})

test('routes: a body past its route’s limit answers 413 with the limit, and a long note saves', async () => {
  const long = 'word '.repeat(4000) // 20 KB
  const saved = await post('/api/notebook', { title: 'A long note', body: long })
  assert.equal(saved.status, 200)
  const { note } = (await saved.json()) as { note: { id: string; version: number } }
  assert.equal(note.version, 1)
  const edited = await post(`/api/notebook/${note.id}`, { body: `${long}more`, ifVersion: 1 })
  assert.equal(edited.status, 200, 'a 20 KB edit from the web app saves')

  const huge = await post(`/api/notebook/${note.id}`, { body: 'x'.repeat(300_000) })
  assert.equal(huge.status, 413)
  assert.match(((await huge.json()) as { error: string }).error, /256 KB/)
  const item = (await (await get('/api/actions')).json()) as { actions: { id: string }[] }
  const big = await post(`/api/actions/${item.actions[0].id}`, { note: 'x'.repeat(20_000) })
  assert.equal(big.status, 413)
  assert.match(((await big.json()) as { error: string }).error, /16 KB/)
})

test('routes: a body that is not a JSON object answers 400', async () => {
  for (const raw of ['null', '[]', '7', '"x"', '{not json'])
    assert.equal((await post(`/api/meetings/${MEETING}/sync`, raw)).status, 400, raw)
})

test('routes: a note edited on an older copy is refused with 409 and the note as it stands', async () => {
  const { note } = (await (await post('/api/notebook', { title: 'Shared', body: 'first' })).json()) as { note: { id: string; version: number } }
  assert.equal((await post(`/api/notebook/${note.id}`, { body: 'second', ifVersion: 1 })).status, 200)
  const stale = await post(`/api/notebook/${note.id}`, { body: 'third, from an old tab', ifVersion: 1 })
  assert.equal(stale.status, 409)
  const back = (await stale.json()) as { note: { body: string; version: number } }
  assert.deepEqual([back.note.body, back.note.version], ['second', 2])
  // appending needs no version and never loses anything
  assert.equal((await post(`/api/notebook/${note.id}`, { append: 'an addition' })).status, 200)
  // a restore is credited to whoever restored it
  await post(`/api/notebook/${note.id}/delete`, {})
  const restored = (await (await post(`/api/notebook/${note.id}/restore`, {})).json()) as { note: { restored: { by: string } } }
  assert.equal(restored.note.restored.by, 'Ada')
})

test('routes: a clock sync is bounded, and refused for a meeting that needs none', async () => {
  const meetings = ((await (await get('/api/library')).json()) as { meetings: { id: string; timeBase: string }[] }).meetings
  const clock = meetings.find((m) => m.timeBase === 'clock')!
  const offset = meetings.find((m) => m.timeBase === 'offset')!
  assert.equal((await post(`/api/meetings/${clock.id}/sync`, { offset: 1e308 })).status, 400)
  assert.equal((await post(`/api/meetings/${clock.id}/sync`, { offset: 'soon' })).status, 400)
  assert.equal((await post(`/api/meetings/${offset.id}/sync`, { offset: 30 })).status, 400)
  const ok = await post(`/api/meetings/${clock.id}/sync`, { offset: 46_800 })
  assert.equal(ok.status, 200)
  assert.equal(((await ok.json()) as { sync: { offset: number } }).sync.offset, 46_800)
  assert.equal((await post(`/api/meetings/${clock.id}/sync`, { offset: null })).status, 200)
})

test('routes: a lost thumbnail answers 404 and is made again, not 500 for good', async () => {
  const lib = app.lib()
  // the made-up recordings aren't real video: once ffprobe has failed on them and the library is rebuilt, none is
  // the default copy any more, and any copy's thumbnails do for this
  const videos = lib.byId.get(MEETING)!.videos
  const video = videos.find((v) => v.isDefault) ?? videos[0]
  const first = await get(`/thumbs/${video.fileId}/poster.jpg`)
  assert.equal(first.status, 200)
  assert.match(first.headers.get('cache-control') ?? '', /max-age=3600/)
  const f = lib.files.get(video.fileId)!
  const cached = join(data, 'cache', 'thumbs', `${f.id}-${f.size.toString(36)}-${f.mtimeMs.toString(36)}`)
  await rm(`${cached}.poster.jpg`)
  assert.equal((await get(`/thumbs/${video.fileId}/poster.jpg`)).status, 404)
  // what was left of the frames is gone, so the next pass makes them again
  await assert.rejects(stat(`${cached}.strip.json`))
  assert.equal((await get(`/thumbs/${video.fileId}/sprite.jpg`)).status, 404)
})

test('routes: the wrong method answers 405, an unknown API path 404', async () => {
  assert.equal((await post('/api/library', {})).status, 405)
  assert.equal((await post('/api/notebook/n-0123456789', {}, {})).status, 400, 'a POST to an unknown note says so')
  assert.equal((await get('/api/nothing-here')).status, 404)
  assert.equal((await fetch(`${base}/api/library`, { method: 'DELETE' })).status, 405)
})

test('routes: a request from outside this Mac without an Access pass is refused', async () => {
  // fetch won't change the Host header, so this one goes out by hand
  const outside = await new Promise<number>((done, fail) => {
    const req = request(`${base}/api/library`, { headers: { Host: 'meetings.example.test' } }, (res) => {
      res.resume()
      done(res.statusCode ?? 0)
    })
    req.on('error', fail)
    req.end()
  })
  assert.equal(outside, 403)
  // a write from another site is refused even on this Mac
  assert.equal((await post('/api/prefs', { theme: 'dark' }, { Origin: 'https://example.com' })).status, 403)
  assert.equal((await fetch(`${base}/api/prefs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"theme":"dark"}' })).status, 403, 'no custom header, no write')
})

test('routes: the read-only door lists the read tools only, and its calls are logged as the agent', async () => {
  logged = []
  const res = await fetch(`${base}/mcp/readonly`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  })
  assert.equal(res.status, 200)
  const tools = ((await res.json()) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name)
  assert.equal(tools.length, 10)
  assert.ok(!tools.includes('update_action_item'))
  assert.ok(logged.some((l) => /^POST \/mcp\/readonly 200 \d+ms Ada's agent$/.test(l)), 'logged under the agent, not the person')
})

test('routes: a download is logged by file id, never by name or query', async () => {
  logged = []
  const v = app.lib().byId.get(MEETING)!.videos[0]
  const res = await get(`/media/${v.fileId}?download=1&q=secret`)
  assert.equal(res.status, 200)
  await res.arrayBuffer()
  assert.ok(logged.some((l) => l === `download: Ada ← ${v.fileId}`))
  assert.ok(!logged.some((l) => /Screen Recording|secret/.test(l)))
})

test('routes: the board lists deleted tasks, newest first, and an undo brings one back', async () => {
  const add = async (text: string) => ((await (await post('/api/tasks', { text, owner: 'Zelda' })).json()) as { action: { id: string; lane: string } }).action
  const one = await add('Order the banner')
  assert.equal(one.lane, 'us', 'crew configured but in no meeting yet still works on us')
  const two = await add('Print the flyers')
  await post(`/api/tasks/${one.id}/delete`, {})
  await post(`/api/tasks/${two.id}/delete`, {})
  const board = (await (await get('/api/actions')).json()) as { deleted: { id: string; text: string; by: string }[] }
  assert.deepEqual(board.deleted.slice(0, 2).map((d) => [d.id, d.by]), [[two.id, 'Ada'], [one.id, 'Ada']])
  assert.equal((await post(`/api/actions/${one.id}`, { undo: true })).status, 200)
  const now = (await (await get('/api/actions')).json()) as { actions: { id: string }[]; deleted: { id: string }[] }
  assert.ok(now.actions.some((a) => a.id === one.id) && !now.deleted.some((d) => d.id === one.id))
})

test('routes: a task brought back offers no undo, and a second undo leaves its earlier change alone', async () => {
  type Card = { id: string; rev: number; status: string; undoable: boolean; done: { evidence?: string } | null; history: { did: string }[] }
  const added = ((await (await post('/api/tasks', { text: 'Order the conference badges', owner: 'Zelda' })).json()) as { action: Card }).action
  assert.equal((await post(`/api/actions/${added.id}`, { status: 'done', evidence: 'Badges arrived Tuesday', rev: added.rev })).status, 200)
  await post(`/api/tasks/${added.id}/delete`, {})
  // Bring back sends no revision
  const back = await post(`/api/actions/${added.id}`, { undo: true })
  const restored = ((await back.json()) as { action: Card }).action
  assert.deepEqual([back.status, restored.status, restored.undoable, restored.history.at(-1)?.did], [200, 'done', false, 'restored'])
  // the toast's Undo after Bring back, or a second Bring back from a list read earlier: refused, with or without the card's revision
  for (const rev of [{}, { rev: restored.rev }]) {
    const again = await post(`/api/actions/${added.id}`, { undo: true, ...rev })
    assert.equal(again.status, 400)
    assert.match(((await again.json()) as { error: string }).error, /already back on the board/)
  }
  const card = ((await (await get('/api/actions')).json()) as { actions: Card[] }).actions.find((a) => a.id === added.id)!
  assert.deepEqual([card.status, card.done?.evidence, card.rev, card.undoable], ['done', 'Badges arrived Tuesday', restored.rev, false])
})

test('start: a copy of the board is taken before anything is written, owner-only', async () => {
  const backups = join(data, 'backups')
  assert.equal((await stat(backups)).mode & 0o777, 0o700)
  const [copy] = await readdir(backups)
  assert.match(copy, /^\d{4}-\d{2}-\d{2}T\d{6}Z-[a-f0-9]{32}$/)
  assert.deepEqual(JSON.parse(await readFile(join(backups, copy, 'state.json'), 'utf8')).tasks, [])
})

test('start: a board that exists but cannot be read stops the server, and nothing is written over it', async () => {
  const other = await mkdtemp(join(tmpdir(), 'meetings-app-locked-'))
  const saved = JSON.stringify({ actions: { abc: { done: { by: 'Ada', at: '2026-01-01T00:00:00.000Z' } } }, tasks: [{ id: 't1' }], trash: [], seen: {}, aliases: {}, sync: {}, prefs: {} })
  await writeFile(join(other, 'state.json'), saved)
  await chmod(join(other, 'state.json'), 0o000)
  try {
    const locked = await createApp(settings(1, other), { watch: false, backups: false })
    await assert.rejects(locked.start(), /can't read/)
    await locked.close()
  } finally {
    await chmod(join(other, 'state.json'), 0o600)
  }
  assert.equal(await readFile(join(other, 'state.json'), 'utf8'), saved)
  await rm(other, { recursive: true, force: true })
})

test('agents: a note edited on an older version is refused with the note as it stands, and a filter that means nothing is named', async () => {
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-11-25' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    })
    return ((await res.json()) as { result: { isError?: boolean; structuredContent?: Record<string, unknown>; content: { text: string }[] } }).result
  }
  const saved = (await call('save_note', { title: 'Agent findings', body: 'first pass' })).structuredContent!.saved as { id: string; version: number }
  assert.equal(saved.version, 1)
  assert.equal((await call('update_note', { id: saved.id, body: 'second pass', if_version: 1 })).isError, undefined)
  const stale = await call('update_note', { id: saved.id, body: 'from an older read', if_version: 1 })
  assert.equal(stale.isError, true)
  assert.equal(JSON.parse(stale.content[1].text).current.body, 'second pass')
  const found = await call('search', { query: 'pilot after:soon' })
  assert.deepEqual([found.structuredContent!.total, found.structuredContent!.bad_filters], [0, ['after:soon']])
})

test('routes: a topic followed across meetings comes oldest first, with the items it touched', async () => {
  const r = (await (await get('/api/follow?q=sandbox')).json()) as { meetings: { id: string; date: string; moments: { kind: string }[] }[]; items: { id: string; status: string }[] }
  assert.ok(r.meetings.length >= 1)
  assert.deepEqual(r.meetings.map((m) => m.date), [...r.meetings.map((m) => m.date)].sort())
  assert.ok(r.meetings[0].moments.length > 0)
  assert.ok(r.items.some((i) => i.status === 'open'), 'the sandbox item from the notes, as it stands')
  const bad = (await (await get('/api/follow?q=sandbox%20after:soon')).json()) as { badFilters: string[]; meetings: unknown[] }
  assert.deepEqual([bad.badFilters, bad.meetings], [['after:soon'], []])
  assert.equal((await get('/api/follow?q=')).status, 400)
})

test('the library says whose Mac the archive is on once LOCAL_USER names someone', async () => {
  const lib = (await (await get('/api/library')).json()) as { mac?: string }
  assert.equal(lib.mac, 'Ada')
  // nobody named: the pages say "the archive's Mac"
  assert.equal(configFrom({ PORT: '1', MEETINGS_DIR: dir, DATA_DIR: data, DIARIZE_PYTHON: '' }).localNamed, false)
})
