// Writes a transcript for a recording that has none. The sound is taken out with FFmpeg, heard by a speech
// model on this Mac (scripts/transcribe.py, MLX Whisper), and the result is placed beside the recording as
// "<name> - transcript.txt" and ".json", where the library finds it like any transcript someone put there.
// Off unless TRANSCRIBE_PYTHON names a Python that has mlx_whisper. One recording at a time, at low priority,
// and nothing is downloaded: the model has to be on this Mac already.
import { access, lstat, mkdir, readdir, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { classify, openScanned, type FileEntry, type Library, type Meeting, type Video } from './library.ts'
import { run } from './media.ts'
import { placeBeside, type NewFile } from './place.ts'
import { stripExt } from './text.ts'

export type TranscribeConfig = { python: string; script: string; model: string; language: string }
// where a transcript the server is writing stands; nothing at all once it is in the folder
export type Writing = { state: 'queued' | 'running' | 'failed'; error?: string }
export type Heard = { language: string; segments: { id: number; start: number; end: number; text: string; no_speech_prob?: number; avg_logprob?: number }[] }

// heard: the copy whose sound is taken; named: the copy the transcript says it is timed against, the one the
// player plays (the same file, unless that copy has no sound and another copy of the same length does)
type Job = { meetingId: string; heard: FileEntry; named: FileEntry; key: string; title: string; duration: number }

// a recording shorter than this has nothing worth a transcript
const SHORTEST = 5
const INPUT = ['-protocol_whitelist', 'file', '-format_whitelist', 'mov,matroska,webm,mp3,wav,aac,ogg,flac']
const VIDEO = /\.(mp4|m4v|mov|webm|mkv)$/i

const clock = (t: number) => {
  const s = Math.max(0, Math.floor(t))
  return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map((n) => String(n).padStart(2, '0')).join(':')
}

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  )

// Where the model lives: a folder named in TRANSCRIBE_MODEL, or a model's folder in the Hugging Face cache.
export function modelPath(model: string, env: NodeJS.ProcessEnv = process.env) {
  if (isAbsolute(model)) return model
  const hub = env.HF_HUB_CACHE || join(env.HF_HOME || join(env.HOME || homedir(), '.cache', 'huggingface'), 'hub')
  return join(hub, `models--${model.split('/').join('--')}`)
}

// What the script printed, taken apart with care: it is a model's output, so nothing in it is assumed.
export function readHeard(raw: string): Heard {
  const data = JSON.parse(raw) as { language?: unknown; segments?: unknown }
  if (!data || typeof data !== 'object' || !Array.isArray(data.segments)) throw new Error('the speech model returned something unexpected')
  const segments: Heard['segments'] = []
  for (const s of data.segments as Record<string, unknown>[]) {
    const text = typeof s?.text === 'string' ? s.text.replace(/\s+/g, ' ').trim() : ''
    const start = Number(s?.start)
    const end = Number(s?.end)
    if (!text || !Number.isFinite(start) || !Number.isFinite(end) || start < 0) continue
    const seg: Heard['segments'][number] = { id: segments.length, start, end: Math.max(end, start), text: ` ${text}` }
    for (const key of ['no_speech_prob', 'avg_logprob'] as const) if (Number.isFinite(s[key])) seg[key] = s[key] as number
    segments.push(seg)
  }
  return { language: typeof data.language === 'string' ? data.language.slice(0, 20) : '', segments }
}

// The names a recording's transcript goes by: "<recording> - transcript.txt" and ".json", unless the recording's
// own name would make those read as something else (one called "Release notes" would give notes) or run too long.
// Then they go by the recording's id; the text file names the recording either way.
export function transcriptNames(file: FileEntry): [txt: string, json: string] {
  const named = (stem: string): [string, string] => [`${stem} - transcript.txt`, `${stem} - transcript.json`]
  const own = named(stripExt(file.name))
  return own.every((n) => classify(n) === 'transcript' && Buffer.byteLength(n) <= 240) ? own : named(`Transcript ${file.id}`)
}

// The two files a transcript is kept as: the text a person can read, which also names its recording, and the
// JSON with the finer times.
export function transcriptFiles(file: FileEntry, title: string, duration: number, heard: Heard, model: string): NewFile[] {
  const [txt, json] = transcriptNames(file)
  const text = [
    `MACHINE TRANSCRIPT: ${title}`,
    `Source ${VIDEO.test(file.name) ? 'video' : 'recording'}: ${file.name}`,
    `Duration: ${duration.toFixed(1)} seconds`,
    `Written on this Mac by On the Record with ${model}. Words can be misheard.`,
    '',
    ...heard.segments.map((s) => `[${clock(s.start)} - ${clock(s.end)}] ${s.text.trim()}`),
    '',
  ].join('\n')
  return [
    { name: txt, text },
    { name: json, text: `${JSON.stringify({ language: heard.language, source: file.name, model, segments: heard.segments })}\n` },
  ]
}

// What a failed step said, in a line: the command's own words, without the runner's "nice exited 1:".
const why = (step: string, err: unknown) => {
  const said = (err as Error).message.replace(/^nice exited (?:\d+|null):\s*/, '').replace(/\s+/g, ' ').trim()
  return `${step}: ${/^nice exited null/.test((err as Error).message) ? 'it ran too long and was stopped' : said || 'it stopped without saying why'}`
}

export class Transcriber {
  enabled = false
  // why it is off although TRANSCRIBE_PYTHON is set: the Python, mlx_whisper or the model isn't on this Mac
  problem?: string
  private dir: string
  private cfg: TranscribeConfig
  // a transcript started or stopped for these meetings; placed: its files are in the folder now
  private onChange: (meetingIds: string[], placed: boolean) => void
  private queue: Job[] = []
  private running?: Job
  private stopping?: AbortController
  // why a recording's transcript could not be made, by job key; tried again after a restart or when the file changes
  private failed = new Map<string, string>()
  // the job each meeting without a transcript is waiting on, as of the last plan
  private wanted = new Map<string, Job>()

  constructor(dataDir: string, cfg: TranscribeConfig, onChange: (meetingIds: string[], placed: boolean) => void) {
    this.dir = join(dataDir, 'transcribe')
    this.cfg = cfg
    this.onChange = onChange
  }

  // The job finds FFmpeg and the model on this Mac. It gets none of the server's settings or keys, and may not
  // fetch anything: HF_HUB_OFFLINE keeps the model loader off the network.
  private env(): NodeJS.ProcessEnv {
    const cache = Object.fromEntries((['HF_HOME', 'HF_HUB_CACHE'] as const).flatMap((k) => (process.env[k] ? [[k, process.env[k]]] : [])))
    return { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? homedir(), TMPDIR: process.env.TMPDIR ?? '/tmp', LANG: 'en_US.UTF-8', ...cache, HF_HUB_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1' }
  }

  async load() {
    this.enabled = false
    this.problem = undefined
    if (!this.cfg.python) return
    this.problem = await this.check()
    if (this.problem) {
      console.warn(`transcripts: ${this.problem}, so recordings without a transcript stay as they are`)
      return
    }
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    // sound left by a job the last run did not finish
    for (const name of await readdir(this.dir).catch(() => [])) if (name.endsWith('.wav')) await rm(join(this.dir, name), { force: true })
    this.enabled = true
  }

  // What stops the job running on this Mac, if anything does.
  private async check(): Promise<string | undefined> {
    if (!(await exists(this.cfg.python))) return `${this.cfg.python}, the Python that TRANSCRIBE_PYTHON names, isn't there`
    if (!(await exists(this.cfg.script))) return 'scripts/transcribe.py is missing'
    const has = await run(this.cfg.python, ['-I', this.cfg.script, '--check'], 30_000, 65_536, this.env()).then(() => true, () => false)
    if (!has) return `${this.cfg.python} has no mlx_whisper (pip install mlx-whisper)`
    if (!(await exists(modelPath(this.cfg.model, this.env())))) return `the model ${this.cfg.model} isn't on this Mac (it is never downloaded by the server)`
  }

  // The recording to hear: the copy the player plays, or when that one has no sound, the lightest copy of the same
  // length that has. A copy still being written, or one ffprobe couldn't read, waits.
  private jobFor(lib: Library, m: Meeting): Job | undefined {
    const shown = m.videos.find((v) => v.isDefault)
    const length = shown?.probe?.duration
    if (!shown || !length || shown.growing) return
    const hearable = (v: Video) => Boolean(v.probe?.hasAudio) && !v.growing && !v.failed && Math.abs((v.probe!.duration ?? 0) - length) <= Math.max(2, length * 0.02)
    const v = hearable(shown) ? shown : m.videos.filter(hearable).sort((a, b) => a.size - b.size)[0]
    const heard = v && lib.files.get(v.fileId)
    const named = lib.files.get(shown.fileId)
    if (!heard || !named || length < SHORTEST) return
    return { meetingId: m.id, heard, named, key: `${heard.id}-${heard.size.toString(36)}-${heard.mtimeMs.toString(36)}`, title: m.title, duration: length }
  }

  // Queue every recording that has no transcript, newest first. A meeting meetings-index.json lists keeps the
  // files the index gives it, so it is left to whoever keeps the index. A job whose meeting got a transcript
  // meanwhile, from anyone, is dropped, and stopped if it is running.
  plan(lib: Library) {
    this.wanted.clear()
    if (!this.enabled) return
    for (const m of lib.meetings) {
      if (m.transcripts.length || m.fromIndex) continue
      const job = this.jobFor(lib, m)
      if (job) this.wanted.set(m.id, job)
    }
    const keys = new Set([...this.wanted.values()].map((j) => j.key))
    this.queue = this.queue.filter((q) => keys.has(q.key))
    if (this.running && !keys.has(this.running.key)) this.stopping?.abort()
    for (const job of this.wanted.values()) if (!this.failed.has(job.key)) this.enqueue(job)
  }

  view(meetingId: string): Writing | undefined {
    const job = this.wanted.get(meetingId)
    if (!job) return
    if (this.running?.key === job.key) return { state: 'running' }
    const error = this.failed.get(job.key)
    if (error) return { state: 'failed', error }
    return this.queue.some((q) => q.key === job.key) ? { state: 'queued' } : undefined
  }

  // For the Lab: on or off (and why it is off when it was asked for), the model, and how many wait or failed.
  status() {
    const wanted = [...this.wanted.values()]
    return {
      enabled: this.enabled,
      ...(this.cfg.python ? { model: basename(this.cfg.model) } : {}),
      ...(this.problem ? { problem: this.problem } : {}),
      waiting: wanted.filter((j) => !this.failed.has(j.key)).length,
      writing: Boolean(this.running),
      failed: wanted.filter((j) => this.failed.has(j.key)).length,
    }
  }

  // The server is closing: the job running now stops, and the next start begins it again.
  stop() {
    this.queue = []
    this.stopping?.abort()
  }

  private enqueue(job: Job) {
    if (this.running?.key === job.key || this.queue.some((q) => q.key === job.key)) return
    this.queue.push(job)
    void this.drain()
  }

  // About a tenth of the recording's length on an M-series Mac with the turbo model.
  private async drain() {
    if (this.running) return
    for (let job = this.queue.shift(); job; job = this.queue.shift()) {
      const stop = new AbortController()
      this.running = job
      this.stopping = stop
      this.onChange([job.meetingId], false)
      const started = Date.now()
      const sound = join(this.dir, `${job.key}.wav`)
      let placed = false
      try {
        // the names have to be free before an hour of listening, not only after
        for (const name of transcriptNames(job.named)) {
          const there = await lstat(join(dirname(job.named.path), name)).then(() => true, () => false)
          if (there) throw new Error(`a file called "${name}" is already beside the recording, and it is never written over`)
        }
        // the recording is opened the way the scan saw it and handed to FFmpeg already open
        const handle = await openScanned(job.heard)
        try {
          const args = ['-n', '15', 'ffmpeg', '-nostdin', '-v', 'error', ...INPUT, '-i', '/dev/fd/3', '-map', '0:a:0', '-vn', '-sn', '-dn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 'wav', '-y', sound]
          await run('nice', args, 20 * 60_000, 65_536, this.env(), handle.fd, stop.signal).catch((err) => {
            throw new Error(why("FFmpeg couldn't take the sound out", err))
          })
        } finally {
          await handle.close().catch(() => {})
        }
        const args = ['-n', '15', this.cfg.python, '-I', this.cfg.script, '--model', this.cfg.model, '--input', sound]
        if (this.cfg.language) args.push('--language', this.cfg.language)
        const raw = await run('nice', args, Math.min(6 * 3600_000, Math.max(15 * 60_000, job.duration * 2000)), 64_000_000, this.env(), undefined, stop.signal).catch((err) => {
          throw new Error(why('the speech model stopped', err))
        })
        const heard = readHeard(raw.toString())
        if (!heard.segments.length) throw new Error('the speech model heard no words in this recording')
        if (stop.signal.aborted) throw new Error('stopped')
        const names = await placeBeside(job.named, transcriptFiles(job.named, job.title, job.duration, heard, basename(this.cfg.model)))
        if (!names.length) throw new Error("files with the transcript's names turned up beside the recording meanwhile, so nothing was placed")
        placed = true
        const words = heard.segments.reduce((n, s) => n + s.text.trim().split(/\s+/).length, 0)
        console.log(`transcripts: ${job.named.name}: ${heard.segments.length} lines, ${words} words in ${Math.round((Date.now() - started) / 1000)}s`)
      } catch (err) {
        // stopped on purpose (a transcript turned up meanwhile, or the server is closing) is not a failure
        if (stop.signal.aborted) console.log(`transcripts: stopped the one for ${job.named.name}`)
        else {
          const error = (err as Error).message.slice(0, 300)
          this.failed.set(job.key, error)
          console.warn(`transcripts: couldn't write a transcript for ${job.named.name}: ${error}`)
        }
      } finally {
        this.running = undefined
        this.stopping = undefined
        await rm(sound, { force: true }).catch(() => {})
      }
      this.onChange([job.meetingId], placed)
    }
  }
}
