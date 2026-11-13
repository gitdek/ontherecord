import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import type { PathLike } from 'node:fs'
import fs, { mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { test, type TestContext } from 'node:test'
import type { Viewer } from './access.ts'
import { CONNECTOR_LIMITS, Connector, OAuthError, serveConnector } from './connector.ts'

const issuer = 'https://connector.example.test'
const callback = 'https://assistant.example.test/callback'
const remote: Viewer = { name: 'Ada', email: 'Ada@example.test', local: false }
const local: Viewer = { name: 'Ada', email: '', local: true }
const alternate: Viewer = { name: 'Ada', email: 'alternate@example.test', local: false }
const digest = (s: string) => createHash('sha256').update(s)
const bearer = (token: string) => `Bearer ${token}`
const basic = (value: string) => `Basic ${Buffer.from(value).toString('base64')}`
const oauthError = (code: string, status = 400) => (err: unknown) => err instanceof OAuthError && err.code === code && err.status === status

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'meetings-connector-state-'))
  const opened: Connector[] = []
  // a door check queues a last-used write nobody awaits: the folder goes only once every save has finished
  t.after(async () => {
    await Promise.all(opened.map((c) => c.waitForWrites()))
    await rm(dir, { recursive: true, force: true })
  })
  const path = join(dir, 'connector.json')
  const users = new Map([[remote.email.toLowerCase(), remote.name], [alternate.email, alternate.name]])
  async function open(localUser = local.name, remoteEnabled = true) {
    const c = new Connector({ url: issuer, redirects: [callback] }, 'https://site.example.test', path, { users, localUser, remoteEnabled })
    opened.push(c)
    await c.load()
    return c
  }
  async function obstructSave() {
    await rename(path, `${path}.fixture`)
    await mkdir(path)
    return async () => {
      await rm(path, { recursive: true })
      await rename(`${path}.fixture`, path)
    }
  }
  return { c: await open(), open, users, path, obstructSave }
}

function register(c: Connector, method = 'none') {
  return c.register({ redirect_uris: [callback], token_endpoint_auth_method: method })
}

function pending(c: Connector, clientId: string, viewer = remote, redirectUri = callback) {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = digest(verifier).digest('base64url')
  const query = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', code_challenge_method: 'S256', code_challenge: challenge, resource: `${issuer}/mcp/readonly` })
  const { id } = c.authorize(query, viewer)
  return { id, approve: (who = viewer) => {
    const redirect = new URL(c.decide(id, true, who))
    return new URLSearchParams({ client_id: clientId, grant_type: 'authorization_code', code: redirect.searchParams.get('code')!, code_verifier: verifier, redirect_uri: redirectUri })
  } }
}

function refresh(c: Connector, clientId: string, token: string, authorization?: string) {
  return c.exchange(new URLSearchParams({ client_id: clientId, grant_type: 'refresh_token', refresh_token: token }), authorization)
}

test('connector approval belongs to the normalized email or the configured local identity', async (t) => {
  const { c, users } = await fixture(t)
  const client = await register(c)
  const request = pending(c, client.client_id)
  for (const viewer of [alternate, local, { ...remote, agent: true }]) {
    assert.equal(c.request(request.id, viewer), undefined)
    assert.throws(() => request.approve(viewer), oauthError('invalid_request', 404))
  }
  users.set(remote.email.toLowerCase(), 'Renamed Ada')
  const renamed = { ...remote, name: 'Renamed Ada', email: remote.email.toLowerCase() }
  assert.equal(c.request(request.id, renamed)?.person, 'Renamed Ada')
  const tokens = await c.exchange(request.approve(renamed))
  assert.deepEqual(c.check(bearer(tokens.access_token), 'read'), { viewer: { name: "Renamed Ada's agent", email: renamed.email, local: false, agent: true, scope: 'read' } })
  assert.deepEqual(c.check(bearer(tokens.access_token), 'write'), { status: 403, error: 'insufficient_scope' })
  await c.end(c.list()[0].id)
})

test('connector policy applies at approval, exchange and bearer use, including across restart', async (t) => {
  const { c, open, users } = await fixture(t)
  const client = await register(c)
  const tokens = await c.exchange(pending(c, client.client_id).approve())
  const localTokens = await c.exchange(pending(c, client.client_id, local).approve())
  const queued = pending(c, client.client_id)
  const code = pending(c, client.client_id).approve()
  users.delete(remote.email.toLowerCase())
  assert.equal(c.request(queued.id, remote), undefined)
  assert.throws(() => queued.approve(), oauthError('invalid_request', 404))
  await assert.rejects(c.exchange(code), oauthError('invalid_grant'))
  for (const current of [c, await open()]) {
    assert.deepEqual(current.check(bearer(tokens.access_token), 'read'), { status: 401, error: 'invalid_token' })
    await assert.rejects(refresh(current, client.client_id, tokens.refresh_token), oauthError('invalid_grant'))
  }
  const changedOwner = await open('New owner')
  assert.deepEqual(changedOwner.check(bearer(localTokens.access_token), 'read'), { status: 401, error: 'invalid_token' })
  await assert.rejects(refresh(changedOwner, client.client_id, localTokens.refresh_token), oauthError('invalid_grant'))
  assert.ok((await refresh(c, client.client_id, localTokens.refresh_token)).access_token)
  users.set(remote.email.toLowerCase(), remote.name)
  await assert.rejects(c.exchange(code), oauthError('invalid_grant'), 'an authenticated rejected exchange spends the code')
  const localOnly = await open(local.name, false)
  assert.deepEqual(localOnly.check(bearer(tokens.access_token), 'read'), { status: 401, error: 'invalid_token' })
  await assert.rejects(refresh(localOnly, client.client_id, tokens.refresh_token), oauthError('invalid_grant'))
})

test('legacy connector snapshots restore access and refresh for allowed remote and local people', async (t) => {
  const { c, open, path } = await fixture(t)
  const client = await register(c)
  const remoteTokens = await c.exchange(pending(c, client.client_id).approve())
  const localTokens = await c.exchange(pending(c, client.client_id, local).approve())
  const snapshot = JSON.parse(await readFile(path, 'utf8')) as { grants: { identity?: unknown }[] }
  for (const grant of snapshot.grants) delete grant.identity
  await writeFile(path, JSON.stringify(snapshot))
  const restarted = await open()
  for (const tokens of [remoteTokens, localTokens]) {
    assert.ok('viewer' in restarted.check(bearer(tokens.access_token), 'read'))
    assert.ok((await refresh(restarted, client.client_id, tokens.refresh_token)).access_token)
  }
})

test('a failed connector snapshot leaves refresh, registration and revocation retryable', async (t) => {
  const { c, open, obstructSave } = await fixture(t)
  const client = await register(c)
  const code = pending(c, client.client_id).approve()
  const tokens = await c.exchange(pending(c, client.client_id).approve())
  const restore = await obstructSave()
  const unavailable = oauthError('temporarily_unavailable', 503)
  await assert.rejects(refresh(c, client.client_id, tokens.refresh_token), unavailable)
  await assert.rejects(register(c), unavailable)
  await assert.rejects(c.exchange(code), unavailable)
  assert.ok('viewer' in c.check(bearer(tokens.access_token), 'read'))
  await c.end('unknown') // wait behind the best-effort last-used write
  assert.equal(c.list().length, 1)
  assert.equal(c.list()[0].lastUsedAt, null)
  await restore()
  assert.ok('viewer' in c.check(bearer(tokens.access_token), 'read'))
  await c.end('unknown')
  assert.ok(c.list()[0].lastUsedAt)
  await assert.rejects(c.exchange(code), oauthError('invalid_grant'))
  const rotated = await refresh(c, client.client_id, tokens.refresh_token)
  assert.ok('viewer' in c.check(bearer(rotated.access_token), 'read'))
  const id = c.list()[0].id
  const restoreAgain = await obstructSave()
  await assert.rejects(c.revokeToken(rotated.refresh_token), unavailable)
  assert.deepEqual(c.check(bearer(rotated.access_token), 'read'), { status: 401, error: 'invalid_token' })
  await assert.rejects(refresh(c, client.client_id, rotated.refresh_token), unavailable)
  assert.equal(c.list()[0].id, id, 'the Lab can retry pending revocation')
  await assert.rejects(c.end(id), unavailable)
  await restoreAgain()
  await c.revokeToken(rotated.refresh_token)
  assert.equal(await c.end(id), false)
  const restarted = await open()
  assert.equal(restarted.list().length, 0)
  assert.deepEqual(restarted.check(bearer(rotated.access_token), 'read'), { status: 401, error: 'invalid_token' })
})

test('serialized refresh, registration, last-used and revocation preserve the resulting snapshot', async (t) => {
  const { c, open } = await fixture(t)
  const client = await register(c)
  const first = await c.exchange(pending(c, client.client_id).approve())
  const second = await c.exchange(pending(c, client.client_id, local).approve())
  assert.ok('viewer' in c.check(bearer(second.access_token), 'read'))
  const [rotated, registered] = await Promise.all([refresh(c, client.client_id, first.refresh_token), register(c), c.revokeToken(first.access_token)])
  const restarted = await open()
  assert.equal(restarted.list().length, 1)
  assert.ok(restarted.list()[0].lastUsedAt)
  assert.deepEqual(restarted.check(bearer(rotated.access_token), 'read'), { status: 401, error: 'invalid_token' })
  await assert.rejects(refresh(restarted, client.client_id, rotated.refresh_token), oauthError('invalid_grant'))
  assert.ok((await restarted.exchange(pending(restarted, registered.client_id).approve())).access_token)
})

test('a concurrent revocation binds the family of the presented confidential refresh token', async (t) => {
  const { c, open } = await fixture(t)
  const client = await register(c, 'client_secret_basic')
  const authorization = basic(`${client.client_id}:${client.client_secret}`)
  const tokens = await c.exchange(pending(c, client.client_id).approve(), authorization)
  const [rotated] = await Promise.all([refresh(c, client.client_id, tokens.refresh_token, authorization), c.revokeToken(tokens.refresh_token)])
  const restarted = await open()
  assert.deepEqual(restarted.check(bearer(rotated.access_token), 'read'), { status: 401, error: 'invalid_token' })
  await assert.rejects(refresh(restarted, client.client_id, rotated.refresh_token, authorization), oauthError('invalid_grant'))
})

test('public refresh history persists and revokes only its family', async (t) => {
  const { c, open, obstructSave } = await fixture(t)
  const client = await register(c)
  const other = await register(c)
  const first = await c.exchange(pending(c, client.client_id).approve())
  const unrelated = await c.exchange(pending(c, client.client_id).approve())
  const second = await refresh(c, client.client_id, first.refresh_token)
  const latest = await refresh(c, client.client_id, second.refresh_token)
  const restarted = await open()
  await assert.rejects(refresh(restarted, other.client_id, first.refresh_token), oauthError('invalid_grant'))
  assert.equal(restarted.list().length, 2)
  const restore = await obstructSave()
  await assert.rejects(refresh(restarted, client.client_id, first.refresh_token), oauthError('temporarily_unavailable', 503))
  assert.equal(restarted.list().length, 2)
  assert.deepEqual(restarted.check(bearer(latest.access_token), 'read'), { status: 401, error: 'invalid_token' })
  await restore()
  await assert.rejects(refresh(restarted, client.client_id, first.refresh_token), oauthError('invalid_grant'))
  const again = await open()
  assert.deepEqual(again.check(bearer(latest.access_token), 'read'), { status: 401, error: 'invalid_token' })
  await assert.rejects(refresh(again, client.client_id, latest.refresh_token), oauthError('invalid_grant'))
  assert.ok((await refresh(again, client.client_id, unrelated.refresh_token)).access_token)
})

test('a renewal retried within a minute renews again; after that the old token ends the connection', async (t) => {
  const now = Date.now()
  t.mock.timers.enable({ apis: ['Date'], now })
  const { c, open } = await fixture(t)
  const client = await register(c)
  const tokens = await c.exchange(pending(c, client.client_id).approve())
  // the same token twice, as when the first answer is lost and the client tries again
  const [first, retried] = await Promise.all([refresh(c, client.client_id, tokens.refresh_token), refresh(c, client.client_id, tokens.refresh_token)])
  assert.notEqual(first.refresh_token, retried.refresh_token)
  const restarted = await open()
  assert.equal(restarted.list().length, 1)
  assert.ok('viewer' in restarted.check(bearer(retried.access_token), 'read'))
  const latest = await refresh(restarted, client.client_id, retried.refresh_token)
  // a minute after the first renewal, the original token can only be a copy: the connection ends
  t.mock.timers.setTime(now + 61_000)
  await assert.rejects(refresh(restarted, client.client_id, tokens.refresh_token), oauthError('invalid_grant'))
  const after = await open()
  assert.equal(after.list().length, 0)
  assert.deepEqual(after.check(bearer(latest.access_token), 'read'), { status: 401, error: 'invalid_token' })
})

test('public refresh history keeps its newest entries and never forces a reconnect', async (t) => {
  const { c, open, path } = await fixture(t)
  const client = await register(c)
  const tokens = await c.exchange(pending(c, client.client_id).approve())
  const snapshot = JSON.parse(await readFile(path, 'utf8')) as { grants: { usedRefreshHashes?: string[] }[] }
  // an earlier version kept up to 4,096 spent tokens per connection
  snapshot.grants[0].usedRefreshHashes = Array.from({ length: 4096 }, (_, i) => digest(String(i)).digest('hex'))
  await writeFile(path, JSON.stringify(snapshot))
  const restarted = await open()
  assert.ok((await refresh(restarted, client.client_id, tokens.refresh_token)).access_token)
  const saved = JSON.parse(await readFile(path, 'utf8')) as { grants: { usedRefreshHashes?: string[] }[] }
  assert.equal(saved.grants[0].usedRefreshHashes?.length, CONNECTOR_LIMITS.refreshHistory)
  assert.equal((await open()).list().length, 1)
})

test('loopback registrations allow a dynamic port and the issued code binds its chosen callback', async (t) => {
  const { c } = await fixture(t)
  const client = await c.register({ redirect_uris: ['http://127.0.0.1/callback'] })
  const used = 'http://127.0.0.1:45328/callback'
  const wrong = pending(c, client.client_id, remote, used).approve()
  wrong.set('redirect_uri', 'http://127.0.0.1:45329/callback')
  await assert.rejects(c.exchange(wrong), oauthError('invalid_grant'))
  assert.ok((await c.exchange(pending(c, client.client_id, remote, used).approve())).access_token)
  const omitted = pending(c, client.client_id, remote, used).approve()
  omitted.delete('redirect_uri')
  assert.ok((await c.exchange(omitted)).access_token)
})

test('connector rejects expired credentials and binds exchange to the authorized resource', async (t) => {
  const now = Date.now()
  t.mock.timers.enable({ apis: ['Date'], now })
  const { c } = await fixture(t)
  const client = await register(c)
  const mismatched = pending(c, client.client_id).approve()
  mismatched.set('resource', `${issuer}/mcp`)
  await assert.rejects(c.exchange(mismatched), oauthError('invalid_target'))
  mismatched.set('resource', `${issuer}/mcp/readonly`)
  await assert.rejects(c.exchange(mismatched), oauthError('invalid_grant'))
  const expiredCode = pending(c, client.client_id).approve()
  const tokens = await c.exchange(pending(c, client.client_id).approve())
  const refreshParams = new URLSearchParams({ client_id: client.client_id, grant_type: 'refresh_token', refresh_token: tokens.refresh_token, resource: `${issuer}/mcp` })
  await assert.rejects(c.exchange(refreshParams), oauthError('invalid_target'))
  t.mock.timers.setTime(now + 60 * 60_000)
  await assert.rejects(c.exchange(expiredCode), oauthError('invalid_grant'))
  assert.deepEqual(c.check(bearer(tokens.access_token), 'read'), { status: 401, error: 'invalid_token' })
  const refreshed = await refresh(c, client.client_id, tokens.refresh_token)
  t.mock.timers.setTime(now + 61 * 24 * 60 * 60_000)
  await assert.rejects(refresh(c, client.client_id, refreshed.refresh_token), oauthError('invalid_grant'))
})

test('the original access token can retry a failed revocation after it expires', async (t) => {
  const now = Date.now()
  t.mock.timers.enable({ apis: ['Date'], now })
  const { c, open, obstructSave } = await fixture(t)
  const client = await register(c)
  const tokens = await c.exchange(pending(c, client.client_id).approve())
  const restore = await obstructSave()
  await assert.rejects(c.revokeToken(tokens.access_token), oauthError('temporarily_unavailable', 503))
  await restore()
  t.mock.timers.setTime(now + 60 * 60_000)
  await c.revokeToken(tokens.access_token)
  await assert.rejects(refresh(await open(), client.client_id, tokens.refresh_token), oauthError('invalid_grant'))
})

test('Basic client validation returns OAuth errors and confidential refresh stays supported', async (t) => {
  const { c } = await fixture(t)
  const client = await register(c, 'client_secret_basic')
  const code = pending(c, client.client_id).approve()
  for (const header of ['Basic', 'Basic invalid*', basic(client.client_id), basic(`${client.client_id}:%`), basic(`%:${client.client_secret}`)]) {
    await assert.rejects(c.exchange(code, header), oauthError('invalid_client', 401))
  }
  const authorization = basic(`${client.client_id}:${client.client_secret}`)
  const tokens = await c.exchange(code, authorization)
  const rotated = await refresh(c, client.client_id, tokens.refresh_token, authorization)
  // once the minute for retrying a lost answer is over, the replaced token is refused
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 61_000 })
  await assert.rejects(refresh(c, client.client_id, tokens.refresh_token, authorization), oauthError('invalid_grant'))
  assert.ok((await refresh(c, client.client_id, rotated.refresh_token, authorization)).access_token)
})

test('connector HTTP token handler sends OAuth client and request validation errors', async (t) => {
  const { c } = await fixture(t)
  const client = await register(c, 'client_secret_basic')
  const fields = pending(c, client.client_id).approve()
  async function tokenResponse(body: string, headers: IncomingMessage['headers']) {
    const req = Object.assign(Readable.from([Buffer.from(body)]), { method: 'POST', headers })
    let status = 0
    let output: unknown
    let responseHeaders: Record<string, string> = {}
    const res = {
      writeHead(code: number, sent: Record<string, string>) { status = code; responseHeaders = sent },
      end(data: string) { output = JSON.parse(data) },
    }
    await serveConnector(req as IncomingMessage, res as unknown as ServerResponse, c, '/oauth/token', async () => assert.fail('a token request must not dispatch MCP'))
    return { status, headers: responseHeaders, output }
  }
  const badCredentials = await tokenResponse(fields.toString(), { authorization: basic(`${client.client_id}:%`) })
  assert.equal(badCredentials.status, 401)
  assert.match(badCredentials.headers['WWW-Authenticate'], /^Basic /)
  assert.deepEqual(badCredentials.output, { error: 'invalid_client', error_description: 'malformed Basic credentials' })
  const badBody = await tokenResponse(JSON.stringify({ client_id: [] }), { 'content-type': 'application/json' })
  assert.equal(badBody.status, 400)
  assert.deepEqual(badBody.output, { error: 'invalid_request', error_description: 'expected scalar OAuth parameters' })
})

test('waiting for writes covers the last-used write a door check queues', async (t) => {
  const { c, path } = await fixture(t)
  const client = await register(c)
  const tokens = await c.exchange(pending(c, client.client_id).approve())
  // the next save of the file waits until the test lets it go
  let release = () => {}
  const held = new Promise<void>((resolve) => (release = resolve))
  const write = fs.writeFile
  const holding = t.mock.method(fs, 'writeFile', async (...args: Parameters<typeof fs.writeFile>) => {
    await held
    return write(...args)
  })
  syncBuiltinESMExports()
  try {
    assert.ok('viewer' in c.check(bearer(tokens.access_token), 'read'))
    let waited = false
    const waiting = c.waitForWrites().then(() => (waited = true))
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(waited, false, 'the last-used write is still under way')
    release()
    await waiting
  } finally {
    release()
    holding.mock.restore()
    syncBuiltinESMExports()
  }
  const saved = JSON.parse(await readFile(path, 'utf8')) as { grants: { lastUsedAt?: string }[] }
  assert.ok(saved.grants[0].lastUsedAt)
})

// A registration as it reaches the connector hostname: relayed by Cloudflare, which names the caller's address, or
// straight to the port, where the connection's own address is all there is.
async function registerFrom(c: Connector, headers: IncomingMessage['headers'], remoteAddress = '127.0.0.1') {
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify({ redirect_uris: [callback] }))]), { method: 'POST', headers, socket: { remoteAddress } })
  let status = 0
  let output: { client_id?: string; error?: string } = {}
  const res = {
    writeHead(code: number) { status = code },
    end(data: string) { output = JSON.parse(data) },
  }
  await serveConnector(req as unknown as IncomingMessage, res as unknown as ServerResponse, c, '/oauth/register', async () => assert.fail('a registration must not dispatch MCP'))
  return { status, output }
}
const tunnel = (ip: string) => ({ 'cf-ray': 'fixture', 'cf-connecting-ip': ip })

// an assistant registered, approved and connected
async function connected(c: Connector, caller: string) {
  const client = await c.register({ redirect_uris: [callback] }, caller)
  return { client, tokens: await c.exchange(pending(c, client.client_id).approve()) }
}

test('one address can’t use up everyone’s registrations: each gets a few an hour', async (t) => {
  const { c } = await fixture(t)
  const perCaller = CONNECTOR_LIMITS.registrationsPerCaller
  const stranger: number[] = []
  for (let i = 0; i < 30; i++) stranger.push((await registerFrom(c, tunnel('203.0.113.9'))).status)
  assert.deepEqual(stranger, [...Array(perCaller).fill(201), ...Array(30 - perCaller).fill(429)])
  const refused = await registerFrom(c, tunnel('203.0.113.9'))
  assert.deepEqual([refused.status, refused.output.error], [429, 'temporarily_unavailable'])
  // another address, the owner's, still registers
  const owner = await registerFrom(c, tunnel('198.51.100.20'))
  assert.equal(owner.status, 201)
  assert.match(owner.output.client_id!, /^otr_c_/)
  // an IPv6 address counts by its /64, however it is written
  for (let i = 1; i <= perCaller; i++) assert.equal((await registerFrom(c, tunnel(`2001:db8:a:b::${i}`))).status, 201)
  assert.equal((await registerFrom(c, tunnel('2001:0DB8:000A:000B:ffff:1:2:3'))).status, 429)
  assert.equal((await registerFrom(c, tunnel('2001:db8:a:c::1'))).status, 201)
  // without Cloudflare's header, the connection's own address counts, an IPv4 one written as IPv6 included
  for (let i = 0; i < perCaller; i++) assert.equal((await registerFrom(c, {}, '192.0.2.7')).status, 201)
  assert.equal((await registerFrom(c, {}, '::ffff:192.0.2.7')).status, 429)
  assert.equal((await registerFrom(c, {}, '192.0.2.8')).status, 201)
})

test('every address together has a ceiling an hour, so stored state stays bounded', async (t) => {
  const now = Date.now()
  t.mock.timers.enable({ apis: ['Date'], now })
  const { c } = await fixture(t)
  for (let i = 0; i < CONNECTOR_LIMITS.registrationsPerHour; i++) await c.register({ redirect_uris: [callback] }, `198.18.0.${i}`)
  await assert.rejects(c.register({ redirect_uris: [callback] }, '198.18.1.1'), oauthError('temporarily_unavailable', 429))
  t.mock.timers.setTime(now + 60 * 60_000)
  assert.ok((await c.register({ redirect_uris: [callback] }, '198.18.1.1')).client_id)
})

test('a stranger filling the list can’t push out an assistant registered minutes ago, or a connected one', async (t) => {
  const now = Date.now()
  t.mock.timers.enable({ apis: ['Date'], now })
  const { c } = await fixture(t)
  const { clients, registrationsPerHour } = CONNECTOR_LIMITS
  let n = 0
  // a stranger with many addresses, one registration from each
  const stranger = () => c.register({ redirect_uris: ['http://127.0.0.1/cb'] }, `198.18.${n >> 8}.${n++ & 255}`)
  // enough connected assistants that the hour's ceiling of strangers would reach the newest one
  const older = clients - registrationsPerHour + 1
  for (let i = 0; i < older; i++) await connected(c, `192.0.2.${i}`)
  t.mock.timers.setTime(now + 61 * 60_000)
  const owners = await c.register({ redirect_uris: [callback] }, '198.51.100.20')
  t.mock.timers.setTime(now + 63 * 60_000)
  while (n < clients - older - 1) await stranger()
  // the list is full and every client nobody connected registered in the last hour: refused, not pushed out
  await assert.rejects(stranger(), oauthError('temporarily_unavailable', 429))
  const tokens = await c.exchange(pending(c, owners.client_id).approve())
  // hours later the stranger's registrations push out the stranger's older ones, then are refused: never a
  // connected assistant
  t.mock.timers.setTime(now + 3 * 60 * 60_000)
  for (let i = 0; i < clients - older - 1; i++) await stranger()
  await assert.rejects(stranger(), oauthError('temporarily_unavailable', 429))
  assert.ok((await refresh(c, owners.client_id, tokens.refresh_token)).access_token)
  assert.equal(c.list().length, older + 1)
})

test('a client nobody approved goes after a day; one that connected stays, even after its connection ended', async (t) => {
  const now = Date.now()
  t.mock.timers.enable({ apis: ['Date'], now })
  const { c, open } = await fixture(t)
  const unapproved = await c.register({ redirect_uris: [callback] }, '203.0.113.9')
  const live = await connected(c, '198.51.100.20')
  const ended = await connected(c, '198.51.100.21')
  await c.revokeToken(ended.tokens.refresh_token)
  assert.equal(c.list().length, 1)
  t.mock.timers.setTime(now + 24 * 60 * 60_000 + 60_000)
  // the next change drops it
  const renewed = await refresh(c, live.client.client_id, live.tokens.refresh_token)
  for (const current of [c, await open()]) {
    assert.throws(() => pending(current, unapproved.client_id), oauthError('invalid_client'))
    assert.ok(pending(current, live.client.client_id).id)
    assert.ok(pending(current, ended.client.client_id).id)
  }
  assert.ok('viewer' in c.check(bearer(renewed.access_token), 'read'))
})

test('a renewal keeps only the token it replaced, so renewing in a loop can’t pile up access tokens', async (t) => {
  const now = Date.now()
  t.mock.timers.enable({ apis: ['Date'], now })
  const { c, open, path } = await fixture(t)
  const client = await register(c)
  const issued = [await c.exchange(pending(c, client.client_id).approve())]
  for (let i = 0; i < 50; i++) issued.push(await refresh(c, client.client_id, issued.at(-1)!.refresh_token))
  const grant = c.list()[0].id
  const saved = async () => (JSON.parse(await readFile(path, 'utf8')) as { access: { grantId: string }[] }).access.filter((a) => a.grantId === grant).length
  assert.equal(await saved(), 2)
  const [replaced, latest] = issued.slice(-2)
  for (const current of [c, await open()]) {
    assert.ok('viewer' in current.check(bearer(latest.access_token), 'read'))
    assert.ok('viewer' in current.check(bearer(replaced.access_token), 'read'), 'the token the latest renewal replaced still works')
    for (const old of issued.slice(0, -2)) assert.deepEqual(current.check(bearer(old.access_token), 'read'), { status: 401, error: 'invalid_token' })
  }
  // the latest renewal's answer got lost: retried within the minute with the token it replaced, it renews again
  const retried = await refresh(c, client.client_id, replaced.refresh_token)
  assert.ok('viewer' in c.check(bearer(retried.access_token), 'read'))
  assert.equal(await saved(), 2)
})

test('two copies of a public client that renew together keep their connection', async (t) => {
  const now = Date.now()
  t.mock.timers.enable({ apis: ['Date'], now })
  const { c, open } = await fixture(t)
  const client = await register(c)
  const tokens = await c.exchange(pending(c, client.client_id).approve())
  // copy A renews; copy B, holding the same token, renews seconds later, inside the minute for a lost answer
  const a = await refresh(c, client.client_id, tokens.refresh_token)
  t.mock.timers.setTime(now + 5_000)
  const b = await refresh(c, client.client_id, tokens.refresh_token)
  // both copies' access tokens work until the next renewal
  for (const copy of [a, b]) assert.ok('viewer' in c.check(bearer(copy.access_token), 'read'))
  // an hour on, A renews with the token it was given: refused, and the connection is not ended
  t.mock.timers.setTime(now + 61 * 60_000)
  await assert.rejects(refresh(c, client.client_id, a.refresh_token), oauthError('invalid_grant'))
  assert.equal(c.list().length, 1)
  const later = await refresh(c, client.client_id, b.refresh_token)
  assert.ok('viewer' in c.check(bearer(later.access_token), 'read'))
  assert.equal(c.list().length, 1)
  assert.equal((await open()).list().length, 1)
  // the token both copies presented was spent, and still ends the connection when it shows up again
  await assert.rejects(refresh(c, client.client_id, tokens.refresh_token), oauthError('invalid_grant'))
  assert.equal(c.list().length, 0)
})

test('a save syncs the folder after the rename, and a folder that can’t be synced is only logged', async (t) => {
  const { c, open: reopen, path } = await fixture(t)
  const steps: string[] = []
  let failSync = false
  const rename = fs.rename
  const open = fs.open
  const renaming = t.mock.method(fs, 'rename', async (from: PathLike, to: PathLike) => {
    await rename(from, to)
    if (to === path) steps.push('rename')
  })
  const opening = t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args)
    if (args[0] === dirname(path)) {
      const sync = handle.sync.bind(handle)
      handle.sync = async () => {
        if (failSync) throw Object.assign(new Error('injected sync failure'), { code: 'EIO' })
        await sync()
        steps.push('sync folder')
      }
    }
    return handle
  })
  syncBuiltinESMExports()
  const warned = t.mock.method(console, 'warn', () => {})
  let kept: { client_id: string }
  try {
    await register(c)
    assert.deepEqual(steps, ['rename', 'sync folder'])
    failSync = true
    kept = await register(c)
  } finally {
    renaming.mock.restore()
    opening.mock.restore()
    syncBuiltinESMExports()
  }
  assert.match(String(warned.mock.calls.at(-1)?.arguments[0]), /couldn't sync .*injected sync failure/)
  // the save stands
  assert.ok(pending(await reopen(), kept.client_id).id)
})

test('a damaged connector file is set aside, and the connector starts with no connections and saves afresh', async (t) => {
  const errors = t.mock.method(console, 'error', () => {})
  type Snapshot = { grants: Record<string, unknown>[] }
  const damages: [string, (s: Snapshot) => string][] = [
    ['a write cut off', (s) => JSON.stringify(s).slice(0, 80)],
    ['a grant edited to speak for nobody', (s) => JSON.stringify({ ...s, grants: s.grants.map((g) => ({ ...g, identity: { kind: 'remote' } })) })],
    ['a grant edited with a spent token that is no hash', (s) => JSON.stringify({ ...s, grants: s.grants.map((g) => ({ ...g, usedRefreshHashes: ['not a hash'] })) })],
  ]
  for (const [label, damage] of damages) {
    const { c, open, path } = await fixture(t)
    const client = await register(c)
    const tokens = await c.exchange(pending(c, client.client_id).approve())
    const bytes = Buffer.from(damage(JSON.parse(await readFile(path, 'utf8')) as Snapshot))
    await writeFile(path, bytes)
    const restarted = await open()
    assert.deepEqual(restarted.list(), [], label)
    assert.deepEqual(restarted.check(bearer(tokens.access_token), 'read'), { status: 401, error: 'invalid_token' }, label)
    await assert.rejects(refresh(restarted, client.client_id, tokens.refresh_token), oauthError('invalid_client', 401), label)
    // the original bytes are kept aside, and the log says where
    const files = await readdir(dirname(path))
    const aside = files.filter((f) => f.startsWith('connector.json.corrupt-'))
    assert.deepEqual([aside.length, files.includes('connector.json')], [1, false], label)
    assert.deepEqual(await readFile(join(dirname(path), aside[0])), bytes, label)
    assert.match(String(errors.mock.calls.at(-1)?.arguments[0]), /^connector: .*preserved the original at .*connector\.json\.corrupt-/, label)
    // the next save writes a fresh, valid file, which loads as saved
    const fresh = await register(restarted)
    const saved = JSON.parse(await readFile(path, 'utf8')) as { clients: { id: string }[]; grants: unknown[] }
    assert.deepEqual([saved.clients.map((x) => x.id), saved.grants], [[fresh.client_id], []], label)
    assert.ok(pending(await open(), fresh.client_id).id, label)
    assert.equal((await readdir(dirname(path))).filter((f) => f.includes('.corrupt-')).length, 1, label)
  }
})

test('a connector file that can’t be read still stops startup, and nothing is set aside', async (t) => {
  const { open, path } = await fixture(t)
  await symlink(path, path)
  await assert.rejects(open(), /^Error: connector: can't read /)
  assert.deepEqual(await readdir(dirname(path)), ['connector.json'])
})
