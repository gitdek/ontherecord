// Cloudflare Access check at the origin. Access already gates meetings.example.com at the edge; verifying
// its signed JWT here as well means a mis-set Access policy, or any other path to this port, still can't
// read the meetings. Without ACCESS_TEAM + ACCESS_AUD only requests made on this Mac get in, and only
// people and service tokens on our own lists get in at all.
import { createPublicKey, verify, type KeyObject } from 'node:crypto'
import type { IncomingMessage } from 'node:http'

// scope: what an agent may do over MCP ('read' sees the read tools only). exp: when the pass that let this
// viewer in runs out (seconds), so long-lived connections can end with it.
export type Scope = 'read' | 'write'
export type Viewer = { name: string; email: string; local: boolean; agent?: boolean; scope?: Scope; exp?: number }
export type Agent = { name: string; scope: Scope }
export type PersonIdentity = { kind: 'remote'; email: string } | { kind: 'local'; user: string }
export type PersonPolicy = { users: ReadonlyMap<string, string>; localUser: string; remoteEnabled: boolean }
type Jwk = { kid: string; kty: string; n: string; e: string }
type Fetch = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

export class AccessError extends Error {}

export function personIdentity(viewer: Viewer): PersonIdentity | undefined {
  if (viewer.agent) return undefined
  if (viewer.local) return { kind: 'local', user: viewer.name }
  if (viewer.email) return { kind: 'remote', email: viewer.email.toLowerCase() }
}

export function samePerson(a: PersonIdentity, b: PersonIdentity | undefined) {
  return a.kind === 'local' ? b?.kind === 'local' && a.user === b.user : b?.kind === 'remote' && a.email === b.email
}

export function personName(identity: PersonIdentity, policy: PersonPolicy) {
  if (identity.kind === 'local') return identity.user === policy.localUser ? policy.localUser : undefined
  return policy.remoteEnabled ? policy.users.get(identity.email) : undefined
}

export function createVerifier(team: string, auds: string[], users: Map<string, string>, agents: Map<string, Agent> = new Map(), fetchImpl: Fetch = fetch) {
  let keys = new Map<string, KeyObject>()
  let fetchedAt = 0
  let loadedAt = 0
  let inflight: Promise<void> | undefined

  async function refresh() {
    // at most every 30 s, so a flood of tokens with made-up key ids can't hammer Cloudflare
    if (Date.now() - fetchedAt < 30_000) return
    fetchedAt = Date.now()
    // every outside request that needs a key waits on this fetch, so a hanging endpoint gives up after 10 s and the
    // cached keys stand in (keyFor)
    const res = await fetchImpl(`https://${team}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) throw new AccessError(`certs fetch failed: ${res.status}`)
    const body = (await res.json()) as { keys?: Jwk[] }
    keys = new Map((body.keys ?? []).map((k) => [k.kid, createPublicKey({ key: k, format: 'jwk' })]))
    loadedAt = Date.now()
  }

  async function keyFor(kid: string) {
    if (!keys.has(kid) || Date.now() - fetchedAt > 3_600_000) {
      inflight ??= refresh().finally(() => (inflight = undefined))
      await inflight.catch((err) => console.warn('access:', (err as Error).message))
    }
    // keys Cloudflare may have rotated out aren't trusted forever just because the refresh keeps failing
    if (Date.now() - loadedAt > 86_400_000) return undefined
    return keys.get(kid)
  }

  return async function verifyToken(token: string): Promise<Viewer> {
    const parts = token.split('.')
    if (parts.length !== 3) throw new AccessError('malformed token')
    const [h, p, s] = parts
    let header: { alg?: string; kid?: string }
    let claims: { aud?: string | string[]; iss?: string; exp?: number; nbf?: number; email?: string; common_name?: string }
    try {
      header = JSON.parse(Buffer.from(h, 'base64url').toString())
      claims = JSON.parse(Buffer.from(p, 'base64url').toString())
    } catch {
      throw new AccessError('malformed token')
    }
    if (header.alg !== 'RS256' || !header.kid) throw new AccessError('unexpected algorithm')
    const key = await keyFor(header.kid)
    if (!key) throw new AccessError('unknown signing key')
    if (!verify('RSA-SHA256', Buffer.from(`${h}.${p}`), key, Buffer.from(s, 'base64url'))) throw new AccessError('bad signature')
    const now = Date.now() / 1000
    if (typeof claims.exp !== 'number' || claims.exp < now - 30) throw new AccessError('expired')
    if (typeof claims.nbf === 'number' && claims.nbf > now + 30) throw new AccessError('not yet valid')
    const tokenAuds = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
    if (!tokenAuds.some((a) => typeof a === 'string' && auds.includes(a))) throw new AccessError('wrong audience')
    if (claims.iss !== `https://${team}`) throw new AccessError('wrong issuer')
    const email = (claims.email ?? '').toLowerCase()
    if (email) {
      // the list is required: an empty or missing ACCESS_USERS lets nobody in, it doesn't let everybody in
      const name = users.get(email)
      if (!name) throw new AccessError(`${email} is not on the list`)
      return { name, email, local: false, exp: claims.exp }
    }
    // a service token (an agent) carries its client id instead of an email; only listed ones get in
    const client = claims.common_name ?? ''
    const agent = client ? agents.get(client) : undefined
    if (agent) return { name: agent.name, email: '', local: false, agent: true, scope: agent.scope, exp: claims.exp }
    throw new AccessError(client ? `service token ${client} is not on the list` : 'no identity in token')
  }
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

// Browsers label each request with where it came from. Another site (including other *.example.com apps)
// may link to a page of the app, but can't call the API, the MCP endpoint or the live stream, or load
// files, thumbnails or captions (whose timing or download behaviour would tell it what exists).
export function crossSite(req: IncomingMessage, path: string) {
  const site = req.headers['sec-fetch-site']
  if (!site || site === 'same-origin' || site === 'none') return false
  return !(req.method === 'GET' && req.headers['sec-fetch-mode'] === 'navigate' && !/^\/(api|mcp|media|thumbs|captions)\b/.test(path))
}

// Anything relayed by Cloudflare (the tunnel) carries these headers; a browser on this Mac doesn't.
export const viaCloudflare = (req: IncomingMessage) =>
  Boolean(req.headers['cf-ray'] || req.headers['cf-connecting-ip'] || req.headers['cf-access-jwt-assertion'] || req.headers['cf-visitor'])

// localHosts: the Host values a request on this Mac may use (127.0.0.1:PORT, localhost:PORT, [::1]:PORT).
// A web page elsewhere can point its own hostname at 127.0.0.1 (DNS rebinding); its requests then name that
// hostname, so they don't count as "on this Mac".
export function createGate(opts: { team: string; auds: string[]; users: Map<string, string>; agents?: Map<string, Agent>; localUser: string; localHosts: string[] }) {
  const verifyToken = opts.team && opts.auds.length ? createVerifier(opts.team, opts.auds, opts.users, opts.agents) : undefined
  return {
    configured: Boolean(verifyToken),
    async identify(req: IncomingMessage): Promise<Viewer | { error: string }> {
      if (LOOPBACK.has(req.socket.remoteAddress ?? '') && !viaCloudflare(req)) {
        if (!opts.localHosts.includes((req.headers.host ?? '').toLowerCase())) return { error: 'On this Mac, open the site as 127.0.0.1 or localhost.' }
        return { name: opts.localUser, email: '', local: true }
      }
      if (!verifyToken) return { error: 'Cloudflare Access is not configured on the server (ACCESS_TEAM / ACCESS_AUD), so only this Mac may connect.' }
      const token = req.headers['cf-access-jwt-assertion']
      if (typeof token !== 'string' || !token) return { error: 'Missing Cloudflare Access token.' }
      try {
        return await verifyToken(token)
      } catch (err) {
        return { error: err instanceof AccessError ? err.message : 'Access check failed' }
      }
    },
  }
}
