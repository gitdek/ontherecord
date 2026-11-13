import { createHash } from 'node:crypto'
import { rmSync } from 'node:fs'
import { mkdir, mkdtemp, open, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { FileHandle } from 'node:fs/promises'
import { configFrom } from '../server/config.ts'
import { buildLibrary, openScanned, pinFolder, scanFiles, type FileEntry } from '../server/library.ts'
import { run } from '../server/media.ts'
import { distinctScreens, readScreenSnapshot, screenDir, screenEmbeddings, screenProfile, SCREEN_FRAME_LIMIT, tidyScreenText, writeScreenSnapshot, type ScreenFrame } from '../server/screens.ts'

// cut: the picture cut between the look before this one and this one (local mode's looks only)
type Frame = { t: number; path: string; cut?: boolean }
// how far one frame has to differ from the one before it to count as a cut of the picture (FFmpeg's scene score)
const CUT = 0.18
// Local mode looks at a recording more often than it keeps a frame: at most this many looks for each frame an
// index may hold, so a recording of over two hours is looked at less often than every two seconds.
const LOOKS_PER_FRAME = 4
const INPUT = ['-protocol_whitelist', 'file', '-format_whitelist', 'mov,matroska,webm']
const toolEnv = {
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  HOME: process.env.HOME ?? '',
  TMPDIR: process.env.TMPDIR ?? '/tmp',
  DEVELOPER_DIR: process.env.DEVELOPER_DIR,
  LANG: 'en_US.UTF-8',
}

async function assertCurrent(file: FileEntry, handle: FileHandle) {
  const stat = await handle.stat()
  if (stat.size !== file.size || Math.round(stat.mtimeMs) !== file.mtimeMs) throw new Error('the recording changed during indexing')
}

// Runs FFmpeg over the recording with a filter that depends on its length, and gives back the frames it wrote, in
// time order, and what the filter printed.
async function extract(file: FileEntry, directory: string, limit: number, filterFor: (duration: number) => string) {
  const handle = await openScanned(file)
  let printed: Buffer
  try {
    await assertCurrent(file, handle)
    const duration = Number((await run('ffprobe', ['-v', 'error', ...INPUT, '-show_entries', 'format=duration', '-of', 'csv=p=0', '/dev/fd/3'], 30_000, 4096, toolEnv, handle.fd)).toString().trim())
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('the recording has no usable duration')
    printed = await run('ffmpeg', [
      '-nostdin', '-v', 'error', ...INPUT, '-i', '/dev/fd/3', '-map', '0:v:0', '-an', '-sn', '-dn',
      '-vf', filterFor(duration), '-fps_mode', 'vfr', '-enc_time_base', '1:1000', '-frame_pts', '1',
      '-frames:v', String(limit), '-q:v', '4', join(directory, 'frame-%d.jpg'),
    ], 15 * 60_000, 32_000_000, toolEnv, handle.fd)
    await assertCurrent(file, handle)
  } finally {
    await handle.close()
  }
  const frames: Frame[] = (await readdir(directory))
    .flatMap((name) => {
      const match = /^frame-(\d+)\.jpg$/.exec(name)
      return match ? [{ path: join(directory, name), t: Number(match[1]) / 1000 }] : []
    })
    .sort((a, b) => a.t - b.t)
  if (!frames.length) throw new Error('no usable screen frames were found')
  return { frames, printed: printed.toString() }
}

// A frame that repeats an earlier one byte for byte adds nothing to an index.
async function withoutRepeats(frames: Frame[]) {
  const hashes = new Set<string>()
  const out: Frame[] = []
  for (const frame of frames) {
    const hash = createHash('sha256').update(await readFile(frame.path)).digest('hex')
    if (hashes.has(hash)) continue
    hashes.add(hash)
    out.push(frame)
  }
  return out
}

// The frames hosted mode sends: the first of each cut of the picture, and one after `every` seconds without a cut.
// limit: the most frames to pick. every: the longest wait between two while the picture holds still, in seconds.
export async function selectFrames(file: FileEntry, directory: string, limit = SCREEN_FRAME_LIMIT, every = 30): Promise<Frame[]> {
  const { frames } = await extract(file, directory, limit, (duration) => {
    const gap = Math.max(2, Math.ceil(duration / limit * 1000) / 1000)
    return `setpts=PTS-STARTPTS,scale='min(1280,iw)':-2,select='isnan(prev_selected_t)+gte(t-prev_selected_t,${gap})*(gt(scene,${CUT})+gte(t-prev_selected_t,${Math.max(gap, every)}))'`
  })
  return withoutRepeats(frames)
}

// Local mode's looks: a frame every `look` seconds (further apart when that would be more than `limit` looks), each
// marked when the picture cut since the look before it. The first filter scores every frame against the one before
// it, the second prints the time of each cut, and the third keeps the frames on the clock. Which looks an index
// keeps is decided once their text is read (distinctScreens).
export async function lookAtFrames(file: FileEntry, directory: string, limit: number, look: number): Promise<Frame[]> {
  const { frames, printed } = await extract(file, directory, limit, (duration) => {
    const step = Math.max(look, Math.ceil(duration / limit * 1000) / 1000)
    return `setpts=PTS-STARTPTS,scale='min(1280,iw)':-2,select='gte(scene,0)',metadata=mode=print:key=lavfi.scene_score:value=${CUT}:function=greater:file=-,select='isnan(prev_selected_t)+gte(t-prev_selected_t,${step})'`
  })
  // a cut's time is printed to six digits, so one on a look's own frame can read up to five milliseconds late; the
  // frame after a look is further off than that
  const cuts = [...printed.matchAll(/pts_time:(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1])).sort((a, b) => a - b)
  let next = 0
  for (const frame of frames) {
    const from = next
    while (next < cuts.length && cuts[next] <= frame.t + 0.006) next++
    // the first frame has nothing before it to cut from
    if (next > from && frame !== frames[0]) frame.cut = true
  }
  return frames
}

// how many frames one run of the text reader takes
const OCR_RUN = 96

async function readScreenText(frames: Frame[], script: string) {
  const moduleCache = join(dirname(frames[0].path), 'swift-cache')
  const text = new Map<string, string>()
  // a run of the reader at a time: its time and its output have limits, and a long recording has hundreds of frames
  const lines: string[] = []
  let read = 0
  for (let i = 0; i < frames.length; i += OCR_RUN) {
    const batch = frames.slice(i, i + OCR_RUN)
    const output = await run('swift', ['-module-cache-path', moduleCache, script, ...batch.map((f) => f.path)], 180_000, 4_000_000, toolEnv).catch(() => undefined)
    if (!output) continue
    read += batch.length
    lines.push(...output.toString().trim().split('\n'))
  }
  if (!read) {
    console.warn('Screen OCR is unavailable. Matches will link to the recording.')
    return text
  }
  if (read < frames.length) console.warn(`Screen OCR read ${read} of ${frames.length} frames. The others match by their picture only.`)
  for (const line of lines) {
    if (!line) continue
    try {
      const value = JSON.parse(line) as { file: string; lines: { text: string; confidence: number; y: number; x: number }[] }
      const lines = value.lines.filter((item) => item.confidence >= 0.5).sort((a, b) => b.y - a.y || a.x - b.x)
      text.set(value.file, tidyScreenText(lines.map((item) => item.text).join(' ')))
    } catch {
      // Skip unreadable OCR output. The frame can still be matched visually.
    }
  }
  return text
}

// The lock names the run that holds it. A run killed outright (kill -9, a crash) leaves its lock behind, so a lock
// whose process is gone, or whose process id now belongs to a process that started after the lock was taken, is
// stale and taken over. A lock without a holder, being written this moment or left by an older version, counts as
// held for a minute.
async function lockHolder(path: string) {
  const [text, info] = await Promise.all([readFile(path, 'utf8').catch(() => ''), stat(path).catch(() => undefined)])
  if (!info) return { live: false }
  let holder: { pid?: unknown; started?: unknown } | undefined
  try {
    holder = JSON.parse(text)
  } catch {
    // no holder written yet
  }
  const pid = typeof holder?.pid === 'number' && Number.isSafeInteger(holder.pid) && holder.pid > 0 ? holder.pid : undefined
  const started = typeof holder?.started === 'string' && Number.isFinite(Date.parse(holder.started)) ? holder.started : undefined
  if (!pid || !started) return { live: Date.now() - info.mtimeMs < 60_000 }
  try {
    process.kill(pid, 0)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') return { live: false, pid, started }
  }
  const age = await processAge(pid)
  return { live: age === undefined || Date.now() - age * 1000 <= Date.parse(started) + 2000, pid, started }
}

// How long a process has run, in seconds, from ps's elapsed time ([[days-]hours:]minutes:seconds).
async function processAge(pid: number) {
  const out = await run('ps', ['-o', 'etime=', '-p', String(pid)], 5000, 4096, { PATH: '/bin:/usr/bin', LC_ALL: 'C' }).catch(() => undefined)
  const m = /^\s*(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)\s*$/.exec(out?.toString() ?? '')
  return m ? ((Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0)) * 60 + Number(m[3])) * 60 + Number(m[4]) : undefined
}

async function takeLock(path: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      const handle = await open(path, 'wx', 0o600)
      await handle.writeFile(JSON.stringify({ pid: process.pid, started: new Date().toISOString() }))
      return handle
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const holder = await lockHolder(path)
      if (holder.live || attempt > 0) {
        const by = holder.pid ? ` by process ${holder.pid} since ${holder.started}` : ''
        throw new Error(`this recording is already being indexed${by}. If no indexer is running, remove ${path}`)
      }
      await rm(path, { force: true })
    }
  }
}

// Ctrl-C, a closed terminal and kill stop a run; it removes its temporary frames and, while it holds one, its lock
// before it goes. Only a run killed outright (kill -9) leaves them, and the lock is then stale.
function removeOnStop(scratch: string) {
  const held: { lock?: string } = {}
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const
  const stop = (signal: NodeJS.Signals) => {
    for (const path of [held.lock, scratch]) if (path) rmSync(path, { recursive: true, force: true, maxRetries: 3 })
    release()
    console.error(`Screen indexing stopped: removed its temporary frames${held.lock ? ' and its lock' : ''}.`)
    process.kill(process.pid, signal)
  }
  const release = () => {
    for (const signal of signals) process.off(signal, stop)
  }
  for (const signal of signals) process.on(signal, stop)
  return { held, release }
}

// --send-to-gemini sends the frames to Gemini through OpenRouter (SCREEN_SEARCH=1); --index embeds them with the
// picture model on this Mac (SCREEN_SEARCH=local). Each flag works only in its own mode, so a frame never leaves
// the Mac by mistake. Without a flag, the command only counts the frames it would pick.
export async function indexScreens(args: string[], env: NodeJS.ProcessEnv) {
  const [meetingId, mode] = args
  if (!meetingId || args.length > 2 || (mode !== undefined && mode !== '--send-to-gemini' && mode !== '--index')) {
    throw new Error('usage: npm run index-screens -- MEETING_ID [--send-to-gemini | --index]')
  }
  const send = mode !== undefined
  const config = configFrom(env)
  const screens = config.screens
  const local = screens.mode === 'local'
  if (mode === '--send-to-gemini') {
    if (local) throw new Error('SCREEN_SEARCH=local indexes on this Mac and sends nothing to Gemini: use --index')
    if (screens.mode !== 'gemini' || !screens.key) throw new Error('set SCREEN_SEARCH=1 and OPENROUTER_API_KEY before sending frames to Gemini through OpenRouter')
  }
  if (mode === '--index') {
    if (screens.mode === 'gemini') throw new Error(`SCREEN_SEARCH=${env.SCREEN_SEARCH} indexes through Gemini on OpenRouter: use --send-to-gemini to send the frames there, or set SCREEN_SEARCH=local to index on this Mac`)
    if (!local || !screens.url || !screens.model) throw new Error('set SCREEN_SEARCH=local, SCREENS_URL (an address on this Mac: 127.0.0.1, localhost or [::1]) and SCREENS_MODEL before indexing on this Mac')
  }
  const profile = screenProfile(screens)
  // frames embedded on this Mac, or sent to Gemini (uploaded); looked: how many looks local mode kept them from
  const done = (frames: number, count: number, looked?: number) =>
    local ? { frames, uploaded: 0, embedded: count, ...(looked === undefined ? {} : { looked }) } : { frames, uploaded: count }
  const folder = await pinFolder(config.meetingsDir, config.allowLinkedFolder)
  const lib = await buildLibrary(await scanFiles(folder), () => ({}), config.crew, new Map())
  const meeting = lib.byId.get(meetingId)
  const video = meeting?.videos.find((v) => v.isDefault && v.playable) ?? meeting?.videos.find((v) => v.playable)
  const file = video && lib.files.get(video.fileId)
  if (!file) throw new Error('no playable recording for that meeting ID')
  if (Date.now() - file.mtimeMs < 20_000) throw new Error('let the recording finish writing before indexing it')

  const scratch = await mkdtemp(join(tmpdir(), 'meetings-screens-'))
  const stopping = removeOnStop(scratch)
  // The frames this recording's index holds. Hosted mode picks them in one pass and reads their text only when they
  // are sent. Local mode looks more often than it keeps: every look is read, and the ones that show another screen
  // are kept, so counting them takes the reading too.
  const pick = async () => {
    if (!profile.look) return { frames: await selectFrames(file, scratch, profile.frames, profile.every) }
    const looks = await lookAtFrames(file, scratch, profile.frames * LOOKS_PER_FRAME, profile.look)
    const text = await readScreenText(looks, config.diarize.readText)
    const kept = distinctScreens(looks.map((f) => ({ t: f.t, text: text.get(f.path) ?? '', cut: f.cut })), profile.frames, profile.every, profile.changed ?? 1)
    return { frames: await withoutRepeats(kept.map((i) => looks[i])), text, looked: looks.length }
  }
  try {
    if (!send) {
      const { frames, looked } = await pick()
      return done(frames.length, 0, looked)
    }
    const dir = screenDir(config.dataDir, profile)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const lockPath = join(dir, `${file.id}.lock`)
    const lock = await takeLock(lockPath)
    stopping.held.lock = lockPath
    try {
      const saved = await readScreenSnapshot(config.dataDir, file, profile)
      if (saved) return done(saved.length, 0)
      const { frames, text, looked } = await pick()
      const ocr = text ?? (await readScreenText(frames, config.diarize.readText))
      const model = screenEmbeddings(screens)!
      const indexed: ScreenFrame[] = []
      for (const frame of frames) indexed.push({ t: frame.t, ocr: ocr.get(frame.path) ?? '', vector: await model.image(await readFile(frame.path)) })
      const current = await openScanned(file)
      try {
        await assertCurrent(file, current)
        await writeScreenSnapshot(config.dataDir, file, indexed, profile)
      } finally {
        await current.close()
      }
      return done(indexed.length, indexed.length, looked)
    } finally {
      stopping.held.lock = undefined
      await lock.close()
      await rm(lockPath, { force: true })
    }
  } finally {
    stopping.release()
    await rm(scratch, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  try {
    const result = await indexScreens(process.argv.slice(2), process.env)
    if ('embedded' in result) console.log(`Screen frames: ${result.frames}${'looked' in result ? `, kept from ${result.looked} looks` : ''}. Embedded on this Mac: ${result.embedded}. Sent off the Mac: 0.`)
    else console.log(`Screen frames: ${result.frames}. Sent to Gemini: ${result.uploaded}.`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'screen indexing failed')
    process.exitCode = 1
  }
}
