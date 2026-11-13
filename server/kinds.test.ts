// An entry that is not a meeting (a product demo, a training): what sort of recording it is reaches the web
// routes, search and the agents. The synthetic archive's launch planning is made a demo by its index entry;
// "Demo day" has no index entry or notes, so it stays a meeting whatever its name says.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { createApp, type App } from './app.ts'
import { configFrom } from './config.ts'
import { fixtureDir, requestApp } from './fixtures.test-helper.ts'
import { buildLibrary, scanFiles } from './library.ts'
import { parseQuery, SearchIndex } from './search.ts'

const DEMO = '2026-10-02-launch'

async function demoArchive(t: TestContext) {
  const dir = await realpath(await fixtureDir({ index: true }))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const indexPath = join(dir, 'meetings-index.json')
  const index = JSON.parse(await readFile(indexPath, 'utf8'))
  index.sessions[0].kind = 'Demo'
  await writeFile(indexPath, JSON.stringify(index))
  return dir
}

async function demoApp(t: TestContext) {
  const dir = await demoArchive(t)
  const data = await mkdtemp(join(tmpdir(), 'meetings-kinds-'))
  const app: App = await createApp(configFrom({ PORT: '8798', MEETINGS_DIR: dir, DATA_DIR: data, CREW: 'Ada Byron,Grace Hopper', LOCAL_USER: 'Ada', DIARIZE_PYTHON: '' }), { watch: false, backups: false })
  t.after(async () => {
    await app.close()
    await rm(data, { recursive: true, force: true })
  })
  await app.start()
  return app
}

const rpc = (app: App, method: string, params: Record<string, unknown>) => requestApp(app, '/mcp/readonly', { jsonrpc: '2.0', id: 1, method, params }).then((r) => r.json().result)
const tool = (app: App, name: string, args: Record<string, unknown> = {}) => rpc(app, 'tools/call', { name, arguments: args })

test('the web routes say what sort of recording each entry is, on the shelf and on its page', async (t) => {
  const app = await demoApp(t)
  const meetings = (await requestApp(app, '/api/library')).json().meetings as { id: string; title: string; kind: string }[]
  assert.deepEqual(meetings.map((m) => [m.title, m.kind]).sort(), [['Demo day', 'meeting'], ['Launch planning', 'demo']])
  assert.equal((await requestApp(app, `/api/meetings/${DEMO}`)).json().kind, 'demo')
  const other = meetings.find((m) => m.id !== DEMO)!
  assert.equal((await requestApp(app, `/api/meetings/${other.id}`)).json().kind, 'meeting')
})

test('search: kind: finds the entries of one sort, -kind: leaves them out, and a kind nobody has is named', async (t) => {
  const lib = await buildLibrary(await scanFiles(await demoArchive(t)), () => ({}), [], new Map())
  const index = new SearchIndex(lib)
  const where = (q: string) => [...new Set(index.search(q, { typing: false }).hits.map((h) => h.meetingId))].sort()
  const other = lib.meetings.find((m) => m.id !== DEMO)!.id
  // with words, and alone
  assert.ok(index.search('sandbox', { typing: false }).total > 0)
  assert.deepEqual(where('sandbox kind:demo'), [DEMO])
  assert.deepEqual(where('kind:demo'), [DEMO])
  assert.deepEqual(where('Kind:DEMO'), [DEMO])
  // excluded: the demo's own hits are gone, and so is everything else the kind takes in
  assert.deepEqual(where('sandbox -kind:demo'), [])
  assert.deepEqual(where('-kind:demo'), [other])
  assert.equal(index.search('sandbox -kind:demo', { typing: false }).badFilters.length, 0)
  // kind:meeting finds the entries with no other kind
  assert.deepEqual(where('kind:meeting'), [other])
  assert.deepEqual(where('sandbox kind:meeting'), [])
  assert.deepEqual(where('kind:meeting kind:demo'), [DEMO, other].sort())
  // a kind nobody has, or one that can't be a kind, matches nothing and is named, as status:maybe is
  for (const [q, bad] of [
    ['sandbox kind:webinar', 'kind:webinar'],
    ['sandbox -kind:webinar', '-kind:webinar'],
    ['sandbox kind:!!!', 'kind:!!!'],
    ['sandbox kind:', 'kind:'],
  ]) {
    const r = index.search(q, { typing: false })
    assert.deepEqual([r.total, r.badFilters], [0, [bad]], q)
  }
  // the filter is parsed like the others: its words go to nobody, and "Kind: demo" in a sentence is words
  assert.deepEqual(parseQuery('pilot kind:Demo -kind:site-visit').kinds, ['demo'])
  assert.deepEqual(parseQuery('pilot kind:Demo -kind:site-visit').notKinds, ['site-visit'])
  assert.equal(index.prepare('pilot kind:demo').embeddingText, 'pilot')
  assert.deepEqual([parseQuery('Kind: demo').kinds, parseQuery('Kind: demo').words], [[], ['kind', 'demo']])
})

test('agents: list_meetings and get_meeting carry the kind, a brief names it, and the handshake explains it', async (t) => {
  const app = await demoApp(t)
  const listed = (await tool(app, 'list_meetings')).structuredContent.meetings as { id: string; kind: string }[]
  assert.deepEqual(listed.map((m) => [m.id === DEMO, m.kind]).sort(), [[false, 'meeting'], [true, 'demo']])
  const got = await tool(app, 'get_meeting', { meeting_id: DEMO })
  assert.equal(JSON.parse(got.content[1].text).kind, 'demo')
  const brief = (await tool(app, 'gather_context', { topic: 'Widget API sandbox' })).content[0].text as string
  assert.match(brief, /^## 2026-10-02 · Launch planning \(demo\)$/m)
  const found = (await tool(app, 'search', { query: 'sandbox kind:webinar' })).structuredContent
  assert.deepEqual([found.total, found.bad_filters], [0, ['kind:webinar']])
  const hello = await rpc(app, 'initialize', { protocolVersion: '2025-06-18' })
  assert.match(hello.instructions, /An entry can be a demo or another sort of recording, and kind says which: a demo shows what was presented, not what was agreed\./)
})

test('agents: a brief leaves the heading of a meeting as it was', async (t) => {
  const dir = await realpath(await fixtureDir({ index: true }))
  const data = await mkdtemp(join(tmpdir(), 'meetings-kinds-'))
  const app = await createApp(configFrom({ PORT: '8798', MEETINGS_DIR: dir, DATA_DIR: data, CREW: 'Ada Byron,Grace Hopper', LOCAL_USER: 'Ada', DIARIZE_PYTHON: '' }), { watch: false, backups: false })
  t.after(async () => {
    await app.close()
    await Promise.all([dir, data].map((p) => rm(p, { recursive: true, force: true })))
  })
  await app.start()
  const brief = (await tool(app, 'gather_context', { topic: 'Widget API sandbox' })).content[0].text as string
  assert.match(brief, /^## 2026-10-02 · Launch planning$/m)
})
