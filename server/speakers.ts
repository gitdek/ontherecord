// Who is speaking on each transcript line. A background job (scripts/diarize.py: sherpa-onnx with pyannote
// segmentation and TitaNet voiceprints, run on this Mac) splits a meeting's recording into speaker turns, takes
// a voiceprint of each voice, checks each transcript line's own voice, and reads each voice's name off the
// Google Meet tile highlighted while it talks. Every line goes to the voice heard most while it was spoken.
// Names come from, in order: a person naming the voice, the Meet tile, the same voice named in another meeting
// (shown as a guess until someone confirms it), else "Speaker N". A transcript that came with the platform's
// own labels ("Speaker 3", from a caption export) keeps its lines' labels and has them named from the tiles of
// the videos it covers, timed by the meeting's clock sync. Voiceprints stay in DATA_DIR/speakers; the app and
// agents only ever see names.
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { access, copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { stillScanned, type FileEntry, type Library, type Meeting, type TranscriptSource } from './library.ts'
import { run } from './media.ts'
import type { People } from './people.ts'
import { isRecord, isString, listOf, optional, PersistedJson, Unreadable } from './persistence.ts'
import { shortHash } from './text.ts'
import type { Segment } from './transcripts.ts'

// results from an older scripts/diarize.py are redone
const VERSION = 1
// how alike two voiceprints must be to call them the same person: on our meetings the same person scores
// 0.8-0.98 across meetings, different people under 0.4 (scraps of crosstalk up to about 0.5)
const MATCH = 0.6
// a line's own voice overrides the turn it falls in when it is this alike to another main speaker, and this
// much more alike than to the turn's own (a quick "exactly" from someone else mid-turn)
const LINE_SURE = 0.45
const LINE_MARGIN = 0.25
// a line spoken between turns takes the nearest turn this close (seconds)
const SNAP = 1
const NAME_MAX = 60

export type Turn = [start: number, end: number, speaker: number]
// each line's voice against the main speakers': sims[line][k] is how alike it is to speakers[k]
export type LineVoices = { speakers: number[]; sims: (number[] | null)[] }
type Seen = { name: string; votes: number; of: number }
type Diarization = {
  turns: Turn[]
  speakers: Map<string, { seconds: number; voiceprint: number[] | null }>
  lines?: LineVoices
  screen: Map<string, Seen>
}
// a name someone gave a voice, with the voice's print so it can be recognised elsewhere, and the transcript it
// was given in (names saved before that was kept have none)
type Named = { name: string; by: string; at: string; voiceprint: number[] | null; transcript?: string }
// voices: tell a recording's voices apart (and name them); names: only read the names of speakers a caption
// export already labels, off the part of the call one video shows
type Job = { kind: 'voices'; file: FileEntry; key: string; lines: [number, number][] } | { kind: 'names'; file: FileEntry; key: string; turns: Turn[] }
// a transcript that came with speaker labels: the labels (numbered by their place here), the key their names
// are kept under, and a job per video of the call
type Labelled = { labels: string[]; key: string; jobs: Job[] }

// seen: read off the Meet tile (as written there, in so many of the moments looked at); match: a guess from
// the same voice in another meeting, this alike
export type Voice = { key: string; name: string; seconds: number; confirmed: boolean; by?: string; seen?: { as: string; votes: number; of: number }; match?: number }
// none: no recording with sound to listen to; off: no models. source labels: the voices are a caption
// export's own speaker labels
export type SpeakerView = { state: 'none' | 'off' | 'queued' | 'running' | 'failed' | 'done'; source?: 'labels'; voices?: Voice[]; error?: string }

export class SpeakerError extends Error {}

export type DiarizeConfig = { python: string; segmentation: string; embedding: string; script: string; readText: string }

// A transcript whose lines mostly carry speaker labels (a meeting platform's caption export) keeps them;
// "Unknown" is anyone the platform couldn't place, not one person.
const hasLabels = (segs: Segment[]) => segs.length > 0 && segs.filter((s) => s.sp).length >= segs.length / 2
const unknown = (label: string) => /^unknown\b/i.test(label)
// "Speaker 3" is what an unnamed voice is called, not a name to recognise anyone by
const placeholder = (name: string) => /^speaker \d+$/i.test(name)
const CUT = /\s*(?:\.\.\.|…)$/

export function cleanName(v: unknown): string {
  // a trailing "?" is how a guess is shown, so a name can't end in one; it goes after the cut to length, so a
  // name cleaned twice comes out as it did once
  return typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX).replace(/[?\s]+$/, '') : ''
}

// Results are kept per recording and transcript (the job checks each of the transcript's lines).
export function resultKey(f: FileEntry, segs: Segment[]) {
  return `${f.id}-${f.size.toString(36)}-${f.mtimeMs.toString(36)}-${shortHash(JSON.stringify(segs.map((s) => [s.s, s.e])), 8)}`
}

function cosine(a: number[], b: number[]) {
  if (a.length !== b.length) return 0
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i]
  return dot
}

// Letters to change, add or drop to turn one name into the other.
function edits(a: string, b: string) {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const next = [i]
    for (let j = 1; j <= b.length; j++) next.push(Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)))
    row = next
  }
  return row[b.length]
}

// Whether what follows a tile's first word ("hopper (presenting)") can be the rest of a known person's name
// ("hopper"): the same once anything in brackets and trailing punctuation are dropped, an initial or the start
// of it, or misread by a letter (two in a name of eight letters or more, none in one of two). With a middle name
// on one side, the last names decide. Someone the list knows by first name alone has nothing to tell apart by.
function fits(tile: string, known: string) {
  const tidy = (s: string) => s.replace(/[([{][^)\]}]*(?:[)\]}]|$)/g, ' ').replace(/[\s\p{P}]+$/u, '').replace(/\s+/g, ' ').trim()
  const close = (a: string, b: string) => b.startsWith(a) || edits(a, b) <= (b.length < 3 ? 0 : b.length < 8 ? 1 : 2)
  const last = (s: string) => s.slice(s.lastIndexOf(' ') + 1)
  const a = tidy(tile)
  const b = tidy(known)
  return !a || !b || close(a, b) || ((a.includes(' ') || b.includes(' ')) && close(last(a), last(b)))
}

// The voice heard most while each line was spoken (undefined for silence or when nobody was heard nearby),
// unless the line's own voice clearly belongs to someone else.
export function speakerPerLine(segs: Segment[], turns: Turn[], lines?: LineVoices): (number | undefined)[] {
  const longest = turns.reduce((n, t) => Math.max(n, t[1] - t[0]), 0)
  const own = lines?.sims.length === segs.length ? lines : undefined
  return segs.map((s, i) => {
    if (s.q) return undefined
    // turns are in start order: only those starting after (line start - longest turn) can reach this line
    let lo = 0
    let hi = turns.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (turns[mid][0] < s.s - longest - SNAP) lo = mid + 1
      else hi = mid
    }
    const heard = new Map<number, number>()
    let near: { gap: number; who: number } | undefined
    for (let k = lo; k < turns.length && turns[k][0] <= s.e + SNAP; k++) {
      const [a, b, who] = turns[k]
      const overlap = Math.min(b, s.e) - Math.max(a, s.s)
      if (overlap > 0) heard.set(who, (heard.get(who) ?? 0) + overlap)
      else if (-overlap <= SNAP && (!near || -overlap < near.gap)) near = { gap: -overlap, who }
    }
    let who: number | undefined
    for (const [w, secs] of heard) if (who === undefined || secs > heard.get(who)!) who = w
    who ??= near?.who
    const sims = own?.sims[i]
    if (own && sims?.length) {
      const top = sims.indexOf(Math.max(...sims))
      const theirs = who === undefined ? 0 : (sims[own.speakers.indexOf(who)] ?? 0)
      if (own.speakers[top] !== who && sims[top] >= LINE_SURE && sims[top] - theirs >= LINE_MARGIN) who = own.speakers[top]
    }
    return who
  })
}

function parse(raw: unknown): Diarization | undefined {
  const d = raw as { version?: unknown; turns?: unknown; speakers?: unknown; lines?: { speakers?: unknown; sims?: unknown }; screen?: unknown }
  if (!d || d.version !== VERSION || !Array.isArray(d.turns) || !d.speakers || typeof d.speakers !== 'object') return
  const speakers = new Map<string, { seconds: number; voiceprint: number[] | null }>()
  for (const [k, v] of Object.entries(d.speakers as Record<string, { seconds?: unknown; voiceprint?: unknown }>)) {
    if (!/^\d{1,3}$/.test(k) || !v) continue
    const vp = Array.isArray(v.voiceprint) && v.voiceprint.every(Number.isFinite) ? (v.voiceprint as number[]) : null
    speakers.set(k, { seconds: Number(v.seconds) || 0, voiceprint: vp })
  }
  const turns = (d.turns as unknown[])
    .filter((t): t is Turn => Array.isArray(t) && t.length === 3 && t.every(Number.isFinite) && t[1] >= t[0] && speakers.has(String(t[2])))
    .sort((a, b) => a[0] - b[0])
  let lines: LineVoices | undefined
  const ls = d.lines
  if (ls && Array.isArray(ls.speakers) && ls.speakers.every((k) => speakers.has(String(k))) && Array.isArray(ls.sims)) {
    const n = ls.speakers.length
    lines = { speakers: ls.speakers as number[], sims: (ls.sims as unknown[]).map((x) => (Array.isArray(x) && x.length === n && x.every(Number.isFinite) ? (x as number[]) : null)) }
  }
  return { turns, speakers, lines, screen: seenOf(d.screen, (k) => speakers.has(k)) }
}

// Names read off the screen, by speaker: {"0": {"name": "Ada Lovelace", "votes": 5, "of": 6}, ...}
function seenOf(raw: unknown, ok: (key: string) => boolean) {
  const screen = new Map<string, Seen>()
  for (const [k, v] of Object.entries((raw && typeof raw === 'object' ? raw : {}) as Record<string, Partial<Seen>>)) {
    const name = cleanName(v?.name)
    if (/^\d{1,3}$/.test(k) && ok(k) && name) screen.set(k, { name, votes: Number(v.votes) || 0, of: Number(v.of) || 0 })
  }
  return screen
}

// The output of a names-only job (--turns): {"version": 1, "screen": {...}}
function parseNames(raw: unknown) {
  const d = raw as { version?: unknown; screen?: unknown } | undefined
  return d && d.version === VERSION ? seenOf(d.screen, () => true) : undefined
}

// With left, an entry that fails validation is left out and its key noted there, so the rest still load; without
// it (a backup's check), one such entry fails the whole file.
export function decodeSavedNames(value: unknown, left?: string[]): Map<string, Map<string, Named>> {
  if (!isRecord(value)) throw new Error('expected a speaker name map')
  const names = new Map<string, Map<string, Named>>()
  for (const [recording, voices] of Object.entries(value)) {
    if (!isRecord(voices)) {
      if (!left) throw new Error('invalid speaker recording record')
      left.push(recording)
      continue
    }
    const named = new Map<string, Named>()
    for (const [key, entry] of Object.entries(voices)) {
      if (!/^\d{1,3}$/.test(key) || !isRecord(entry) || !cleanName(entry.name) || !optional(entry.by, isString) ||
          !optional(entry.at, isString) || (entry.voiceprint != null && !listOf(entry.voiceprint, Number.isFinite)) ||
          !optional(entry.transcript, isString)) {
        if (!left) throw new Error('invalid saved speaker name or voiceprint')
        left.push(`${recording}/${key}`)
        continue
      }
      // Older records can omit attribution or a voiceprint.
      const { name, by = '', at = '', voiceprint = null } = entry as Partial<Named> & { name: string }
      named.set(key, { ...entry, name: cleanName(name), by, at, voiceprint })
    }
    names.set(recording, named)
  }
  return names
}

export class Speakers {
  enabled = false
  private dir: string
  private cfg: DiarizeConfig
  // ids: transcripts whose voices changed; relabel: their lines need new names (not just a new status)
  private onChange: (ids: string[], relabel: boolean) => void
  private localUser: string
  private people?: People
  private results = new Map<string, Diarization>() // result key → voices
  private read = new Map<string, Map<string, Seen>>() // names-only result key → label number → name off the screen
  private names = new Map<string, Map<string, Named>>() // result key (or labelled transcript's key) → speaker → name
  private failed = new Map<string, string>()
  private jobs = new Map<string, Job>() // transcript id → what its voices come from
  private labelled = new Map<string, Labelled>() // transcript id → its caption labels
  private originals = new WeakMap<TranscriptSource, Segment[]>()
  private queue: Job[] = []
  private running?: string
  private readonly namesFile: PersistedJson
  // why names can't be changed until a restart: the names file couldn't be read, or copied aside when some of
  // its entries had to be left out
  private refused?: string
  // the names file holds just what a save writes, so noting transcripts on older names changes nothing else
  private asSaved = false

  constructor(dataDir: string, cfg: DiarizeConfig, onChange: (ids: string[], relabel: boolean) => void, localUser = 'Owner') {
    this.dir = join(dataDir, 'speakers')
    // damaged names are set aside rather than keeping the whole archive offline; they can be typed again
    this.namesFile = new PersistedJson(join(this.dir, 'names.json'), 'speaker names', () => onChange(this.diarized(), true), 'aside')
    this.cfg = cfg
    this.onChange = onChange
    this.localUser = localUser
  }

  async load() {
    this.refused = undefined
    this.asSaved = false
    const left: string[] = []
    let read: unknown
    try {
      this.names = (await this.namesFile.load((value) => decodeSavedNames((read = value), left))) ?? new Map()
      this.asSaved = read !== undefined && JSON.stringify(read) === this.snapshot()
    } catch (err) {
      if (!(err instanceof Unreadable)) throw err
      // names can be typed again, so they don't keep the archive offline; nor is the file written over
      console.error(`${err.message}; started without them, and every change to them is refused until the file is fixed and the server restarted`)
      this.names = new Map()
      this.refused = "the speaker names file couldn't be read when the server started, so names can't be changed until it is fixed and the server restarted"
    }
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    if (left.length) await this.leaveOut(left)
    if (!this.cfg.python) return
    try {
      await Promise.all([this.cfg.python, this.cfg.segmentation, this.cfg.embedding, this.cfg.script].map((p) => access(p)))
      this.enabled = true
    } catch {
      console.warn('speakers: the diarization models or Python environment are missing (see README, "Who is speaking"); transcripts stay unattributed')
    }
  }

  // Saved entries that failed validation are left out and the rest load. The file as it was is copied aside once
  // and the names that loaded are written back, so the next start has nothing to leave out. Without that copy,
  // nothing is written over the file until a restart can make one.
  private async leaveOut(left: string[]) {
    const path = join(this.dir, 'names.json')
    const aside = `${path}.corrupt-${Date.now()}-${randomUUID()}`
    const what = `speaker names: left out ${left.length} saved ${left.length === 1 ? 'entry' : 'entries'} of ${path} that failed validation (${left.map((k) => JSON.stringify(k)).join(', ')})`
    try {
      await copyFile(path, aside, constants.COPYFILE_EXCL)
    } catch (err) {
      console.error(`${what}, and can't copy the file aside (${(err as Error).message}); started with the rest, and every change is refused until it is fixed and the server restarted`)
      this.refused = "some saved speaker names couldn't be loaded or copied aside, so names can't be changed until the file is fixed and the server restarted"
      return
    }
    console.error(`${what}; preserved the original at ${aside}`)
    await this.save().then(
      () => (this.asSaved = true),
      (err) => console.error(`speaker names: couldn't write back the names that loaded (${(err as Error).message}); the next change tries again`),
    )
  }

  // Which recording each transcript is told apart from (a linked copy with sound, the lightest one), and
  // queue the ones not done yet, newest meeting first. syncOf: a meeting's confirmed clock sync, if any.
  async plan(lib: Library, syncOf: (meetingId: string) => number | undefined = () => undefined) {
    this.people = lib.people
    this.jobs.clear()
    this.labelled.clear()
    for (const m of lib.meetings) {
      for (const t of m.transcripts) {
        const src = lib.transcripts.get(t.id)
        const segs = src && (this.originals.get(src) ?? src.parsed.segments)
        if (!src || !segs) continue
        if (hasLabels(segs)) {
          this.planLabels(lib, m, src, segs, src.parsed.timeBase === 'clock' ? (syncOf(m.id) ?? m.syncSuggestion?.offset) : 0)
          continue
        }
        if (src.parsed.timeBase !== 'offset' || this.jobs.has(t.id)) continue
        const v = m.videos.filter((x) => x.transcriptId === t.id && x.synced && x.probe?.hasAudio && !x.growing).sort((a, b) => a.size - b.size)[0]
        const file = v && lib.files.get(v.fileId)
        if (file) this.jobs.set(t.id, { kind: 'voices', file, key: resultKey(file, segs), lines: segs.map((s) => [s.s, s.e]) })
      }
    }
    for (const job of [...this.jobs.values(), ...[...this.labelled.values()].flatMap((l) => l.jobs)]) {
      if (!this.done(job)) {
        const raw = await readFile(join(this.dir, `${job.key}.json`), 'utf8').then(JSON.parse, () => undefined)
        if (job.kind === 'voices') {
          const d = parse(raw)
          if (d) this.results.set(job.key, d)
        } else {
          const names = parseNames(raw)
          if (names) this.read.set(job.key, names)
        }
      }
      if (this.enabled && !this.done(job) && !this.failed.has(job.key)) this.enqueue(job)
    }
    await this.note()
  }

  // Names a person gave before names kept their transcript get it once their key is a transcript's current one
  // (a key two transcripts share is left alone), so they carry over when its recording changes. Nothing else
  // in an entry changes. One save covers them all, and only a file that holds just what a save writes is saved
  // now; otherwise they go with the next change, as do they if this save fails, which leaves the file as it was.
  private async note() {
    const transcriptOf = new Map<string, string | null>()
    for (const [id, job] of this.jobs) transcriptOf.set(job.key, transcriptOf.has(job.key) ? null : id)
    let noted = 0
    for (const [key, id] of transcriptOf) {
      if (!id) continue
      for (const n of this.names.get(key)?.values() ?? []) {
        if (n.transcript !== undefined) continue
        n.transcript = id
        noted++
      }
    }
    if (!noted || !this.asSaved || this.refused) return
    await this.save().then(
      () => console.log(`speaker names: noted the transcript on ${noted} ${noted === 1 ? 'name' : 'names'} saved before names kept it`),
      (err) => console.error(`speaker names: couldn't note the transcript on ${noted} older ${noted === 1 ? 'name' : 'names'} (${(err as Error).message}); the file is as it was, and the next change saves them`),
    )
  }

  // A caption export names nobody ("Speaker 3"), but a video of the call shows whose tile lights up while each
  // label talks. Each meeting using the transcript adds its video, placed on the transcript's clock by the
  // meeting's sync (confirmed, else suggested from the recording's filename).
  private planLabels(lib: Library, m: Meeting, src: TranscriptSource, segs: Segment[], shift: number | undefined) {
    let plan = this.labelled.get(src.id)
    if (!plan) {
      const labels = [...new Set(segs.flatMap((s) => (s.sp && !unknown(s.sp) ? [s.sp] : [])))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      plan = { labels, key: `${src.id}-${shortHash(labels.join('\n'), 8)}`, jobs: [] }
      this.labelled.set(src.id, plan)
    }
    const v = m.videos.filter((x) => x.probe?.duration && !x.growing).sort((a, b) => a.size - b.size)[0]
    const file = v && lib.files.get(v.fileId)
    if (shift === undefined || !file) return
    const length = v.probe!.duration!
    const turns = segs.flatMap((s): Turn[] => {
      const k = plan.labels.indexOf(s.sp ?? '')
      return k >= 0 && s.s - shift >= 0 && s.e - shift <= length ? [[s.s - shift, s.e - shift, k]] : []
    })
    const key = `${file.id}-${file.size.toString(36)}-${file.mtimeMs.toString(36)}-${shortHash(JSON.stringify(turns), 8)}`
    if (turns.length && !plan.jobs.some((j) => j.key === key)) plan.jobs.push({ kind: 'names', file, key, turns })
  }

  private done = (job: Job) => (job.kind === 'voices' ? this.results.has(job.key) : this.read.has(job.key))

  // Put speakers on transcript lines. Always starts from the lines as parsed, so it can run again whenever a
  // name changes.
  apply(lib: Library) {
    for (const [id, job] of this.jobs) {
      const src = lib.transcripts.get(id)
      const d = this.results.get(job.key)
      if (!src || !d) continue
      const original = this.originals.get(src) ?? src.parsed.segments
      this.originals.set(src, original)
      const voices = new Map(this.voices(id, job.key, d).map((v) => [Number(v.key), v]))
      const who = speakerPerLine(original, d.turns, d.lines)
      // a guessed name carries its "?" everywhere it goes (captions, search passages, agents)
      const label = (v: Voice) => (v.match !== undefined ? `${v.name}?` : v.name)
      src.parsed = { ...src.parsed, segments: original.map((s, i) => (who[i] === undefined || s.sp ? s : { ...s, sp: label(voices.get(who[i]!)!), spk: who[i] })) }
    }
    for (const [id, plan] of this.labelled) {
      const src = lib.transcripts.get(id)
      if (!src) continue
      const original = this.originals.get(src) ?? src.parsed.segments
      this.originals.set(src, original)
      const voices = this.labelVoices(plan, original)
      src.parsed = {
        ...src.parsed,
        segments: original.map((s) => {
          const k = plan.labels.indexOf(s.sp ?? '')
          return k < 0 ? s : { ...s, sp: voices[k].name, spk: k }
        }),
      }
    }
  }

  view(src: TranscriptSource): SpeakerView {
    const plan = this.labelled.get(src.id)
    if (plan) {
      const voices = this.labelVoices(plan, this.originals.get(src) ?? src.parsed.segments)
      const busy = this.enabled ? plan.jobs.find((j) => !this.done(j) && !this.failed.has(j.key)) : undefined
      return { state: busy ? (this.running === busy.key ? 'running' : 'queued') : 'done', source: 'labels', voices }
    }
    const job = this.jobs.get(src.id)
    if (!job) return { state: 'none' }
    const d = this.results.get(job.key)
    if (d) return { state: 'done', voices: this.voices(src.id, job.key, d) }
    if (!this.enabled) return { state: 'off' }
    if (this.failed.has(job.key)) return { state: 'failed', error: this.failed.get(job.key) }
    return { state: this.running === job.key ? 'running' : 'queued' }
  }

  // Every name a voice has had so far, for suggestions.
  known(): string[] {
    return [...new Set([...this.prints('').values()].map((p) => p.name))].sort((a, b) => a.localeCompare(b))
  }

  // Name one voice of a transcript (an empty name goes back to the automatic one). Returns whether anything changed.
  async rename(src: TranscriptSource, speaker: string, name: unknown, by: string): Promise<boolean> {
    if (this.refused) throw new SpeakerError(this.refused)
    this.namesFile.assertWritable()
    const plan = this.labelled.get(src.id)
    const job = this.jobs.get(src.id)
    const d = job && this.results.get(job.key)
    const key = plan?.key ?? (d ? job!.key : undefined)
    if (!key) throw new SpeakerError("this transcript's voices haven't been worked out yet")
    const known = /^\d{1,3}$/.test(speaker) && (plan ? Number(speaker) < plan.labels.length : d!.speakers.has(speaker))
    if (!known) throw new SpeakerError('no such speaker in this transcript')
    const clean = cleanName(name)
    // only an empty name goes back to the automatic one
    if (!clean && typeof name === 'string' && name.trim()) {
      throw new SpeakerError(`that name is empty once trailing question marks (how a guess is shown), control characters and anything past ${NAME_MAX} characters are taken out`)
    }
    const mine = this.names.get(key) ?? new Map<string, Named>()
    const voiceprint = plan ? null : d!.speakers.get(speaker)!.voiceprint
    // the voice's name can be one carried over from an earlier key of this transcript
    const carried = plan ? undefined : this.carried(src.id, key, d!).get(speaker)
    if ((mine.get(speaker)?.name ?? carried?.name ?? '') === clean) {
      await this.namesFile.flush()
      return false
    }
    if (clean) mine.set(speaker, { name: clean, by, at: new Date().toISOString(), voiceprint, transcript: src.id })
    else {
      mine.delete(speaker)
      // back to the automatic name: what an earlier key of this transcript would carry over to the voice goes too
      if (voiceprint) this.forget(src.id, key, voiceprint)
    }
    if (mine.size) this.names.set(key, mine)
    else this.names.delete(key)
    await this.save()
    return true
  }

  // Transcripts with voices worked out or labelled (a rename can change the guesses on any of them).
  diarized = () => [...[...this.jobs].filter(([, job]) => this.results.has(job.key)).map(([id]) => id), ...this.labelled.keys()]

  // How a name read off a Meet tile is shown: "Ada Lovelace" as the people list knows her ("Ada"), a name the
  // tile cut short ("Grace Hopp...") as the one person it can be, "You" as whoever made the recording. A tile
  // whose first word is a known person's first name is that person when the rest fits the rest of their name
  // ("Grace H.", "Grace Hopper (Presenting)"). Any other name the list doesn't know goes by its first word, unless
  // a known person or another name read on the call (others) goes by that too: a guest "Grace Kim" keeps her
  // whole name rather than read as the Grace the archive knows.
  private short(raw: string, others: string[] = []): string {
    if (/^you$/i.test(raw)) return this.localUser
    const people = [...(this.people?.byId.values() ?? [])]
    const cut = CUT.test(raw)
    const stem = raw.replace(CUT, '').toLowerCase()
    const whole = people.filter((p) => (cut ? p.name.toLowerCase().startsWith(stem) : p.name.toLowerCase() === stem))
    if (whole.length === 1) return whole[0].short
    const [first, ...rest] = stem.split(' ')
    const sharedBy = (other: string) => {
      const s = other.replace(CUT, '').toLowerCase()
      return s !== stem && s.split(' ')[0] === first
    }
    if (rest.length) {
      const theirs = people.filter((p) => p.aliases.includes(first) && fits(rest.join(' '), p.name.toLowerCase().split(/\s+/).slice(1).join(' ')))
      if (theirs.length === 1) return theirs[0].short
      if (people.some((p) => p.aliases.includes(first)) || others.some(sharedBy)) return raw
    }
    const byFirst = cut ? [] : people.filter((p) => p.aliases.includes(first))
    if (byFirst.length === 1) return byFirst[0].short
    return raw.replace(CUT, '').split(' ')[0]
  }

  // Every named voice outside one result: named by someone, or read off its Meet tile (only where the tile
  // named a single voice in that recording; see screenNames).
  private prints(except: string) {
    const out = new Map<string, { name: string; prints: number[][] }>()
    const add = (name: string, vp: number[] | null | undefined) => {
      if (placeholder(name)) return
      const p = out.get(name.toLowerCase()) ?? { name, prints: [] }
      if (vp) p.prints.push(vp)
      out.set(name.toLowerCase(), p)
    }
    for (const [key, voices] of this.names) if (key !== except) for (const n of voices.values()) add(n.name, n.voiceprint)
    for (const [key, d] of this.results) {
      if (key === except) continue
      const reads = [...d.screen.values()].map((s) => s.name)
      const read = [...d.screen].filter(([spk]) => !this.names.get(key)?.has(spk)).map(([spk, s]) => [spk, this.short(s.name, reads)] as const)
      for (const [spk, name] of read) if (read.filter(([, n]) => n.toLowerCase() === name.toLowerCase()).length === 1) add(name, d.speakers.get(spk)?.voiceprint)
    }
    return out
  }

  // The names read off Meet tiles, checked against the voices. People sharing a microphone share a tile, so
  // a name read for several voices goes to the one that sounds like that person in other meetings (else the
  // one read most often), and a name is dropped when the voice clearly belongs to someone else.
  private screenNames(d: Diarization, mine: Map<string, Named>, prints: Map<string, { name: string; prints: number[][] }>) {
    const alike = (spk: string, lower: string) => {
      const vp = d.speakers.get(spk)?.voiceprint
      const p = prints.get(lower)
      return vp && p?.prints.length ? Math.max(...p.prints.map((x) => cosine(x, vp))) : undefined
    }
    const reads = [...d.screen.values()].map((s) => s.name)
    const byName = new Map<string, string[]>()
    for (const spk of d.screen.keys()) {
      if (mine.has(spk)) continue
      const lower = this.short(d.screen.get(spk)!.name, reads).toLowerCase()
      byName.set(lower, [...(byName.get(lower) ?? []), spk])
    }
    const out = new Map<string, Seen & { short: string }>()
    for (const [lower, spks] of byName) {
      const spk = spks.sort((a, b) => (alike(b, lower) ?? -1) - (alike(a, lower) ?? -1) || d.screen.get(b)!.votes - d.screen.get(a)!.votes)[0]
      const own = alike(spk, lower)
      const elsewhere = [...prints.keys()].some((other) => other !== lower && (alike(spk, other) ?? 0) >= MATCH)
      if (own !== undefined && own < 0.4 && elsewhere) continue
      out.set(spk, { ...d.screen.get(spk)!, short: this.short(d.screen.get(spk)!.name, reads) })
    }
    return out
  }

  // What a person named this transcript's voices under its earlier keys (the recording was touched, moved or
  // re-encoded, a lighter copy took over, the transcript was redone): each voice without a name under the
  // current key takes the newest such name whose voiceprint matches it. Names from other transcripts stay guesses.
  private carried(transcript: string, key: string, d: Diarization): Map<string, Named> {
    const earlier = [...this.names].flatMap(([k, voices]) => (k === key ? [] : [...voices.values()].filter((n) => n.transcript === transcript && n.voiceprint)))
    const out = new Map<string, Named>()
    for (const [spk, v] of d.speakers) {
      if (this.names.get(key)?.has(spk) || !v.voiceprint) continue
      let best: Named | undefined
      for (const n of earlier) if (cosine(n.voiceprint!, v.voiceprint) >= MATCH && (!best || n.at > best.at)) best = n
      if (best) out.set(spk, best)
    }
    return out
  }

  // Drop the names that would carry over to this voice from the transcript's earlier keys.
  private forget(transcript: string, key: string, voiceprint: number[]) {
    for (const [k, voices] of this.names) {
      if (k === key) continue
      for (const [spk, n] of voices) {
        if (n.transcript !== transcript || !n.voiceprint || cosine(n.voiceprint, voiceprint) < MATCH) continue
        voices.delete(spk)
        if (!voices.size) this.names.delete(k)
      }
    }
  }

  // Names for one result's voices: what someone called each (here or under the transcript's earlier keys), else
  // the name on its Meet tile, else the closest named voice from another meeting (each person at most once), else
  // "Speaker N".
  private voices(transcript: string, key: string, d: Diarization): Voice[] {
    const mine = new Map([...this.carried(transcript, key, d), ...(this.names.get(key) ?? [])])
    const prints = this.prints(key)
    const seen = this.screenNames(d, mine, prints)
    const own = (spk: string) => mine.get(spk)?.name ?? seen.get(spk)?.short
    const taken = new Set([...d.speakers.keys()].flatMap((spk) => own(spk)?.toLowerCase() ?? []))
    const guesses: { spk: string; name: string; score: number }[] = []
    for (const [spk, v] of d.speakers) {
      if (own(spk) || !v.voiceprint) continue
      for (const [lower, p] of prints) {
        if (taken.has(lower) || !p.prints.length) continue
        const score = Math.max(...p.prints.map((x) => cosine(x, v.voiceprint!)))
        if (score >= MATCH) guesses.push({ spk, name: p.name, score })
      }
    }
    const guessed = new Map<string, { name: string; score: number }>()
    for (const g of guesses.sort((a, b) => b.score - a.score)) {
      if (guessed.has(g.spk) || taken.has(g.name.toLowerCase())) continue
      guessed.set(g.spk, g)
      taken.add(g.name.toLowerCase())
    }
    return [...d.speakers].map(([spk, v]) => {
      const named = mine.get(spk)
      const tile = seen.get(spk)
      const guess = named || tile ? undefined : guessed.get(spk)
      return {
        key: spk,
        name: own(spk) ?? guess?.name ?? `Speaker ${Number(spk) + 1}`,
        seconds: v.seconds,
        confirmed: Boolean(named),
        ...(named ? { by: named.by } : {}),
        ...(tile && !named ? { seen: { as: tile.name, votes: tile.votes, of: tile.of } } : {}),
        ...(guess ? { match: Math.round(guess.score * 100) / 100 } : {}),
      }
    })
  }

  // Names for a caption export's labels: what someone called each, else the name read off the tile that lit
  // up while it talked (adding up the reads from every video of the call), else the label itself.
  private labelVoices(plan: Labelled, segs: Segment[]): Voice[] {
    const mine = this.names.get(plan.key) ?? new Map<string, Named>()
    return plan.labels.map((label, i) => {
      const key = String(i)
      const reads = new Map<string, Seen>()
      for (const job of plan.jobs) {
        const s = this.read.get(job.key)?.get(key)
        if (!s) continue
        const before = reads.get(s.name.toLowerCase())
        reads.set(s.name.toLowerCase(), { name: s.name, votes: (before?.votes ?? 0) + s.votes, of: (before?.of ?? 0) + s.of })
      }
      const seen = [...reads.values()].sort((a, b) => b.votes - a.votes)[0]
      const named = mine.get(key)
      // the names read for the call's other labels
      const others = plan.labels.flatMap((_, j) => (j === i ? [] : plan.jobs.flatMap((job) => this.read.get(job.key)?.get(String(j))?.name ?? [])))
      return {
        key,
        name: named?.name ?? (seen ? this.short(seen.name, others) : label),
        seconds: Math.round(segs.reduce((n, s) => n + (s.sp === label ? s.e - s.s : 0), 0) * 10) / 10,
        confirmed: Boolean(named),
        ...(named ? { by: named.by } : {}),
        ...(seen && !named ? { seen: { as: seen.name, votes: seen.votes, of: seen.of } } : {}),
      }
    })
  }

  private snapshot() {
    return JSON.stringify(Object.fromEntries([...this.names].map(([key, voices]) => [key, Object.fromEntries(voices)])))
  }

  private save() {
    return this.namesFile.save(this.snapshot())
  }

  private enqueue(job: Job) {
    if (this.running === job.key || this.queue.some((q) => q.key === job.key)) return
    this.queue.push(job)
    void this.drain()
  }

  private transcriptsOf = (key: string) => [
    ...[...this.jobs].filter(([, job]) => job.key === key).map(([id]) => id),
    ...[...this.labelled].filter(([, plan]) => plan.jobs.some((j) => j.key === key)).map(([id]) => id),
  ]

  // One recording at a time, at low priority: about 4 minutes of work per hour of audio on an M-series Mac.
  private async drain() {
    if (this.running) return
    for (let job = this.queue.shift(); job; job = this.queue.shift()) {
      const { file: f, key } = job
      if (this.done(job)) continue
      this.running = key
      this.onChange(this.transcriptsOf(key), false)
      const started = Date.now()
      // the transcript's lines, or (names only) who spoke when on the video's timeline
      const given = join(this.dir, `${key}.${job.kind === 'voices' ? 'lines' : 'turns'}.json`)
      try {
        await stillScanned(f)
        await writeFile(given, JSON.stringify(job.kind === 'voices' ? job.lines : job.turns), { mode: 0o600 })
        const args = ['-n', '15', this.cfg.python, '-I', this.cfg.script, '--segmentation', this.cfg.segmentation, '--embedding', this.cfg.embedding, '--input', f.path, job.kind === 'voices' ? '--lines' : '--turns', given]
        if (this.cfg.readText) args.push('--read-text', this.cfg.readText)
        // the job only needs to find ffmpeg and swift; it gets none of the server's settings or keys
        const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '', TMPDIR: process.env.TMPDIR ?? '/tmp', LANG: 'en_US.UTF-8' }
        const raw = await run('nice', args, 3 * 3600_000, 32_000_000, env)
        const out = JSON.parse(raw.toString())
        const d = job.kind === 'voices' ? parse(out) : undefined
        const names = job.kind === 'names' ? parseNames(out) : undefined
        if (!d && !names) throw new Error('the diarization script returned something unexpected')
        const path = join(this.dir, `${key}.json`)
        await writeFile(`${path}.tmp`, raw, { mode: 0o600 })
        await rename(`${path}.tmp`, path)
        const secs = Math.round((Date.now() - started) / 1000)
        if (d) {
          this.results.set(key, d)
          console.log(`speakers: ${f.name}: ${d.speakers.size} voices${d.screen.size ? `, ${d.screen.size} named from the screen` : ''} in ${secs}s`)
        } else {
          this.read.set(key, names!)
          console.log(`speakers: ${f.name}: ${names!.size} caption speakers named from the screen in ${secs}s`)
        }
      } catch (err) {
        this.failed.set(key, (err as Error).message.slice(0, 300))
        console.warn(`speakers: couldn't ${job.kind === 'voices' ? 'tell the voices apart' : 'read the speakers\' names'} in ${f.name}: ${(err as Error).message.slice(0, 300)}`)
      } finally {
        this.running = undefined
        await rm(given, { force: true })
      }
      this.onChange(this.transcriptsOf(key), this.done(job))
    }
  }
}
