// A one-way copy of the meetings folder in <BACKUP_DIR>/meetings/ for each backup folder. It only adds and
// updates: nothing in a copy is ever removed or renamed, and nothing is written to the meetings folder. Files are
// read through the library's own safe opener (openScanned), from the list the last scan made, so the folder's
// hardening still applies. One file at a time, in the background: nothing waits for it.
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, rename, rm, stat, type FileHandle } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { openScanned, type FileEntry, type MediaFacts } from './library.ts'
import { missing } from './persistence.ts'

export type MirrorStatus = {
  enabled: boolean
  // how many backup folders hold a copy
  folders: number
  // what the last pass found: files in the meetings folder, copied this time, still being written, not copied
  files: number
  copied: number
  waiting: number
  failed: number
  lastRun: string | null
  running: boolean
}

// A disk that keeps times only to the second or two (FAT keeps two) still counts a copy as the same file.
const SLACK = 2000
// A pass that left files it couldn't copy is tried again this long after, even if nothing in the folder changed.
const RETRY = 10 * 60_000
// A copy is written beside its final name under this name first. A pass cut short leaves one behind: the next
// pass removes it, or writes over it.
const partOf = (f: FileEntry) => `.mirror-${f.id}.part`
const PART = /^\.mirror-[\w-]+\.part$/
// how much is read and written at a time
const CHUNK = 1 << 20
// as deep as the scan goes (scanFiles)
const DEPTH = 2

const signature = (files: FileEntry[]) => files.map((f) => `${f.rel}:${f.size}:${f.mtimeMs}:${f.ino}`).join('|')
const reason = (err: unknown) => (err as NodeJS.ErrnoException).code ?? (err as Error).message
const inside = (a: string, b: string) => a === b || a.startsWith(b.endsWith(sep) ? b : b + sep)

export class Mirror {
  // the backup folders; each one's copy is in its meetings/ folder
  readonly dirs: string[]
  private latest: FileEntry[] = []
  private seen: string | undefined
  private pass: Promise<void> | undefined
  private again = false
  private stopped = false
  private readonly abort = new AbortController()
  private last = { files: 0, copied: 0, waiting: 0, failed: 0, at: 0 }
  // a backup folder's problem is logged when it starts, not at every pass
  private said = new Map<string, string>()

  private readonly meetingsDir: string
  private readonly facts: (f: FileEntry) => MediaFacts

  constructor(backupDirs: string[], meetingsDir: string, facts: (f: FileEntry) => MediaFacts) {
    this.dirs = [...new Set(backupDirs.map((d) => resolve(d)))]
    this.meetingsDir = meetingsDir
    this.facts = facts
  }

  get enabled() {
    return this.dirs.length > 0
  }

  // The files a scan found. A pass starts when they differ from the last pass's, when that pass left a file
  // still being written, or a while after it left one it couldn't copy. If a pass is running, one more runs
  // after it, with the newest list.
  offer(files: FileEntry[]) {
    if (!this.enabled || this.stopped) return
    const due = signature(files) !== this.seen || this.last.waiting > 0 || (this.last.failed > 0 && Date.now() - this.last.at >= RETRY)
    if (!due) return
    this.latest = files
    if (this.pass) this.again = true
    else this.begin()
  }

  private begin() {
    this.again = false
    const files = this.latest
    this.seen = signature(files)
    this.pass = this.run(files)
      .catch((err) => {
        if (!this.stopped) console.error(`mirror: the pass stopped (${reason(err)})`)
      })
      .finally(() => {
        this.pass = undefined
        if (this.again && !this.stopped) this.begin()
      })
  }

  status(): MirrorStatus {
    const { files, copied, waiting, failed, at } = this.last
    return { enabled: this.enabled, folders: this.dirs.length, files, copied, waiting, failed, lastRun: at ? new Date(at).toISOString() : null, running: !!this.pass }
  }

  // settles once no pass is running (tests, and close)
  async idle() {
    while (this.pass) await this.pass
  }

  // stops the file being copied (its part is removed) and starts no more passes
  stop() {
    this.stopped = true
    this.abort.abort()
    return this.idle()
  }

  private async run(files: FileEntry[]) {
    const counts = { files: files.length, copied: 0, waiting: 0, failed: 0 }
    const roots: string[] = []
    for (const dir of this.dirs) {
      const root = await this.prepare(dir)
      if (root) roots.push(root)
    }
    for (const f of files) {
      if (this.stopped) return
      // a recording still being written is copied on a later pass, once it settles
      if (this.facts(f).growing) {
        counts.waiting++
        continue
      }
      let copied = false
      let failed = roots.length < this.dirs.length
      for (const root of roots) {
        try {
          if (await copyInto(root, f, this.abort.signal)) copied = true
        } catch (err) {
          if (this.stopped) return
          failed = true
          console.error(`mirror: couldn't copy ${f.rel} into ${root} (${reason(err)}); trying again on the next pass`)
        }
      }
      if (copied) counts.copied++
      if (failed) counts.failed++
    }
    this.last = { ...counts, at: Date.now() }
    if (counts.copied || counts.failed) console.log(`mirror: ${counts.copied} copied, ${counts.waiting} still being written, ${counts.failed} not copied, of ${counts.files} files`)
  }

  // The backup folder must already be there (a disk that isn't mounted is not made on the startup disk). Its
  // meetings/ folder is made if need be, and must be a real folder, not a link. A copy that would land in the
  // meetings folder itself, or hold it, is refused.
  private async prepare(dir: string): Promise<string | undefined> {
    const root = join(dir, 'meetings')
    try {
      if (!(await stat(dir)).isDirectory()) throw new Error('it is not a folder')
      const real = join(await realpath(dir), 'meetings')
      const source = await realpath(this.meetingsDir).catch(() => resolve(this.meetingsDir))
      if (inside(real, source) || inside(source, real)) throw new Error(`it would overlap the meetings folder ${source}`)
      await mkdir(root, { mode: 0o700 }).catch((err) => {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      })
      if (!(await lstat(root)).isDirectory()) throw new Error(`${root} is a link or a file, not a folder`)
      await sweep(root, 0)
      if (this.said.has(dir)) console.log(`mirror: ${root} can be written again`)
      this.said.delete(dir)
      return root
    } catch (err) {
      const why = reason(err)
      if (this.said.get(dir) !== why) console.error(`mirror: no copy goes to ${root} (${why}); trying again on the next pass`)
      this.said.set(dir, why)
      return undefined
    }
  }
}

// Parts left by a pass that was cut short. Links are never followed.
async function sweep(dir: string, level: number) {
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (e.isFile() && PART.test(e.name)) await rm(join(dir, e.name), { force: true }).catch(() => {})
    else if (e.isDirectory() && level < DEPTH) await sweep(join(dir, e.name), level + 1)
  }
}

// Copies one file into a copy of the folder, keeping its place in the folder. Returns whether it was copied:
// a copy with the same size and modification time is left as it is. No link in the copy is followed: a folder
// or file there that is a link is reported and left alone.
export async function copyInto(root: string, f: FileEntry, signal?: AbortSignal): Promise<boolean> {
  const parts = f.rel.split('/')
  let dir = root
  for (const name of parts.slice(0, -1)) {
    dir = join(dir, name)
    const s = await lstat(dir).catch((err) => {
      if (!missing(err)) throw err
    })
    if (!s) await mkdir(dir, { mode: 0o700 })
    else if (!s.isDirectory()) throw new Error(`a link or a file stands where its folder goes`)
  }
  const target = join(dir, f.name)
  const there = await lstat(target).catch((err) => {
    if (!missing(err)) throw err
  })
  if (there && !there.isFile()) throw new Error('a link or a folder stands in its place')
  if (there && there.size === f.size && Math.abs(there.mtimeMs - f.mtimeMs) < SLACK) return false
  const part = join(dir, partOf(f))
  const src = await openScanned(f)
  let out: FileHandle | undefined
  try {
    out = await open(part, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600)
    // a piece at a time: recordings run to several gigabytes. Never more than the scan saw.
    const buf = Buffer.allocUnsafe(Math.min(CHUNK, Math.max(f.size, 1)))
    for (let at = 0; at < f.size; ) {
      signal?.throwIfAborted()
      const { bytesRead } = await src.read(buf, 0, Math.min(buf.length, f.size - at), at)
      if (!bytesRead) throw new Error('it ended before the size the scan saw')
      for (let done = 0; done < bytesRead; ) done += (await out.write(buf, done, bytesRead - done, at + done)).bytesWritten
      at += bytesRead
    }
    const now = await src.stat()
    if (now.size !== f.size || Math.round(now.mtimeMs) !== f.mtimeMs) throw new Error('it changed while it was being copied')
    await out.datasync()
    if ((await out.stat()).size !== f.size) throw new Error('the copy came out the wrong size')
    await out.utimes(new Date(), new Date(f.mtimeMs))
    await out.close()
    out = undefined
    await rename(part, target)
    return true
  } catch (err) {
    await out?.close().catch(() => {})
    await rm(part, { force: true }).catch(() => {})
    throw err
  } finally {
    await src.close().catch(() => {})
  }
}
