// Both eras of the protocol side by side, on both doors: the older revisions, which open with initialize, and
// 2026-07-28, where every request names its revision in params._meta and mirrors it, with its method, in headers.
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fixtureDir } from './fixtures.test-helper.ts'
import { buildLibrary, scanFiles } from './library.ts'
import { handleMcp } from './mcp.ts'
import { Notebook } from './notebook.ts'
import { SearchIndex } from './search.ts'
import { Reranker, Semantic } from './semantic.ts'
import { Speakers } from './speakers.ts'
import { Store } from './state.ts'
import { allActions, canonical, findAction, reconcile } from './tasks.ts'

// each door, and how many tools it lists
const DOORS = [
  { path: '/mcp', tools: 16 },
  { path: '/mcp/readonly', tools: 10 },
]
const VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']
const READ_ONLY = 'add_action_item changes things, and this connection is read-only.'

let dir: string
let scratch: string
let server: Server
let base: string

before(async () => {
  dir = await fixtureDir({ index: true })
  scratch = await mkdtemp(join(tmpdir(), 'meetings-mcp-'))
  const lib = await buildLibrary(await scanFiles(dir), () => ({}), ['Ada Byron', 'Grace Hopper'], new Map())
  const store = new Store(join(scratch, 'state.json'))
  reconcile(lib, store)
  const notebook = new Notebook(join(scratch, 'notebook.json'))
  const index = new SearchIndex(lib, notebook.list(), allActions(lib, store), (id) => canonical(store, id))
  const ctx = {
    lib: () => lib,
    index: () => index,
    store,
    publicUrl: 'https://example.test',
    originOk: (o?: string) => !o,
    changed: () => index.setBoard(allActions(lib, store)),
    notebook,
    semantic: new Semantic(scratch, { url: '', key: '', model: '' }),
    reranker: new Reranker({ url: '', key: '' }),
    speakers: new Speakers(scratch, { python: '', segmentation: '', embedding: '', script: '', readText: '' }, () => {}),
    lookups: { meeting: (id: string) => lib.byId.get(id)?.id, task: (id: string) => findAction(lib, store, id)?.id },
    notebookChanged: () => {},
  }
  server = createServer((req, res) => void handleMcp(req, res, { name: 'Tester', email: '', local: true, ...(req.url === '/mcp/readonly' ? { scope: 'read' as const } : {}) }, ctx))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

after(async () => {
  server.close()
  await Promise.all([rm(dir, { recursive: true }), rm(scratch, { recursive: true })])
})

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify(body) })

// An older client: no _meta, and once initialize has agreed a revision, that revision in a header
async function legacy(path: string, method: string, params?: unknown, headers: Record<string, string> = { 'mcp-protocol-version': '2025-11-25' }) {
  const r = await post(path, { jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) }, headers)
  assert.equal(r.status, 200, `${method} on ${path}`)
  return r.json()
}

// A 2026-07-28 client: its revision and capabilities in params._meta, mirrored with the method (and a tool call's
// name) in headers. A test changes one part to disagree with the rest, or sets it to undefined to leave it out.
const META = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {}, 'io.modelcontextprotocol/clientInfo': { name: 'era-test', version: '1.0.0' } }
function modern(path: string, method: string, params: Record<string, unknown> = {}, change: { meta?: Record<string, unknown>; headers?: Record<string, string | undefined> } = {}) {
  const headers = { 'mcp-protocol-version': '2026-07-28', 'mcp-method': method, ...(method === 'tools/call' ? { 'mcp-name': String(params.name) } : {}), ...change.headers }
  const sent = Object.fromEntries(Object.entries(headers).filter((h): h is [string, string] => h[1] !== undefined))
  return post(path, { jsonrpc: '2.0', id: 7, method, params: { ...params, _meta: { ...META, ...change.meta } } }, sent)
}

// a 2026-07-28 request that has to go through: its result, which says it is complete
async function ok(path: string, method: string, params?: Record<string, unknown>) {
  const r = await modern(path, method, params)
  assert.equal(r.status, 200, `${method} on ${path}`)
  const { result } = await r.json()
  assert.equal(result.resultType, 'complete', method)
  return result
}

// a request that has to be refused: the HTTP status, and a JSON-RPC error for the request, since a client reads a
// 4xx without one as an older server and falls back to initialize
async function refused(r: Response, status: number, code: number) {
  assert.equal(r.status, status)
  assert.match(r.headers.get('content-type') ?? '', /^application\/json/)
  const body = await r.json()
  assert.deepEqual([body.jsonrpc, body.id, body.error.code, typeof body.error.message], ['2.0', 7, code, 'string'], JSON.stringify(body))
  return body.error
}

test('mcp: an older client opens with initialize, then lists and calls the tools, on both doors', async () => {
  for (const { path, tools } of DOORS) {
    // it is answered in the revision it asks for, or in the newest one that opens this way
    const hello = async (asked: string) => (await legacy(path, 'initialize', { protocolVersion: asked, capabilities: {}, clientInfo: { name: 'era-test', version: '1.0.0' } }, {})).result
    const current = await hello('2025-11-25')
    assert.deepEqual([current.protocolVersion, current.capabilities, current.serverInfo.name], ['2025-11-25', { tools: { listChanged: false } }, 'on-the-record'])
    assert.match(current.serverInfo.description, /^A private archive of Ada and Grace's recorded meetings/)
    const older = await hello('2025-06-18')
    assert.deepEqual([older.protocolVersion, older.serverInfo.description], ['2025-06-18', undefined], 'a description is a 2025-11-25 field')
    for (const asked of ['2026-07-28', '2027-01-01', '']) assert.equal((await hello(asked)).protocolVersion, '2025-11-25', asked)
    assert.equal((await post(path, { jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202)
    // the door's own tools, and results the way those revisions know them
    const list = (await legacy(path, 'tools/list')).result
    assert.equal(list.tools.length, tools, path)
    assert.deepEqual([list.resultType, list.ttlMs, list.cacheScope, list._meta], [undefined, undefined, undefined, undefined])
    const board = (await legacy(path, 'tools/call', { name: 'list_action_items', arguments: { status: 'all' } })).result
    assert.ok(board.structuredContent.items.length > 0 && !board.isError && board.resultType === undefined)
    // a change is made on /mcp, and refused on /mcp/readonly as a tool error the model can read
    const added = (await legacy(path, 'tools/call', { name: 'add_action_item', arguments: { text: 'Order the name badges', owner: 'Grace' } })).result
    if (path === '/mcp') assert.equal(added.structuredContent.added.text, 'Order the name badges')
    else assert.deepEqual([added.isError, added.content[0].text], [true, READ_ONLY])
    assert.deepEqual((await legacy(path, 'ping')).result, {})
    // server/discover is 2026-07-28's: asked without params._meta it isn't there, and the client carries on with initialize
    assert.equal((await legacy(path, 'server/discover')).error.code, -32601)
  }
})

test('mcp: a 2026-07-28 client discovers the server, then lists and calls the tools, on both doors', async () => {
  for (const { path, tools } of DOORS) {
    const found = await ok(path, 'server/discover')
    assert.deepEqual([found.supportedVersions, found.capabilities], [VERSIONS, { tools: { listChanged: false } }])
    assert.match(found.instructions, path === '/mcp' ? /Changes are credited to "Tester"/ : /this connection is read-only/)
    assert.ok(Number.isInteger(found.ttlMs) && found.ttlMs > 0 && found.cacheScope === 'private', `${found.ttlMs} ${found.cacheScope}`)
    const me = found._meta['io.modelcontextprotocol/serverInfo']
    assert.deepEqual([me.name, me.title], ['on-the-record', "On the Record: Ada and Grace's meetings"])
    assert.match(me.version, /^\d+\.\d+\.\d+$/)
    assert.match(me.description, /Ada and Grace/)
    // the door's own tools: the ones an older client gets, in the same order every time, for this connection to keep a while
    const list = await ok(path, 'tools/list')
    const names = (l: { tools: { name: string }[] }) => l.tools.map((t) => t.name)
    assert.equal(list.tools.length, tools, path)
    assert.deepEqual(names(list), names((await legacy(path, 'tools/list')).result))
    assert.deepEqual(names(await ok(path, 'tools/list')), names(list))
    assert.deepEqual([list.ttlMs, list.cacheScope, list._meta['io.modelcontextprotocol/serverInfo'].name], [found.ttlMs, 'private', 'on-the-record'])
    // a tool call, its name in Mcp-Name: a complete result, and not a list to keep
    const board = await ok(path, 'tools/call', { name: 'list_action_items', arguments: { status: 'all' } })
    assert.ok(board.structuredContent.items.length > 0 && !board.isError)
    assert.deepEqual([board.ttlMs, board.cacheScope], [undefined, undefined])
    const added = await ok(path, 'tools/call', { name: 'add_action_item', arguments: { text: 'Book the shuttle', owner: 'Ada' } })
    if (path === '/mcp') assert.equal(added.structuredContent.added.text, 'Book the shuttle')
    else assert.deepEqual([added.isError, added.content[0].text], [true, READ_ONLY])
    // a name sent as =?base64?…?= is read the same as the plain one
    const encoded = await modern(path, 'tools/call', { name: 'list_meetings', arguments: {} }, { headers: { 'mcp-name': `=?base64?${Buffer.from('list_meetings').toString('base64')}?=` } })
    assert.equal(encoded.status, 200)
    assert.equal((await encoded.json()).result.structuredContent.meetings.length, 2)
    // the empty lists, for clients that ask whatever the capabilities say, carry the same hints
    for (const [method, key] of [['resources/list', 'resources'], ['resources/templates/list', 'resourceTemplates'], ['prompts/list', 'prompts']]) {
      const empty = await ok(path, method)
      assert.deepEqual([empty[key], empty.ttlMs, empty.cacheScope], [[], found.ttlMs, 'private'], method)
    }
    // an unknown tool is the client's mistake, said in the answer like any other JSON-RPC error
    const unknown = await modern(path, 'tools/call', { name: 'rm_rf', arguments: {} })
    assert.deepEqual([unknown.status, (await unknown.json()).error.code], [200, -32602])
  }
})

test('mcp: a 2026-07-28 request is refused, and nothing runs, when its revision, headers or _meta are off', async () => {
  const call = { name: 'add_action_item', arguments: { text: 'Never added', owner: 'Grace' } }
  for (const { path } of DOORS) {
    // a header left out
    for (const header of ['mcp-protocol-version', 'mcp-method', 'mcp-name']) await refused(await modern(path, 'tools/call', call, { headers: { [header]: undefined } }), 400, -32020)
    // a header that says something other than the body
    const disagree = [
      { 'mcp-protocol-version': '2027-01-01' },
      { 'mcp-method': 'tools/list' },
      { 'mcp-name': 'search' },
      { 'mcp-name': `=?base64?${Buffer.from('delete_action_item').toString('base64')}?=` },
      { 'mcp-name': 'add_actión_item' }, // not plain ASCII, and not sent as base64
    ]
    for (const headers of disagree) await refused(await modern(path, 'tools/call', call, { headers }), 400, -32020)
    // a revision this server doesn't serve this way, named in both places: the error lists the ones it does
    for (const version of ['2027-01-01', '2025-11-25']) {
      const error = await refused(await modern(path, 'tools/call', call, { meta: { 'io.modelcontextprotocol/protocolVersion': version }, headers: { 'mcp-protocol-version': version } }), 400, -32022)
      assert.deepEqual(error.data, { supported: VERSIONS, requested: version })
    }
    // the one disagreement let through: Claude's connectors send the older revision in the header (see mcp.ts)
    const tolerated = await modern(path, 'tools/call', { name: 'list_action_items', arguments: {} }, { headers: { 'mcp-protocol-version': '2025-11-25' } })
    assert.equal(tolerated.status, 200)
    // the client's capabilities are required, even when it has none to declare
    await refused(await modern(path, 'tools/call', call, { meta: { 'io.modelcontextprotocol/clientCapabilities': undefined } }), 400, -32602)
  }
  const board = (await legacy('/mcp', 'tools/call', { name: 'list_action_items', arguments: { status: 'all' } })).result.structuredContent.items
  assert.ok(!board.some((a: { text: string }) => a.text === 'Never added'), 'a refused request runs nothing')
})

test('mcp: 2026-07-28 has no batches, ping, handshake or stream, and older clients keep what they had', async () => {
  for (const { path } of DOORS) {
    // a batch with a 2026-07-28 request in it is refused whole, while an older client's batch is still answered
    const request = (id: number) => ({ jsonrpc: '2.0', id, method: 'tools/list', params: { _meta: META } })
    const batch = await post(path, [request(1), request(2)], { 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/list' })
    assert.equal(batch.status, 400)
    assert.equal((await batch.json()).error.code, -32600)
    const older = await post(path, [{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', id: 2, method: 'tools/list' }])
    assert.deepEqual((await older.json()).map((r: { id: number }) => r.id), [1, 2])
    // a method it doesn't have answers 404, with the JSON-RPC error that tells this server from an older one
    for (const method of ['ping', 'initialize', 'logging/setLevel', 'subscriptions/listen']) await refused(await modern(path, method), 404, -32601)
    // a notification is taken, with no answer
    assert.equal((await post(path, { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 7, _meta: META } }, { 'mcp-protocol-version': '2026-07-28' })).status, 202)
    // no stream to open and no session to end, whichever revision the client names
    for (const method of ['GET', 'DELETE']) {
      for (const headers of [{}, { 'mcp-protocol-version': '2026-07-28' }, { 'mcp-protocol-version': '2025-06-18' }] as Record<string, string>[]) {
        const r = await fetch(`${base}${path}`, { method, headers })
        assert.deepEqual([r.status, r.headers.get('allow')], [405, 'POST'], `${method} ${JSON.stringify(headers)}`)
        await r.arrayBuffer()
      }
    }
  }
})

// Just enough of JSON Schema to hold a result to the schemas these tools publish: what doesn't fit, and where
type Schema = { type?: string; properties?: Record<string, Schema>; required?: string[]; items?: Schema; enum?: unknown[] }
function misfits(value: unknown, schema: Schema, at = 'result'): string[] {
  const type = Array.isArray(value) ? 'array' : value === null ? 'null' : Number.isInteger(value) ? 'integer' : typeof value
  if (schema.type && schema.type !== type) return [`${at} is ${type}, not ${schema.type}`]
  if (schema.enum && !schema.enum.includes(value)) return [`${at} is ${JSON.stringify(value)}, not one of ${schema.enum.join(', ')}`]
  const out: string[] = []
  if (type === 'object') {
    const v = value as Record<string, unknown>
    for (const k of schema.required ?? []) if (!(k in v)) out.push(`${at}.${k} is missing`)
    for (const [k, s] of Object.entries(schema.properties ?? {})) if (k in v) out.push(...misfits(v[k], s, `${at}.${k}`))
  }
  if (type === 'array' && schema.items) (value as unknown[]).forEach((x, i) => out.push(...misfits(x, schema.items!, `${at}[${i}]`)))
  return out
}

test('mcp: list_action_items and get_action_item publish the shape of their results, and keep to it', async () => {
  // items in every state there is, so the shape is held to more than a plain open item
  const add = async (text: string) => (await ok('/mcp', 'tools/call', { name: 'add_action_item', arguments: { text, owner: 'Grace' } })).structuredContent.added.id as string
  const [finished, dropped, parked] = [await add('Print the programmes'), await add('Rent the projector'), await add('Send the follow-up survey')]
  await ok('/mcp', 'tools/call', { name: 'update_action_item', arguments: { id: finished, status: 'done', evidence: 'Collected on Friday' } })
  await ok('/mcp', 'tools/call', { name: 'update_action_item', arguments: { id: dropped, status: 'canceled', reason: 'The venue has one' } })
  await ok('/mcp', 'tools/call', { name: 'update_action_item', arguments: { id: parked, on_hold: 'Until the event is over', blocked_by: [finished] } })
  for (const { path } of DOORS) {
    const tools: { name: string; outputSchema?: Schema }[] = (await ok(path, 'tools/list')).tools
    assert.deepEqual(tools.filter((t) => t.outputSchema).map((t) => t.name), ['list_action_items', 'get_action_item'], 'the others answer in text, or in JSON with no promise about its shape')
    const schema = (name: string) => tools.find((t) => t.name === name)!.outputSchema!
    assert.deepEqual(misfits({ count: 1, board: {}, items: [{ id: 'x', rev: 1.5, status: 'open', owner: 'Ada', lane: 'us' }] }, schema('list_action_items')), ['result.items[0].text is missing', 'result.items[0].rev is number, not integer'])
    const list = await ok(path, 'tools/call', { name: 'list_action_items', arguments: { status: 'all' } })
    assert.deepEqual(misfits(list.structuredContent, schema('list_action_items')), [])
    // the same result as JSON text, for clients that only read text
    assert.deepEqual(JSON.parse(list.content[0].text), list.structuredContent)
    for (const { id } of list.structuredContent.items) {
      const one = await ok(path, 'tools/call', { name: 'get_action_item', arguments: { id } })
      assert.deepEqual(misfits(one.structuredContent, schema('get_action_item')), [], id)
    }
    // read by name: where each item stands, and the rev to pass back as if_rev
    const byId = new Map(list.structuredContent.items.map((a: { id: string; status: string; rev: number }) => [a.id, [a.status, a.rev]]))
    assert.deepEqual([byId.get(finished), byId.get(dropped), byId.get(parked)], [['done', 1], ['canceled', 1], ['open', 1]])
  }
})
