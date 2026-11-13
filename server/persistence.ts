import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { TextDecoder } from 'node:util'

type Check = (value: unknown) => boolean
// A save asked for and not yet known to be on disk. A snapshot given as a function is taken when its write starts.
type Pending = { snapshot: string | (() => string); failed: boolean; written: Promise<void> }
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
export const isString = (value: unknown): value is string => typeof value === 'string'
export const listOf = (value: unknown, check: Check): boolean => Array.isArray(value) && value.every(check)
export const optional = (value: unknown, check: Check): boolean => value === undefined || check(value)

// A shape gives the path to the first field of a value that doesn't fit it ('' for the value itself), or
// undefined when the value fits. A path holds field names and indexes, never what a field says.
export type Shape = (value: unknown) => string | undefined
const under = (at: string, inner: string | undefined) => (inner === undefined ? undefined : `${at}${inner && !inner.startsWith('[') ? '.' : ''}${inner}`)
export const is = (check: Check): Shape => (value) => (check(value) ? undefined : '')
export const maybe = (shape: Shape): Shape => (value) => (value === undefined ? undefined : shape(value))
export const items = (shape: Shape): Shape => (value) => {
  if (!Array.isArray(value)) return ''
  for (const [i, item] of value.entries()) {
    const at = under(`[${i}]`, shape(item))
    if (at !== undefined) return at
  }
}
export const fields = (shape: Record<string, Shape>): Shape => {
  const all = Object.entries(shape)
  return (value) => {
    if (!isRecord(value)) return ''
    for (const [key, check] of all) {
      const at = under(key, check(value[key]))
      if (at !== undefined) return at
    }
  }
}

// How an error names a stored record: by its key, or its index and id, and the field that doesn't fit.
export const keyOf = (key: string) => JSON.stringify(key.slice(0, 120))
export const itemOf = (i: number, id: unknown) => `[${i}]${isString(id) ? ` ${keyOf(id)}` : ''}`
export function mustFit(shape: Shape, value: unknown, record: string) {
  const at = shape(value)
  if (at !== undefined) throw new Error(at ? `${record}: ${at}` : record)
}

export const missing = (err: unknown) => (err as NodeJS.ErrnoException).code === 'ENOENT'

// Read one inode even if the owner atomically replaces the path during the read. A dangling symlink or a
// non-file is an error, and a FIFO must never block startup.
export async function readRegularFile(path: string): Promise<Buffer | undefined> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch((err) => {
    if (!missing(err)) throw err
    return undefined
  })
  if (!file) return
  try {
    if (!(await file.stat()).isFile()) throw new Error(`${path} is not a regular file`)
    return await file.readFile()
  } finally {
    await file.close()
  }
}

// A rename survives a power cut only once its folder is synced. Best effort: the file itself is already flushed,
// and a folder that can't be synced mustn't fail the save.
export async function syncFolder(path: string) {
  const folder = dirname(path)
  try {
    const handle = await open(folder, 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch (err) {
    console.error(`can't sync ${folder} after writing ${basename(path)} (${(err as Error).message})`)
  }
}

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

export function parseJson(bytes: Buffer): unknown {
  try {
    return JSON.parse(utf8.decode(bytes))
  } catch {
    // JSON parser errors can contain private data.
    throw new Error('invalid UTF-8 or JSON')
  }
}

// A file an 'aside' store can't read: its caller can start without it. The store refuses every write until a
// load reads the file, so the file is never written over.
export class Unreadable extends Error {}

// The name of a save's temp file beside its target is `<file>.tmp-<randomUUID()>`.
const TEMP = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const HOUR = 3_600_000

// Bytes that aren't JSON are moved to a .corrupt-* path and the store starts empty. invalid: what JSON in an
// unexpected shape does. 'stop' (the board, the notebook: nothing can rebuild them) refuses to load and leaves the
// file where it is, so a code bug can't hide the live records behind an empty store. 'aside' treats it like bad bytes.
export class PersistedJson {
  private readonly path: string
  private readonly label: string
  private readonly onRecovered?: () => void
  private readonly invalid: 'stop' | 'aside'
  private writing = Promise.resolve()
  private pending?: Pending
  private loading = false
  private failure?: Error

  constructor(path: string, label: string, onRecovered?: () => void, invalid: 'stop' | 'aside' = 'stop') {
    this.path = path
    this.label = label
    this.onRecovered = onRecovered
    this.invalid = invalid
  }

  assertWritable() {
    if (this.loading) throw new Error(`${this.label}: wait for ${this.path} to finish loading before saving`)
    if (this.failure) throw this.failure
  }

  async load<T>(decode: (value: unknown) => T): Promise<T | undefined> {
    if (this.loading) throw new Error(`${this.label}: already loading ${this.path}`)
    this.loading = true
    try {
      await this.writing.catch(() => {})
      await this.removeLeftovers()
      const value = await this.read(decode)
      this.pending = undefined
      this.failure = undefined
      return value
    } catch (err) {
      this.failure = err as Error
      throw err
    } finally {
      this.loading = false
    }
  }

  // A save killed between writing its temp file and the rename leaves a full private copy behind. Only this
  // store's own, and only once they are an hour old, so a save still being written elsewhere is never touched.
  private async removeLeftovers() {
    const folder = dirname(this.path)
    const prefix = `${basename(this.path)}.tmp-`
    for (const name of await readdir(folder).catch(() => [])) {
      if (!name.startsWith(prefix) || !TEMP.test(name.slice(prefix.length))) continue
      const path = join(folder, name)
      try {
        const info = await lstat(path)
        if (info.isFile() && Date.now() - info.mtimeMs > HOUR) await rm(path)
      } catch (err) {
        if (!missing(err)) console.error(`${this.label}: can't remove the leftover ${path} (${(err as Error).message})`)
      }
    }
  }

  private async read<T>(decode: (value: unknown) => T): Promise<T | undefined> {
    let bytes: Buffer | undefined
    try {
      bytes = await readRegularFile(this.path)
    } catch (err) {
      const reason = `${this.label}: can't read ${this.path} (${(err as Error).message})`
      if (this.invalid === 'aside') throw new Unreadable(reason, { cause: err })
      throw new Error(`${reason}; fix the file or restore it before starting`, { cause: err })
    }
    if (!bytes) return
    let value: unknown
    try {
      value = parseJson(bytes)
    } catch (err) {
      // bytes that aren't JSON (a write cut off) can't be used whatever the code expects: keep them aside
      return this.setAside(err as Error)
    }
    try {
      return decode(value)
    } catch (err) {
      // JSON in a shape the code doesn't expect: the records are probably fine and the code is older or newer
      if (this.invalid === 'stop') {
        throw new Error(`${this.label}: ${this.path} failed validation (${(err as Error).message}); it was left as it is. Fix it or restore a verified copy (docs/recovery.md) before starting`, { cause: err })
      }
      return this.setAside(err as Error)
    }
  }

  private async setAside(err: Error): Promise<undefined> {
    const aside = `${this.path}.corrupt-${Date.now()}-${randomUUID()}`
    try {
      await rename(this.path, aside)
    } catch (cause) {
      throw new Error(`${this.label}: can't quarantine ${this.path} (${(cause as Error).message}); fix directory permissions or move the damaged file aside before starting`, { cause })
    }
    console.error(`${this.label}: ${this.path} failed validation (${err.message}); preserved the original at ${aside} and started empty`)
  }

  save(snapshot: string | (() => string)) {
    this.assertWritable()
    // A failed save rejects its caller. A later save writes the full state, including earlier changes.
    const pending: Pending = { snapshot, failed: false, written: Promise.resolve() }
    this.pending = pending
    this.writing = pending.written = this.writing.catch(() => {}).then(() => this.writeSnapshot(typeof snapshot === 'string' ? snapshot : snapshot())).then(() => {
      if (this.pending === pending) this.pending = undefined
    }, (err) => {
      pending.failed = true
      throw err
    })
    return this.writing
  }

  // A change saved whole or not at all. `apply` runs once every save asked for before it has finished: it makes the
  // change and says how to take it back (no undo: nothing changed, nothing to write). The snapshot is taken as the
  // write starts. If the write fails, the change is taken back before any later save starts, so the caller's error
  // means it did not happen and no later save can carry it.
  commit<T>(apply: () => { value: T; undo?: () => void }, snapshot: () => string): Promise<T> {
    this.assertWritable()
    const run = this.writing.catch(() => {}).then(async () => {
      const { value, undo } = apply()
      if (!undo) return value
      try {
        await this.writeSnapshot(snapshot())
      } catch (err) {
        undo()
        throw err
      }
      // the write held everything in memory as it began, including a change whose own save had failed
      if (this.pending?.failed) this.pending = undefined
      return value
    })
    this.writing = run.then(() => {}, () => {})
    return run
  }

  // An unchanged retry may still be waiting for the earlier change to reach disk.
  flush() {
    const pending = this.pending
    if (!pending) return
    if (!pending.failed) return pending.written
    return this.save(pending.snapshot).then(() => this.onRecovered?.())
  }

  private async writeSnapshot(snapshot: string) {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    const tmp = `${this.path}.tmp-${randomUUID()}`
    const file = await open(tmp, 'wx', 0o600)
    try {
      try {
        await file.writeFile(snapshot)
        await file.sync()
      } finally {
        await file.close()
      }
      await rename(tmp, this.path)
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {})
      throw err
    }
    await syncFolder(this.path)
  }
}
