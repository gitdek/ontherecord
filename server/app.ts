// The app: the archive, the board, the notebook and search, and the routes that serve them, made from a
// Config and nothing else. index.ts runs one for real behind cloudflared; the route tests make one on temp
// folders and call its handler. Watches the folder, so new notes, transcripts and videos show up live.
import { randomBytes } from 'node:crypto'
import { watch, type FSWatcher } from 'node:fs'
import { copyFile, readdir, stat, truncate } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, join, resolve } from 'node:path'
import { createGate, crossSite, type Viewer } from './access.ts'
import { Asker, ASK_LIMITS, citationReport, type Source } from './ask.ts'
import { keepBackups } from './backup.ts'
import { AuthorizeError, Connector, OAuthError, serveConnector } from './connector.ts'
import type { Config } from './config.ts'
import { fuse, grouped, rerank, type Fused } from './fuse.ts'
import { buildLibrary, openScanned, pinFolder, readScanned, scanFiles, StaleFile, type FileEntry, type Library, type Meeting, type ParseCache, type PinnedFolder, type TranscriptSource } from './library.ts'
import { Media, mimeOf, sendFile, type Strip } from './media.ts'
import { Mirror } from './mirror.ts'
import { handleMcp } from './mcp.ts'
import { Notebook, NoteConflict, NoteError, versionOf, type Note } from './notebook.ts'
import { meaning } from './retrieval.ts'
import { SavedNotes } from './saved-notes.ts'
import { ScreenSearch } from './screens.ts'
import { SearchIndex } from './search.ts'
import { chunksOf, Reranker, Semantic } from './semantic.ts'
import { cleanName, SpeakerError, Speakers } from './speakers.ts'
import { LIMITS, Store } from './state.ts'
import { actionEvent, addAction, allActions, canonical, ConflictError, findAction, openOnUs, reconcile, removeAction, TaskError, updateAction, type ActionView, type BoardEvent } from './tasks.ts'
import { fmtTime, shortHash } from './text.ts'
import { Transcriber } from './transcriber.ts'

export type AppOptions = {
  // follow the meetings folder (fs.watch, and a poll every minute)
  watch?: boolean
  // keep copies of the board, the notebook and the speaker names (see backup.ts), and of the meetings folder in
  // each BACKUP_DIR folder (see mirror.ts)
  backups?: boolean
  // where the launchd services write their logs, the checkout's data/logs whatever DATA_DIR says: index.ts names it,
  // and start() rotates it with DATA_DIR/logs
  serviceLogs?: string
}

// ---------- http helpers ----------

const SECURITY: Record<string, string> = {
  'Strict-Transport-Security': 'max-age=31536000',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
}

const STATIC: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
}

// What a JSON body may weigh: most routes take a few fields, a notebook note can run to 60,000 characters.
export const BODY = { small: 16_384, note: 262_144 }

// A body larger than its route takes. Answered with 413 and the limit, never a bare 500.
export class TooLarge extends Error {
  constructor(limit: number) {
    super(`the request is larger than ${Math.round(limit / 1024)} KB, the most this takes`)
  }
}

// An address with a broken %-escape ("/%E0%A4%A"): nothing can be found under it.
class BadPath extends Error {}

function json(res: ServerResponse, status: number, body: unknown) {
  const data = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store', 'Content-Length': Buffer.byteLength(data) })
  res.end(data)
}

// A JSON object, or a 400: a list, a number or `null` is no more a request than malformed JSON is.
async function body(req: IncomingMessage, limit = BODY.small): Promise<Record<string, unknown>> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const c of req) {
    size += (c as Buffer).length
    if (size > limit) throw new TooLarge(limit)
    chunks.push(c as Buffer)
  }
  if (!chunks.length) return {}
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString())
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new SyntaxError('expected a JSON object')
  return parsed as Record<string, unknown>
}

const decode = (s: string) => {
  try {
    return decodeURIComponent(s)
  } catch {
    throw new BadPath()
  }
}

// Logs that grow past this are copied to <name>.1 and emptied at start (launchd appends, so writing goes on).
const LOG_MAX = 5_000_000
async function rotateLogs(dir: string) {
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (!name.endsWith('.log')) continue
    const path = join(dir, name)
    const s = await stat(path).catch(() => undefined)
    if (!s || s.size <= LOG_MAX) continue
    await copyFile(path, `${path}.1`)
    await truncate(path, 0)
    console.log(`logs: ${name} was ${Math.round(s.size / 1_000_000)} MB; the old part is in ${name}.1`)
  }
}

// ---------- the app ----------

export type App = Awaited<ReturnType<typeof createApp>>

export async function createApp(config: Config, opts: AppOptions = {}) {
  const gate = createGate({ team: config.accessTeam, auds: config.accessAuds, users: config.users, agents: config.agents, localUser: config.localUser, localHosts: config.localHosts })
  const store = new Store(join(config.dataDir, 'state.json'), () => boardChanged())
  const notebook = new Notebook(join(config.dataDir, 'notebook.json'))
  const semantic = new Semantic(config.dataDir, config.embed, () => broadcast('semantic', semantic.status()))
  const reranker = new Reranker(config.rerank)
  const asker = new Asker(config.ask)
  const connector = new Connector(config.connector, config.publicUrl, join(config.dataDir, 'connector.json'), {
    users: config.users,
    localUser: config.localUser,
    remoteEnabled: gate.configured,
  })
  const speakers = new Speakers(config.dataDir, config.diarize, (ids, relabel) => speakersChanged(ids, relabel), config.localUser)
  // A transcript started, stopped or failed: the pages showing those meetings hear of it. Once its files are in the
  // folder the folder is scanned again at once, without waiting for the watcher.
  const transcriber = new Transcriber(config.dataDir, config.transcribe, (ids, placed) => {
    broadcast('writing', { meetings: ids })
    if (placed) schedule('transcript written', 0)
  })
  // meetings' notes saved by agents through save_notes, and the versions they replaced
  const savedNotes = new SavedNotes(config.dataDir)
  const parseCache: ParseCache = new Map()
  const thumbs = new Map<string, { base: string; strip: Strip; poster: string; sprite: string }>()
  // what start() set going, so close() can stop it
  const stops: (() => void)[] = []

  let lib: Library
  const screens = new ScreenSearch(config.screens, config.dataDir, () => lib)
  let index: SearchIndex
  let searchRevision = 0
  let signatures = new Map<string, string>()
  const buildIndex = (l: Library, actions = allActions(l, store)) => {
    searchRevision++
    return new SearchIndex(l, notebook.list(), actions, (id) => canonical(store, id))
  }

  // ---------- live updates (server-sent events) ----------

  // until: when the stream must end (the Access pass that opened it runs out, or ten minutes at most); the
  // browser reconnects through Access, which checks the session again, so a revoked sign-in drops off soon.
  type Client = { res: ServerResponse; viewer: Viewer; id: string; page: string; until: number }
  const clients = new Map<string, Client>()
  const LIVE = { perViewer: 12, total: 64, maxAge: 600_000, backlog: 1_000_000 }

  // A viewer whose pass ran out, or who isn't reading what we send, is dropped instead of buffered for.
  function send(c: Client, msg: string) {
    if (Date.now() >= c.until || c.res.writableLength > LIVE.backlog) {
      c.res.destroy()
      return
    }
    c.res.write(msg)
  }
  function broadcast(event: string, data: unknown) {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    for (const c of clients.values()) send(c, msg)
  }
  const presence = () => [...clients.values()].map((c) => ({ id: c.id, name: c.viewer.name, page: c.page }))
  // where someone is in the app ("/m/<id>", "/actions"): a short app path, nothing else
  const pageOf = (v: unknown) => {
    const page = String(v ?? '').slice(0, 200)
    return /^\/[\w\-./%?=&]*$/.test(page) ? page : '/'
  }

  // ---------- indexing ----------

  const media = new Media(config.dataDir, (kind, file) => {
    if (kind === 'probe') schedule('probed', 400)
    else
      void loadThumbs(file).then(() => {
        const owners = lib.meetings.filter((m) => m.videos.some((v) => v.fileId === file.id)).map((m) => m.id)
        broadcast('thumbs', { fileId: file.id, meetings: owners })
      })
  })

  // a copy of the meetings folder in each BACKUP_DIR folder, kept in the background after each scan
  const mirror = new Mirror(opts.backups ?? true ? config.backupDirs : [], config.meetingsDir, (f) => media.facts(f))

  async function loadThumbs(f: FileEntry) {
    const t = await media.thumbs(f)
    if (t.strip && t.poster && t.sprite) thumbs.set(f.id, { base: media.thumbBase(f), strip: t.strip, poster: t.poster, sprite: t.sprite })
  }

  const posterAt = (m: Meeting) => {
    const d = m.videos.find((v) => v.isDefault)?.probe?.duration ?? 0
    const first = m.timeBase === 'offset' ? m.phases[0]?.start ?? m.topics[0]?.ranges[0]?.[0] : undefined
    return first !== undefined ? first + 45 : d * 0.15
  }

  let refreshing: Promise<void> | undefined
  let again = false
  let timer: NodeJS.Timeout | undefined
  function schedule(reason: string, ms = 1200) {
    clearTimeout(timer)
    timer = setTimeout(() => void refresh(reason).catch(failed), ms)
  }
  // a file the library can't make sense of shouldn't take the site down: keep serving the last good build
  const failed = (err: unknown) => console.error('library: rebuild failed; still serving the previous one:', err)

  let scanned = ''
  // pinned at startup (see pinFolder); a folder that doesn't exist yet is scanned by path until it does
  let folder: string | PinnedFolder = config.meetingsDir
  async function refresh(reason: string) {
    if (refreshing) {
      again = true
      return refreshing
    }
    refreshing = (async () => {
      do {
        again = false
        // a folder that doesn't exist yet is scanned by path (and found empty); one reached through a symlink is refused
        if (typeof folder === 'string')
          folder = await pinFolder(config.meetingsDir, config.allowLinkedFolder).catch((err) => {
            if (err instanceof StaleFile) throw err
            return config.meetingsDir
          })
        const files = await scanFiles(folder)
        // starts a pass in the background only if the files changed, or the last pass left some to do
        mirror.offer(files)
        // the minute-by-minute poll only rebuilds when something in the folder actually changed
        const sig = files.map((f) => `${f.rel}:${f.size}:${f.mtimeMs}:${f.ino}`).join('|')
        if (reason === 'poll' && sig === scanned && lib) continue
        const next = await buildLibrary(files, (f) => media.facts(f), config.crew, parseCache)
        await speakers.plan(next, syncOf(next))
        speakers.apply(next)
        transcriber.plan(next)
        scanned = sig
        for (const id of thumbs.keys()) if (!next.files.has(id)) thumbs.delete(id)
        for (const m of next.meetings) {
          const v = m.videos.find((x) => x.isDefault)
          const f = v && next.files.get(v.fileId)
          if (!f) continue
          // a replaced video keeps its id but not its frames
          if (thumbs.get(f.id)?.base !== media.thumbBase(f)) {
            thumbs.delete(f.id)
            await loadThumbs(f)
          }
          if (!thumbs.has(f.id)) media.ensureThumbs(f, posterAt(m))
        }
        const first = !lib
        lib = next
        // an action item reworded in the notes keeps the id the board knows it by; only then is the board read.
        // What that learned is in memory either way; if saving it fails, the next save of the board writes it.
        const relinked = await reconcile(next, store).catch((err) => {
          console.error(`board: couldn't save what the notes taught it (${(err as Error).message}); the next save will`)
          return 0
        })
        if (relinked) console.log(`board: ${relinked} reworded action item${relinked === 1 ? '' : 's'} kept ${relinked === 1 ? 'its' : 'their'} place`)
        const actions = allActions(next, store)
        const nextSigs = new Map(next.meetings.map((m) => [m.id, shortHash(JSON.stringify(summary(m, actions)))]))
        const added = [...nextSigs.keys()].filter((id) => !signatures.has(id))
        const removed = [...signatures.keys()].filter((id) => !nextSigs.has(id))
        const changed = [...nextSigs.entries()].filter(([id, s]) => signatures.has(id) && signatures.get(id) !== s).map(([id]) => id)
        index = buildIndex(next, actions)
        signatures = nextSigs
        syncMeaning()
        if (!first && (added.length || removed.length || changed.length)) {
          console.log(`library: ${reason} (+${added.length} ~${changed.length} -${removed.length})`)
          broadcast('library', { reason, added, changed, removed })
        }
        if (files.some((f) => (f.kind === 'video' || f.kind === 'audio') && Date.now() - f.mtimeMs < 20_000)) schedule('settled', 21_000)
      } while (again)
    })().finally(() => (refreshing = undefined))
    return refreshing
  }

  // The clock sync someone confirmed for a meeting whose transcript runs on a wall clock (Oct 7). It is kept
  // under the id the meeting had then: one renamed since finds it under an alias (the newest, if several).
  const syncFor = (m: Meeting) =>
    [m.id, ...m.aliases].flatMap((id) => (Object.hasOwn(store.state.sync, id) ? [store.state.sync[id]] : [])).sort((a, b) => b.at.localeCompare(a.at))[0]
  const syncOf = (l: Library) => (meetingId: string) => {
    const m = l.byId.get(meetingId)
    return m && syncFor(m)?.offset
  }

  // A confirmed or nudged sync moves which moments of the video show each caption speaker: read them again.
  async function replanSpeakers() {
    await speakers.plan(lib, syncOf(lib))
    speakersChanged(speakers.diarized(), true)
  }

  // Voices worked out or renamed: relabel the transcript lines, then keyword and meaning search catch up.
  // A status change alone (a job starting, say) just tells the pages showing those transcripts.
  function speakersChanged(ids: string[], relabel: boolean, change?: { by: string; name: string }) {
    if (!lib) return
    if (relabel) {
      speakers.apply(lib)
      index = buildIndex(lib)
      syncMeaning()
    }
    broadcast('speakers', { transcripts: ids, ...change })
  }

  // Names to offer for a voice: the meeting's participants, then everyone a voice has been named before.
  function voiceNames(src: TranscriptSource) {
    const ids = new Set(lib.meetings.filter((m) => m.transcripts.some((t) => t.id === src.id)).flatMap((m) => m.participants))
    const people = [...ids].flatMap((id) => lib.people.byId.get(id) ?? [])
    return [...new Set([...people.map((p) => p.short), ...speakers.known()])]
  }

  // The meaning index catches up with the meetings, the notebook and the board: only what is new or changed
  // goes to the model, in the background.
  const syncMeaning = () => void semantic.sync(chunksOf(lib, notebook.list(), config.embed.model, { board: allActions(lib, store) }))

  // ---------- shaping ----------

  const fileUrl = (id: string, download = false) => `/media/${id}${download ? '?download=1' : ''}`

  // `actions` is the whole board (allActions), read once by the caller however many meetings it shapes.
  function summary(m: Meeting, actions: ActionView[]) {
    const v = m.videos.find((x) => x.isDefault)
    const t = v ? thumbs.get(v.fileId) : undefined
    const mine = actions.filter((a) => a.meeting?.id === m.id)
    const us = mine.filter((a) => a.lane === 'us')
    return {
      id: m.id,
      title: m.title,
      kind: m.kind,
      date: m.date,
      time: m.time,
      duration: m.duration,
      blurb: m.blurb,
      hue: m.hue,
      participants: m.participants,
      has: { notes: Boolean(m.notes), transcript: m.transcripts.length > 0, video: m.videos.some((x) => x.playable), docs: m.docs.length },
      timeBase: m.timeBase,
      axis: m.axis,
      phases: m.phases,
      topics: m.topics.map(({ key, title, group, color, ranges, auto }) => ({ key, title, group, color, ranges, auto })),
      words: m.words,
      actions: { total: mine.length, us: us.length, open: openOnUs(mine) },
      poster: t && v ? `/thumbs/${v.fileId}/poster.jpg` : null,
      strip: t ? { interval: t.strip.interval, colors: t.strip.colors } : null,
      video: v ? { fileId: v.fileId, size: v.size, label: v.label, duration: v.probe?.duration } : null,
      processing: m.videos.some((x) => x.growing),
      pulse: m.pulse,
    }
  }

  function detail(m: Meeting) {
    const actions = allActions(lib, store)
    return {
      ...summary(m, actions),
      aliases: m.aliases,
      timing: m.timing,
      notes: m.notes ?? null,
      // each action line of the notes names its item by hash (line.action); this says which board id that is now,
      // so a reworded item's line still finds its checkbox
      lineActions: Object.fromEntries(m.actions.map((a) => [a.id, canonical(store, a.id)])),
      notesFile: m.notesFile ? { id: m.notesFile.id, name: m.notesFile.name, url: fileUrl(m.notesFile.id, true) } : null,
      // who saved the notes, when an agent did through save_notes and they are still that version
      notesSaved: savedNotes.saved(m) ?? null,
      topics: m.topics,
      actions: actions.filter((a) => a.meeting?.id === m.id),
      videos: m.videos.map((v) => {
        const t = thumbs.get(v.fileId)
        return {
          ...v,
          url: fileUrl(v.fileId),
          download: fileUrl(v.fileId, true),
          thumbs: t ? { poster: `/thumbs/${v.fileId}/poster.jpg`, sprite: `/thumbs/${v.fileId}/sprite.jpg`, ...t.strip } : null,
        }
      }),
      transcripts: m.transcripts.map((t) => {
        const src = lib.transcripts.get(t.id)!
        return {
          ...t,
          timeBase: src.parsed.timeBase,
          words: src.words,
          header: src.parsed.header,
          url: `/api/transcripts/${t.id}`,
          files: src.files.map((f) => ({ id: f.id, name: f.name, size: f.size, url: fileUrl(f.id, true) })),
        }
      }),
      primaryTranscript: m.primaryTranscript ?? null,
      // a transcript this Mac is writing for a meeting that has none: queued, running, or failed and why
      transcribing: transcriber.view(m.id) ?? null,
      docs: m.docs.map((f) => ({ id: f.id, name: f.name, url: `/api/docs/${f.id}`, download: fileUrl(f.id, true) })),
      files: m.files.map((f) => ({ id: f.id, name: f.name, kind: f.kind, size: f.size, mtimeMs: f.mtimeMs, url: fileUrl(f.id, true) })),
      sync: syncFor(m) ?? null,
      syncSuggestion: m.syncSuggestion ?? null,
    }
  }

  const safeName = (s: string) => s.replace(/[/\\:*?"<>|\u0000-\u001f]+/g, '-').replace(/\s+/g, ' ').trim()

  // "<date> <meeting title>.mp4" instead of "Screen Recording …"
  function downloadName(f: FileEntry) {
    const m = lib.meetings.find((x) => x.files.includes(f))
    if (!m) return f.name
    const ext = extname(f.name)
    const v = m.videos.find((x) => x.fileId === f.id)
    if (v) return safeName(`${m.date} ${m.title}${m.videos.length > 1 ? ` (${v.label})` : ''}`) + ext
    return f.name
  }

  function vtt(transcriptId: string, shift: number) {
    const src = lib.transcripts.get(transcriptId)
    if (!src) return
    const ts = (t: number) => {
      const ms = Math.max(0, Math.round(t * 1000))
      const h = Math.floor(ms / 3_600_000)
      const m = Math.floor(ms / 60_000) % 60
      const s = Math.floor(ms / 1000) % 60
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`
    }
    const cues = src.parsed.segments
      .filter((s) => !s.q && s.e - shift > 0)
      .map((s) => `${ts(s.s - shift)} --> ${ts(Math.max(s.e, s.s + 0.5) - shift)}\n${s.sp ? `<v ${s.sp.replace(/[<>]/g, '')}>` : ''}${s.t.replace(/-->/g, '→').replace(/</g, '‹')}`)
    return `WEBVTT\n\n${cues.join('\n\n')}\n`
  }

  const lookups = {
    meeting: (id: string) => lib.byId.get(id)?.id,
    task: (id: string) => findAction(lib, store, id)?.id,
  }

  function notebookChanged(kind: string, note: { id: string; title: string }, by: string) {
    // only the notebook's part of the keyword index is redone
    index.setNotes(notebook.list())
    searchRevision++
    syncMeaning()
    broadcast('notebook', { kind, id: note.id, title: note.title, by })
  }

  const noteView = (n: Note, full = true) => ({
    id: n.id,
    title: n.title,
    tags: n.tags,
    meetingIds: n.meetingIds,
    taskIds: n.taskIds,
    author: n.author,
    source: n.source ?? null,
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
    updatedBy: n.updatedBy,
    revisions: n.revisions.length,
    version: versionOf(n),
    ...(n.deleted ? { deleted: n.deleted } : {}),
    ...(n.restored ? { restored: n.restored } : {}),
    ...(full ? { body: n.body } : { excerpt: n.body.slice(0, 400), words: n.body.split(/\s+/).length }),
  })

  // A browser may only write from this app's own pages: the public site or this Mac's loopback address.
  const originOk = (origin: string | undefined) => !origin || config.origins.includes(origin)
  // The MCP endpoint also answers the hosted assistants named in MCP_ORIGINS, should their connector send
  // an Origin. Access still decides who gets in; no CORS header is ever sent, so their pages can't read replies.
  const mcpOriginOk = (origin: string | undefined) => originOk(origin) || config.mcpOrigins.includes(origin ?? '')

  // Titles of the notebook notes that items cite as a source, so the board can name what it links to.
  function citedNotes(actions: ActionView[]) {
    const titles: Record<string, string> = {}
    for (const a of actions) {
      for (const p of [a.done, a.canceled, a.checked, ...a.history]) {
        for (const s of p?.sources ?? []) if (s.note && !(s.note in titles)) titles[s.note] = notebook.get(s.note)?.title ?? ''
      }
    }
    return titles
  }

  // The board changed, from the web app or an agent: keyword search catches up and every open page hears of it.
  function boardChanged(e?: BoardEvent) {
    if (!index) return
    index.setBoard(allActions(lib, store))
    searchRevision++
    syncMeaning()
    broadcast('state', e ?? { kind: 'recovered' })
  }

  const mcpCtx = {
    lib: () => lib,
    index: () => index,
    store,
    publicUrl: config.publicUrl,
    originOk: mcpOriginOk,
    changed: boardChanged,
    notebook,
    semantic,
    screens,
    reranker,
    speakers,
    transcriber,
    savedNotes,
    // the folder read again at once after notes are saved, so the board has their action items when the tool answers,
    // or when get_meeting finds a notes file changed since the last scan
    notesChanged: (reason = 'notes saved') => refresh(reason),
    lookups,
    notebookChanged,
  }

  // Agents (Access service tokens) get the MCP endpoint and read-only API routes, exactly; the web app is for people.
  const AGENT_OK =
    /^\/(?:mcp(?:\/readonly)?|api\/(?:library|search|actions|lab|notebook)|api\/(?:meetings|transcripts|docs)\/[^/]+|api\/notebook\/n-[a-f0-9]{10}|media\/[^/]+|captions\/[^/]+\.vtt)$/

  // Whoever connects an agent, its changes show up as the agent's: "Grace's Hermes" for a service token,
  // "Ada's agent" for one signed in as Ada or running on this Mac. /mcp/readonly offers only the read tools.
  function mcpViewer(v: Viewer, readonly: boolean): Viewer {
    const agent: Viewer = v.agent ? v : { ...v, name: `${v.name}'s agent`, agent: true, scope: 'write' }
    return readonly ? { ...agent, scope: 'read' } : agent
  }

  // ---------- routes ----------

  type Call = { req: IncomingMessage; res: ServerResponse; url: URL; viewer: Viewer }
  type Route = { method: 'GET' | 'POST'; path: RegExp; run: (c: Call, ...params: string[]) => unknown }

  const library = ({ res, viewer }: Call) => {
    const actions = allActions(lib, store)
    const us = actions.filter((a) => a.lane === 'us')
    const theme = store.state.prefs[viewer.name]?.theme ?? (config.lightByDefault.includes(viewer.name.toLowerCase()) ? 'light' : 'dark')
    return json(res, 200, {
      me: { name: viewer.name, local: viewer.local, theme },
      access: gate.configured,
      // a local model can answer questions from the archive (see ask.ts)
      ask: asker.enabled,
      // whose Mac this is, for the pages that say where the work happens
      ...(config.localNamed ? { mac: config.localUser } : {}),
      ...(screens.enabled ? { screenSearch: true } : {}),
      folder: config.meetingsDir.split('/').slice(-2).join('/'),
      stats: {
        meetings: lib.meetings.length,
        seconds: lib.meetings.reduce((n, m) => n + (m.duration ?? 0), 0),
        words: lib.meetings.reduce((n, m) => n + m.words, 0),
        actions: us.length,
        open: openOnUs(actions),
        bytes: [...lib.files.values()].filter((f) => f.kind === 'video').reduce((n, f) => n + f.size, 0),
      },
      meetings: lib.meetings.map((m) => summary(m, actions)),
      people: lib.people.list(),
      crew: lib.people.crewNames(),
      threads: lib.threads,
      cautions: lib.cautions,
      presence: presence(),
    })
  }

  async function sync({ req, res, viewer }: Call, id: string) {
    const meeting = lib.byId.get(id)
    if (!meeting) return json(res, 404, { error: 'no such meeting' })
    const { offset } = await body(req)
    if (offset !== null && (typeof offset !== 'number' || !Number.isFinite(offset) || Math.abs(offset) > LIMITS.sync))
      return json(res, 400, { error: `offset must be a number of seconds, at most ${LIMITS.sync} either way, or null` })
    // a transcript timed from the start of its recording already lines up; only a wall-clock one needs a sync
    if (offset !== null && meeting.timeBase !== 'clock') return json(res, 400, { error: "this meeting's transcript is timed from the start of its recording, so it needs no sync" })
    // saved under the meeting's id now, so an older one under an alias stops counting
    await store.setSync(meeting.id, offset, viewer.name, meeting.aliases)
    broadcast('state', { kind: 'sync', meetingId: meeting.id, by: viewer.name })
    void replanSpeakers()
    return json(res, 200, { ok: true, sync: store.state.sync[meeting.id] ?? null })
  }

  async function renameSpeaker({ req, res, viewer }: Call, id: string) {
    const src = lib.transcripts.get(id)
    if (!src) return json(res, 404, { error: 'no such transcript' })
    const { speaker, name } = await body(req)
    if (name !== null && typeof name !== 'string') return json(res, 400, { error: 'name must be text, or null to go back to the automatic name' })
    if (await speakers.rename(src, String(speaker), name, viewer.name)) speakersChanged(speakers.diarized(), true, { by: viewer.name, name: cleanName(name) })
    return json(res, 200, { ok: true, speakers: speakers.view(src) })
  }

  function displayHit<T extends { evidence?: string }>(row: T) {
    const { evidence, ...display } = row
    return display
  }

  async function settledRows(q: string, { limit, k, rank, signal }: { limit: number; k: number; rank?: boolean; signal?: AbortSignal }) {
    const query = index.prepare(q)
    const current = () => index.prepare(query)
    const collect = async () => {
      const near = await meaning(semantic, query, { k, signal, current, screens })
      signal?.throwIfAborted()
      const results = index.search(current(), { limit, typing: false })
      return { results, rows: fuse(results, near, semantic.related, Infinity), revision: searchRevision }
    }
    let result = await collect()
    let reranked = false
    if (rank && query.embeddingText.length > 2) {
      reranked = await rerank(query.embeddingText, result.rows, reranker, signal)
      signal?.throwIfAborted()
      if (result.revision !== searchRevision) {
        // The model ranked an older candidate set. Re-collect once from the current archive.
        result = await collect()
        reranked = false
      }
    }
    return { results: result.results, rows: result.rows, reranked }
  }

  async function rowsWhileConnected(res: ServerResponse, q: string, opts: { limit: number; k: number; rank?: boolean }) {
    if (res.destroyed) return
    const stop = new AbortController()
    const cancel = () => stop.abort()
    res.once('close', cancel)
    try {
      return await settledRows(q, { ...opts, signal: stop.signal })
    } catch (err) {
      if (!stop.signal.aborted) throw err
    } finally {
      res.off('close', cancel)
    }
  }

  async function search({ res, url }: Call) {
    const q = (url.searchParams.get('q') ?? '').slice(0, 300)
    const limit = Math.max(1, Math.min(200, Math.floor(Number(url.searchParams.get('limit') ?? 60)) || 60))
    if (url.searchParams.get('typing') !== '0') return json(res, 200, { ...index.search(q, { limit, typing: true }), related: [] })
    const settled = await rowsWhileConnected(res, q, { limit: 200, k: 40, rank: url.searchParams.get('rerank') !== '0' })
    if (!settled) return
    const { results, rows, reranked } = settled
    if (results.badFilters.length || results.unknownPeople.length || results.ambiguousPeople?.length) return json(res, 200, { ...results, related: [] })
    const groups = grouped(results, rows, limit)
    const mixedModels = rows.some((row) => row.kind === 'screen')
    const related = rows
      .filter((row) => row.title !== undefined && row.similarity !== undefined)
      .sort((a, b) => mixedModels ? b.score - a.score : b.similarity! - a.similarity!)
      .slice(0, 10)
      .map((row) => ({
        kind: row.semanticKind,
        meetingId: row.meetingId || null,
        noteId: row.noteId ?? null,
        fileId: row.fileId ?? null,
        ...(row.videoId ? { videoId: row.videoId } : {}),
        title: row.title,
        section: row.section ?? null,
        text: row.text,
        t: row.t ?? null,
        score: Math.round(row.similarity! * 1000) / 1000,
        link: row.link,
      }))
    return json(res, 200, { ...groups, hits: groups.hits.map(displayHit), related, fused: rows.slice(0, limit).map(displayHit), reranked })
  }

  // One topic, person or decision followed across the meetings, oldest first: the moments each meeting gave it
  // (found by keyword or by meaning), the board items it touched with where they stand now, and the notebook
  // entries about it. The same filters as search work, so "person:ada pricing" follows one person on one thing.
  async function follow({ res, url }: Call) {
    const q = (url.searchParams.get('q') ?? '').slice(0, 300)
    if (!q.trim()) return json(res, 400, { error: 'q is required' })
    // Every keyword hit, grouped by meeting before any is left out: the best 200 across the archive can all come
    // from a few meetings that say the word often. The board items and notebook entries come from those 200.
    const settled = await rowsWhileConnected(res, q, { limit: Infinity, k: 60 })
    if (!settled) return
    const { results, rows: ranked } = settled
    const rows = ranked.slice(0, 200)
    const empty = { query: q, badFilters: results.badFilters, unknownPeople: results.unknownPeople, ambiguousPeople: results.ambiguousPeople ?? [], meetings: [], items: [], notebook: [] }
    if (results.badFilters.length || results.unknownPeople.length || results.ambiguousPeople?.length) return json(res, 200, empty)
    const moments = new Map<string, Fused[]>()
    for (const r of ranked)
      if (r.meetingId && !r.board && !r.noteId && lib.byId.has(r.meetingId)) {
        const rs = moments.get(r.meetingId)
        if (rs) rs.push(r)
        else moments.set(r.meetingId, [r])
      }
    const board = new Map(allActions(lib, store).map((a) => [a.id, a]))
    const touched = [...new Set(rows.flatMap((r) => (r.actionId && board.has(r.actionId) ? [r.actionId] : [])))].map((id) => board.get(id)!)
    const notes = [...new Set(rows.flatMap((r) => (r.noteId ? [r.noteId] : [])))].flatMap((id) => notebook.get(id) ?? [])
    return json(res, 200, {
      ...empty,
      meetings: [...moments.entries()]
        .map(([id, rs]) => {
          const m = lib.byId.get(id)!
          return { id, title: m.title, date: m.date, time: m.time ?? null, hue: m.hue, timeBase: m.timeBase, count: rs.length, moments: rs.slice(0, 5).map(displayHit) }
        })
        .sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? 0) - (b.time ?? 0)),
      items: touched.map((a) => ({ id: a.id, text: a.text, owner: a.owner, lane: a.lane, status: a.status, onHold: !!a.hold && !a.hold.ready, reason: a.canceled?.reason ?? null, meeting: a.meeting })),
      notebook: notes.map((n) => ({ id: n.id, title: n.title, updatedAt: n.updatedAt, updatedBy: n.updatedBy })),
    })
  }

  // A question's best passages, numbered for citing: the fused ranking the search page shows, each line of
  // transcript with the lines around it so it stands alone, and a link back to where it was said or written.
  async function sourcesFor(question: string, signal: AbortSignal): Promise<Source[]> {
    const { rows } = await settledRows(question, { limit: 40, k: 40, rank: true, signal })
    return rows.filter((r) => r.kind !== 'screen' || r.evidence).slice(0, ASK_LIMITS.sources).map((r, i) => {
      const m = r.meetingId ? lib.byId.get(r.meetingId) : undefined
      const note = r.noteId ? notebook.get(r.noteId) : undefined
      const when = m ? [m.date, r.t != null ? fmtTime(r.t, r.kind !== 'screen' && m.timeBase === 'clock') : ''].filter(Boolean).join(' ') : undefined
      return {
        n: i + 1,
        kind: r.kind,
        title: note?.title ?? r.title ?? m?.title ?? 'The board',
        ...(when ? { when } : {}),
        text: r.evidence.slice(0, 1200),
        link: r.link,
        ...(m ? { meetingId: m.id } : {}),
        ...(r.noteId ? { noteId: r.noteId } : {}),
        ...(r.actionId ? { actionId: r.actionId } : {}),
        ...(r.fileId ? { fileId: r.fileId } : {}),
        ...(r.videoId ? { videoId: r.videoId } : {}),
        ...(r.t != null ? { t: r.t } : {}),
      }
    })
  }

  // What Ask says when no passage came back. A filter that can't mean anything, a name nobody has or one that
  // several people share means nothing was searched at all, and the answer names it, as the search page does.
  function nothingFound(question: string) {
    const { q, unknownPeople, ambiguousPeople } = index.prepare(question)
    const who = (id: string) => `${lib.people.byId.get(id)?.name ?? id} (person:${id})`
    const why = [
      q.bad.length ? `${q.bad.map((f) => `"${f}"`).join(', ')} ${q.bad.length === 1 ? "isn't a filter" : "aren't filters"} this search can use` : '',
      unknownPeople.length ? `nobody called ${unknownPeople.join(' or ')} appears in the notes` : '',
      ...ambiguousPeople.map(({ name, ids }) => `more than one person is called ${name}: ${ids.map(who).join(' or ')}`),
    ].filter(Boolean)
    return why.length ? `Nothing was searched: ${why.join(', and ')}.` : 'Nothing in the archive matches that question.'
  }

  // Ask sends newline-separated JSON: sources, text deltas, then either done with citation status or error.
  // A disconnected client gets no terminal event. Grounding describes the citation IDs in the answer.
  const asking = new Map<string, AbortController>()
  async function ask({ req, res, viewer }: Call) {
    if (!asker.enabled) return json(res, 503, { error: 'no answering model is set up on this Mac (ops/install.sh ask MODEL.gguf)' })
    const { question } = await body(req)
    if (typeof question !== 'string' || !question.trim()) return json(res, 400, { error: 'a question is required' })
    if (question.length > ASK_LIMITS.question) return json(res, 400, { error: `a question is at most ${ASK_LIMITS.question} characters` })
    const person = viewer.local ? 'local' : viewer.email
    if (asking.has(person)) return json(res, 429, { error: 'one question at a time' })
    const stop = new AbortController()
    const release = () => {
      if (asking.get(person) === stop) asking.delete(person)
    }
    const cancel = () => {
      stop.abort()
      release()
    }
    asking.set(person, stop)
    res.once('close', cancel)
    try {
      const sources = await sourcesFor(question.trim(), stop.signal)
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'private, no-store', 'X-Accel-Buffering': 'no' })
      const line = (o: unknown) => res.write(`${JSON.stringify(o)}\n`)
      line({ sources })
      if (!sources.length) {
        line({ text: nothingFound(question.trim()) })
        line({ done: true, cited: [], grounding: 'no-sources' })
        return res.end()
      }
      let answer = ''
      try {
        for await (const piece of asker.answer(question.trim(), sources, stop.signal)) {
          answer += piece
          line({ text: piece })
        }
        const { cited, invalid } = citationReport(answer, sources)
        if (!stop.signal.aborted) line({ done: true, cited, grounding: invalid.length ? 'invalid' : cited.length ? 'cited' : 'uncited' })
      } catch (err) {
        if (!stop.signal.aborted) line({ error: err instanceof Error ? err.message : 'the answering model stopped' })
      }
      if (!stop.signal.aborted) res.end()
    } catch (err) {
      if (!stop.signal.aborted) throw err
    } finally {
      res.off('close', cancel)
      release()
    }
  }

  // The authorize step of the connector's OAuth (connector.ts), behind Access: the person is known, and approves on
  // /connect. A request that can go back to the assistant does; one that can't is shown there instead.
  function authorize({ res, url, viewer }: Call) {
    if (!connector.enabled) return json(res, 404, { error: 'not found' })
    const to = (location: string) => {
      res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' })
      res.end()
    }
    try {
      return to(`/connect?req=${connector.authorize(url.searchParams, viewer).id}`)
    } catch (err) {
      if (!(err instanceof AuthorizeError)) throw err
      // a code the page turns into its own sentence (web/js/views/connect.js), so a link can't put words there
      if (!err.back) return to(`/connect?error=${encodeURIComponent(err.code)}`)
      const back = new URL(err.back.redirectUri)
      back.searchParams.set('error', err.code)
      back.searchParams.set('error_description', err.message)
      if (err.back.state !== undefined) back.searchParams.set('state', err.back.state)
      back.searchParams.set('iss', connector.url)
      return to(back.toString())
    }
  }

  async function connectRequest({ req, res, viewer }: Call, id: string) {
    if (!connector.enabled || viewer.agent) return json(res, 404, { error: 'not found' })
    if (req.method !== 'POST') {
      const r = connector.request(id, viewer)
      return r ? json(res, 200, r) : json(res, 404, { error: 'this request has expired; press Connect in the assistant again' })
    }
    const { approve } = await body(req)
    try {
      const redirect = connector.decide(id, approve === true, viewer)
      console.log(`connector: ${viewer.name} ${approve === true ? 'approved' : 'declined'} a connection`)
      return json(res, 200, { redirect })
    } catch (err) {
      if (err instanceof OAuthError) return json(res, err.status, { error: err.message })
      throw err
    }
  }

  async function notebookNote({ req, res, viewer }: Call, id: string, action?: string) {
    if (req.method !== 'POST') {
      if (action) return json(res, 405, { error: 'method not allowed' })
      const n = notebook.get(id)
      return n ? json(res, 200, { note: noteView(n), revisions: n.revisions }) : json(res, 404, { error: 'no such note' })
    }
    let n: Note
    if (action === 'delete') n = await notebook.remove(id, viewer.name)
    else if (action === 'restore') n = await notebook.restore(id, viewer.name)
    else {
      // ifVersion: the version the editor opened; someone else's newer edit is never overwritten (409)
      const input = await body(req, BODY.note)
      n = await notebook.update(id, { ...input, ifVersion: input.ifVersion ?? input.if_version }, viewer.name, lookups)
    }
    notebookChanged(action === 'delete' ? 'deleted' : action === 'restore' ? 'restored' : 'updated', n, viewer.name)
    return json(res, 200, { ok: true, note: noteView(n) })
  }

  async function updateItem({ req, res, viewer }: Call, id: string) {
    const b = await body(req)
    // rev is the revision the page was showing: a change made on top of someone else's newer one is refused (409)
    const patch = { status: b.status, done: b.done, reason: b.reason, note: b.note, hold: b.hold, blockedBy: b.blockedBy, evidence: b.evidence, sources: b.sources, notFound: b.notFound, replacedBy: b.replacedBy, text: b.text, owner: b.owner, undo: b.undo, rev: b.rev }
    const { action: a, changed, did } = await updateAction(lib, store, id, patch, viewer.name, { noteOk: (note) => !!notebook.get(note) })
    if (changed) boardChanged(actionEvent(a, did, viewer.name))
    return json(res, 200, { ok: true, action: a, done: a.done, did })
  }

  function events({ req, res, url, viewer }: Call) {
    const open = [...clients.values()]
    if (open.length >= LIVE.total || open.filter((c) => c.viewer.name === viewer.name).length >= LIVE.perViewer) return json(res, 429, { error: 'too many live connections' })
    if (req.destroyed) return
    const id = randomBytes(8).toString('hex')
    const until = Math.min(viewer.exp ? viewer.exp * 1000 : Infinity, Date.now() + LIVE.maxAge)
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'private, no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
    res.write(`retry: 3000\nevent: hello\ndata: ${JSON.stringify({ id, me: viewer.name })}\n\n`)
    clients.set(id, { res, viewer, id, page: pageOf(url.searchParams.get('page')), until })
    const end = setTimeout(() => res.end(), Math.max(0, until - Date.now()))
    broadcast('presence', presence())
    // the tab went away, we ended the stream, or send() dropped it: whichever comes first
    res.on('close', () => {
      clearTimeout(end)
      if (clients.delete(id)) broadcast('presence', presence())
    })
  }

  async function thumb({ req, res }: Call, fileId: string, which: string) {
    const t = thumbs.get(fileId)
    if (!t) return json(res, 404, { error: 'not ready' })
    const path = which === 'poster' ? t.poster : t.sprite
    const st = await stat(path).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return undefined
      throw err
    })
    if (!st) {
      // the frames are gone from the cache (removed by hand, say): forget them and make them again
      thumbs.delete(fileId)
      const f = lib.files.get(fileId)
      const m = lib.meetings.find((x) => x.videos.some((v) => v.fileId === fileId && v.isDefault))
      if (f) {
        await media.forgetThumbs(f)
        if (m) media.ensureThumbs(f, posterAt(m))
      }
      return json(res, 404, { error: 'not ready' })
    }
    return sendFile(req, res, path, { size: st.size, mtimeMs: st.mtimeMs, type: 'image/jpeg', cache: 'private, max-age=3600' })
  }

  const routes: Route[] = [
    { method: 'GET', path: /^\/api\/library$/, run: library },
    { method: 'GET', path: /^\/api\/meetings\/([^/]+)$/, run: ({ res }, id) => (lib.byId.get(id) ? json(res, 200, detail(lib.byId.get(id)!)) : json(res, 404, { error: 'no such meeting' })) },
    { method: 'POST', path: /^\/api\/meetings\/([^/]+)\/sync$/, run: sync },
    {
      method: 'GET',
      path: /^\/api\/transcripts\/([^/]+)$/,
      run: ({ res }, id) => {
        const src = lib.transcripts.get(id)
        if (!src) return json(res, 404, { error: 'no such transcript' })
        return json(res, 200, { id: src.id, label: src.label, timeBase: src.parsed.timeBase, header: src.parsed.header, segments: src.parsed.segments, speakers: speakers.view(src), names: voiceNames(src) })
      },
    },
    { method: 'POST', path: /^\/api\/transcripts\/([^/]+)\/speakers$/, run: renameSpeaker },
    {
      method: 'GET',
      path: /^\/api\/docs\/([^/]+)$/,
      run: async ({ res }, id) => {
        const f = lib.files.get(id)
        if (!f || f.kind !== 'doc') return json(res, 404, { error: 'no such document' })
        return json(res, 200, { id: f.id, name: f.name, text: await readScanned(f, 5_000_000) })
      },
    },
    { method: 'GET', path: /^\/api\/search$/, run: search },
    { method: 'POST', path: /^\/api\/ask$/, run: ask },
    { method: 'GET', path: /^\/api\/follow$/, run: follow },
    { method: 'GET', path: /^\/connect\/authorize$/, run: authorize },
    { method: 'GET', path: /^\/api\/connector\/requests\/([a-f0-9]{32})$/, run: connectRequest },
    { method: 'POST', path: /^\/api\/connector\/requests\/([a-f0-9]{32})$/, run: connectRequest },
    {
      method: 'GET',
      path: /^\/api\/connector$/,
      run: ({ res, viewer }) => (viewer.agent ? json(res, 404, { error: 'not found' }) : json(res, 200, { enabled: connector.enabled, url: connector.url, connections: connector.list() })),
    },
    {
      method: 'POST',
      path: /^\/api\/connector\/connections\/([A-Za-z0-9_-]{8,40})\/end$/,
      run: async ({ res, viewer }, id) => {
        if (viewer.agent) return json(res, 404, { error: 'not found' })
        const ended = await connector.end(id)
        if (ended) console.log(`connector: ${viewer.name} ended a connection`)
        return ended ? json(res, 200, { ok: true }) : json(res, 404, { error: 'no such connection' })
      },
    },
    {
      method: 'GET',
      path: /^\/api\/notebook$/,
      run: ({ res, url }) => json(res, 200, { notes: notebook.list({ deleted: url.searchParams.get('deleted') === '1' }).map((n) => noteView(n, false)), semantic: semantic.status() }),
    },
    {
      method: 'POST',
      path: /^\/api\/notebook$/,
      run: async ({ req, res, viewer }) => {
        const n = await notebook.create(await body(req, BODY.note), viewer.name, lookups)
        notebookChanged('saved', n, viewer.name)
        return json(res, 200, { ok: true, note: noteView(n) })
      },
    },
    { method: 'GET', path: /^\/api\/notebook\/(n-[a-f0-9]{10})$/, run: notebookNote },
    { method: 'POST', path: /^\/api\/notebook\/(n-[a-f0-9]{10})(?:\/(delete|restore))?$/, run: notebookNote },
    { method: 'GET', path: /^\/api\/me$/, run: ({ res, viewer }) => json(res, 200, { name: viewer.name, local: viewer.local }) },
    {
      method: 'GET',
      path: /^\/api\/actions$/,
      run: ({ res }) => {
        const actions = allActions(lib, store)
        // the tasks deleted lately, newest first, so a mistaken delete can be undone from the board
        const deleted = store.state.trash.map((t) => ({ id: t.task.id, text: t.task.text, owner: t.task.owner, by: t.by, at: t.at })).reverse()
        return json(res, 200, { actions, notes: citedNotes(actions), deleted })
      },
    },
    { method: 'POST', path: /^\/api\/actions\/([^/]+)$/, run: updateItem },
    {
      method: 'POST',
      path: /^\/api\/tasks$/,
      run: async ({ req, res, viewer }) => {
        const input = await body(req)
        const a = await addAction(lib, store, { text: input.text, owner: input.owner, lane: input.lane, meetingId: input.meetingId }, viewer.name)
        boardChanged({ kind: 'task-added', id: a.id, text: a.text, by: viewer.name })
        return json(res, 200, { ok: true, action: a })
      },
    },
    {
      method: 'POST',
      path: /^\/api\/tasks\/([^/]+)\/delete$/,
      run: async ({ res, viewer }, id) => {
        // not gone for good: POST /api/actions/<id> { undo: true } brings it back
        const a = await removeAction(lib, store, id, viewer.name)
        boardChanged({ kind: 'task-deleted', id: a.id, text: a.text, by: viewer.name })
        return json(res, 200, { ok: true })
      },
    },
    {
      method: 'POST',
      path: /^\/api\/prefs$/,
      run: async ({ req, res, viewer }) => {
        const { theme } = await body(req)
        if (theme !== 'light' && theme !== 'dark') return json(res, 400, { error: 'theme must be light or dark' })
        await store.setTheme(viewer.name, theme)
        return json(res, 200, { ok: true, theme })
      },
    },
    {
      method: 'POST',
      path: /^\/api\/presence$/,
      run: async ({ req, res, viewer }) => {
        const { id, page } = await body(req)
        const c = clients.get(String(id))
        if (c && c.viewer.name === viewer.name && c.page !== pageOf(page)) {
          c.page = pageOf(page)
          broadcast('presence', presence())
        }
        return json(res, 200, { ok: true })
      },
    },
    {
      method: 'GET',
      path: /^\/api\/lab$/,
      run: ({ res }) =>
        json(res, 200, {
          ffmpeg: media.enabled,
          semantic: semantic.status(),
          reranker: reranker.enabled,
          mirror: mirror.status(),
          transcripts: transcriber.status(),
          meetings: lib.meetings.map((x) => ({ id: x.id, title: x.title, date: x.date, hue: x.hue, videos: x.videos })),
          loose: lib.loose.map((f) => ({ id: f.id, name: f.name, kind: f.kind, size: f.size })),
        }),
    },
    { method: 'GET', path: /^\/api\/events$/, run: events },
    {
      method: 'GET',
      path: /^\/media\/([^/]+)$/,
      run: ({ req, res, url, viewer }, id) => {
        const f = lib.files.get(id)
        if (!f) return json(res, 404, { error: 'no such file' })
        const download = url.searchParams.has('download')
        // the file's id, not its name: names can say what a meeting was about
        if (download && !req.headers.range) console.log(`download: ${viewer.name} ← ${f.id}`)
        return sendFile(req, res, () => openScanned(f), { size: f.size, mtimeMs: f.mtimeMs, type: mimeOf(f.name), download: download ? downloadName(f) : undefined })
      },
    },
    { method: 'GET', path: /^\/thumbs\/([^/]+)\/(poster|sprite)\.jpg$/, run: thumb },
    {
      method: 'GET',
      path: /^\/captions\/([^/]+)\.vtt$/,
      run: ({ res, url }, id) => {
        const text = vtt(id, Number(url.searchParams.get('shift') ?? 0) || 0)
        if (!text) return json(res, 404, { error: 'no such transcript' })
        res.writeHead(200, { 'Content-Type': 'text/vtt; charset=utf-8', 'Cache-Control': 'private, no-store' })
        return res.end(text)
      },
    },
  ]

  async function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string) {
    const root = resolve(config.webDir)
    let decoded: string
    try {
      decoded = decodeURIComponent(pathname)
    } catch {
      return json(res, 404, { error: 'not found' })
    }
    let path = resolve(root, `.${decoded}`)
    if (!path.startsWith(`${root}/`) && path !== root) return json(res, 404, { error: 'not found' })
    const s = await stat(path).catch(() => undefined)
    // Client-side routes (/m/…, /actions, …) all load the app shell, whatever dots they hold: a meeting id from the
    // index can be "q3.review". Only a static file's extension, at the top of web/ or under one of its folders (js/,
    // css/), asks for a file, and a missing one answers 404.
    if (!s?.isFile()) {
      const [top, ...rest] = path.slice(root.length + 1).split('/')
      const folder = rest.length > 0 && Boolean((await stat(join(root, top)).catch(() => undefined))?.isDirectory())
      if (STATIC[extname(path)] && (rest.length === 0 || folder)) return json(res, 404, { error: 'not found' })
      path = join(root, 'index.html')
    }
    const st = await stat(path)
    await sendFile(req, res, path, { size: st.size, mtimeMs: st.mtimeMs, type: STATIC[extname(path)] ?? 'application/octet-stream', cache: 'private, no-cache' })
  }

  async function handle(req: IncomingMessage, res: ServerResponse, url: URL, viewer: Viewer) {
    const p = url.pathname
    const method = req.method ?? 'GET'

    if (crossSite(req, p)) return json(res, 403, { error: 'cross-site request refused' })
    if (viewer.agent && (!AGENT_OK.test(p) || (!p.startsWith('/mcp') && method !== 'GET' && method !== 'HEAD'))) return json(res, 403, { error: 'agent tokens may use /mcp and read-only /api' })
    if (p === '/mcp' || p === '/mcp/readonly') return handleMcp(req, res, mcpViewer(viewer, p === '/mcp/readonly'), mcpCtx)

    if (method === 'POST') {
      // same-origin fetches only: a custom header forces a CORS preflight that we never approve
      if (req.headers['x-requested-with'] !== 'meetings' || !originOk(req.headers.origin)) return json(res, 403, { error: 'cross-site request refused' })
    } else if (method !== 'GET' && method !== 'HEAD') return json(res, 405, { error: 'method not allowed' })

    let elsewhere = false
    for (const r of routes) {
      const m = r.path.exec(p)
      if (!m) continue
      if (r.method !== (method === 'HEAD' ? 'GET' : method)) {
        elsewhere = true
        continue
      }
      return r.run({ req, res, url, viewer }, ...m.slice(1).map((s) => (s === undefined ? s : decode(s))))
    }
    if (elsewhere) return json(res, 405, { error: 'method not allowed' })
    if (p.startsWith('/api/')) return json(res, 404, { error: 'not found' })
    if (method === 'POST') return json(res, 405, { error: 'method not allowed' })
    return serveStatic(req, res, p)
  }

  // ---------- the request entry ----------

  async function handler(req: IncomingMessage, res: ServerResponse) {
    const started = Date.now()
    let path = ''
    try {
      for (const [k, v] of Object.entries(SECURITY)) res.setHeader(k, v)
      const url = URL.parse(req.url ?? '/', 'http://local')
      if (!url) return json(res, 400, { error: 'malformed address' })
      // Log only the path. Query strings can contain private search terms.
      path = url.pathname.slice(0, 120)
      if (path === '/connect' || path === '/connect/authorize') res.setHeader('Cross-Origin-Opener-Policy', 'unsafe-none')
      if (connector.enabled && (req.headers.host ?? '').toLowerCase() === connector.host) {
        let name = ''
        try {
          await serveConnector(req, res, connector, url.pathname, (viewer) => {
            name = viewer.name
            return handleMcp(req, res, viewer, mcpCtx)
          })
        } catch (err) {
          console.error(`${req.method} connector ${path} failed:`, err instanceof Error ? err.name : 'unexpected error')
          if (!res.headersSent) json(res, 500, { error: 'server_error' })
          else res.destroy()
        }
        return void console.log(`${req.method} connector ${path} ${res.statusCode} ${Date.now() - started}ms${name ? ` ${name}` : ''}`)
      }
      const who = await gate.identify(req)
      if ('error' in who) {
        console.warn(`refused ${req.method} ${path} from ${req.headers['cf-connecting-ip'] ?? req.socket.remoteAddress}: ${who.error}`)
        return json(res, 403, { error: who.error })
      }
      await handle(req, res, url, who)
      // an agent's calls are logged under the agent's name, so the log tells a person from their agent
      const name = path === '/mcp' || path === '/mcp/readonly' ? mcpViewer(who, path === '/mcp/readonly').name : who.name
      if ((path.startsWith('/api/') || path.startsWith('/mcp')) && path !== '/api/events' && path !== '/api/presence') console.log(`${req.method} ${path} ${res.statusCode} ${Date.now() - started}ms ${name}`)
    } catch (err) {
      if (err instanceof StaleFile) schedule('a file changed under us', 0)
      if (res.headersSent) {
        console.error(`${req.method} ${path} failed:`, err)
        return void res.destroy()
      }
      if (err instanceof TooLarge) return json(res, 413, { error: err.message })
      if (err instanceof BadPath) return json(res, 400, { error: 'malformed address' })
      if (err instanceof OAuthError) return json(res, err.status, { error: err.message })
      if (err instanceof ConflictError) return json(res, 409, { error: err.message, action: err.action })
      if (err instanceof NoteConflict) return json(res, 409, { error: err.message, note: noteView(err.note) })
      if (err instanceof TaskError || err instanceof NoteError || err instanceof SpeakerError) return json(res, 400, { error: err.message })
      if (err instanceof StaleFile) return json(res, 404, { error: 'that file just changed; reload the page' })
      if (err instanceof SyntaxError) return json(res, 400, { error: 'malformed JSON' })
      console.error(`${req.method} ${path} failed:`, err)
      json(res, 500, { error: 'server error' })
    }
  }

  // ---------- start and stop ----------

  // Reads what's saved (an unreadable board or notebook stops it here, before anything is written), builds
  // the library, then follows the folder.
  async function start() {
    for (const dir of new Set([join(config.dataDir, 'logs'), ...(opts.serviceLogs ? [resolve(opts.serviceLogs)] : [])])) await rotateLogs(dir)
    // a copy in data/backups of what's on disk before anything here can write to it (BACKUP_DIR gets its own in the background)
    if (opts.backups ?? true) stops.push(await keepBackups(config.dataDir, config.backupDirs))
    await store.load()
    await notebook.load()
    await connector.load()
    await semantic.load()
    await media.load()
    await speakers.load()
    await transcriber.load()
    await savedNotes.load()
    await refresh('startup').catch(async (err) => {
      failed(err)
      lib = await buildLibrary([], () => ({}), config.crew, parseCache)
      index = buildIndex(lib)
    })
    const ping = setInterval(() => {
      for (const c of clients.values()) send(c, ': ping\n\n')
    }, 25_000)
    ping.unref()
    stops.push(() => clearInterval(ping))
    if (opts.watch ?? true) {
      try {
        const watcher: FSWatcher = watch(config.meetingsDir, { recursive: true }, (_, name) => {
          if (name && /(^|\/)\./.test(String(name))) return
          schedule('files changed')
        })
        stops.push(() => watcher.close())
      } catch (err) {
        console.warn(`can't watch ${config.meetingsDir} (${(err as Error).message}); polling instead`)
      }
      const poll = setInterval(() => void refresh('poll').catch(failed), 60_000)
      poll.unref()
      stops.push(() => clearInterval(poll))
    }
  }

  // Stop watching, close live streams and drain pending index and connector writes.
  async function close() {
    for (const stop of stops.splice(0)) stop()
    clearTimeout(timer)
    // a transcript being written stops; the next start writes it again
    transcriber.stop()
    // the file being copied is cut short and its part removed; the next start copies it again
    const mirrored = mirror.stop()
    for (const c of clients.values()) c.res.destroy()
    await refreshing
    await mirrored
    await semantic.waitForSync()
    await connector.waitForWrites()
  }

  return { handler, start, close, gate, store, notebook, lib: () => lib, index: () => index }
}
