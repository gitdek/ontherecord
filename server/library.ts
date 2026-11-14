// Turns the meetings folder into meetings. meetings-index.json (written alongside the files) says which
// notes, videos and transcripts belong together; anything it doesn't mention yet is grouped by the names
// and "Source video:" references inside the files themselves.
import { constants, type Stats } from 'node:fs'
import { open, readdir, realpath, stat, type FileHandle } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { actionsOf, parseNotes, topicsOf, type Line, type Notes, type Phase } from './notes.ts'
import { nicknamesOf, People } from './people.ts'
import { autoChapters, blockIdf, findThreads, type Thread } from './topics.ts'
import { parseTranscript, transcriptWords, type Transcript } from './transcripts.ts'
import { ISO_DATE, localDay, NAME_DATE, nameDate, normKind, normName, parseTime, recordingStamp, shortHash, slug, stripExt, type Range } from './text.ts'

export type FileKind = 'notes' | 'transcript' | 'video' | 'audio' | 'doc' | 'index' | 'manifest' | 'readme' | 'other'
// dev + ino pin the exact file the scan saw, so a later swap (say, for a symlink) is noticed when it's opened
export type FileEntry = { id: string; name: string; rel: string; path: string; size: number; mtimeMs: number; kind: FileKind; dev: number; ino: number }

export type Probe = {
  duration?: number
  width?: number
  height?: number
  fps?: number
  vcodec?: string
  acodec?: string
  bitrate?: number
  hasAudio: boolean
  rotation?: number
}
// failed: ffprobe couldn't read the file (a copy whose compression was cut off, say)
export type MediaFacts = { probe?: Probe; faststart?: boolean; growing?: boolean; failed?: boolean }

export type Video = {
  fileId: string
  name: string
  label: string
  size: number
  mtimeMs: number
  probe?: Probe
  faststart?: boolean
  growing?: boolean
  failed?: boolean
  transcriptId?: string
  synced: boolean
  playable: boolean
  isDefault: boolean
  // where this copy's 0:00 falls on the meeting's clock: a copy trimmed at the start begins partway into
  // the full recording that the notes are timed on
  offset: number
}

export type TranscriptSource = {
  id: string
  stem: string
  label: string
  files: FileEntry[]
  parsed: Transcript
  words: number
  videoNames: string[]
}

export type Topic = { key: string; n?: number; title: string; group: string; color: number; ranges: Range[]; bullets: Line[]; auto?: boolean }
export type Action = { id: string; owner: string; people: string[]; lane: 'us' | 'them'; text: string; ranges: Range[]; section: string }

export type Meeting = {
  id: string
  aliases: string[]
  title: string
  // what sort of recording it is: "meeting" unless the index or the notes say otherwise ("demo", "training")
  kind: string
  // what a presenter typed on screen (a phone number, an address) is masked in the text read off its frames;
  // maskWords: words to mask as well, which no shape tells (a street, the name of a shop)
  maskScreens: boolean
  maskWords: string[]
  date: string
  time?: number
  duration?: number
  blurb: string
  timing?: string
  hue: number
  notes?: Notes
  notesFile?: FileEntry
  participants: string[]
  videos: Video[]
  // offset: where the transcript's 0:00 falls on the meeting's clock (as for videos)
  transcripts: { id: string; label: string; synced: boolean; videoIds: string[]; offset: number }[]
  primaryTranscript?: string
  docs: FileEntry[]
  topics: Topic[]
  phases: Phase[]
  actions: Action[]
  timeBase: 'offset' | 'clock'
  axis: Range
  files: FileEntry[]
  syncSuggestion?: { offset: number; hours: number }
  words: number
  // how much talking happens across the axis, 0–1 in 96 bins
  pulse: number[]
  fromIndex: boolean
}

export type Library = {
  meetings: Meeting[]
  byId: Map<string, Meeting>
  files: Map<string, FileEntry>
  transcripts: Map<string, TranscriptSource>
  people: People
  threads: Thread[]
  cautions: string[]
  loose: FileEntry[]
  // the text of each document attached to a meeting (an agenda, an excerpt), by file id, for search
  docText: Map<string, string>
  builtAt: number
}

const VIDEO = /\.(mp4|m4v|mov|webm|mkv)$/i
const AUDIO = /\.(m4a|mp3|wav|aac|ogg|opus|flac)$/i
const PLAYABLE = /\.(mp4|m4v|mov|webm|m4a|mp3|wav|aac|ogg|opus|flac)$/i

export function classify(name: string): FileKind {
  const n = normName(name)
  if (n === 'meetings-index.json') return 'index'
  if (/^collection-manifest.*\.json$/.test(n)) return 'manifest'
  if (/^(start here\b.*|readme.*)\.(txt|md)$/.test(n)) return 'readme'
  if (VIDEO.test(n)) return 'video'
  if (AUDIO.test(n)) return 'audio'
  if (/\.(srt|vtt)$/.test(n)) return 'transcript'
  if (/\.json$/.test(n)) return /transcript/.test(n) ? 'transcript' : 'other'
  if (/\.(txt|md)$/.test(n)) {
    if (/\bnotes?\b/.test(n)) return 'notes'
    if (/\btranscript\b|\bsource\.txt$|\bcaptions?\b/.test(n)) return 'transcript'
    return 'doc'
  }
  return 'other'
}

// How reviewed notes open. A file is notes because of this line, whatever it is called.
const NOTES_HEAD = /^\s*MEETING NOTES\b/

// A doc that is really notes or a transcript, judging by its first lines.
function sniff(kind: FileKind, text: string): FileKind {
  if (kind !== 'doc') return kind
  const head = text.slice(0, 2000)
  if (NOTES_HEAD.test(head)) return 'notes'
  if (/^\s*MACHINE TRANSCRIPT\b/m.test(head) || /^\[\d{1,2}:\d{2}/m.test(head) || /^\d{1,2}:\d{2}:\d{2}(?:[.,]\d+)?\s*-->/m.test(head)) return 'transcript'
  return kind
}

// The meetings folder as it was when the server started: its real path and identity. If the folder (or a
// folder above it) is later replaced, say by a symlink to somewhere else, scans stop instead of following it.
// moved: set once that is noticed, and from then on every scan stops at once.
export type PinnedFolder = { path: string; dev: number; ino: number; moved?: string }
// A path that runs through a symlink is refused (it could have been swapped in before a restart) unless the
// owner says the link is intended (MEETINGS_DIR_ALLOW_LINK=1).
export async function pinFolder(dir: string, allowLink = false): Promise<PinnedFolder> {
  const path = await realpath(dir)
  if (!allowLink && path !== resolve(dir)) throw new StaleFile(`${dir} leads through a symlink to ${path}; point MEETINGS_DIR at the real folder, or set MEETINGS_DIR_ALLOW_LINK=1 if the link is intended`)
  const s = await stat(path)
  if (!s.isDirectory()) throw new Error(`${dir} is not a folder`)
  return { path, dev: s.dev, ino: s.ino }
}

// macOS refuses a path with a symlink in ANY component when opened with O_NOFOLLOW_ANY (O_NOFOLLOW checks only
// the last one, and the two can't be combined), so a folder swapped for a link, even mid-scan, can't bring
// outside files in. Elsewhere only the last component is checked.
export const NOFOLLOW = process.platform === 'darwin' ? 0x20000000 : constants.O_NOFOLLOW

// What a file really is, opened the safe way: undefined for anything but a regular file reached without links.
async function identify(path: string) {
  const fh = await open(path, constants.O_RDONLY | NOFOLLOW | constants.O_NONBLOCK).catch(() => undefined)
  if (!fh) return
  try {
    const s = await fh.stat()
    return s.isFile() ? s : undefined
  } finally {
    await fh.close()
  }
}

// The pinned folder is checked without following links. Moved on the same disk with a symlink left in its
// place, or in place of a folder above it, it is still the same folder, but no file in it opens through the
// link, so a scan would find it empty. That counts as moved: scanning stops until a restart, and the library
// in memory stays as it was. A folder that can't be opened for another reason (too many files open, say)
// stops this scan only.
async function checkPinned(folder: PinnedFolder) {
  if (!folder.moved) {
    let s: Stats | undefined
    try {
      const fh = await open(folder.path, constants.O_RDONLY | NOFOLLOW | constants.O_DIRECTORY)
      try {
        s = await fh.stat()
      } finally {
        await fh.close()
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      // a link on the way, nothing there, or a file in its place
      if (code !== 'ELOOP' && code !== 'ENOENT' && code !== 'ENOTDIR') throw new StaleFile(`the meetings folder at ${folder.path} can't be opened just now (${code ?? (err as Error).message})`)
    }
    if (!s || s.dev !== folder.dev || s.ino !== folder.ino) {
      folder.moved = `the meetings folder at ${folder.path} was moved or replaced, so scanning has stopped and the archive keeps what it had; restart the server if that was intended`
      console.error(`library: ${folder.moved}`)
    }
  }
  if (folder.moved) throw new StaleFile(folder.moved)
}

export async function scanFiles(folder: string | PinnedFolder, depth = 2): Promise<FileEntry[]> {
  let dir = typeof folder === 'string' ? await realpath(folder).catch(() => folder) : folder.path
  if (typeof folder !== 'string') {
    await checkPinned(folder)
    dir = folder.path
  }
  const out: FileEntry[] = []
  async function walk(abs: string, rel: string, level: number) {
    let entries
    try {
      entries = await readdir(abs, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name.startsWith('~$')) continue
      const path = join(abs, e.name)
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (level < depth) await walk(path, r, level + 1)
        continue
      }
      if (!e.isFile()) continue
      const s = await identify(path)
      if (!s) continue
      out.push({ id: shortHash(r), name: e.name, rel: r, path, size: s.size, mtimeMs: Math.round(s.mtimeMs), kind: classify(e.name), dev: s.dev, ino: s.ino })
    }
  }
  await walk(dir, '', 0)
  return out.sort((a, b) => a.rel.localeCompare(b.rel))
}

// Files are reopened by the path the last scan saw. If that path has since become a symlink, a pipe or a
// different file, refuse rather than follow it out of the meetings folder.
export class StaleFile extends Error {}

export async function openScanned(f: FileEntry): Promise<FileHandle> {
  const fh = await open(f.path, constants.O_RDONLY | NOFOLLOW | constants.O_NONBLOCK).catch(() => {
    throw new StaleFile(`${f.rel} changed since the last scan`)
  })
  try {
    const s = await fh.stat()
    if (s.isFile() && s.dev === f.dev && s.ino === f.ino) return fh
  } catch {}
  await fh.close()
  throw new StaleFile(`${f.rel} changed since the last scan`)
}

// The same check for tools that open the file themselves (ffprobe, ffmpeg).
export async function stillScanned(f: FileEntry) {
  await (await openScanned(f)).close()
}

// Text of a scanned file, never more than the scan saw (and never more than max bytes).
export async function readScanned(f: FileEntry, max = 25_000_000): Promise<string> {
  const fh = await openScanned(f)
  try {
    const buf = Buffer.alloc(Math.min(f.size, max))
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
    return buf.toString('utf8', 0, bytesRead).normalize('NFC')
  } finally {
    await fh.close()
  }
}

// ---------- parsing, cached by size + mtime ----------

type Parsed = { text: string; kind: FileKind; notes?: Notes; transcript?: Transcript; json?: unknown }
export type ParseCache = Map<string, { key: string; value: Parsed }>

// unread: where a file that can't be read or parsed is put, so the library can say so
async function parse(file: FileEntry, cache: ParseCache, unread: FileEntry[]): Promise<Parsed | undefined> {
  if (file.kind === 'video' || file.kind === 'audio' || file.kind === 'other' || file.size > 25_000_000) return
  const key = `${file.size}:${file.mtimeMs}`
  const hit = cache.get(file.rel)
  if (hit?.key === key) return hit.value
  try {
    const text = await readScanned(file)
    // A name is only a hint. A file called "notes" that doesn't open the way reviewed notes do is someone's own
    // notes: a document of its meeting, never a meeting of its own with its bullets on the board.
    const hinted = sniff(file.kind, text)
    const kind = hinted === 'notes' && !NOTES_HEAD.test(text.slice(0, 2000)) ? 'doc' : hinted
    const value: Parsed = { text, kind }
    if (kind === 'notes') value.notes = parseNotes(text)
    else if (kind === 'transcript') {
      const transcript = parseTranscript(text, file.name)
      // The same goes for a transcript: an agenda with "[9:15] Intro" lines has no timed line in it. As text it
      // is a document; in any other format it is left out of meetings and listed as a loose file.
      if (transcript.segments.length) value.transcript = transcript
      else value.kind = /\.(txt|md)$/i.test(file.name) ? 'doc' : 'other'
    } else if (kind === 'index' || kind === 'manifest') value.json = JSON.parse(text)
    cache.set(file.rel, { key, value })
    return value
  } catch (err) {
    // a file mid-copy can be truncated JSON; the watcher will bring us back once it settles
    console.warn(`skipping ${file.rel}: ${(err as Error).message}`)
    unread.push(file)
    return
  }
}

// ---------- names ----------

const VARIANT = /\b(compressed|crf ?\d+|meeting[ -]only|trimmed?|edited|cut|clip|small|web|faststart|browsing(?: copy)?|\d{3,4}p|h\.?26[45]|hevc|x26[45]|original)\b/gi

export const recordingKey = (name: string) =>
  normName(stripExt(name)).replace(/\s+-\s+/g, ' ').replace(VARIANT, ' ').replace(/[\s_()-]+/g, ' ').trim()

export const variantLabel = (name: string) =>
  (stripExt(name).normalize('NFC').match(VARIANT) ?? []).join(' ').replace(/meeting[ -]only/i, 'meeting only') || 'original'

// What a file's name says its meeting is called: the name without its date (and the time and zone an exported
// recording's name carries after it), without the words that tell copies of one recording apart, and without
// the role it ends in ("- notes", "- transcript", "Recording 1").
const ZONE = String.raw`(?:UTC|GMT(?:[+-]\d{1,2})?|[ECMP][SD]T|AK[SD]T|HST|BST|CES?T|IST|AE[SD]T)`
const STAMP = new RegExp(String.raw`[\s_(-]*${NAME_DATE.source}(?:[\s_T]+\d{1,2}[_.:h]\d{2}(?:[_.:]\d{2})?(?![\d.])(?:[\s_]*${ZONE}(?![A-Za-z]))?)?[\s_)-]*`, 'i')
// (only the words that can't be part of a title: "web" and "cut" tell copies apart too, and name meetings)
const TAIL = new RegExp(String.raw`(?:^|[\s(-]+)(?:notes?|transcript|source|captions?|(?<!screen\s)recording(?:\s+\d{1,2})?|\(\d{1,2}\)|compressed|crf ?\d+|meeting[ -]only|trimmed|faststart|browsing(?: copy)?|\d{3,4}p|h\.?26[45]|hevc|x26[45]|original)[\s)-]*$`, 'i')
export function nameTitle(name: string): string {
  let s = stripExt(name).normalize('NFC').replace(STAMP, ' ').replace(/_/g, ' ')
  for (let last = ''; last !== s; ) {
    last = s
    s = s.replace(TAIL, '')
  }
  return s.replace(/\s+/g, ' ').replace(/^[\s-]+|[\s-]+$/g, '')
}

const transcriptStem = (name: string) => normName(stripExt(name))
const meetingStem = (name: string) =>
  normName(stripExt(name))
    .replace(/\s*-?\s*(transcript|notes?|source)$/i, '')
    .replace(/\s+-\s+/g, ' ')
    .replace(VARIANT, ' ')
    .replace(/[\s_()-]+/g, ' ')
    .trim()

// ---------- building ----------

type IndexSession = {
  id?: string
  // what sort of recording it is ("demo"); wins over a Kind: line in the notes
  kind?: string
  // true when someone types their own details into a form on screen: screen search and the agents' tools then
  // give the text read off its frames with those masked. A list of words does the same and masks those words too.
  mask_screens?: boolean | string[]
  date?: string
  time_local?: string
  title?: string
  topic?: string
  timing?: string
  notes?: string
  videos?: string[]
  transcript?: string
  transcript_json?: string
  subtitles?: string
  meeting_only_transcript?: string
  meeting_only_transcript_json?: string
  meeting_only_subtitles?: string
  additional_excerpt?: string
  video_transcripts?: {
    video?: string
    transcript?: string
    transcript_json?: string
    subtitles?: string
    synchronization?: string
    // how far into the full recording (the notes' clock) this copy starts
    source_offset_seconds?: number
  }[]
}

type Draft = {
  id?: string
  title?: string
  kind?: string
  maskScreens?: boolean
  maskWords?: string[]
  date?: string
  time?: number
  blurb?: string
  timing?: string
  notesFile?: FileEntry
  videos: FileEntry[]
  transcripts: Map<string, TranscriptSource>
  links: { video: string; transcript: string; synced: boolean }[]
  // video file id / transcript id → where its 0:00 falls on the notes' clock, when that isn't 0:00
  offsets: Map<string, number>
  docs: FileEntry[]
  // anything else the index lists for the meeting (a verification report, say)
  extras: FileEntry[]
  fromIndex: boolean
}

const TOPIC_COLORS = 10

// For a meeting's aliases (by the array itself), the ones that are ids it had while its files arrived.
const earlierIds = new WeakMap<string[], Set<string>>()

export async function buildLibrary(
  files: FileEntry[],
  facts: (f: FileEntry) => MediaFacts,
  crew: string[],
  cache: ParseCache,
): Promise<Library> {
  const parsed = new Map<string, Parsed>()
  const unread: FileEntry[] = []
  for (const f of files) {
    const p = await parse(f, cache, unread)
    if (p) {
      parsed.set(f.id, p)
      f.kind = p.kind
    }
  }
  // A file is found by its path in the meetings folder. A bare name stands for a file only while no other file
  // in the folder tree has that name; a name two files share (notes.txt in two subfolders, say) means the one
  // beside the file that names it, and the stems of such files are matched within their own folder only.
  const byRel = new Map(files.map((f) => [normName(f.rel), f]))
  const byName = new Map(files.map((f) => [normName(f.name), f]))
  const count = new Map<string, number>()
  for (const f of files) count.set(normName(f.name), (count.get(normName(f.name)) ?? 0) + 1)
  const alone = (f: FileEntry) => count.get(normName(f.name)) === 1
  const folderOf = (f: FileEntry) => f.rel.slice(0, f.rel.length - f.name.length)
  const once = (name: string) => (count.get(name) === 1 ? byName.get(name) : undefined)
  // a bare name another file gives (a Source video line): the file of that name beside it, else the only one
  const near = (name: string, from: FileEntry[]) => (name.includes('/') ? undefined : from.map((f) => byRel.get(normName(folderOf(f) + name))).find(Boolean)) ?? once(name)
  // a file named in another's text: when its name is shared, only the one beside it
  const meant = (f: FileEntry, by: FileEntry) => alone(f) || folderOf(f) === folderOf(by)
  const find = (name?: string) => (name ? (byRel.get(normName(name)) ?? once(normName(name.split('/').pop()!))) : undefined)
  const claimed = new Set<string>()
  const claim = (f?: FileEntry) => f && claimed.add(f.id)

  const sources = new Map<string, TranscriptSource>()
  // transcript stems that files with shared names have: their twins are paired within a folder
  const sharedStems = new Set(files.filter((f) => f.kind === 'transcript' && !alone(f)).map((f) => transcriptStem(f.name)))
  const sourceFor = (f: FileEntry): TranscriptSource | undefined => {
    const stem = sharedStems.has(transcriptStem(f.name)) ? transcriptStem(f.rel) : transcriptStem(f.name)
    let src = sources.get(stem)
    const p = parsed.get(f.id)?.transcript
    if (!p) return src
    if (!src) {
      src = { id: shortHash(stem), stem, label: '', files: [], parsed: p, words: 0, videoNames: [] }
      sources.set(stem, src)
    }
    if (!src.files.includes(f)) src.files.push(f)
    // whisper JSON has the finer segments; the .txt twin carries the header (source video, duration)
    const json = src.files.find((x) => /\.json$/i.test(x.name))
    const txt = src.files.find((x) => /\.(txt|md)$/i.test(x.name)) ?? src.files.find((x) => !/\.json$/i.test(x.name))
    const jp = json && parsed.get(json.id)?.transcript
    const tp = txt && parsed.get(txt.id)?.transcript
    src.parsed = { ...(tp ?? jp!), segments: (jp ?? tp)!.segments, timeBase: (tp ?? jp)!.timeBase }
    if (tp?.sourceVideo && !src.videoNames.includes(normName(tp.sourceVideo))) src.videoNames.push(normName(tp.sourceVideo))
    src.words = transcriptWords(src.parsed)
    return src
  }

  // manifests remember which video each transcript came from
  const manifestSource = new Map<string, string>()
  for (const f of files.filter((x) => x.kind === 'manifest')) {
    const m = parsed.get(f.id)?.json as { files?: { path?: unknown; source_video?: unknown }[] } | undefined
    for (const e of Array.isArray(m?.files) ? m.files : [])
      if (typeof e?.path === 'string' && typeof e.source_video === 'string') manifestSource.set(normName(e.path.split('/').pop()!), normName(e.source_video.split('/').pop()!))
  }

  const drafts: Draft[] = []
  const index = files.find((f) => f.kind === 'index')
  const indexJson = index ? (parsed.get(index.id)?.json as { sessions?: IndexSession[]; cautions?: string[]; nicknames?: unknown } | undefined) : undefined
  claim(index)
  // a hand-edited index can hold anything; one bad session is skipped and reported, not fatal
  const problems: string[] = []
  // each file that can't be read is named among the cautions (never what it holds)
  for (const f of unread) problems.push(f === index ? `${f.rel} can't be read, so meetings are grouped by name until it is fixed` : `${f.rel} can't be read, so what it holds is left out`)
  const sessions = Array.isArray(indexJson?.sessions) ? indexJson.sessions : []
  const indexed: [Draft, string[]][] = []
  // Files a session names under keys this code doesn't know (the index keeps growing new ones) still belong
  // to that meeting, never to one of their own. Looked at once every session has taken what it names outright.
  const named = (v: unknown): string[] => (typeof v === 'string' ? [v] : v && typeof v === 'object' ? Object.values(v).flatMap(named) : [])

  for (const [i, s] of sessions.entries()) {
    if (!s || typeof s !== 'object') continue
    try {
      // read first, so a session nested too deep to read is skipped before it takes anything
      const { kind, mask_screens, ...rest } = s
      const names = named(rest)
      // ids end up in page URLs, so only plain ones are taken as given; anything else gets a derived id
      const id = typeof s.id === 'string' && /^[A-Za-z0-9][\w.-]{0,119}$/.test(s.id) ? s.id : undefined
      const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v : undefined)
      const d: Draft = {
        id,
        title: text(s.title),
        kind: normKind(kind),
        maskScreens: mask_screens === true || Array.isArray(mask_screens),
        // a word to mask is a few letters at least, and a list is short: it is read against every frame
        maskWords: Array.isArray(mask_screens) ? [...new Set(mask_screens.filter((w): w is string => typeof w === 'string').map((w) => w.trim()).filter((w) => w.length >= 3 && w.length <= 60))].slice(0, 40) : [],
        date: text(s.date),
        time: typeof s.time_local === 'string' ? parseTime(s.time_local, true) : undefined,
        blurb: text(s.topic),
        timing: text(s.timing),
        videos: [],
        transcripts: new Map(),
        links: [],
        offsets: new Map(),
        docs: [],
        extras: [],
        fromIndex: true,
      }
      d.notesFile = find(s.notes)
      claim(d.notesFile)
      for (const v of s.videos ?? []) {
        const f = find(v)
        if (f && !d.videos.includes(f)) d.videos.push(f)
        claim(f)
      }
      const addTranscript = (name?: string) => {
        const f = find(name)
        if (!f) return
        claim(f)
        const src = sourceFor(f)
        if (src) d.transcripts.set(src.id, src)
        return src
      }
      for (const n of [s.transcript, s.transcript_json, s.subtitles, s.meeting_only_transcript, s.meeting_only_transcript_json, s.meeting_only_subtitles]) addTranscript(n)
      for (const vt of s.video_transcripts ?? []) {
        const src = addTranscript(vt.transcript) ?? addTranscript(vt.transcript_json) ?? addTranscript(vt.subtitles)
        addTranscript(vt.transcript_json)
        addTranscript(vt.subtitles)
        const video = find(vt.video)
        const offset = vt.source_offset_seconds
        if (typeof offset === 'number' && offset > 0 && offset < 86400) for (const f of [src, video]) if (f) d.offsets.set(f.id, offset)
        if (src && video) d.links.push({ video: video.id, transcript: src.id, synced: /offset/i.test(vt.synchronization ?? '') })
      }
      const doc = find(s.additional_excerpt)
      if (doc) {
        d.docs.push(doc)
        claim(doc)
      }
      drafts.push(d)
      indexed.push([d, names])
    } catch (err) {
      problems.push(`meetings-index.json session ${i + 1} skipped: ${(err as Error).message}`)
    }
  }
  for (const [d, names] of indexed) {
    for (const n of names) {
      const f = find(n)
      if (!f || claimed.has(f.id)) continue
      claim(f)
      const src = f.kind === 'transcript' ? sourceFor(f) : undefined
      if (src) d.transcripts.set(src.id, src)
      else if (f.kind === 'video' || f.kind === 'audio') d.videos.push(f)
      // a text document (an agenda, say) is one of the meeting's documents, so its words are searched
      else if (f.kind === 'doc') d.docs.push(f)
      else d.extras.push(f)
    }
  }

  // ----- fallback grouping for files the index doesn't know about yet -----
  const free = (kinds: FileKind[]) => files.filter((f) => !claimed.has(f.id) && kinds.includes(f.kind))
  const recordings = new Map<string, FileEntry[]>()
  // copies of one recording share a key; a key that files with shared names have is kept per folder
  const sharedKeys = new Set(free(['video', 'audio']).filter((f) => !alone(f)).map((f) => recordingKey(f.name)))
  const keyOf = (f: FileEntry) => (sharedKeys.has(recordingKey(f.name)) ? folderOf(f) + recordingKey(f.name) : recordingKey(f.name))
  for (const f of free(['video', 'audio'])) {
    const k = keyOf(f)
    recordings.set(k, [...(recordings.get(k) ?? []), f])
  }
  const placed = new Set(drafts.flatMap((d) => [...d.transcripts.keys()]))
  const looseSources = new Map<string, TranscriptSource>()
  for (const f of free(['transcript'])) {
    const src = sourceFor(f)
    claim(f)
    // another copy of a transcript the index already placed (its subtitles, say) stays with that meeting
    if (src && !placed.has(src.id)) looseSources.set(src.id, src)
  }
  const videoOf = (src: TranscriptSource): FileEntry | undefined => {
    for (const n of src.videoNames) {
      const f = near(n, src.files)
      if (f) return f
    }
    for (const f of src.files) {
      // a manifest names files by their names alone, so it can't speak for one whose name is shared
      const v = alone(f) ? manifestSource.get(normName(f.name)) : undefined
      const hit = v && near(v, [f])
      if (hit) return hit
    }
    // The recording it names is gone (deleted once a lighter copy was made, say, or renamed): a copy of the same
    // recording left in the folder stands in for it, unless that copy is trimmed and so runs on other times.
    for (const n of [...src.videoNames, ...src.files.flatMap((f) => (alone(f) && manifestSource.get(normName(f.name))) || [])]) {
      const k = recordingKey(n)
      const copies = sharedKeys.has(k) ? src.files.map((f) => recordings.get(folderOf(f) + k)).find(Boolean) : recordings.get(k)
      const copy = copies?.find((v) => !TRIMMED.test(variantLabel(v.name)))
      if (copy) return copy
    }
  }
  const usedRecordings = new Set<string>()
  const usedSources = new Set<string>()
  const attachRecording = (d: Draft, key: string) => {
    for (const f of recordings.get(key) ?? []) if (!d.videos.includes(f)) d.videos.push(f)
    usedRecordings.add(key)
  }
  const attachSource = (d: Draft, src: TranscriptSource) => {
    d.transcripts.set(src.id, src)
    usedSources.add(src.id)
    const v = videoOf(src)
    if (v) {
      if (recordings.has(keyOf(v))) attachRecording(d, keyOf(v))
      d.links.push({ video: v.id, transcript: src.id, synced: src.parsed.timeBase === 'offset' })
    }
  }

  for (const nf of free(['notes'])) {
    claim(nf)
    const d: Draft = { notesFile: nf, videos: [], transcripts: new Map(), links: [], offsets: new Map(), docs: [], extras: [], fromIndex: false }
    const head = normName((parsed.get(nf.id)?.text ?? '').slice(0, 4000))
    // a stem matches across folders only while every name involved is the only one of its kind
    const sameStem = (stem: string, f: FileEntry, shared: boolean) => stem === meetingStem(nf.name) && (folderOf(f) === folderOf(nf) || (!shared && alone(nf)))
    for (const [key, fs] of recordings)
      if (fs.some((f) => (head.includes(normName(f.name)) && meant(f, nf)) || sameStem(recordingKey(f.name), f, sharedKeys.has(recordingKey(f.name))))) attachRecording(d, key)
    for (const src of looseSources.values()) {
      const first = src.files[0]
      const mentioned = src.files.some((f) => head.includes(normName(f.name)) && meant(f, nf))
      const stem = sameStem(meetingStem(first.name), first, sharedStems.has(transcriptStem(first.name)))
      const sameVideo = d.videos.some((v) => (src.videoNames.includes(normName(v.name)) && src.files.some((f) => meant(v, f))) || videoOf(src) === v)
      if (mentioned || stem || sameVideo) attachSource(d, src)
    }
    drafts.push(d)
  }
  for (const src of looseSources.values()) {
    if (usedSources.has(src.id)) continue
    const d: Draft = { videos: [], transcripts: new Map(), links: [], offsets: new Map(), docs: [], extras: [], fromIndex: false }
    attachSource(d, src)
    drafts.push(d)
  }
  for (const [key] of recordings) {
    if (usedRecordings.has(key)) continue
    const d: Draft = { videos: [], transcripts: new Map(), links: [], offsets: new Map(), docs: [], extras: [], fromIndex: false }
    attachRecording(d, key)
    drafts.push(d)
  }
  for (const d of drafts) for (const f of [...d.videos, ...[...d.transcripts.values()].flatMap((s) => s.files)]) claim(f)

  // loose docs go with the meeting that shares their date, when there's exactly one
  const looseDocs = free(['doc'])
  const loose = files.filter((f) => !claimed.has(f.id) && !looseDocs.includes(f) && f.kind !== 'index')

  // ----- meetings -----
  const people = new People(crew, nicknamesOf(indexJson?.nicknames))
  const meetings: Meeting[] = []
  for (const d of drafts) {
    try {
      meetings.push(assemble(d, parsed, facts))
    } catch (err) {
      problems.push(`couldn't assemble "${String(d.title ?? d.id ?? 'a meeting')}": ${(err as Error).message}`)
    }
  }
  for (const doc of looseDocs) {
    // no date in its name: the day it was saved, on this Mac's calendar
    const date = nameDate(doc.name) ?? localDay(doc.mtimeMs)
    const same = meetings.filter((m) => m.date === date)
    if (same.length === 1) {
      same[0].docs.push(doc)
      same[0].files.push(doc)
    } else loose.push(doc)
  }

  meetings.sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? 0) - (b.time ?? 0) || a.title.localeCompare(b.title))
  // A colour for each entry, a golden angle apart in date order. Meetings have their own run and the other kinds
  // theirs, half a step off, so adding a demo recolours no meeting and adding a meeting recolours no demo.
  const runs = { meeting: 0, other: 0 }
  for (const m of meetings) m.hue = Math.round((m.kind === 'meeting' ? runs.meeting++ * 137.508 + 18 : runs.other++ * 137.508 + 86.754) % 360)
  const taken = new Set<string>()
  for (const m of meetings) {
    let id = m.id
    for (let n = 2; taken.has(id); n++) id = `${m.id}-${n}`
    m.id = id
    taken.add(id)
  }

  // people: notes participants first, then first names in titles for meetings without notes
  for (const m of meetings) m.participants = (m.notes?.participants ?? []).map((name) => people.add(name, m.id))
  for (const m of meetings) {
    if (m.participants.length) continue
    m.participants = people.mentioned(`${m.title} ${m.files.map((f) => f.name).join(' ')}`)
    for (const id of m.participants) people.byId.get(id)!.meetings.push(m.id)
  }
  for (const m of meetings) {
    for (const a of m.actions) {
      a.people = people.mentioned(a.owner)
      a.lane = a.people.some((id) => people.isCrew(id)) || /^(team|all|we)\b/i.test(a.owner) ? 'us' : 'them'
    }
  }

  // auto chapters for meetings that only have a transcript
  const allSegments = [...sources.values()].map((s) => s.parsed.segments)
  const idf = blockIdf(allSegments)
  for (const m of meetings) {
    if (m.topics.length || !m.primaryTranscript) continue
    const src = [...sources.values()].find((s) => s.id === m.primaryTranscript)
    if (!src || src.parsed.timeBase !== 'offset') continue
    m.topics = autoChapters(src.parsed.segments, idf).map((c, i) => ({
      key: `a${i}`,
      title: c.label,
      group: 'Auto-detected from the transcript',
      color: i % TOPIC_COLORS,
      ranges: [[c.start + offsetIn(m, src.id), c.end + offsetIn(m, src.id)]],
      bullets: [],
      auto: true,
    }))
  }

  const transcripts = new Map([...sources.values()].map((s) => [s.id, s]))
  const personWords = new Set([...people.byId.values()].flatMap((p) => [...p.aliases, ...p.name.toLowerCase().split(/\s+/)]))
  const threads = findThreads(
    meetings.map((m) => ({
      id: m.id,
      notes: [...(m.notes?.intro.map((l) => l.text) ?? []), ...(m.notes?.sections.map((s) => s.title) ?? []), notesText(m.notes)].join('\n'),
      transcript: transcriptText(m, transcripts),
    })),
    personWords,
  )

  // A meeting answers to its id and to its aliases, and an id always wins over an alias. A name from a meeting's
  // own files finds the first meeting that has it, as it always has, so no link that works stops working. An id
  // a meeting had while its files arrived is newer: one that would fit two meetings is given to neither. A
  // meeting's aliases are the ones that find it.
  const byId = new Map<string, Meeting>(meetings.map((m) => [m.id, m]))
  const earlier = (m: Meeting, a: string) => earlierIds.get(m.aliases)?.has(a) ?? false
  for (const m of meetings) for (const a of m.aliases) if (!earlier(m, a) && !byId.has(a)) byId.set(a, m)
  const claims = new Map<string, Meeting | null>()
  for (const m of meetings) for (const a of m.aliases) if (earlier(m, a) && !byId.has(a)) claims.set(a, claims.has(a) && claims.get(a) !== m ? null : m)
  for (const [a, m] of claims) if (m) byId.set(a, m)
  for (const m of meetings) m.aliases = m.aliases.filter((a) => a !== m.id && byId.get(a) === m)
  return {
    meetings: meetings.reverse(),
    byId,
    files: new Map(files.map((f) => [f.id, f])),
    transcripts,
    people,
    threads,
    cautions: [...(Array.isArray(indexJson?.cautions) ? indexJson.cautions.filter((c) => typeof c === 'string') : []), ...problems],
    loose,
    docText: new Map(meetings.flatMap((m) => m.docs).map((f) => [f.id, parsed.get(f.id)?.text ?? ''])),
    builtAt: Date.now(),
  }
}

// The date and title a meeting's own files give it (an index entry can set both instead).
// before: the way both were worked out until November 2026, when a file name's title kept the separators around
// its date and the words of a lighter copy, and a file with no date anywhere got the UTC day it was saved. Ids
// were made from them, so assemble() still works them out to keep those ids opening their meeting.
function ownName(notes: Notes | undefined, notesFile: FileEntry | undefined, videos: FileEntry[], srcs: TranscriptSource[], before = false) {
  const anyName = notesFile?.name ?? videos[0]?.name ?? srcs[0]?.files[0]?.name ?? 'meeting'
  const stamp = videos.map((v) => recordingStamp(v.name)).find(Boolean)
  const names = [anyName, ...videos.map((v) => v.name)].join(' ')
  const saved = [notesFile, ...videos, ...srcs.flatMap((s) => s.files)].reduce((t, f) => Math.min(t, f?.mtimeMs ?? t), Date.now())
  const fromName = before ? stripExt(anyName).replace(ISO_DATE, '').replace(/\s+-\s+(notes|transcript|compressed).*$/i, '').replace(/[\s-]+$/, '').trim() : nameTitle(anyName) || 'Recording'
  return {
    date: notes?.date ?? (before ? ISO_DATE.exec(names)?.[0] : nameDate(names)) ?? stamp?.date ?? (before ? new Date(saved).toISOString().slice(0, 10) : localDay(saved)),
    title: notes?.title ?? srcs[0]?.parsed.title ?? fromName,
  }
}

function assemble(d: Draft, parsed: Map<string, Parsed>, facts: (f: FileEntry) => MediaFacts): Meeting {
  const notes = d.notesFile ? parsed.get(d.notesFile.id)?.notes : undefined
  const srcs = [...d.transcripts.values()]
  const stamp = d.videos.map((v) => recordingStamp(v.name)).find(Boolean)
  const own = ownName(notes, d.notesFile, d.videos, srcs)
  const date = d.date ?? own.date
  const title = d.title ?? own.title

  // videos: pick the lightest copy that still covers (nearly) the whole recording
  const videos: Video[] = d.videos.map((f) => {
    const fx = facts(f)
    const link = d.links.find((l) => l.video === f.id)
    return {
      fileId: f.id,
      name: f.name,
      label: variantLabel(f.name),
      size: f.size,
      mtimeMs: f.mtimeMs,
      probe: fx.probe,
      faststart: fx.faststart,
      growing: fx.growing,
      failed: fx.failed,
      transcriptId: link?.transcript,
      synced: link?.synced ?? false,
      playable: PLAYABLE.test(f.name) && !fx.growing && !fx.failed,
      isDefault: false,
      offset: d.offsets.get(f.id) ?? 0,
    }
  })
  // The index lists the browsing copy first; otherwise start from the smallest file. Swap to a copy of the
  // same length when it is much lighter, and never default to one whose rotation flag turns it sideways.
  // A copy with a picture comes before one with sound only (the audio a transcription step kept, say).
  const ready = videos.filter((v) => v.playable)
  const pictured = ready.filter((v) => VIDEO.test(v.name) && (!v.probe || Boolean(v.probe.width)))
  const playable = pictured.length ? pictured : ready
  if (!d.fromIndex) playable.sort((a, b) => a.size - b.size)
  let pick = playable[0]
  for (const v of playable) if (pick && v !== pick && sameTimeline(v, pick) && v.size < pick.size * 0.8 && !v.probe?.rotation) pick = v
  if (pick?.probe?.rotation) pick = playable.find((v) => !v.probe?.rotation && sameTimeline(v, pick!)) ?? pick
  if (pick) pick.isDefault = true

  // transcripts: the one tied to the default video leads
  const transcriptsOut = srcs.map((s) => {
    const vids = d.links.filter((l) => l.transcript === s.id).map((l) => l.video)
    const tiedTo = videos.find((v) => vids.includes(v.fileId))
    const label =
      s.parsed.timeBase === 'clock'
        ? 'Source transcript (wall clock)'
        : srcs.length > 1 && tiedTo
          ? `Transcript · ${TRIMMED.test(tiedTo.label) ? tiedTo.label : 'full recording'}`
          : 'Transcript'
    s.label = label
    return { id: s.id, label, synced: d.links.some((l) => l.transcript === s.id && l.synced), videoIds: vids, offset: d.offsets.get(s.id) ?? 0 }
  })
  const primary = (pick?.transcriptId && transcriptsOut.find((t) => t.id === pick.transcriptId)) || transcriptsOut[0]
  if (primary) transcriptsOut.unshift(...transcriptsOut.splice(transcriptsOut.indexOf(primary), 1))

  const primarySrc = srcs.find((s) => s.id === primary?.id)
  const timeBase = notes?.timeBase ?? primarySrc?.parsed.timeBase ?? 'offset'
  // the primary transcript's lines, placed on the meeting's clock
  const shift = primary?.offset ?? 0
  const segs = (primarySrc?.parsed.segments ?? []).map((s) => (shift ? { ...s, s: s.s + shift, e: s.e + shift } : s))

  let duration: number | undefined
  let axis: Range
  if (timeBase === 'clock') {
    // a wall-clock transcript can be shared by two meetings: this meeting is the window its notes cite
    const times = notes ? allNoteRanges(notes).flat() : []
    axis = times.length ? [Math.min(...times) - 30, Math.max(...times) + 30] : segs.length ? [segs[0].s, segs[segs.length - 1].e] : [0, 0]
    duration = pick?.probe?.duration ?? axis[1] - axis[0]
  } else {
    // the copy that plays, where it sits on the notes' clock (a copy trimmed at the start begins partway in)
    const start = pick?.offset ?? shift
    duration =
      pick?.probe?.duration ?? (notes?.duration !== undefined ? notes.duration - start : undefined) ?? primarySrc?.parsed.duration ?? (segs.length ? segs[segs.length - 1].e - start : undefined)
    axis = [start, start + (duration ?? 0)]
  }
  const inWindow = segs.filter((s) => !s.q && (timeBase === 'offset' || (s.e >= axis[0] && s.s <= axis[1])))
  const wordCount = timeBase === 'offset' ? (primarySrc?.words ?? 0) : inWindow.reduce((n, s) => n + s.t.split(/\s+/).length, 0)

  // Screen recordings are named in local time while the transcript clock may sit a few time zones away:
  // offer the whole-hour shift that lands the recording start inside this meeting's window.
  let syncSuggestion: Meeting['syncSuggestion']
  if (timeBase === 'clock' && stamp && segs.length) {
    for (let hours = 0; hours <= 12; hours++) {
      const offset = stamp.seconds - hours * 3600
      if (offset < axis[0] - 900 || offset > axis[1]) continue
      if (!syncSuggestion || Math.abs(offset - axis[0]) < Math.abs(syncSuggestion.offset - axis[0])) syncSuggestion = { offset, hours }
    }
  }

  const id = d.id ?? `${date}-${slug(title, 48)}`
  // Until the index lists a meeting, its id follows the best title its files give so far: a recording's
  // file name, then its transcript's title, then the notes. It also answers to the ids it had on the way,
  // so links and the clock sync saved under one of them still find it.
  // (and the ids the earlier way of reading names gave it, which may be out in links and notes)
  const stages = [false, true]
    .flatMap((before) => [
      ...(d.notesFile || d.videos.length || srcs.length ? [ownName(notes, d.notesFile, d.videos, srcs, before)] : []),
      ...(d.videos.length ? [ownName(undefined, undefined, d.videos, [], before)] : []),
      ...d.videos.map((v) => ownName(undefined, undefined, [v], [], before)),
      ...srcs.flatMap((s) => [ownName(undefined, undefined, [], [s], before), ownName(undefined, undefined, d.videos, [s], before)]),
    ])
    .map((n) => `${n.date}-${slug(n.title, 48)}`)
  const stems = new Set([d.notesFile, ...d.videos, ...srcs.flatMap((s) => s.files)].filter(Boolean).map((f) => slug(meetingStem(f!.name), 80)))
  const aliases = [...new Set([...stems, ...stages])].filter((a) => a !== id)
  // which of them are ids from earlier stages rather than names of its files (buildLibrary treats the two apart)
  earlierIds.set(aliases, new Set(stages.filter((a) => !stems.has(a))))
  const topics: Topic[] = notes ? topicsOf(notes).map((t, i) => ({ ...t, color: i % TOPIC_COLORS })) : []
  // An item is named by its meeting and wording. A second item worded the same in one meeting gets its own
  // id (the first keeps the one it always had), and every line of the notes says which item it is, so
  // search, the meaning index and the page never have to guess by wording.
  const repeats = new Map<string, number>()
  const actions: Action[] = notes
    ? actionsOf(notes).map((a) => {
        const words = normName(a.text)
        const k = (repeats.get(words) ?? 0) + 1
        repeats.set(words, k)
        const actionId = shortHash(k === 1 ? `${id}|${words}` : `${id}|${words}|${k}`, 10)
        a.line.action = actionId
        return { id: actionId, owner: a.owner, people: [], lane: 'them', text: a.text, ranges: a.ranges, section: a.section }
      })
    : []
  const summary = notes?.sections.find((s) => s.role === 'summary')
  const summaryText = summary?.blocks.map((b) => ('text' in b ? b.text : b.title)).join(' ') ?? ''

  return {
    id,
    aliases,
    title,
    kind: d.kind ?? notes?.kind ?? 'meeting',
    maskScreens: d.maskScreens === true,
    maskWords: d.maskWords ?? [],
    date,
    time: stamp?.seconds ?? d.time,
    duration,
    blurb: d.blurb ?? firstSentences(summaryText, 220),
    timing: d.timing,
    hue: 0,
    notes,
    notesFile: d.notesFile,
    participants: [],
    videos,
    transcripts: transcriptsOut,
    primaryTranscript: primary?.id,
    docs: d.docs,
    topics,
    phases: notes?.phases ?? [],
    actions,
    timeBase,
    axis,
    files: [d.notesFile, ...d.videos, ...srcs.flatMap((s) => s.files), ...d.docs, ...d.extras].filter((f): f is FileEntry => Boolean(f)),
    syncSuggestion,
    words: wordCount,
    pulse: pulseOf(inWindow, axis),
    fromIndex: d.fromIndex,
  }
}

function pulseOf(segs: { s: number; e: number; t: string }[], [a, b]: Range, bins = 96): number[] {
  const out = new Array<number>(bins).fill(0)
  if (b <= a) return out
  const w = (b - a) / bins
  for (const seg of segs) {
    const n = seg.t.split(/\s+/).length
    const first = Math.max(0, Math.floor((seg.s - a) / w))
    const last = Math.min(bins - 1, Math.floor((Math.max(seg.s, seg.e - 0.01) - a) / w))
    for (let i = first; i <= last; i++) out[i] += n / (last - first + 1)
  }
  const max = Math.max(...out, 1)
  return out.map((x) => Math.round((x / max) * 100) / 100)
}

const TRIMMED = /meeting only|trim|cut|clip/i

// Re-encodes of one recording share a timeline; a trimmed cut does not.
function sameTimeline(a: Video, b: Video) {
  const da = a.probe?.duration
  const db = b.probe?.duration
  if (da && db) return Math.abs(da - db) <= Math.max(2, 0.02 * Math.max(da, db))
  return !TRIMMED.test(a.label) && !TRIMMED.test(b.label)
}

function allNoteRanges(notes: Notes): Range[] {
  const out: Range[] = notes.phases.map((p) => [p.start, p.end])
  for (const s of notes.sections) {
    if (s.role === 'source' || s.role === 'caveats') continue
    for (const b of s.blocks) {
      out.push(...b.ranges)
      if (b.kind === 'item') for (const l of b.bullets) out.push(...l.ranges)
    }
  }
  return out
}

function firstSentences(text: string, max: number) {
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  const end = cut.lastIndexOf('. ')
  return end > 60 ? cut.slice(0, end + 1) : `${cut.replace(/\s+\S*$/, '')}…`
}

// Where a transcript's 0:00 falls on a meeting's clock: a transcript of a copy trimmed at the start begins
// partway into the recording the notes are timed on.
export const offsetIn = (m: Meeting, transcriptId: string) => m.transcripts.find((t) => t.id === transcriptId)?.offset ?? 0

export function notesText(notes?: Notes): string {
  if (!notes) return ''
  return notes.sections
    .filter((s) => s.role !== 'source' && s.role !== 'caveats')
    .flatMap((s) => s.blocks.flatMap((b) => (b.kind === 'item' ? [b.title, ...b.bullets.map((l) => l.text)] : [b.text])))
    .join('\n')
}

// For a wall-clock transcript shared by two meetings, only the part inside this meeting's window counts.
function transcriptText(m: Meeting, transcripts: Map<string, TranscriptSource>): string {
  const src = m.primaryTranscript ? transcripts.get(m.primaryTranscript) : undefined
  if (!src) return ''
  const [a, b] = m.axis
  return src.parsed.segments
    .filter((s) => !s.q && (m.timeBase === 'offset' || (s.e >= a && s.s <= b)))
    .map((s) => s.t)
    .join(' ')
}

