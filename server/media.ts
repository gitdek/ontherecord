// Video and file delivery: byte-range streaming (so <video> can seek and downloads can resume), ffprobe
// facts, and background thumbnails: a poster, a hover-preview sprite and a strip of average frame colours.
import { spawn } from 'node:child_process'
import { mkdir, open, readFile, rename, rm, writeFile, type FileHandle } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { openScanned, stillScanned, type FileEntry, type MediaFacts, type Probe } from './library.ts'

const TYPES: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  m4a: 'audio/mp4',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  flac: 'audio/flac',
  txt: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8',
  json: 'application/json; charset=utf-8',
  vtt: 'text/vtt; charset=utf-8',
  srt: 'text/plain; charset=utf-8',
  jpg: 'image/jpeg',
}
export const mimeOf = (name: string) => TYPES[name.split('.').pop()!.toLowerCase()] ?? 'application/octet-stream'

// RFC 6266: an ASCII fallback plus the real UTF-8 name
export function attachment(name: string) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, "'")
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

type SendOptions = { size: number; mtimeMs: number; type: string; download?: string; cache?: string }

// source: a path we own (the app, thumbnails) or an opener for a meetings-folder file (see openScanned)
export async function sendFile(req: IncomingMessage, res: ServerResponse, source: string | (() => Promise<FileHandle>), o: SendOptions) {
  const etag = `W/"${o.size.toString(36)}-${Math.round(o.mtimeMs).toString(36)}"`
  const headers: Record<string, string | number> = {
    'Content-Type': o.type,
    'Accept-Ranges': 'bytes',
    ETag: etag,
    'Last-Modified': new Date(o.mtimeMs).toUTCString(),
    'Cache-Control': o.cache ?? 'private, max-age=0, must-revalidate',
  }
  if (o.download) headers['Content-Disposition'] = attachment(o.download)

  if (req.headers['if-none-match'] === etag && !req.headers.range) {
    res.writeHead(304, headers).end()
    return
  }

  let start = 0
  let end = o.size - 1
  let status = 200
  const range = req.headers.range
  const ifRange = req.headers['if-range']
  if (range && (!ifRange || ifRange === etag)) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
    if (m && (m[1] || m[2])) {
      if (m[1] === '') start = Math.max(0, o.size - Number(m[2]))
      else {
        start = Number(m[1])
        if (m[2]) end = Math.min(Number(m[2]), o.size - 1)
      }
      if (start > end || start >= o.size) {
        res.writeHead(416, { ...headers, 'Content-Range': `bytes */${o.size}` }).end()
        return
      }
      status = 206
      headers['Content-Range'] = `bytes ${start}-${end}/${o.size}`
    }
  }
  // opened before answering, so a file that changed since the scan fails cleanly instead of mid-stream
  const fh = typeof source === 'string' ? await open(source, 'r') : await source()
  try {
    headers['Content-Length'] = o.size ? end - start + 1 : 0
    res.writeHead(status, headers)
    if (req.method === 'HEAD' || !o.size) return void res.end()
    // a seek or a closed tab aborts the response mid-stream; that's routine, not an error
    await pipeline(fh.createReadStream({ start, end, highWaterMark: 1 << 20, autoClose: false }), res).catch(() => {})
  } finally {
    // closed here, every time: a handle left for the garbage collector to close takes the process down on Node 26
    await fh.close().catch(() => {})
  }
}

// ---------- probing ----------

// Output is capped: what we read back (probe JSON, a strip of frame colours) is small, so anything
// bigger is a misbehaving file and the tool is stopped.
export function run(cmd: string, args: string[], timeoutMs: number, maxOut = 4_000_000, env?: NodeJS.ProcessEnv, inputFd?: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const stdio: ['ignore', 'pipe', 'pipe', ...number[]] = ['ignore', 'pipe', 'pipe']
    if (inputFd !== undefined) stdio.push(inputFd)
    const child = spawn(cmd, args, { stdio, ...(env ? { env } : {}) })
    const out: Buffer[] = []
    const err: Buffer[] = []
    let outSize = 0
    let errSize = 0
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.stdout!.on('data', (d: Buffer) => {
      outSize += d.length
      if (outSize > maxOut) child.kill('SIGKILL')
      else out.push(d)
    })
    child.stderr!.on('data', (d: Buffer) => {
      if ((errSize += d.length) <= 65_536) err.push(d)
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(Buffer.concat(out))
      else reject(new Error(`${cmd} exited ${code}: ${Buffer.concat(err).toString().slice(0, 300)}`))
    })
  })
}

type FfStream = {
  codec_type?: string
  codec_name?: string
  width?: number
  height?: number
  avg_frame_rate?: string
  r_frame_rate?: string
  bit_rate?: string
  tags?: Record<string, string>
  side_data_list?: { rotation?: number }[]
}

// Inputs are read as plain local files in the formats we expect, so a file that is really a playlist or
// manifest can't make ffmpeg fetch other files or URLs.
const INPUT = ['-protocol_whitelist', 'file', '-format_whitelist', 'mov,matroska,webm,mp3,wav,aac,ogg,flac']

export async function probeFile(path: string): Promise<Probe> {
  const raw = await run('ffprobe', ['-v', 'error', ...INPUT, '-print_format', 'json', '-show_format', '-show_streams', path], 30_000)
  const j = JSON.parse(raw.toString()) as { streams?: FfStream[]; format?: { duration?: string; bit_rate?: string } }
  const v = j.streams?.find((s) => s.codec_type === 'video')
  const a = j.streams?.find((s) => s.codec_type === 'audio')
  const rate = (r?: string) => {
    const [n, d] = (r ?? '').split('/').map(Number)
    return n && d ? Math.round((n / d) * 100) / 100 : undefined
  }
  const rotation = v?.side_data_list?.find((s) => typeof s.rotation === 'number')?.rotation ?? (v?.tags?.rotate ? Number(v.tags.rotate) : 0)
  return {
    duration: j.format?.duration ? Number(j.format.duration) : undefined,
    width: v?.width,
    height: v?.height,
    fps: rate(v?.avg_frame_rate) ?? rate(v?.r_frame_rate),
    vcodec: v?.codec_name,
    acodec: a?.codec_name,
    bitrate: j.format?.bit_rate ? Number(j.format.bit_rate) : undefined,
    hasAudio: Boolean(a),
    rotation: rotation ? Math.round(rotation) : 0,
  }
}

// MP4s stream best with the index (moov) before the media data (mdat): "faststart".
export async function isFaststart(f: FileEntry): Promise<boolean | undefined> {
  const fh = await openScanned(f)
  try {
    const { size } = await fh.stat()
    const buf = Buffer.alloc(16)
    let pos = 0
    for (let i = 0; i < 64 && pos + 8 <= size; i++) {
      await fh.read(buf, 0, 16, pos)
      let len = buf.readUInt32BE(0)
      const type = buf.toString('latin1', 4, 8)
      if (type === 'moov') return true
      if (type === 'mdat') return false
      if (len === 1) len = Number(buf.readBigUInt64BE(8))
      else if (len === 0) return
      if (len < 8) return
      pos += len
    }
  } finally {
    await fh.close()
  }
}

// ---------- the media cache: probes, faststart and thumbnails, keyed by size + mtime ----------

export type Strip = { interval: number; count: number; cols: number; rows: number; tileW: number; tileH: number; colors: string[] }
type Entry = { key: string; probe?: Probe; faststart?: boolean; failed?: string }

export class Media {
  private entries = new Map<string, Entry>()
  private queue: (() => Promise<void>)[] = []
  private busy = false
  private pendingThumbs = new Set<string>()
  enabled = true
  private dir: string
  private onChange: (kind: 'probe' | 'thumbs', file: FileEntry) => void

  constructor(dataDir: string, onChange: (kind: 'probe' | 'thumbs', file: FileEntry) => void) {
    this.dir = join(dataDir, 'cache')
    this.onChange = onChange
  }

  async load() {
    await mkdir(join(this.dir, 'thumbs'), { recursive: true, mode: 0o700 })
    try {
      const saved = JSON.parse(await readFile(join(this.dir, 'media.json'), 'utf8')) as Record<string, Entry>
      // a probe that failed in an earlier run is tried again once: a copy it couldn't read isn't played
      for (const [k, v] of Object.entries(saved)) if (!v.failed) this.entries.set(k, v)
    } catch {}
    try {
      await run('ffprobe', ['-version'], 5000)
    } catch {
      this.enabled = false
      console.warn('ffprobe/ffmpeg not found: no durations or thumbnails (brew install ffmpeg)')
    }
  }

  private async save() {
    const tmp = join(this.dir, 'media.json.tmp')
    await writeFile(tmp, JSON.stringify(Object.fromEntries(this.entries)), { mode: 0o600 })
    await rename(tmp, join(this.dir, 'media.json'))
  }

  private key = (f: FileEntry) => `${f.size}:${f.mtimeMs}`

  // What we know right now; unknown files get probed in the background.
  facts(f: FileEntry): MediaFacts {
    if (f.kind !== 'video' && f.kind !== 'audio') return {}
    // still being written (a compression pass in progress): look again once it settles. A time ahead of this
    // Mac's clock (a file unzipped from a zone further east, say) is not a file being written.
    const age = Date.now() - f.mtimeMs
    if (age >= 0 && age < 20_000) return { growing: true }
    const e = this.entries.get(f.rel)
    if (e?.key === this.key(f)) return { probe: e.probe, faststart: e.faststart, ...(e.failed && !e.probe ? { failed: true } : {}) }
    this.enqueue(async () => {
      const entry: Entry = { key: this.key(f) }
      try {
        await stillScanned(f)
        if (this.enabled) entry.probe = await probeFile(f.path)
        if (/\.(mp4|m4v|mov|m4a)$/i.test(f.name)) entry.faststart = await isFaststart(f)
      } catch (err) {
        entry.failed = (err as Error).message
      }
      this.entries.set(f.rel, entry)
      await this.save()
      this.onChange('probe', f)
    }, `probe:${f.rel}:${this.key(f)}`)
    return {}
  }

  private queued = new Set<string>()
  private enqueue(job: () => Promise<void>, id: string) {
    if (this.queued.has(id)) return
    this.queued.add(id)
    this.queue.push(async () => {
      try {
        await job()
      } finally {
        this.queued.delete(id)
      }
    })
    void this.drain()
  }

  private async drain() {
    if (this.busy) return
    this.busy = true
    while (this.queue.length) await this.queue.shift()!().catch((err) => console.warn('media job failed:', err))
    this.busy = false
  }

  thumbBase = (f: FileEntry) => join(this.dir, 'thumbs', `${f.id}-${f.size.toString(36)}-${f.mtimeMs.toString(36)}`)

  async thumbs(f: FileEntry): Promise<{ poster?: string; sprite?: string; strip?: Strip }> {
    const base = this.thumbBase(f)
    const out: { poster?: string; sprite?: string; strip?: Strip } = {}
    try {
      out.strip = JSON.parse(await readFile(`${base}.strip.json`, 'utf8')) as Strip
      out.sprite = `${base}.sprite.jpg`
      out.poster = `${base}.poster.jpg`
    } catch {}
    return out
  }

  // Frames that went missing from the cache: drop what's left of them so ensureThumbs makes them again.
  async forgetThumbs(f: FileEntry) {
    const base = this.thumbBase(f)
    await Promise.all(['strip.json', 'poster.jpg', 'sprite.jpg'].map((x) => rm(`${base}.${x}`, { force: true })))
    this.pendingThumbs.delete(`thumbs:${f.rel}:${this.key(f)}`)
  }

  // Poster, sprite and colour strip in one low-priority ffmpeg pass over keyframes only (~15 s an hour).
  ensureThumbs(f: FileEntry, posterAt: number) {
    if (!this.enabled) return
    const e = this.entries.get(f.rel)
    if (!e?.probe?.duration || !e.probe.width || !e.probe.height || e.key !== this.key(f)) return
    const id = `thumbs:${f.rel}:${this.key(f)}`
    if (this.pendingThumbs.has(id)) return
    this.pendingThumbs.add(id)
    const probe = e.probe
    this.enqueue(async () => {
      const base = this.thumbBase(f)
      try {
        await readFile(`${base}.strip.json`)
        return
      } catch {}
      const duration = probe.duration!
      const interval = Math.max(6, Math.ceil(duration / 160))
      const count = Math.ceil(duration / interval) + 1
      const cols = 10
      const rows = Math.ceil(count / cols)
      const sideways = Math.abs(probe.rotation ?? 0) % 180 === 90
      const [w, h] = sideways ? [probe.height!, probe.width!] : [probe.width!, probe.height!]
      const tileW = 192
      const tileH = Math.round((tileW * h) / w / 2) * 2
      const nice = ['-n', '15', 'ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', ...INPUT]
      await stillScanned(f)
      await run('nice', [...nice, '-ss', String(Math.max(0, Math.min(posterAt, duration - 1))), '-i', f.path, '-frames:v', '1', '-vf', 'scale=960:-2', '-q:v', '4', `${base}.poster.jpg`], 120_000)
      const rgb = await run(
        'nice',
        [
          ...nice,
          '-skip_frame', 'nokey',
          '-i', f.path,
          '-filter_complex', `[0:v]fps=1/${interval},split=2[a][b];[a]scale=${tileW}:${tileH},tile=${cols}x${rows}[s];[b]scale=1:1:flags=area,format=rgb24[c]`,
          '-map', '[s]', '-frames:v', '1', '-q:v', '6', `${base}.sprite.jpg`,
          '-map', '[c]', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
        ],
        15 * 60_000,
      )
      const colors: string[] = []
      for (let i = 0; i + 2 < rgb.length; i += 3) colors.push(`#${rgb.subarray(i, i + 3).toString('hex')}`)
      const strip: Strip = { interval, count: Math.min(colors.length, cols * rows), cols, rows, tileW, tileH, colors: colors.slice(0, cols * rows) }
      await writeFile(`${base}.strip.json`, JSON.stringify(strip), { mode: 0o600 })
      this.onChange('thumbs', f)
    }, id)
  }
}
