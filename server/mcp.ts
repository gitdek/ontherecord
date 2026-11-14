// MCP endpoint (Streamable HTTP, JSON responses, stateless) so the owners' agents can search the
// meetings, read notes and transcripts, and work the action-item board. Same front door as the site:
// Cloudflare Access (a service token, or the person signing in for their agent) or a request made on this
// Mac. A connection with read scope (/mcp/readonly, or a service token not marked :write) sees only the
// read tools, so an agent that reads other people's words in a transcript can't be talked into changes.
// Both doors speak both eras of the protocol: 2026-07-28, where every request names its revision in
// params._meta and mirrors it in headers, and the older revisions, which open with initialize. This file is
// the transport; the tools are in mcp-tools.ts.
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Viewer } from './access.ts'
import { crewOf, instructions, listTools, RpcError, runTool, type Ctx } from './mcp-tools.ts'

// Newest first. 2026-07-28 is served to a request that names it in params._meta; the others are agreed in initialize.
const MODERN = ['2026-07-28']
const LEGACY = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']
const PROTOCOLS = [...MODERN, ...LEGACY]

// The _meta keys where a 2026-07-28 request names its revision and its client's capabilities, and a result its server
const VERSION = 'io.modelcontextprotocol/protocolVersion'
const CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities'
const SERVER_INFO = 'io.modelcontextprotocol/serverInfo'

// Who answers. description is a 2025-11-25 field, so only clients on that revision or later are sent it.
const serverInfo = (crew: string, version: string) => ({
  name: 'on-the-record',
  title: `On the Record: ${crew}'s meetings`,
  version: '0.3.0',
  ...(version >= '2025-11-25' ? { description: `A private archive of ${crew}'s recorded meetings: meeting notes, machine transcripts, a shared board of action items and a shared notebook.` } : {}),
})

// A 2026-07-28 result says it is complete (this server never comes back asking for more) and who sent it. The lists
// also say how long a client may keep them: they change with a deploy, or when the archive's people do. Each door,
// and each person's agent, gets its own tools and instructions, so only the connection that asked may reuse them.
const TTL_MS = 5 * 60_000
const CACHEABLE = ['server/discover', 'tools/list', 'resources/list', 'resources/templates/list', 'prompts/list']

type Message = { jsonrpc?: string; id?: string | number | null; method?: unknown; params?: unknown }

async function dispatch(method: string, params: Record<string, unknown>, viewer: Viewer, ctx: Ctx, modern: boolean) {
  // 2026-07-28 drops the handshake and ping, and brings server/discover: each era answers its own
  if (modern ? method === 'initialize' || method === 'ping' : method === 'server/discover') throw new RpcError(-32601, `method not found: ${method}`)
  switch (method) {
    case 'initialize': {
      const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : ''
      const crew = crewOf(ctx.lib())
      // a revision with no handshake (2026-07-28), or one this server doesn't know, is answered with the newest that has one
      const version = LEGACY.includes(asked) ? asked : LEGACY[0]
      return {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: serverInfo(crew, version),
        instructions: instructions(crew, viewer, ctx.screens?.enabled),
      }
    }
    case 'server/discover': {
      const crew = crewOf(ctx.lib())
      return { supportedVersions: PROTOCOLS, capabilities: { tools: { listChanged: false } }, instructions: instructions(crew, viewer, ctx.screens?.enabled) }
    }
    case 'ping':
      return {}
    case 'tools/list':
      return { tools: listTools(viewer, ctx) }
    case 'resources/list':
      return { resources: [] }
    case 'resources/templates/list':
      return { resourceTemplates: [] }
    case 'prompts/list':
      return { prompts: [] }
    case 'tools/call':
      return runTool(params, viewer, ctx)
  }
  throw new RpcError(-32601, `method not found: ${method}`)
}

// params._meta, where a 2026-07-28 request names its revision. Naming one there is what makes a request modern,
// whatever its headers say (and then they have to agree); a request that doesn't is an older client's.
function metaOf(msg: unknown) {
  const params = msg && typeof msg === 'object' ? (msg as Message).params : undefined
  const meta = params && typeof params === 'object' ? (params as { _meta?: unknown })._meta : undefined
  return meta && typeof meta === 'object' ? (meta as Record<string, unknown>) : undefined
}
const isModern = (msg: unknown) => metaOf(msg)?.[VERSION] !== undefined

// What a 2026-07-28 request mirrors in headers, so a proxy can route it without reading the body: the revision, the
// method, and the name of the one thing a call acts on (as =?base64?…?= when it isn't plain ASCII). Headers and body
// have to agree, or something along the way could act on a different request from the one that runs here.
const NAMED = new Map([['tools/call', 'name'], ['prompts/get', 'name'], ['resources/read', 'uri']])
function headerMismatch(req: IncomingMessage, method: string, params: Record<string, unknown>, version: string) {
  const mirrored: [string, unknown][] = [['MCP-Protocol-Version', version], ['Mcp-Method', method]]
  const named = NAMED.get(method)
  if (named) mirrored.push(['Mcp-Name', params[named]])
  for (const [header, body] of mirrored) {
    const raw = req.headers[header.toLowerCase()]
    const sent = Array.isArray(raw) ? raw.join(', ') : raw
    if (sent === undefined) return `the ${header} header is missing`
    if (!/^[\t\x20-\x7e]*$/.test(sent)) return `the ${header} header holds characters a header can't carry`
    const value = header === 'Mcp-Name' && /^=\?base64\?.*\?=$/.test(sent) ? Buffer.from(sent.slice(9, -2), 'base64').toString() : sent
    // Claude's connectors (the desktop app and the CLI) send the 2025-11-25 header with a 2026-07-28 body
    // (anthropics/claude-code#93290). The body names the revision, so an older one in the header is let through:
    // refusing it, as the specification asks, would refuse every call they make.
    if (header === 'MCP-Protocol-Version' && LEGACY.includes(value)) continue
    if (value !== body) return `the ${header} header says ${JSON.stringify(value).slice(0, 80)}, the body ${JSON.stringify(body ?? null).slice(0, 80)}`
  }
}

// A 2026-07-28 request, one per POST. One this server won't read (a revision it doesn't serve this way, headers that
// don't match the body, required _meta missing) gets 400, and a method it doesn't have 404, each with a JSON-RPC
// error: a client reads a 4xx without one as an older server, and falls back to initialize.
async function serveModern(req: IncomingMessage, msg: Message, viewer: Viewer, ctx: Ctx): Promise<[number, unknown?]> {
  const meta = metaOf(msg)!
  const fail = (status: number, code: number, message: string, data?: unknown): [number, unknown] => {
    if (status !== 200) console.log(`mcp: ${viewer.name}: ${status} ${message}`)
    const id = typeof msg.id === 'string' || typeof msg.id === 'number' ? { id: msg.id } : {}
    return [status, { jsonrpc: '2.0', ...id, error: { code, message, ...(data === undefined ? {} : { data }) } }]
  }
  if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return fail(400, -32600, 'invalid request')
  // a notification needs no answer, and this revision has none for a client to send over HTTP
  if (msg.id === undefined || msg.id === null) return [202]
  const asked = meta[VERSION]
  if (typeof asked !== 'string' || !MODERN.includes(asked)) {
    const why = LEGACY.includes(asked as string) ? `${asked} opens with initialize and carries no version in params._meta` : `this server does not speak ${String(asked)}`
    return fail(400, -32022, `Unsupported protocol version: ${why}`, { supported: PROTOCOLS, requested: String(asked) })
  }
  const params = msg.params as Record<string, unknown>
  const mismatch = headerMismatch(req, msg.method, params, asked)
  if (mismatch) return fail(400, -32020, `Header mismatch: ${mismatch}`)
  const caps = meta[CAPABILITIES]
  if (!caps || typeof caps !== 'object' || Array.isArray(caps)) return fail(400, -32602, `params._meta needs ${CAPABILITIES} ({} declares none)`)
  try {
    const result = await dispatch(msg.method, params, viewer, ctx, true)
    const cache = CACHEABLE.includes(msg.method) ? { ttlMs: TTL_MS, cacheScope: 'private' } : {}
    return [200, { jsonrpc: '2.0', id: msg.id, result: { resultType: 'complete', ...result, ...cache, _meta: { [SERVER_INFO]: serverInfo(crewOf(ctx.lib()), asked) } } }]
  } catch (err) {
    if (err instanceof RpcError) return fail(err.code === -32601 ? 404 : 200, err.code, err.message)
    console.error('mcp error:', err)
    return fail(200, -32603, 'internal error')
  }
}

export async function handleMcp(req: IncomingMessage, res: ServerResponse, viewer: Viewer, ctx: Ctx) {
  const reply = (status: number, body?: unknown, headers: Record<string, string> = {}) => {
    const data = body === undefined ? '' : JSON.stringify(body)
    res.writeHead(status, { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), 'Cache-Control': 'no-store', ...headers })
    res.end(data)
  }
  if (req.method === 'GET') return reply(405, { error: 'this server does not open a server-to-client stream' }, { Allow: 'POST' })
  // no session is ever handed out, in either era, so there is none to end
  if (req.method === 'DELETE') return reply(405, { error: 'there is no session to end: every request stands on its own' }, { Allow: 'POST' })
  if (req.method !== 'POST') return reply(405, { error: 'method not allowed' }, { Allow: 'POST' })
  // JSON only: a cross-site form or "simple" request can't produce it without a CORS preflight we never grant
  if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return reply(415, { error: 'send Content-Type: application/json' })
  if (!ctx.originOk(req.headers.origin)) return reply(403, { error: 'cross-origin request refused' })

  let body: unknown
  try {
    let size = 0
    const chunks: Buffer[] = []
    for await (const c of req) {
      size += (c as Buffer).length
      if (size > 1_000_000) return reply(413, { error: 'request too large' })
      chunks.push(c as Buffer)
    }
    body = JSON.parse(Buffer.concat(chunks).toString())
  } catch {
    return reply(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })
  }
  const batch = Array.isArray(body)
  const messages = (batch ? body : [body]) as Message[]
  // 2026-07-28 has no batches: a request that names that revision comes alone
  if (batch && messages.some(isModern)) return reply(400, { jsonrpc: '2.0', error: { code: -32600, message: 'one request per POST: 2026-07-28 has no batches' } })
  if (!batch && isModern(body)) {
    const [status, out] = await serveModern(req, body as Message, viewer, ctx)
    return reply(status, out)
  }
  // from here on, an older client's request (or batch, which 2025-03-26 allowed)
  if (batch && messages.length > 20) return reply(400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'batch too large' } })
  const out: unknown[] = []
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      // responses or junk from the client: nothing to answer
      if (msg && typeof msg === 'object' && 'id' in msg && !('result' in msg) && !('error' in msg)) out.push({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32600, message: 'invalid request' } })
      continue
    }
    if (msg.id === undefined || msg.id === null) continue // a notification
    try {
      const params = msg.params && typeof msg.params === 'object' ? (msg.params as Record<string, unknown>) : {}
      out.push({ jsonrpc: '2.0', id: msg.id, result: await dispatch(msg.method, params, viewer, ctx, false) })
    } catch (err) {
      const code = err instanceof RpcError ? err.code : -32603
      if (!(err instanceof RpcError)) console.error('mcp error:', err)
      out.push({ jsonrpc: '2.0', id: msg.id, error: { code, message: err instanceof RpcError ? err.message : 'internal error' } })
    }
  }
  if (!out.length) return reply(202)
  return reply(200, batch ? out : out[0])
}
