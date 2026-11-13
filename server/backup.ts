// Verified copies of what can't be rebuilt from the archive. Each destination has its own schedule.
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { decodeNotes } from './notebook.ts'
import { isRecord, missing, parseJson, readRegularFile, syncFolder } from './persistence.ts'
import { decodeSavedNames } from './speakers.ts'
import { decodeState } from './state.ts'

const FILES = [
  { path: 'state.json', decode: decodeState },
  { path: 'notebook.json', decode: decodeNotes },
  { path: 'speakers/names.json', decode: decodeSavedNames },
] as const
const MANIFEST = 'manifest.json'
const NAME = /^(\d{4}-\d{2}-\d{2})T(\d{6})Z(?:-([a-f0-9]{32}))?$/
export const KEEP = { days: 7, newest: 3 }
const HOUR = 3_600_000
const MINUTE = 60_000

type Entry = { path: typeof FILES[number]['path']; bytes: number; sha256: string }
type Captured = { entry: Entry; contents: Buffer }

export const nameOf = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/^(\d{4})(\d{2})(\d{2})T(\d{6})\.\d+Z$/, '$1-$2-$3T$4Z')
const timeOf = (name: string) => {
  const m = NAME.exec(name)
  return m ? Date.parse(`${m[1]}T${m[2].slice(0, 2)}:${m[2].slice(2, 4)}:${m[2].slice(4)}Z`) : NaN
}
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
// A copy dated after the clock (taken while it ran ahead) is kept, but it is neither recent nor one of the newest
// few: it would stop every copy until that date and push the real ones out of retention.
const ahead = (name: string, now: number) => timeOf(name) > now + MINUTE

async function copies(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch((err) => {
    if (!missing(err)) throw err
    return []
  })
  // Only the manifest-backed format is eligible for automated scheduling and retention.
  return entries.filter((e) => e.isDirectory() && NAME.exec(e.name)?.[3] && Number.isFinite(timeOf(e.name))).map((e) => e.name).sort().reverse()
}

// Finder writes .DS_Store into a folder it shows, and macOS writes AppleDouble ._ files beside files on some
// disks. Neither is part of a copy, so the listing checks leave them out.
const finderFile = (name: string) => name === '.DS_Store' || name.startsWith('._')

// Copies the earlier version took, named by time alone and holding only what it copied (no manifest).
const EARLIER = new Set(['state.json', 'notebook.json', 'speakers'])
async function earlierCopies(dir: string): Promise<string[]> {
  const names: string[] = []
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const m = NAME.exec(e.name)
    if (!e.isDirectory() || !m || m[3]) continue
    const inside = (await readdir(join(dir, e.name))).filter((n) => !finderFile(n))
    if (inside.length && inside.every((n) => EARLIER.has(n))) names.push(e.name)
  }
  return names
}

// Keep the newest few plus the newest snapshot on each day in the retention window.
export function stale(names: string[], now: number): string[] {
  const sorted = [...names].sort().reverse()
  const keep = new Set(sorted.filter((n) => !ahead(n, now)).slice(0, KEEP.newest))
  const days = new Set<string>()
  for (const n of sorted) {
    const day = n.slice(0, 10)
    if (now - timeOf(n) <= KEEP.days * 24 * HOUR && !days.has(day)) {
      days.add(day)
      keep.add(n)
    }
  }
  return sorted.filter((n) => !keep.has(n))
}

async function capture(dataDir: string): Promise<Captured[]> {
  const files: Captured[] = []
  for (const { path, decode } of FILES) {
    const source = join(dataDir, path)
    try {
      const contents = await readRegularFile(source)
      if (!contents) continue
      decode(parseJson(contents))
      files.push({ entry: { path, bytes: contents.length, sha256: sha256(contents) }, contents })
    } catch (err) {
      throw new Error(`can't back up ${source} (${(err as Error).message})`, { cause: err })
    }
  }
  return files
}

async function privateEntry(path: string, directory: boolean) {
  const info = await lstat(path)
  if ((directory ? !info.isDirectory() : !info.isFile()) || (info.mode & 0o777) !== (directory ? 0o700 : 0o600)) {
    throw new Error(`unexpected type or permissions for ${path}`)
  }
}

// A valid manifest describes the entire snapshot, Finder's own files aside. Extra entries, symlinks and invalid
// saved records make it ineligible for automated retention. The same check can be run before restoring into an
// empty data dir.
export async function verifyBackup(dir: string): Promise<Entry[]> {
  await privateEntry(dir, true)
  const manifestPath = join(dir, MANIFEST)
  await privateEntry(manifestPath, false)
  const raw = await readRegularFile(manifestPath)
  const manifest = raw && parseJson(raw)
  if (!isRecord(manifest) || manifest.version !== 1 || !Array.isArray(manifest.files) || !manifest.files.length) {
    throw new Error('invalid backup manifest')
  }
  const files: Entry[] = []
  const seen = new Set<string>()
  for (const entry of manifest.files as unknown[]) {
    const file = isRecord(entry) && FILES.find((f) => f.path === entry.path)
    if (!file || !isRecord(entry) || seen.has(file.path) || typeof entry.bytes !== 'number' ||
        !Number.isSafeInteger(entry.bytes) || entry.bytes <= 0 || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
      throw new Error('invalid backup file inventory')
    }
    if (file.path === 'speakers/names.json') {
      const speakers = join(dir, 'speakers')
      await privateEntry(speakers, true)
      if ((await readdir(speakers)).filter((n) => !finderFile(n)).join() !== 'names.json') throw new Error('unexpected backup speaker files')
    }
    const path = join(dir, file.path)
    await privateEntry(path, false)
    const contents = await readRegularFile(path)
    if (!contents || contents.length !== entry.bytes || sha256(contents) !== entry.sha256) throw new Error(`backup checksum mismatch for ${file.path}`)
    file.decode(parseJson(contents))
    files.push({ path: file.path, bytes: entry.bytes, sha256: entry.sha256 })
    seen.add(file.path)
  }
  const expected = [MANIFEST, ...files.map((file) => file.path.split('/')[0])].sort()
  if (JSON.stringify((await readdir(dir)).filter((n) => !finderFile(n)).sort()) !== JSON.stringify(expected)) throw new Error('unexpected backup directory entries')
  return files
}

async function verified(dest: string, name: string) {
  try {
    await verifyBackup(join(dest, name))
    return true
  } catch (err) {
    console.error(`backup: ignoring unverified snapshot ${join(dest, name)} (${(err as Error).message})`)
    return false
  }
}

async function publish(dest: string, files: Captured[], now: Date) {
  const final = join(dest, `${nameOf(now)}-${randomUUID().replaceAll('-', '')}`)
  await mkdir(dest, { recursive: true, mode: 0o700 })
  const tmp = await mkdtemp(join(dest, '.meetings-backup-'))
  try {
    for (const { entry, contents } of files) {
      const path = join(tmp, entry.path)
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      await writeFile(path, contents, { mode: 0o600, flag: 'wx', flush: true })
    }
    await writeFile(join(tmp, MANIFEST), JSON.stringify({ version: 1, files: files.map(({ entry }) => entry) }, null, 2), { mode: 0o600, flag: 'wx', flush: true })
    await verifyBackup(tmp)
    const exists = await lstat(final).catch((err) => {
      if (!missing(err)) throw err
    })
    if (exists) throw new Error(`snapshot path already exists: ${final}`)
    await rename(tmp, final)
    await syncFolder(final)
    return final
  } catch (err) {
    await rm(tmp, { recursive: true, force: true }).catch((cause) => console.error(`backup: couldn't remove incomplete copy ${tmp}`, cause))
    throw err
  }
}

// Every copy's check needs private modes, which a disk formatted exFAT or FAT can't keep: there every file reads
// back as 0700. Each destination is tried once, with a file written as 0600, before its first copy.
const suitable = new Set<string>()
const unsuitable = new Set<string>()
async function probeMode(dest: string) {
  await mkdir(dest, { recursive: true, mode: 0o700 })
  const probe = join(dest, `.meetings-probe-${randomUUID()}`)
  await writeFile(probe, '', { mode: 0o600, flag: 'wx' })
  try {
    return (await lstat(probe)).mode & 0o777
  } finally {
    await rm(probe, { force: true })
  }
}

// Serialize due checks, writes and pruning to the same destination in this process. Separate destinations
// can proceed independently, even if one is unavailable or a scheduled run overlaps the last one. A destination
// that doesn't answer (a network share whose host is asleep can block a call for good) fails the run once it has
// had WAIT; its work stays queued, so the next run waits behind it instead of racing it.
const WAIT = 10 * MINUTE
const running = new Map<string, Promise<string | undefined>>()
const failed = new Set<string>()
const warned = new Set<string>()
function inDestination(dest: string, work: () => Promise<string | undefined>) {
  const next = (running.get(dest) ?? Promise.resolve()).then(work).catch((err) => {
    failed.add(dest)
    console.error(`backup: failed in ${dest} (${(err as Error).message})`)
    return undefined
  }).finally(() => {
    if (running.get(dest) === next) running.delete(dest)
  })
  running.set(dest, next)
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<undefined>((settle) => {
    timer = setTimeout(() => {
      failed.add(dest)
      console.error(`backup: failed in ${dest} (no answer in ${WAIT / MINUTE} minutes)`)
      settle(undefined)
    }, WAIT)
    timer.unref()
  })
  return Promise.race([next, late]).finally(() => clearTimeout(timer))
}

// With no minimum age, request a fresh copy at every destination. Otherwise skip a destination only if it
// already has a recent verified snapshot. Return just the destinations that published a copy this run.
export async function backup(dataDir: string, dests: string[], now = new Date(), minimumAge?: number): Promise<string[]> {
  let captured: Promise<Captured[]> | undefined
  const done = await Promise.all([...new Set(dests.map((dest) => resolve(dest)))].map((dest) => inDestination(dest, async () => {
    if (unsuitable.has(dest)) return
    const previous = await copies(dest)
    for (const name of previous) {
      if (ahead(name, now.getTime())) {
        const path = join(dest, name)
        if (!warned.has(path)) console.warn(`backup: ${path} is dated after the clock, so it is kept but counts neither as recent nor as one of the newest copies (was the clock ahead when it was taken?)`)
        warned.add(path)
        continue
      }
      if (failed.has(dest) || minimumAge === undefined || now.getTime() - timeOf(name) >= minimumAge) break
      if (await verified(dest, name)) return
    }
    const files = await (captured ??= capture(dataDir))
    if (!files.length) return
    if (!suitable.has(dest)) {
      const mode = await probeMode(dest)
      if (mode !== 0o600) {
        unsuitable.add(dest)
        console.error(`backup: no copies go to ${dest}: a file written there as 600 reads back as ${mode.toString(8)}, so no copy could pass its check. Use a folder on a disk formatted APFS or Mac OS Extended.`)
        return
      }
      suitable.add(dest)
    }
    const final = await publish(dest, files, now)
    failed.delete(dest)
    try {
      const eligible = [basename(final)]
      for (const name of previous) if (await verified(dest, name)) eligible.push(name)
      const gone = stale(eligible, now.getTime())
      for (const name of gone) {
        const old = join(dest, name)
        if (old !== final) await rm(old, { recursive: true })
      }
      // The earlier version kept its copies a week and always its newest three. Its copies go after the same week
      // once verified copies are here, and its newest three stay until three verified copies are.
      const earlier = (await earlierCopies(dest)).sort().reverse()
      const held = eligible.length - gone.length < KEEP.newest ? earlier.slice(0, KEEP.newest) : []
      for (const name of earlier) {
        if (!held.includes(name) && now.getTime() - timeOf(name) > KEEP.days * 24 * HOUR) await rm(join(dest, name), { recursive: true })
      }
    } catch (err) {
      // The new copy is already published. A retention failure must not report it as a failed backup.
      console.error(`backup: copied into ${final} but couldn't finish retention (${(err as Error).message})`)
    }
    return final
  })))
  return done.filter((path) => path !== undefined)
}

// Startup waits only for the copy in data/backups, the one made before anything here writes. The other folders
// get theirs in the background, so one that doesn't answer can't keep the server from starting. Resolves to a
// function that stops it all; its `elsewhere` settles once those first copies have.
export async function keepBackups(dataDir: string, extra: string[] = []): Promise<(() => void) & { elsewhere: Promise<void> }> {
  const local = join(dataDir, 'backups')
  const run = async (dests: string[], age: number) => {
    for (const path of await backup(dataDir, dests, new Date(), age)) console.log(`backup: verified copy in ${path}`)
  }
  await run([local], HOUR)
  const elsewhere = run(extra, HOUR).catch((err) => console.error('backup: failed', err))
  const timer = setInterval(() => void run([local, ...extra], 24 * HOUR).catch((err) => console.error('backup: failed', err)), HOUR)
  timer.unref()
  return Object.assign(() => clearInterval(timer), { elsewhere })
}
