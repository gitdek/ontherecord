import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { test } from 'node:test'
import { createGate, createVerifier, crossSite } from './access.ts'

const TEAM = 'example.cloudflareaccess.com'
const AUD = 'aud-tag-123'
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const jwk = { ...(publicKey.export({ format: 'jwk' }) as object), kid: 'k1', alg: 'RS256', use: 'sig' }
const fetchCerts = async () => ({ ok: true, status: 200, json: async () => ({ keys: [jwk] }) })

function token(claims: Record<string, unknown>, opts: { kid?: string; key?: typeof privateKey; alg?: string } = {}) {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const head = b64({ alg: opts.alg ?? 'RS256', kid: opts.kid ?? 'k1', typ: 'JWT' })
  const now = Math.floor(Date.now() / 1000)
  const body = b64({ aud: [AUD], iss: `https://${TEAM}`, iat: now, exp: now + 600, ...claims })
  const sig = sign('RSA-SHA256', Buffer.from(`${head}.${body}`), opts.key ?? privateKey).toString('base64url')
  return `${head}.${body}.${sig}`
}

const users = new Map([
  ['ada@example.com', 'Ada'],
  ['grace@example.com', 'Grace'],
])
const agents = new Map([
  ['client-1.access', { name: "Grace's agent", scope: 'write' as const }],
  ['client-2.access', { name: "Ada's reader", scope: 'read' as const }],
])
const verify = createVerifier(TEAM, [AUD], users, agents, fetchCerts)

test('a listed person gets in under their name, with the pass expiry', async () => {
  const { exp, ...v } = await verify(token({ email: 'Grace@Example.com' }))
  assert.deepEqual(v, { name: 'Grace', email: 'grace@example.com', local: false })
  assert.ok(typeof exp === 'number' && exp > Date.now() / 1000)
})

test('a listed service token is an agent with its scope', async () => {
  const { exp: _, ...v } = await verify(token({ common_name: 'client-1.access', email: undefined }))
  assert.deepEqual(v, { name: "Grace's agent", email: '', local: false, agent: true, scope: 'write' })
  assert.equal((await verify(token({ common_name: 'client-2.access' }))).scope, 'read')
})

test('an empty allow-list lets nobody in (it does not mean "anyone Access admits")', async () => {
  const none = createVerifier(TEAM, [AUD], new Map(), new Map(), fetchCerts)
  await assert.rejects(none(token({ email: 'ada@example.com' })), /not on the list/)
})

test('a second Access application (say, one just for /mcp) can be accepted too', async () => {
  const both = createVerifier(TEAM, [AUD, 'mcp-aud'], users, agents, fetchCerts)
  assert.equal((await both(token({ email: 'ada@example.com', aud: ['mcp-aud'] }))).name, 'Ada')
  await assert.rejects(verify(token({ email: 'ada@example.com', aud: ['mcp-aud'] })), /wrong audience/)
})

test('everything else is refused', async () => {
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
  const now = Math.floor(Date.now() / 1000)
  const cases: [string, string][] = [
    ['not on the list', token({ email: 'eve@example.com' })],
    ['service token not on the list', token({ common_name: 'client-9.access' })],
    ['wrong audience', token({ email: 'ada@example.com', aud: ['someone-else'] })],
    ['wrong issuer', token({ email: 'ada@example.com', iss: 'https://evil.cloudflareaccess.com' })],
    ['expired', token({ email: 'ada@example.com', exp: now - 120 })],
    ['not yet valid', token({ email: 'ada@example.com', nbf: now + 600 })],
    ['bad signature', token({ email: 'ada@example.com' }, { key: other })],
    ['unknown signing key', token({ email: 'ada@example.com' }, { kid: 'k2' })],
    ['unexpected algorithm', token({ email: 'ada@example.com' }, { alg: 'none' })],
    ['malformed token', 'abc.def'],
    ['no identity', token({})],
  ]
  for (const [name, t] of cases) await assert.rejects(verify(t), Error, name)
})

const req = (remote: string, headers: Record<string, string> = {}, method = 'GET') => ({ socket: { remoteAddress: remote }, headers, method }) as unknown as IncomingMessage
const localHosts = ['127.0.0.1:8797', 'localhost:8797', '[::1]:8797']
const here = { host: '127.0.0.1:8797' }

test('the gate: this Mac is trusted, anything relayed or remote needs a valid Access token', async () => {
  const open = createGate({ team: '', auds: [], users, localUser: 'Ada', localHosts })
  assert.deepEqual(await open.identify(req('127.0.0.1', here)), { name: 'Ada', email: '', local: true })
  assert.deepEqual(await open.identify(req('::1', { host: 'localhost:8797' })), { name: 'Ada', email: '', local: true })
  assert.ok('error' in (await open.identify(req('127.0.0.1', { ...here, 'cf-ray': 'abc' }))), 'through the tunnel without Access configured: refused')
  assert.ok('error' in (await open.identify(req('192.168.1.20', here))), 'from the LAN: refused')

  const gate = createGate({ team: TEAM, auds: [AUD], users, localUser: 'Ada', localHosts })
  assert.ok('error' in (await gate.identify(req('127.0.0.1', { 'cf-ray': 'abc' }))), 'tunnel without a token: refused')
  assert.ok('error' in (await gate.identify(req('127.0.0.1', { 'cf-ray': 'abc', 'cf-access-jwt-assertion': 'nope' }))))
})

test('the gate: a page that rebinds its own hostname to 127.0.0.1 is not "this Mac"', async () => {
  const gate = createGate({ team: '', auds: [], users, localUser: 'Ada', localHosts })
  for (const host of ['rebind.attacker.test:8797', '127.0.0.1.nip.io:8797', '127.0.0.1:9999', ''])
    assert.ok('error' in (await gate.identify(req('127.0.0.1', host ? { host, origin: `http://${host}` } : {}))), host || 'no Host')
})

test('fetch metadata: other sites may link here but not call the API', () => {
  const r = (site: string, mode: string, method = 'GET') => req('127.0.0.1', { 'sec-fetch-site': site, 'sec-fetch-mode': mode }, method)
  assert.equal(crossSite(r('same-origin', 'cors', 'POST'), '/api/tasks'), false)
  assert.equal(crossSite(r('none', 'navigate'), '/m/abc'), false)
  assert.equal(crossSite(req('127.0.0.1', {}), '/api/library'), false, 'non-browser clients send no metadata')
  assert.equal(crossSite(r('cross-site', 'navigate'), '/m/abc'), false, 'a link from elsewhere still opens the page')
  assert.equal(crossSite(r('cross-site', 'no-cors'), '/api/events'), true)
  assert.equal(crossSite(r('cross-site', 'navigate'), '/api/search'), true)
  assert.equal(crossSite(r('same-site', 'cors', 'POST'), '/mcp'), true, 'other *.example.com apps are other sites')
  assert.equal(crossSite(r('cross-site', 'navigate', 'POST'), '/m/abc'), true)
  assert.equal(crossSite(r('cross-site', 'navigate'), '/media/abc'), true, 'a download link from elsewhere would reveal what exists')
  assert.equal(crossSite(r('cross-site', 'no-cors'), '/thumbs/abc/poster.jpg'), true)
})

test('a keys refresh that hangs gives up after 10 seconds, and the cached keys still let people in', async (t) => {
  const now = Date.now()
  t.mock.timers.enable({ apis: ['Date'], now })
  const warned = t.mock.method(console, 'warn', () => {})
  // the time limit asked for, with a short real one standing in for it
  const limits: number[] = []
  const timeout = AbortSignal.timeout
  t.mock.method(AbortSignal, 'timeout', (ms: number) => (limits.push(ms), timeout.call(AbortSignal, 5)))
  let hang = false
  // once hanging, a fetch that only settles when it is aborted
  const fetchImpl = async (_url: string, init?: { signal?: AbortSignal }) => {
    if (!hang) return fetchCerts()
    return new Promise<never>((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)))
  }
  const verify = createVerifier(TEAM, [AUD], users, agents, fetchImpl)
  assert.equal((await verify(token({ email: 'ada@example.com' }))).name, 'Ada')
  hang = true
  // the hourly refresh is due: both requests wait on it, then go ahead on the cached keys
  t.mock.timers.setTime(now + 3_600_001)
  let guard: ReturnType<typeof setTimeout> | undefined
  const gaveUp = new Promise<never>((_, reject) => (guard = setTimeout(() => reject(new Error('the refresh never gave up')), 2_000)))
  try {
    const people = await Promise.race([Promise.all([verify(token({ email: 'ada@example.com' })), verify(token({ email: 'grace@example.com' }))]), gaveUp])
    assert.deepEqual(people.map((p) => p.name), ['Ada', 'Grace'])
  } finally {
    clearTimeout(guard)
  }
  assert.ok(limits.length >= 1 && limits.every((ms) => ms === 10_000), String(limits))
  assert.match(String(warned.mock.calls.at(-1)?.arguments.join(' ')), /^access: /)
  // keys last fetched more than a day ago are no longer trusted
  t.mock.timers.setTime(now + 86_400_001)
  await assert.rejects(verify(token({ email: 'ada@example.com' })), /unknown signing key/)
})
