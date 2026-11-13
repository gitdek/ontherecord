// Settings from the environment (.env in production, see .env.example).
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Agent, Scope } from './access.ts'
import type { ScreenConfig } from './screens.ts'

export type Config = {
  port: number
  host: string
  meetingsDir: string
  // MEETINGS_DIR may lead through a symlink only when the owner says so
  allowLinkedFolder: boolean
  dataDir: string
  webDir: string
  accessTeam: string
  // the Access application(s) whose tokens this server accepts (the site, and optionally a separate one for /mcp)
  accessAuds: string[]
  // email (lowercased) → display name; only these people get in
  users: Map<string, string>
  // Access service-token client id → agent ("Grace's Hermes") and whether it may change things (default: read)
  agents: Map<string, Agent>
  publicUrl: string
  // Host values that mean "this Mac" (loopback trust) and the browser origins allowed to send writes
  localHosts: string[]
  origins: string[]
  // other Origins the MCP endpoint alone answers (hosted assistants such as Claude's connector)
  mcpOrigins: string[]
  localUser: string
  // whether LOCAL_USER names someone: the pages then say whose Mac the archive is on
  localNamed: boolean
  crew: string[]
  // viewers who start in light mode until they pick for themselves
  lightByDefault: string[]
  // more folders that get a copy of the board, the notebook and the speaker names (data/backups/ always does)
  backupDirs: string[]
  // local embedding server (llama.cpp llama-server) for meaning-based search; empty url turns it off
  embed: { url: string; key: string; model: string }
  screens: ScreenConfig
  // optional local reranker (llama-server --reranking) that sharpens agents' context pulls
  rerank: { url: string; key: string }
  // optional local chat model (llama-server) that answers a question from the archive's passages; empty url turns it off
  ask: { url: string; key: string; model: string }
  // the second hostname, outside Access, where hosted assistants connect with this server's own OAuth
  // (connector.ts), and the redirect addresses those assistants may register; an empty url turns it off
  connector: { url: string; redirects: string[] }
  // telling speakers apart (scripts/diarize.py with sherpa-onnx) and reading their names off Meet tiles
  // (scripts/read-text.swift); an empty python turns it off
  diarize: { python: string; segmentation: string; embedding: string; script: string; readText: string }
}

// Screen search: SCREEN_SEARCH=1 (or gemini) sends picked frames and screen searches to Gemini Embedding 2 through
// OpenRouter; local keeps them on this Mac, with the picture model at SCREENS_URL, and never reads the OpenRouter
// key. Anything else is off.
function screenSettings(env: Record<string, string | undefined>): ScreenConfig {
  if (env.SCREEN_SEARCH === '1' || env.SCREEN_SEARCH === 'gemini') return { mode: 'gemini', key: (env.OPENROUTER_API_KEY ?? '').trim() }
  if (env.SCREEN_SEARCH !== 'local') return { mode: 'off' }
  return { mode: 'local', url: loopbackUrl(env.SCREENS_URL), key: (env.SCREENS_KEY ?? '').trim(), model: (env.SCREENS_MODEL ?? '').trim() }
}

// An address on this Mac (127.0.0.1, localhost or [::1]) without a trailing slash, or '' for anything else.
export function loopbackUrl(value = '') {
  try {
    const url = new URL(value.trim())
    if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return ''
    if (url.username || url.password || url.search || url.hash) return ''
    return `${url.origin}${url.pathname}`.replace(/\/+$/, '')
  } catch {
    return ''
  }
}

export function configFrom(env: Record<string, string | undefined>): Config {
  const users = new Map<string, string>()
  for (const entry of (env.ACCESS_USERS ?? '').split(',')) {
    const [email, name] = entry.split('=').map((s) => s.trim())
    if (email) users.set(email.toLowerCase(), name || email.split('@')[0])
  }
  // <client id>=<name>[:write], e.g. 3f9c….access=Grace's Hermes:write
  const agents = new Map<string, Agent>()
  for (const entry of (env.ACCESS_SERVICE_TOKENS ?? '').split(',')) {
    const [id, rest = ''] = entry.split(/=(.*)/s).map((s) => s.trim())
    const m = /^(.*?)(?::(read|write))?$/s.exec(rest)!
    if (id) agents.set(id, { name: m[1].trim() || 'agent', scope: (m[2] as Scope | undefined) ?? 'read' })
  }
  const root = join(import.meta.dirname, '..')
  const models = join(homedir(), 'models/diarization')
  const port = Number(env.PORT ?? 8797)
  const localHosts = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]
  const publicUrl = (env.PUBLIC_URL ?? `http://127.0.0.1:${port}`).replace(/\/+$/, '')
  return {
    port,
    host: env.HOST ?? '127.0.0.1',
    meetingsDir: resolve(env.MEETINGS_DIR ?? join(homedir(), 'Pictures/Screenshots/meetings')),
    allowLinkedFolder: env.MEETINGS_DIR_ALLOW_LINK === '1',
    dataDir: resolve(env.DATA_DIR ?? join(root, 'data')),
    webDir: join(root, 'web'),
    accessTeam: (env.ACCESS_TEAM ?? '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, ''),
    accessAuds: (env.ACCESS_AUD ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    users,
    agents,
    publicUrl,
    localHosts,
    origins: [...new Set([new URL(publicUrl).origin, ...localHosts.map((h) => `http://${h}`)])],
    // extra Origins the MCP endpoint (and only it) answers: the hosted assistants that connect to it
    mcpOrigins: (env.MCP_ORIGINS ?? 'https://claude.ai,https://claude.com').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean),
    localUser: env.LOCAL_USER?.trim() || 'Owner',
    localNamed: Boolean(env.LOCAL_USER?.trim()),
    crew: (env.CREW ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    lightByDefault: (env.LIGHT_MODE_USERS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    backupDirs: (env.BACKUP_DIR ?? '').split(',').map((s) => s.trim()).filter(Boolean).map((d) => resolve(d)),
    embed: { url: (env.EMBED_URL ?? '').trim().replace(/\/+$/, ''), key: (env.EMBED_KEY ?? '').trim(), model: (env.EMBED_MODEL ?? '').trim() },
    screens: screenSettings(env),
    rerank: { url: (env.RERANK_URL ?? '').trim().replace(/\/+$/, ''), key: (env.RERANK_KEY ?? '').trim() },
    ask: { url: (env.ASK_URL ?? '').trim().replace(/\/+$/, ''), key: (env.ASK_KEY ?? '').trim(), model: (env.ASK_MODEL ?? '').trim() },
    connector: {
      url: (env.CONNECTOR_URL ?? '').trim().replace(/\/+$/, ''),
      redirects: (env.CONNECTOR_REDIRECTS ?? 'https://claude.ai/api/mcp/auth_callback,https://claude.com/api/mcp/auth_callback').split(',').map((s) => s.trim()).filter(Boolean),
    },
    diarize: {
      python: (env.DIARIZE_PYTHON ?? join(models, 'venv/bin/python')).trim(),
      segmentation: resolve(env.DIARIZE_SEGMENTATION ?? join(models, 'segmentation/sherpa-onnx-pyannote-segmentation-3-0/model.onnx')),
      embedding: resolve(env.DIARIZE_EMBEDDING ?? join(models, 'embedding/nemo_en_titanet_large.onnx')),
      script: join(root, 'scripts/diarize.py'),
      readText: join(root, 'scripts/read-text.swift'),
    },
  }
}
