// The MCP doors for assistants that connect from their provider's servers. Claude's hosted connectors (claude.ai on
// the web, the phone and the desktop app) can't complete Cloudflare Access's own OAuth sign-in
// (anthropics/claude-ai-mcp#980), so the same two doors also stand on a second hostname (CONNECTOR_URL) that Access
// doesn't cover, guarded by this server's own OAuth 2.1:
//   1. the assistant registers itself (RFC 7591), with a redirect address on CONNECTOR_REDIRECTS or on loopback;
//   2. it sends the person to /connect/authorize on the site, which stays behind Access, and they approve it there;
//   3. it trades the code (PKCE S256 only) for a one-hour access token and a refresh token, both bound to that person
//      and to one door: write (/mcp) or read (/mcp/readonly).
// The assistant's changes show up as "Ada's agent", as on /mcp. Only hashes of the codes and tokens are kept: codes
// in memory, and clients, grants and access tokens in data/connector.json, owner-only. Access tokens outlive a
// restart because some clients (Codex) only refresh when their own clock says so, and would be signed out until then.
// Anyone on the board can see and end a connection on the Lab page.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, open, rename, rm, writeFile, type FileHandle } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isIPv6 } from 'node:net'
import { dirname } from 'node:path'
import { personIdentity, personName, samePerson, type PersonIdentity, type PersonPolicy, type Scope, type Viewer } from './access.ts'
import { PersistedJson } from './persistence.ts'

export type ConnectorConfig = { url: string; redirects: string[] }

type Client = { id: string; secretHash?: string; name: string; redirectUris: string[]; createdAt: string; lastUsedAt?: string }
// previousRefreshHash and rotatedAt: the token the last renewal replaced, and when, so a retry of it still works for a minute
type Grant = { id: string; clientId: string; person: string; email: string; identity: PersonIdentity; scope: Scope; refreshHash: string; refreshExpires: number; previousRefreshHash?: string; rotatedAt?: number; usedRefreshHashes?: string[]; createdAt: string; lastUsedAt?: string }
// waiting on the person at the authorize page
type Pending = { clientId: string; redirectUri: string; state?: string; challenge: string; scope: Scope; identity: PersonIdentity; expires: number }
type Code = Omit<Pending, 'state'>
type Access = { grantId: string; scope: Scope; person: string; email: string; expires: number }
// registered: the last hour's registrations and who made them (callerOf), kept in memory only
type State = { clients: Client[]; grants: Grant[]; access: Map<string, Access>; registered: { at: number; caller: string }[] }

// refreshHistory: how many spent refresh tokens of a public client are remembered, newest first kept.
// registrationsPerCaller: an hour's registrations from one address; registrationsPerHour: from every address
// together, fewer than `clients`, so a full list always holds some clients older than an hour.
export const CONNECTOR_LIMITS = { clients: 200, grants: 200, registrationsPerCaller: 6, registrationsPerHour: 120, name: 100, redirects: 5, redirect: 500, refreshHistory: 64 }
// refreshRetry: how long the token a renewal replaced still renews, for a client whose answer got lost.
// newClient: how long a registration can't be pushed out to make room (its person may be approving it);
// unapproved: how long a client that never connected is kept.
const TTL = { pending: 10 * 60_000, code: 5 * 60_000, access: 60 * 60_000, refresh: 60 * 24 * 60 * 60_000, refreshRetry: 60_000, newClient: 60 * 60_000, unapproved: 24 * 60 * 60_000 }
const isHash = (h: unknown) => typeof h === 'string' && /^[0-9a-f]{64}$/.test(h)

export class OAuthError extends Error {
  code: string
  status: number
  constructor(code: string, description: string, status = 400) {
    super(description)
    this.code = code
    this.status = status
  }
}

// An authorization request that can't go on. With somewhere to send it, the error goes back to the assistant
// (RFC 6749 4.1.2.1); without, the assistant or its address can't be trusted, so the page shows its own sentence
// for the code instead (web/js/views/connect.js).
export class AuthorizeError extends OAuthError {
  back?: { redirectUri: string; state?: string }
  constructor(code: string, description: string, back?: { redirectUri: string; state?: string }) {
    super(code, description)
    this.back = back
  }
}

const token = (kind: string) => `otr_${kind}_${randomBytes(32).toString('base64url')}`
const hash = (s: string) => createHash('sha256').update(s).digest('hex')
const sameHash = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))
const s256 = (verifier: string) => createHash('sha256').update(verifier).digest('base64url')

// A loopback redirect (a command-line assistant on someone's own machine, RFC 8252) may use any port.
const loopback = (u: URL) => u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)
function redirectMatches(registered: string, given: string) {
  try {
    const b = new URL(given)
    if (b.hash || b.username || b.password) return false
    if (registered === given) return true
    const a = new URL(registered)
    return loopback(a) && loopback(b) && a.hostname === b.hostname && a.pathname === b.pathname && a.search === b.search
  } catch {
    return false
  }
}

export class Connector {
  readonly url: string
  readonly host: string
  private redirects: string[]
  private site: string
  private path: string
  private file: PersistedJson
  private policy: PersonPolicy
  private state: State = { clients: [], grants: [], access: new Map(), registered: [] }
  private pending = new Map<string, Pending>()
  private codes = new Map<string, Code>()
  private touching = new Set<string>()
  // Keep denying an ended connection if disk is unavailable. Only a successful commit survives restart.
  private revoking = new Map<string, string | undefined>()
  private writing = Promise.resolve()

  // site: the site's own address (PUBLIC_URL), where the authorize page sits behind Access
  constructor(cfg: ConnectorConfig, site: string, path: string, policy: PersonPolicy) {
    this.url = cfg.url.replace(/\/+$/, '')
    this.host = this.url ? new URL(this.url).host.toLowerCase() : ''
    this.redirects = cfg.redirects
    this.site = site.replace(/\/+$/, '')
    this.path = path
    this.file = new PersistedJson(path, 'connector', undefined, 'aside')
    this.policy = policy
  }

  get enabled() {
    return Boolean(this.url)
  }

  // the two doors, and what each lets an assistant do
  door(path: string): Scope | undefined {
    return path === '/mcp' ? 'write' : path === '/mcp/readonly' ? 'read' : undefined
  }

  // A file that can't be read stops startup. Bytes that aren't JSON, or JSON in a shape decode() rejects, are set
  // aside the way damaged speaker names are, and the connector starts with no assistants and no connections: everyone
  // approves their agents again. Nothing is read back from the file set aside, so an ended connection stays ended.
  async load() {
    if (!this.enabled) return
    const now = Date.now()
    this.state = (await this.file.load((value) => this.decode(value, now))) ?? this.state
  }

  private decode(value: unknown, now: number): State {
    const saved = value as { clients?: Client[]; grants?: (Omit<Grant, 'identity'> & { identity?: PersonIdentity })[]; access?: (Access & { hash: string })[] }
    const grants = (saved.grants ?? []).flatMap<Grant>((g) => {
      if (!(g.refreshExpires > now)) return []
      const history = g.usedRefreshHashes
      if ((history !== undefined && (!Array.isArray(history) || !history.every(isHash))) ||
          (g.previousRefreshHash !== undefined && !isHash(g.previousRefreshHash)) || (g.rotatedAt !== undefined && !Number.isFinite(g.rotatedAt))) {
        throw new Error('invalid refresh history')
      }
      // a longer history from an earlier version keeps its newest entries
      if (history && history.length > CONNECTOR_LIMITS.refreshHistory) g = { ...g, usedRefreshHashes: history.slice(-CONNECTOR_LIMITS.refreshHistory) }
      // Legacy human grants had an email unless they came from the trusted local owner.
      const identity = g.identity === undefined && typeof g.email === 'string'
        ? personIdentity({ name: g.person, email: g.email, local: g.email === '' }) : g.identity
      if (identity?.kind === 'remote' && typeof identity.email === 'string' && identity.email) return [{ ...g, identity: { ...identity, email: identity.email.toLowerCase() } }]
      if (identity?.kind === 'local' && typeof identity.user === 'string' && identity.user) return [{ ...g, identity }]
      throw new Error('invalid grant identity')
    })
    const ids = new Set(grants.map((g) => g.id))
    return {
      clients: saved.clients ?? [], grants, registered: [],
      access: new Map((saved.access ?? []).filter((a) => a.expires > now && ids.has(a.grantId)).map(({ hash: h, ...a }) => [h, a])),
    }
  }

  // Only the queued writer can commit. Records shared with the published state must be replaced when edited.
  private mutate<T>(run: (next: State, now: number) => Promise<T>): Promise<T> {
    const result = this.writing.then(() => {
      const now = Date.now()
      const current = this.state
      const grants = current.grants.filter((g) => g.refreshExpires > now)
      return run({
        // a client that registered and never connected goes after a day
        clients: current.clients.filter((c) => c.lastUsedAt || now - Date.parse(c.createdAt) < TTL.unapproved || grants.some((g) => g.clientId === c.id)),
        grants,
        access: new Map(current.access),
        registered: current.registered.filter((r) => now - r.at < 3_600_000),
      }, now)
    })
    this.writing = result.then(() => {}, () => {})
    return result
  }

  // Resolves once every change queued so far is saved or has failed, the last-used write a door check queues
  // included, so whoever stops the server (or a test removing its folder) doesn't race a save still under way.
  waitForWrites() {
    return this.writing
  }

  private async commit(next: State, now: number) {
    next.grants = next.grants.filter((g) => !this.revoking.has(g.id))
    const ids = new Set(next.grants.map((g) => g.id))
    for (const [key, a] of next.access) if (a.expires <= now || !ids.has(a.grantId)) next.access.delete(key)
    const access = [...next.access].map(([h, a]) => ({ hash: h, ...a }))
    const snapshot = JSON.stringify({ clients: next.clients, grants: next.grants, access }, null, 1)
    const tmp = `${this.path}.${randomBytes(8).toString('hex')}.tmp`
    try {
      await mkdir(dirname(this.path), { recursive: true })
      await writeFile(tmp, snapshot, { flag: 'wx', mode: 0o600, flush: true })
      await rename(tmp, this.path)
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {})
      console.error(`connector: couldn't save (${(err as Error).message})`)
      throw new OAuthError('temporarily_unavailable', 'could not save connector changes; try again', 503)
    }
    // Until the folder is synced, a power cut can undo the rename, and with it a change already reported as saved
    // (a connection someone ended could come back). Best effort: the change is in place either way.
    let folder: FileHandle | undefined
    try {
      folder = await open(dirname(this.path), 'r')
      await folder.sync()
    } catch (err) {
      console.warn(`connector: couldn't sync ${dirname(this.path)} (${(err as Error).message})`)
    } finally {
      await folder?.close().catch(() => {})
    }
    this.state = next
    for (const id of this.revoking.keys()) if (!ids.has(id)) this.revoking.delete(id)
  }

  // ---------- discovery (RFC 9728, RFC 8414) ----------

  resourceMetadata(scope: Scope) {
    return {
      resource: `${this.url}${scope === 'write' ? '/mcp' : '/mcp/readonly'}`,
      authorization_servers: [this.url],
      scopes_supported: [scope],
      bearer_methods_supported: ['header'],
      resource_name: 'On the Record',
    }
  }

  serverMetadata() {
    return {
      issuer: this.url,
      authorization_endpoint: `${this.site}/connect/authorize`,
      token_endpoint: `${this.url}/oauth/token`,
      registration_endpoint: `${this.url}/oauth/register`,
      revocation_endpoint: `${this.url}/oauth/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
      scopes_supported: ['read', 'write'],
      // the approval page is on the site's hostname, not the issuer's, so every answer it sends back names the issuer
      // (RFC 9207). Codex refuses a sign-in page on another hostname unless this says so.
      authorization_response_iss_parameter_supported: true,
    }
  }

  // What a 401 or 403 on a door says, so a client knows where to sign in and for what.
  challenge(scope: Scope, error?: 'invalid_token' | 'insufficient_scope') {
    const meta = `${this.url}/.well-known/oauth-protected-resource${scope === 'write' ? '/mcp' : '/mcp/readonly'}`
    return `Bearer resource_metadata="${meta}", scope="${scope}"${error ? `, error="${error}"` : ''}`
  }

  // ---------- registration (RFC 7591) ----------

  // caller: who is asking (callerOf), so that one address can't use up everyone's registrations
  async register(input: Record<string, unknown>, caller = '') {
    const uris = input.redirect_uris
    if (!Array.isArray(uris) || !uris.length || uris.length > CONNECTOR_LIMITS.redirects || uris.some((u) => typeof u !== 'string' || u.length > CONNECTOR_LIMITS.redirect))
      throw new OAuthError('invalid_redirect_uri', `redirect_uris must list 1 to ${CONNECTOR_LIMITS.redirects} addresses`)
    for (const u of uris as string[]) {
      let parsed: URL
      try {
        parsed = new URL(u)
      } catch {
        throw new OAuthError('invalid_redirect_uri', `not an address: ${u.slice(0, 80)}`)
      }
      if (parsed.hash || parsed.username || parsed.password || (!this.redirects.includes(u) && !loopback(parsed))) throw new OAuthError('invalid_redirect_uri', `${u.slice(0, 120)} isn't an assistant this archive accepts`)
    }
    const method = input.token_endpoint_auth_method ?? 'none'
    if (method !== 'none' && method !== 'client_secret_post' && method !== 'client_secret_basic') throw new OAuthError('invalid_client_metadata', 'token_endpoint_auth_method must be none, client_secret_post or client_secret_basic')
    const grants = (input.grant_types as unknown[] | undefined) ?? ['authorization_code', 'refresh_token']
    if (!Array.isArray(grants) || grants.some((g) => g !== 'authorization_code' && g !== 'refresh_token')) throw new OAuthError('invalid_client_metadata', 'grant_types may hold authorization_code and refresh_token')
    const responses = (input.response_types as unknown[] | undefined) ?? ['code']
    if (!Array.isArray(responses) || responses.some((r) => r !== 'code')) throw new OAuthError('invalid_client_metadata', 'response_types may hold code')
    const name = typeof input.client_name === 'string' ? input.client_name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, CONNECTOR_LIMITS.name) : ''
    const redirectUris = (uris as string[]).slice()
    return this.mutate(async (next, now) => {
      if (next.registered.filter((r) => r.caller === caller).length >= CONNECTOR_LIMITS.registrationsPerCaller) throw new OAuthError('temporarily_unavailable', 'too many registrations from this address in the last hour; try again later', 429)
      if (next.registered.length >= CONNECTOR_LIMITS.registrationsPerHour) throw new OAuthError('temporarily_unavailable', 'too many registrations in the last hour; try again later', 429)
      const secret = method === 'none' ? undefined : token('cs')
      const client: Client = { id: `otr_c_${randomBytes(12).toString('base64url')}`, ...(secret ? { secretHash: hash(secret) } : {}), name: name || 'An assistant', redirectUris, createdAt: new Date(now).toISOString() }
      // full: the oldest client nobody approved makes room, unless it registered in the last hour and its person
      // may still be approving it
      if (next.clients.length >= CONNECTOR_LIMITS.clients) {
        const idle = next.clients.find((c) => !(now - Date.parse(c.createdAt) < TTL.newClient) && !next.grants.some((g) => g.clientId === c.id && !this.revoking.has(g.id)))
        if (!idle) throw new OAuthError('temporarily_unavailable', 'no room for another assistant; end one on the Lab page', 429)
        next.clients = next.clients.filter((c) => c !== idle)
      }
      next.clients.push(client)
      next.registered.push({ at: now, caller })
      await this.commit(next, now)
      return {
        client_id: client.id,
        client_id_issued_at: Math.floor(now / 1000),
        client_name: client.name,
        redirect_uris: redirectUris.slice(),
        grant_types: grants,
        response_types: ['code'],
        token_endpoint_auth_method: method,
        ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
      }
    })
  }

  // ---------- the authorize page (on the site, behind Access) ----------

  // Checks an authorization request and parks it for the person to approve (see AuthorizeError).
  authorize(q: URLSearchParams, viewer: Viewer): { id: string } {
    this.prune()
    const client = this.state.clients.find((c) => c.id === q.get('client_id'))
    const redirectUri = q.get('redirect_uri') ?? (client?.redirectUris.length === 1 ? client.redirectUris[0] : '')
    if (!client) throw new AuthorizeError('invalid_client', 'This assistant isn’t registered here. Start again from its Connect button.')
    if (!client.redirectUris.some((r) => redirectMatches(r, redirectUri))) throw new AuthorizeError('invalid_request', 'The assistant asked to send you somewhere it didn’t register.')
    const back = (code: string, description: string) => new AuthorizeError(code, description, { redirectUri, state: q.get('state') ?? undefined })
    const identity = personIdentity(viewer)
    if (!identity || !personName(identity, this.policy)) throw back('access_denied', 'only a person allowed into the archive can approve a connection')
    if (q.get('response_type') !== 'code') throw back('unsupported_response_type', 'response_type must be code')
    const challenge = q.get('code_challenge') ?? ''
    if (q.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) throw back('invalid_request', 'PKCE with S256 is required')
    // the door the token will open: named by the resource (RFC 8707), else by the scope asked for, else read only
    const resource = q.get('resource')
    let scope: Scope = /\bwrite\b/.test(q.get('scope') ?? '') ? 'write' : 'read'
    if (resource) {
      const path = resource.startsWith(this.url) ? resource.slice(this.url.length) : undefined
      const door = path !== undefined ? this.door(path) : undefined
      if (!door) throw back('invalid_target', `resource must be ${this.url}/mcp or ${this.url}/mcp/readonly`)
      scope = door
    }
    const id = randomBytes(16).toString('hex')
    this.pending.set(id, { clientId: client.id, redirectUri, state: q.get('state') ?? undefined, challenge, scope, identity, expires: Date.now() + TTL.pending })
    return { id }
  }

  // What the approval page shows. Only the person who started it sees it.
  request(id: string, viewer: Viewer) {
    const p = this.pending.get(id)
    if (!p || p.expires <= Date.now() || !samePerson(p.identity, personIdentity(viewer))) return undefined
    const person = personName(p.identity, this.policy)
    if (!person) return undefined
    const client = this.state.clients.find((c) => c.id === p.clientId)
    return { id, client: client?.name ?? 'An assistant', redirectHost: new URL(p.redirectUri).host, scope: p.scope, person, expires: new Date(p.expires).toISOString() }
  }

  // Approve or decline: where the browser goes next, with a code or with the refusal.
  decide(id: string, approve: boolean, viewer: Viewer): string {
    const p = this.pending.get(id)
    if (!p || p.expires <= Date.now() || !samePerson(p.identity, personIdentity(viewer)) || !personName(p.identity, this.policy)) throw new OAuthError('invalid_request', 'this request has expired; press Connect in the assistant again', 404)
    this.pending.delete(id)
    const to = new URL(p.redirectUri)
    if (p.state !== undefined) to.searchParams.set('state', p.state)
    // a refusal names its issuer too (RFC 9207)
    to.searchParams.set('iss', this.url)
    if (!approve) {
      to.searchParams.set('error', 'access_denied')
      return to.toString()
    }
    const code = token('code')
    this.codes.set(hash(code), { clientId: p.clientId, redirectUri: p.redirectUri, challenge: p.challenge, scope: p.scope, identity: p.identity, expires: Date.now() + TTL.code })
    to.searchParams.set('code', code)
    return to.toString()
  }

  // ---------- tokens ----------

  private clientFor(clients: Client[], params: URLSearchParams, authorization: string | undefined): Client {
    let id = params.get('client_id') ?? ''
    let secret = params.get('client_secret') ?? undefined
    if (authorization && /^Basic(?:\s|$)/i.test(authorization)) {
      try {
        const encoded = /^Basic[ \t]+([A-Za-z0-9+/]+={0,2})$/i.exec(authorization)?.[1]
        if (!encoded) throw new Error('missing credentials')
        const decoded = Buffer.from(encoded, 'base64')
        const canonical = decoded.toString('base64')
        if (encoded !== canonical && encoded !== canonical.replace(/=+$/, '')) throw new Error('invalid base64')
        const credentials = decoded.toString()
        const split = credentials.indexOf(':')
        if (split < 0) throw new Error('missing separator')
        id = decodeURIComponent(credentials.slice(0, split).replace(/\+/g, ' '))
        secret = decodeURIComponent(credentials.slice(split + 1).replace(/\+/g, ' '))
      } catch {
        throw new OAuthError('invalid_client', 'malformed Basic credentials', 401)
      }
    }
    const client = clients.find((c) => c.id === id)
    if (!client) throw new OAuthError('invalid_client', 'unknown client', 401)
    if (client.secretHash && !(secret && sameHash(hash(secret), client.secretHash))) throw new OAuthError('invalid_client', 'client authentication failed', 401)
    return client
  }

  private issue(next: State, grant: Grant, refresh: string, now: number) {
    const access = token('at')
    // The grant keeps one earlier token, the newest (the map keeps the order they were issued in), which another
    // process of the same client may still be using. Older ones stop working, so renewing in a loop can't pile them up.
    const earlier = [...next.access].filter(([, a]) => a.grantId === grant.id).map(([h]) => h)
    for (const h of earlier.slice(0, -1)) next.access.delete(h)
    next.access.set(hash(access), { grantId: grant.id, scope: grant.scope, person: grant.person, email: grant.email, expires: now + TTL.access })
    return { access_token: access, token_type: 'Bearer', expires_in: TTL.access / 1000, refresh_token: refresh, scope: grant.scope }
  }

  async exchange(params: URLSearchParams, authorization?: string) {
    this.prune()
    return this.mutate((next, now) => this.exchangeIn(next, now, params, authorization))
  }

  private async exchangeIn(next: State, now: number, params: URLSearchParams, authorization?: string) {
    const client = this.clientFor(next.clients, params, authorization)
    const grantType = params.get('grant_type')
    if (grantType === 'authorization_code') {
      const key = hash(params.get('code') ?? '')
      const code = this.codes.get(key)
      // An authenticated exchange spends the code even if validation or the durable grant creation fails.
      this.codes.delete(key)
      if (!code || code.expires <= now || code.clientId !== client.id) throw new OAuthError('invalid_grant', 'the code is unknown, used or expired')
      const person = personName(code.identity, this.policy)
      if (!person) throw new OAuthError('invalid_grant', 'the person who approved the connection is no longer allowed')
      if (params.has('redirect_uri') && params.get('redirect_uri') !== code.redirectUri) throw new OAuthError('invalid_grant', 'redirect_uri differs from the one the code was issued for')
      const verifier = params.get('code_verifier') ?? ''
      if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || s256(verifier) !== code.challenge) throw new OAuthError('invalid_grant', 'the code verifier does not match')
      this.checkResource(params, code.scope)
      const refresh = token('rt')
      const email = code.identity.kind === 'remote' ? code.identity.email : ''
      const grant: Grant = { id: randomBytes(9).toString('base64url'), clientId: client.id, person, email, identity: code.identity, scope: code.scope, refreshHash: hash(refresh), refreshExpires: now + TTL.refresh, createdAt: new Date(now).toISOString() }
      if (next.grants.length >= CONNECTOR_LIMITS.grants && !next.grants.some((g) => this.revoking.has(g.id))) {
        next.grants.sort((a, b) => (a.lastUsedAt ?? a.createdAt).localeCompare(b.lastUsedAt ?? b.createdAt)).shift()
      }
      next.grants.push(grant)
      next.clients[next.clients.indexOf(client)] = { ...client, lastUsedAt: grant.createdAt }
      const tokens = this.issue(next, grant, refresh, now)
      await this.commit(next, now)
      console.log(`connector: ${grant.person} connected ${client.name} (${grant.scope})`)
      return tokens
    }
    if (grantType === 'refresh_token') {
      const h = hash(params.get('refresh_token') ?? '')
      let grant = next.grants.find((g) => g.clientId === client.id && sameHash(g.refreshHash, h))
      const invalid = () => new OAuthError('invalid_grant', 'the refresh token is unknown, used or expired')
      // The answer to a renewal can get lost on the way back, and the client retries with the token it still holds.
      // For a minute after a renewal, the token it replaced renews again instead of counting as stolen.
      const retry = !grant && next.grants.find((g) => g.clientId === client.id && g.previousRefreshHash !== undefined &&
        sameHash(g.previousRefreshHash, h) && g.rotatedAt !== undefined && now - g.rotatedAt < TTL.refreshRetry)
      if (retry) grant = retry
      if (!grant) {
        const replay = !client.secretHash && next.grants.find((g) => g.clientId === client.id && g.usedRefreshHashes?.includes(h))
        if (replay) await this.revoke(next, replay.id, now)
        throw invalid()
      }
      const person = personName(grant.identity, this.policy)
      if (!person) throw invalid()
      if (this.revoking.has(grant.id)) {
        await this.revoke(next, grant.id, now)
        throw invalid()
      }
      this.checkResource(params, grant.scope)
      // A public client's spent tokens are remembered (the newest few), so presenting one later ends its connection:
      // only a copy can still hold it. A retry's window runs from the first renewal, not from the retry. A retry
      // leaves the list as it was: the token the first renewal handed out was never presented, and a second copy of
      // the client may hold it, so presenting it later is refused without ending the connection.
      const history = grant.usedRefreshHashes ?? []
      const refresh = token('rt')
      const updated: Grant = {
        ...grant, person, refreshHash: hash(refresh), refreshExpires: now + TTL.refresh, lastUsedAt: new Date(now).toISOString(),
        previousRefreshHash: h, rotatedAt: retry ? grant.rotatedAt : now,
        ...(!client.secretHash && !retry ? { usedRefreshHashes: [...history.filter((u) => u !== grant!.refreshHash), grant.refreshHash].slice(-CONNECTOR_LIMITS.refreshHistory) } : {}),
      }
      next.grants[next.grants.indexOf(grant)] = updated
      const tokens = this.issue(next, updated, refresh, now)
      await this.commit(next, now)
      return tokens
    }
    throw new OAuthError('unsupported_grant_type', 'grant_type must be authorization_code or refresh_token')
  }

  private checkResource(params: URLSearchParams, scope: Scope) {
    const resource = params.get('resource')
    if (resource && resource !== this.resourceMetadata(scope).resource) throw new OAuthError('invalid_target', 'the resource differs from the one approved')
  }

  // RFC 7009: ends the grant a refresh or access token belongs to. Unknown tokens are not an error.
  // If revocation can't be saved, deny its tokens and return 503 so the caller can retry the durable change.
  async revokeToken(value: string) {
    const h = hash(value)
    // Remember the family if a valid token was presented before a concurrent rotation commits.
    const known = this.grantForToken(this.state, h, Date.now())
    return this.mutate(async (next, now) => {
      const grantId = known ?? this.grantForToken(next, h, now)
      if (grantId) await this.revoke(next, grantId, now, h)
    })
  }

  private grantForToken(state: State, h: string, now: number) {
    const access = state.access.get(h)
    if (access && access.expires > now) return access.grantId
    const grant = state.grants.find((g) => g.refreshExpires > now && (sameHash(g.refreshHash, h) || g.previousRefreshHash === h || g.usedRefreshHashes?.includes(h)))
    if (grant) return grant.id
    for (const [id, proof] of this.revoking) if (proof === h) return id
  }

  // ---------- the doors ----------

  // Who a bearer token speaks for, or why it doesn't.
  check(authorization: string | undefined, scope: Scope): { viewer: Viewer } | { status: 401 | 403; error?: 'invalid_token' | 'insufficient_scope' } {
    const m = /^Bearer\s+(\S+)$/i.exec(authorization ?? '')
    if (!m) return { status: 401 }
    const now = Date.now()
    const a = this.state.access.get(hash(m[1]))
    const grant = a && this.state.grants.find((g) => g.id === a.grantId && g.refreshExpires > now)
    const person = grant && personName(grant.identity, this.policy)
    if (!a || a.expires <= now || !grant || this.revoking.has(grant.id) || !person) return { status: 401, error: 'invalid_token' }
    if (scope === 'write' && grant.scope !== 'write') return { status: 403, error: 'insufficient_scope' }
    const usedAt = new Date(now).toISOString()
    if (grant.lastUsedAt?.slice(0, 16) !== usedAt.slice(0, 16)) this.touch(grant.id, usedAt)
    const email = grant.identity.kind === 'remote' ? grant.identity.email : ''
    return { viewer: { name: `${person}'s agent`, email, local: false, agent: true, scope } }
  }

  private touch(grantId: string, usedAt: string) {
    if (this.touching.has(grantId)) return
    this.touching.add(grantId)
    void this.mutate(async (next, now) => {
      const index = next.grants.findIndex((g) => g.id === grantId)
      if (index < 0 || this.revoking.has(grantId)) return
      const grant = next.grants[index]
      if (grant.lastUsedAt && grant.lastUsedAt.slice(0, 16) >= usedAt.slice(0, 16)) return
      next.grants[index] = { ...grant, lastUsedAt: usedAt }
      await this.commit(next, now)
    }).catch(() => {}).finally(() => this.touching.delete(grantId))
  }

  // ---------- connections, for the Lab page ----------

  list() {
    return this.state.grants
      .map((g) => ({ id: g.id, assistant: this.state.clients.find((c) => c.id === g.clientId)?.name ?? 'An assistant', person: personName(g.identity, this.policy) ?? g.person, scope: g.scope, createdAt: g.createdAt, lastUsedAt: g.lastUsedAt ?? null }))
      .sort((a, b) => (b.lastUsedAt ?? b.createdAt).localeCompare(a.lastUsedAt ?? a.createdAt))
  }

  // Ends a connection: its refresh token and every access token it issued stop working at once.
  async end(grantId: string) {
    return this.mutate((next, now) => this.revoke(next, grantId, now))
  }

  private async revoke(next: State, grantId: string, now: number, proof?: string) {
    if (!next.grants.some((g) => g.id === grantId)) return false
    // The original revocation request can retry even if its token rotated or expired in the meantime.
    this.revoking.set(grantId, this.revoking.get(grantId) ?? proof)
    await this.commit(next, now)
    return true
  }

  private prune() {
    const now = Date.now()
    for (const [k, p] of this.pending) if (p.expires < now) this.pending.delete(k)
    for (const [k, c] of this.codes) if (c.expires < now) this.codes.delete(k)
  }
}

// ---------- the connector hostname ----------

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const data = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', Pragma: 'no-cache', 'Content-Length': String(Buffer.byteLength(data)), ...headers })
  res.end(data)
}

async function text(req: IncomingMessage) {
  let size = 0
  const chunks: Buffer[] = []
  for await (const c of req) {
    size += (c as Buffer).length
    if (size > 16_384) throw new OAuthError('invalid_request', 'the request is too large')
    chunks.push(c as Buffer)
  }
  return Buffer.concat(chunks).toString()
}

function object(raw: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw || '{}')
  } catch {
    throw new OAuthError('invalid_request', 'malformed JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new OAuthError('invalid_request', 'expected a JSON object')
  return parsed as Record<string, unknown>
}

// Who is registering, for one address's share: the address Cloudflare's edge saw (the tunnel itself connects from
// this Mac), or the connection's own when nothing relayed it. An IPv6 address counts by its /64, which one
// subscriber usually holds whole.
function callerOf(req: IncomingMessage) {
  const relayed = req.headers['cf-connecting-ip']
  let address = (typeof relayed === 'string' && relayed.trim()) || req.socket.remoteAddress || ''
  address = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1] ?? address
  if (!isIPv6(address)) return address.slice(0, 64)
  // expand the :: and keep the first four groups (an IPv4 tail is two groups, always past them)
  const [head, tail] = address.split('::').map((half) => (half ? half.split(':') : []).flatMap((g) => (g.includes('.') ? ['0', '0'] : [g])))
  const groups = tail ? [...head, ...Array<string>(8 - head.length - tail.length).fill('0'), ...tail] : head
  return `${groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(':')}::/64`
}

// A token or revocation request: form-encoded, as OAuth asks, or JSON from a lenient client.
async function form(req: IncomingMessage): Promise<URLSearchParams> {
  const raw = await text(req)
  if (/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
    const fields = Object.entries(object(raw))
    if (fields.some(([, v]) => v !== null && typeof v === 'object')) throw new OAuthError('invalid_request', 'expected scalar OAuth parameters')
    return new URLSearchParams(fields.map(([k, v]) => [k, String(v)]))
  }
  return new URLSearchParams(raw)
}

// Everything the connector hostname serves: discovery, registration, tokens, and the two doors. Nothing else is
// there; the site, its API and the media stay on the hostname Access guards.
export async function serveConnector(req: IncomingMessage, res: ServerResponse, c: Connector, p: string, mcp: (viewer: Viewer) => Promise<unknown>) {
  const method = req.method ?? 'GET'
  try {
    if (method === 'GET' && (p === '/.well-known/oauth-protected-resource/mcp' || p === '/.well-known/oauth-protected-resource')) return send(res, 200, c.resourceMetadata('write'))
    if (method === 'GET' && p === '/.well-known/oauth-protected-resource/mcp/readonly') return send(res, 200, c.resourceMetadata('read'))
    if (method === 'GET' && (p === '/.well-known/oauth-authorization-server' || p === '/.well-known/openid-configuration')) return send(res, 200, c.serverMetadata())
    if (p === '/oauth/register' && method === 'POST') return send(res, 201, await c.register(object(await text(req)), callerOf(req)))
    if (p === '/oauth/token' && method === 'POST') return send(res, 200, await c.exchange(await form(req), req.headers.authorization))
    if (p === '/oauth/revoke' && method === 'POST') {
      await c.revokeToken((await form(req)).get('token') ?? '')
      return send(res, 200, {})
    }
    const scope = c.door(p)
    if (scope) {
      const who = c.check(req.headers.authorization, scope)
      if ('status' in who) return send(res, who.status, { error: who.error ?? 'unauthorized', error_description: who.error === 'insufficient_scope' ? 'this connection may only read; connect the read-only door, or reconnect for write' : 'sign in through the assistant’s Connect button' }, { 'WWW-Authenticate': c.challenge(scope, who.error) })
      return mcp(who.viewer)
    }
    return send(res, 404, { error: 'not_found' })
  } catch (err) {
    if (err instanceof OAuthError) return send(res, err.status, { error: err.code, error_description: err.message }, err.status === 401 ? { 'WWW-Authenticate': 'Basic realm="On the Record"' } : {})
    throw err
  }
}
