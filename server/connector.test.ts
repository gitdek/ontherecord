// The connector hostname end to end, the way a hosted assistant goes through it: discovery, registration, the
// person approving on the site, the code traded for tokens with PKCE, the two doors, refresh and ending it.
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import fs, { mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer, request, type Server } from 'node:http'
import { syncBuiltinESMExports } from 'node:module'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { createApp, type App } from './app.ts'
import { configFrom } from './config.ts'
import { fixtureDir, requestApp } from './fixtures.test-helper.ts'

const CONNECTOR = 'https://meetings-mcp.example.test'
const CLAUDE = 'https://claude.ai/api/mcp/auth_callback'
let dir: string
let data: string
let server: Server
let port: number
let app: App

const settings = (dataDir = data) =>
  configFrom({ PORT: String(port), MEETINGS_DIR: dir, DATA_DIR: dataDir, CREW: 'Ada Byron,Grace Hopper', LOCAL_USER: 'Ada', DIARIZE_PYTHON: '', PUBLIC_URL: `http://127.0.0.1:${port}`, CONNECTOR_URL: CONNECTOR })

before(async () => {
  dir = await realpath(await fixtureDir({ index: true }))
  data = await mkdtemp(join(tmpdir(), 'meetings-connector-'))
  server = createServer((req, res) => void app.handler(req, res))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  port = (server.address() as AddressInfo).port
  app = await createApp(settings(), { watch: false, backups: false })
  await app.start()
})

after(async () => {
  await app.close()
  server.close()
  await rm(dir, { recursive: true, force: true })
  await rm(data, { recursive: true, force: true })
})

type Reply = { status: number; headers: Record<string, string | string[] | undefined>; body: string; json: () => any }
// A request to this server under a given hostname (the connector's, or the site's own on this Mac).
function call(host: string, method: string, path: string, opts: { headers?: Record<string, string>; body?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers: { Host: host, ...opts.headers } }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (d) => (body += d))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body, json: () => JSON.parse(body) }))
    })
    req.on('error', reject)
    req.end(opts.body)
  })
}
const connector = (method: string, path: string, opts?: { headers?: Record<string, string>; body?: string }) => call('meetings-mcp.example.test', method, path, opts)
const site = (method: string, path: string, opts?: { headers?: Record<string, string>; body?: string }) => call(`127.0.0.1:${port}`, method, path, opts)
const form = (fields: Record<string, string>) => ({ headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() })
const asJson = (value: unknown, headers: Record<string, string> = {}) => ({ headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(value) })
const mcp = (tok: string, method: string, params: unknown = {}) =>
  asJson({ jsonrpc: '2.0', id: 1, method, params }, { Accept: 'application/json, text/event-stream', Authorization: `Bearer ${tok}`, 'MCP-Protocol-Version': '2025-06-18' })

const pkce = () => {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

// one address may register only a few assistants an hour, so each comes from its own, as through Cloudflare
let callers = 0
async function register(redirect = CLAUDE, extra: Record<string, unknown> = {}) {
  const r = await connector('POST', '/oauth/register', asJson({ client_name: 'Claude', redirect_uris: [redirect], ...extra }, { 'CF-Connecting-IP': `198.51.100.${++callers}` }))
  assert.equal(r.status, 201, r.body)
  return r.json() as { client_id: string; client_secret?: string }
}

// Everything up to the approval page: returns the pending request's id, or where the browser was sent instead.
async function authorize(clientId: string, challenge: string, more: Record<string, string> = {}) {
  const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: CLAUDE, code_challenge: challenge, code_challenge_method: 'S256', state: 'st-1', resource: `${CONNECTOR}/mcp`, ...more })
  const r = await site('GET', `/connect/authorize?${q}`)
  assert.equal(r.status, 302)
  return String(r.headers.location)
}

async function approve(location: string, yes = true) {
  const id = /^\/connect\?req=([a-f0-9]{32})$/.exec(location)![1]
  const r = await site('POST', `/api/connector/requests/${id}`, asJson({ approve: yes }, { 'X-Requested-With': 'meetings' }))
  assert.equal(r.status, 200, r.body)
  return new URL(r.json().redirect as string)
}

async function connect(resource = `${CONNECTOR}/mcp`) {
  const client = await register()
  const { verifier, challenge } = pkce()
  const back = await approve(await authorize(client.client_id, challenge, { resource }))
  const r = await connector('POST', '/oauth/token', form({ grant_type: 'authorization_code', code: back.searchParams.get('code')!, redirect_uri: CLAUDE, code_verifier: verifier, client_id: client.client_id }))
  assert.equal(r.status, 200, r.body)
  return { client, tokens: r.json() as { access_token: string; refresh_token: string; token_type: string; scope: string; expires_in: number } }
}

test('connector: a door without a token says where to sign in, and discovery leads there', async () => {
  const bare = await connector('POST', '/mcp', asJson({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))
  assert.equal(bare.status, 401)
  assert.equal(bare.headers['www-authenticate'], `Bearer resource_metadata="${CONNECTOR}/.well-known/oauth-protected-resource/mcp", scope="write"`)
  const ro = await connector('POST', '/mcp/readonly', asJson({}))
  assert.match(String(ro.headers['www-authenticate']), /oauth-protected-resource\/mcp\/readonly", scope="read"/)
  const meta = (await connector('GET', '/.well-known/oauth-protected-resource/mcp')).json()
  assert.deepEqual([meta.resource, meta.authorization_servers], [`${CONNECTOR}/mcp`, [CONNECTOR]])
  const as = (await connector('GET', '/.well-known/oauth-authorization-server')).json()
  assert.equal(as.issuer, CONNECTOR)
  assert.equal(as.authorization_endpoint, `http://127.0.0.1:${port}/connect/authorize`, 'the authorize page stays on the site, behind Access')
  assert.deepEqual(as.code_challenge_methods_supported, ['S256'])
  // Codex accepts a sign-in page on another hostname than the issuer's only when the answers name their issuer
  assert.notEqual(new URL(as.authorization_endpoint).origin, new URL(as.issuer).origin)
  assert.equal(as.authorization_response_iss_parameter_supported, true)
  // the connector hostname serves nothing of the site
  for (const p of ['/api/library', '/', '/media/x', '/api/actions']) assert.equal((await connector('GET', p)).status, 404, p)
})

test('connector: only known assistants and loopback addresses may register', async () => {
  const bad = await connector('POST', '/oauth/register', asJson({ redirect_uris: ['https://evil.example/cb'] }))
  assert.deepEqual([bad.status, bad.json().error], [400, 'invalid_redirect_uri'])
  assert.equal((await connector('POST', '/oauth/register', asJson({ redirect_uris: [] }))).status, 400)
  assert.ok((await register('http://127.0.0.1:33418/callback')).client_id)
  const secret = await register(CLAUDE, { token_endpoint_auth_method: 'client_secret_post' })
  assert.match(secret.client_secret!, /^otr_cs_/)
})

test('connector: command-line agents sign in through a callback on their own machine, on any port', async () => {
  // Codex registers http://127.0.0.1/callback/<id> and signs in on the port it listens on; Hermes picks a random
  // port and registers as a confidential client; Claude Code uses localhost
  const agents: [string, string, Record<string, unknown>][] = [
    ['http://127.0.0.1/callback/XuuuHAzzHOni', 'http://127.0.0.1:5555/callback/XuuuHAzzHOni', {}],
    ['http://127.0.0.1:49152/callback', 'http://127.0.0.1:49152/callback', { token_endpoint_auth_method: 'client_secret_post' }],
    ['http://localhost:33418/callback', 'http://localhost:40001/callback', {}],
  ]
  for (const [registered, used, extra] of agents) {
    const client = await register(registered, extra)
    const { verifier, challenge } = pkce()
    const back = await approve(await authorize(client.client_id, challenge, { redirect_uri: used }))
    assert.equal(back.origin + back.pathname, used)
    const secret: Record<string, string> = client.client_secret ? { client_secret: client.client_secret } : {}
    const r = await connector('POST', '/oauth/token', form({ grant_type: 'authorization_code', code: back.searchParams.get('code')!, redirect_uri: used, code_verifier: verifier, client_id: client.client_id, resource: `${CONNECTOR}/mcp`, ...secret }))
    assert.equal(r.status, 200, r.body)
    assert.equal((await connector('POST', '/mcp', mcp(r.json().access_token, 'tools/list'))).status, 200)
  }
  // only the port is free: another path, another loopback name or https is refused before anyone sees a page
  const client = await register('http://127.0.0.1/callback')
  for (const elsewhere of ['http://127.0.0.1:5555/other', 'http://localhost:5555/callback', 'https://127.0.0.1/callback'])
    assert.match(await authorize(client.client_id, pkce().challenge, { redirect_uri: elsewhere }), /^\/connect\?error=/, elsewhere)
})

test('connector: approve, trade the code with PKCE, and work as the person’s agent through both doors', async () => {
  const { tokens } = await connect()
  assert.deepEqual([tokens.token_type, tokens.scope, tokens.expires_in], ['Bearer', 'write', 3600])
  const list = await connector('POST', '/mcp', mcp(tokens.access_token, 'tools/list'))
  assert.equal(list.status, 200, list.body)
  assert.equal(list.json().result.tools.length, 17)
  const added = await connector('POST', '/mcp', mcp(tokens.access_token, 'tools/call', { name: 'add_action_item', arguments: { text: 'Order the banner', owner: 'Ada' } }))
  assert.deepEqual([added.status, added.json().result.isError], [200, undefined], added.body)
  const board = (await site('GET', '/api/actions')).json() as { actions: { text: string; createdBy?: string }[] }
  assert.equal(board.actions.find((a) => a.text === 'Order the banner')?.createdBy, "Ada's agent")
  // the write token may read on the read-only door, which offers the read tools only
  const ro = await connector('POST', '/mcp/readonly', mcp(tokens.access_token, 'tools/list'))
  assert.equal(ro.json().result.tools.length, 10)
})

test('connector: a code works once, only with its verifier, and a decline goes back as access_denied', async () => {
  const client = await register()
  const { verifier, challenge } = pkce()
  const back = await approve(await authorize(client.client_id, challenge))
  assert.deepEqual([back.origin + back.pathname, back.searchParams.get('state'), back.searchParams.get('iss')], [CLAUDE, 'st-1', CONNECTOR])
  const code = back.searchParams.get('code')!
  const wrong = await connector('POST', '/oauth/token', form({ grant_type: 'authorization_code', code, redirect_uri: CLAUDE, code_verifier: pkce().verifier, client_id: client.client_id }))
  assert.deepEqual([wrong.status, wrong.json().error], [400, 'invalid_grant'])
  const again = await connector('POST', '/oauth/token', form({ grant_type: 'authorization_code', code, redirect_uri: CLAUDE, code_verifier: verifier, client_id: client.client_id }))
  assert.equal(again.json().error, 'invalid_grant', 'a code is spent by its first use, right or wrong')
  const declined = await approve(await authorize(client.client_id, challenge), false)
  assert.deepEqual([declined.searchParams.get('error'), declined.searchParams.get('code'), declined.searchParams.get('iss')], ['access_denied', null, CONNECTOR])
  // without PKCE the assistant hears why; from an unknown assistant, the page says so instead of sending anyone anywhere
  const noPkce = new URL(await authorize(client.client_id, challenge, { code_challenge_method: 'plain' }))
  assert.deepEqual([noPkce.searchParams.get('error'), noPkce.searchParams.get('state'), noPkce.searchParams.get('iss')], ['invalid_request', 'st-1', CONNECTOR])
  assert.match(await authorize('otr_c_nobody', challenge), /^\/connect\?error=/)
  // an approval page belongs to whoever opened it, and a confidential client must prove its secret
  const secret = await register(CLAUDE, { token_endpoint_auth_method: 'client_secret_post' })
  const p2 = pkce()
  const c2 = (await approve(await authorize(secret.client_id, p2.challenge))).searchParams.get('code')!
  const noSecret = await connector('POST', '/oauth/token', form({ grant_type: 'authorization_code', code: c2, redirect_uri: CLAUDE, code_verifier: p2.verifier, client_id: secret.client_id }))
  assert.deepEqual([noSecret.status, noSecret.json().error], [401, 'invalid_client'])
  const credentials = Buffer.from(`${secret.client_id}:%`).toString('base64')
  const malformed = form({ grant_type: 'authorization_code', code: c2, redirect_uri: CLAUDE, code_verifier: p2.verifier })
  const invalid = await connector('POST', '/oauth/token', { ...malformed, headers: { ...malformed.headers, Authorization: `Basic ${credentials}` } })
  assert.deepEqual([invalid.status, invalid.json().error], [401, 'invalid_client'])
  assert.match(String(invalid.headers['www-authenticate']), /^Basic /)
})

test('connector: a read-only connection can’t write, refresh tokens rotate, and an ended connection stops at once', async (t) => {
  const ro = await connect(`${CONNECTOR}/mcp/readonly`)
  assert.equal(ro.tokens.scope, 'read')
  const refused = await connector('POST', '/mcp', mcp(ro.tokens.access_token, 'tools/list'))
  assert.equal(refused.status, 403)
  assert.match(String(refused.headers['www-authenticate']), /error="insufficient_scope"/)
  assert.equal((await connector('POST', '/mcp/readonly', mcp(ro.tokens.access_token, 'tools/list'))).status, 200)

  const { client, tokens } = await connect()
  const fresh = await connector('POST', '/oauth/token', form({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id }))
  assert.equal(fresh.status, 200)
  const next = fresh.json() as { access_token: string; refresh_token: string }
  assert.notEqual(next.refresh_token, tokens.refresh_token)
  // within a minute the replaced token renews again, for a client whose answer got lost on the way back
  const retried = await connector('POST', '/oauth/token', form({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id }))
  assert.equal(retried.status, 200, retried.body)
  const latest = retried.json() as { access_token: string; refresh_token: string }
  // after that, an old token is a copy someone kept, and presenting it ends the public connection
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 61_000 })
  const reused = await connector('POST', '/oauth/token', form({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id }))
  assert.equal(reused.json().error, 'invalid_grant', 'a refresh token works once')
  assert.equal((await connector('POST', '/mcp', mcp(latest.access_token, 'tools/list'))).status, 401, 'a replay ends the public connection')
  const afterReplay = await connector('POST', '/oauth/token', form({ grant_type: 'refresh_token', refresh_token: latest.refresh_token, client_id: client.client_id }))
  assert.equal(afterReplay.json().error, 'invalid_grant')

  const listed = (await site('GET', '/api/connector')).json() as { enabled: boolean; connections: { id: string; person: string; scope: string }[] }
  assert.equal(listed.enabled, true)
  const mine = listed.connections.filter((c) => c.person === 'Ada')
  assert.ok(mine.length >= 3)
  for (const c of mine) assert.equal((await site('POST', `/api/connector/connections/${c.id}/end`, asJson({}, { 'X-Requested-With': 'meetings' }))).status, 200)
  assert.equal((await connector('POST', '/mcp/readonly', mcp(ro.tokens.access_token, 'tools/list'))).status, 401, 'ended: its tokens stop working at once')
  const afterEnd = await connector('POST', '/oauth/token', form({ grant_type: 'refresh_token', refresh_token: ro.tokens.refresh_token, client_id: ro.client.client_id }))
  assert.equal(afterEnd.json().error, 'invalid_grant')
})

test('connector: a restart signs nobody out, and a connection ended before it stays ended', async () => {
  // Codex refreshes only when its own clock says the access token is spent, so the token has to outlive a restart
  const kept = await connect()
  const ended = await connect()
  assert.equal((await connector('POST', '/oauth/revoke', form({ token: ended.tokens.refresh_token, client_id: ended.client.client_id }))).status, 200)
  const again = await createApp(settings(), { watch: false, backups: false })
  await again.start()
  const srv = createServer((req, res) => void again.handler(req, res))
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  const status = (tok: string) =>
    new Promise<number>((resolve, reject) => {
      const { headers, body } = mcp(tok, 'tools/list')
      const req = request({ host: '127.0.0.1', port: (srv.address() as AddressInfo).port, method: 'POST', path: '/mcp', headers: { Host: 'meetings-mcp.example.test', ...headers } }, (res) => (res.resume(), resolve(res.statusCode ?? 0)))
      req.on('error', reject)
      req.end(body)
    })
  try {
    assert.equal(await status(kept.tokens.access_token), 200)
    assert.equal(await status(ended.tokens.access_token), 401)
  } finally {
    srv.close()
    await again.close()
  }
})

test('connector: off without CONNECTOR_URL, and the approval page keeps the assistant’s window', async () => {
  const page = await site('GET', '/connect?req=0123')
  assert.equal(page.headers['cross-origin-opener-policy'], 'unsafe-none')
  assert.equal((await site('GET', '/actions')).headers['cross-origin-opener-policy'], 'same-origin')
  const off = await createApp(configFrom({ PORT: String(port), MEETINGS_DIR: dir, DATA_DIR: data, DIARIZE_PYTHON: '' }), { watch: false, backups: false })
  const srv = createServer((req, res) => void off.handler(req, res))
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  const p = (srv.address() as AddressInfo).port
  const status = await new Promise<number>((resolve) => request({ host: '127.0.0.1', port: p, path: '/mcp', method: 'POST', headers: { Host: 'meetings-mcp.example.test' } }, (res) => (res.resume(), resolve(res.statusCode ?? 0))).end())
  assert.equal(status, 403, 'no connector: the hostname is just another request the Access gate refuses')
  srv.close()
  await off.close()
})

test('connector: closing the app waits for the last-used write a door check queued', async (t) => {
  const { tokens } = await connect()
  const second = await createApp(settings(), { watch: false, backups: false })
  await second.start()
  // the next save of the connector file waits until the test lets it go
  let release = () => {}
  const held = new Promise<void>((resolve) => (release = resolve))
  const write = fs.writeFile
  const holding = t.mock.method(fs, 'writeFile', async (...args: Parameters<typeof fs.writeFile>) => {
    if (String(args[0]).startsWith(join(data, 'connector.json'))) await held
    return write(...args)
  })
  syncBuiltinESMExports()
  try {
    const door = await requestApp(second, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, undefined,
      { host: 'meetings-mcp.example.test', authorization: `Bearer ${tokens.access_token}`, accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' })
    assert.equal(door.statusCode, 200, door.payload)
    let closed = false
    const closing = second.close().then(() => (closed = true))
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(closed, false, 'close waits for the save still under way')
    release()
    await closing
  } finally {
    release()
    holding.mock.restore()
    syncBuiltinESMExports()
  }
  assert.deepEqual((await readdir(data)).filter((f) => f.startsWith('connector.json.')), [], 'no save is left half done')
  const saved = JSON.parse(await readFile(join(data, 'connector.json'), 'utf8')) as { grants: { createdAt: string; lastUsedAt?: string }[] }
  assert.ok(saved.grants.reduce((a, b) => (a.createdAt > b.createdAt ? a : b)).lastUsedAt, 'the newest connection’s last use was saved')
})

test('connector: a damaged connector file is set aside and the site still starts, with no connections', async (t) => {
  const fresh = await mkdtemp(join(tmpdir(), 'meetings-connector-damaged-'))
  t.after(() => rm(fresh, { recursive: true, force: true }))
  const cutOff = '{"clients":[{"id":"otr_c_x","name":"Cl'
  await writeFile(join(fresh, 'connector.json'), cutOff)
  const errors = t.mock.method(console, 'error', () => {})
  const damaged = await createApp(settings(fresh), { watch: false, backups: false })
  await damaged.start()
  try {
    const here = { host: `127.0.0.1:${port}` }
    assert.equal((await requestApp(damaged, '/api/library', undefined, undefined, here)).statusCode, 200)
    assert.deepEqual((await requestApp(damaged, '/api/connector', undefined, undefined, here)).json().connections, [])
  } finally {
    await damaged.close()
  }
  const aside = (await readdir(fresh)).filter((f) => f.startsWith('connector.json.corrupt-'))
  assert.equal(aside.length, 1)
  assert.equal(await readFile(join(fresh, aside[0]), 'utf8'), cutOff)
  assert.ok(errors.mock.calls.some((call) => /^connector: .*preserved the original/.test(String(call.arguments[0]))))
})

test('connector: with nowhere to send the person, the approval page gets a short code, never words', async () => {
  assert.equal(await authorize('otr_c_nobody', pkce().challenge), '/connect?error=invalid_client')
  const client = await register('http://127.0.0.1/callback')
  assert.equal(await authorize(client.client_id, pkce().challenge, { redirect_uri: 'http://127.0.0.1:5555/other' }), '/connect?error=invalid_request')
})
