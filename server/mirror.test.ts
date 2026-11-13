// The copy of the meetings folder in each BACKUP_DIR folder, on temp folders only.
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { createApp } from './app.ts'
import { configFrom } from './config.ts'
import { fixtureDir, requestApp } from './fixtures.test-helper.ts'
import { scanFiles, type FileEntry } from './library.ts'
import { Mirror } from './mirror.ts'

const settled = () => ({})
const hour = 3_600_000

async function scratch(t: TestContext) {
  // real paths: the meetings folder is never reached through a link
  const root = await realpath(await mkdtemp(join(tmpdir(), 'meetings-mirror-')))
  t.after(async () => {
    await chmod(root, 0o700).catch(() => {})
    await rm(root, { recursive: true, force: true })
  })
  const meetings = join(root, 'meetings-folder')
  const backup = join(root, 'backup')
  await mkdir(meetings)
  await mkdir(backup)
  return { root, meetings, backup, copy: join(backup, 'meetings') }
}

// a file with a time well in the past, so nothing takes it for a recording still being written
async function put(path: string, data: string | Buffer, ago = hour) {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, data)
  const when = new Date(Date.now() - ago)
  await utimes(path, when, when)
}

async function pass(mirror: Mirror, folder: string) {
  const files = await scanFiles(folder)
  mirror.offer(files)
  await mirror.idle()
  return files
}

test('mirror: copies new files, one in a subfolder too, and keeps their modification times', async (t) => {
  const { meetings, backup, copy } = await scratch(t)
  await put(join(meetings, 'notes.txt'), 'notes')
  await put(join(meetings, 'meetings-index.json'), '{"sessions":[]}')
  await put(join(meetings, '2026-10', 'Screen Recording.mp4'), Buffer.alloc(300_000, 7), 3 * hour)
  t.mock.method(console, 'log', () => {})
  const mirror = new Mirror([backup], meetings, settled)
  const files = await pass(mirror, meetings)
  for (const f of files) {
    const there = join(copy, f.rel)
    assert.deepEqual(await readFile(there), await readFile(f.path), f.rel)
    assert.equal(Math.round((await stat(there)).mtimeMs), f.mtimeMs, `${f.rel} keeps its time`)
  }
  assert.deepEqual((await readdir(join(copy, '2026-10'))).sort(), ['Screen Recording.mp4'], 'no part is left behind')
  assert.deepEqual({ ...mirror.status(), lastRun: undefined }, { enabled: true, folders: 1, files: 3, copied: 3, waiting: 0, failed: 0, lastRun: undefined, running: false })
  assert.ok(mirror.status().lastRun)
})

test('mirror: the second pass leaves unchanged files alone and copies a changed one again', async (t) => {
  const { meetings, backup, copy } = await scratch(t)
  await put(join(meetings, 'a.txt'), 'first')
  await put(join(meetings, 'b.txt'), 'other')
  t.mock.method(console, 'log', () => {})
  const mirror = new Mirror([backup], meetings, settled)
  await pass(mirror, meetings)
  const before = (await stat(join(copy, 'b.txt'))).ino
  // the same files offered again start no pass
  mirror.offer(await scanFiles(meetings))
  assert.equal(mirror.status().running, false)

  // same size, a new time
  await put(join(meetings, 'a.txt'), 'again', 2 * 60_000)
  await pass(mirror, meetings)
  assert.equal(await readFile(join(copy, 'a.txt'), 'utf8'), 'again')
  assert.equal(mirror.status().copied, 1)
  assert.equal((await stat(join(copy, 'b.txt'))).ino, before, 'the unchanged file was not written again')
  // a new size, the same time as before
  const was = await stat(join(meetings, 'b.txt'))
  await writeFile(join(meetings, 'b.txt'), 'longer than it was')
  await utimes(join(meetings, 'b.txt'), was.atime, was.mtime)
  await pass(mirror, meetings)
  assert.equal(await readFile(join(copy, 'b.txt'), 'utf8'), 'longer than it was')
  assert.equal(mirror.status().copied, 1)
})

test('mirror: never deletes, and leaves the meetings folder as it was', async (t) => {
  const { meetings, backup, copy } = await scratch(t)
  await put(join(meetings, 'kept.txt'), 'kept')
  await put(join(meetings, 'sub', 'gone.txt'), 'gone')
  await put(join(copy, 'only in the copy.txt'), 'mine')
  t.mock.method(console, 'log', () => {})
  const mirror = new Mirror([backup], meetings, settled)
  await pass(mirror, meetings)
  const listing = async (dir: string) => (await readdir(dir, { recursive: true })).map(String).sort()
  const source = await listing(meetings)
  await rm(join(meetings, 'sub'), { recursive: true })
  await pass(mirror, meetings)
  assert.equal(await readFile(join(copy, 'sub', 'gone.txt'), 'utf8'), 'gone')
  assert.equal(await readFile(join(copy, 'only in the copy.txt'), 'utf8'), 'mine')
  assert.deepEqual(await listing(meetings), source.filter((n) => !n.startsWith('sub')), 'nothing was written to the meetings folder')
})

test('mirror: a recording still being written is skipped, then copied once it settles', async (t) => {
  const { meetings, backup, copy } = await scratch(t)
  await put(join(meetings, 'notes.txt'), 'notes')
  await put(join(meetings, 'Recording.mov'), Buffer.alloc(5000, 1))
  t.mock.method(console, 'log', () => {})
  const growing = new Set(['Recording.mov'])
  const mirror = new Mirror([backup], meetings, (f: FileEntry) => (growing.has(f.rel) ? { growing: true } : {}))
  await pass(mirror, meetings)
  assert.deepEqual(await readdir(copy), ['notes.txt'])
  assert.equal(mirror.status().waiting, 1)
  // nothing changed on disk, but the last pass left a file waiting, so the next scan's offer runs one
  growing.clear()
  await pass(mirror, meetings)
  assert.deepEqual((await readdir(copy)).sort(), ['Recording.mov', 'notes.txt'])
  assert.deepEqual([mirror.status().copied, mirror.status().waiting], [1, 0])
})

test('mirror: one file that fails does not stop the others, and is tried again', async (t) => {
  const { meetings, backup, copy } = await scratch(t)
  await put(join(meetings, 'a.txt'), 'a')
  await put(join(meetings, 'b.txt'), 'secret words')
  await put(join(meetings, 'z.txt'), 'z')
  // a folder stands where one file's copy goes in the second backup: it is reported and left alone
  const second = join(backup, '..', 'second')
  await mkdir(join(second, 'meetings', 'z.txt'), { recursive: true })
  const errors: string[] = []
  t.mock.method(console, 'error', (...args: unknown[]) => void errors.push(args.map(String).join(' ')))
  t.mock.method(console, 'log', () => {})
  const mirror = new Mirror([backup, second], meetings, settled)
  const files = await scanFiles(meetings)
  // b.txt is replaced after the scan: the safe reader refuses the file it now finds
  await rm(join(meetings, 'b.txt'))
  await put(join(meetings, 'b.txt'), 'secret words, again')
  mirror.offer(files)
  await mirror.idle()
  assert.deepEqual((await readdir(copy)).sort(), ['a.txt', 'z.txt'])
  assert.deepEqual(await readdir(join(second, 'meetings')), ['a.txt', 'z.txt'])
  assert.ok((await stat(join(second, 'meetings', 'z.txt'))).isDirectory())
  assert.deepEqual([mirror.status().copied, mirror.status().failed], [2, 2])
  assert.equal(errors.length, 3, errors.join('\n'))
  assert.equal(errors.filter((e) => e.includes('b.txt')).length, 2)
  assert.ok(errors.some((e) => e.includes('z.txt') && e.includes('stands in its place')))
  assert.ok(!errors.some((e) => e.includes('secret')), 'names only, never contents')

  await rm(join(second, 'meetings', 'z.txt'), { recursive: true })
  await pass(mirror, meetings)
  assert.equal(await readFile(join(copy, 'b.txt'), 'utf8'), 'secret words, again')
  assert.equal(await readFile(join(second, 'meetings', 'z.txt'), 'utf8'), 'z')
  assert.deepEqual([mirror.status().copied, mirror.status().failed], [2, 0])
})

test('mirror: links in the copy are never followed, and a part left by a cut-short pass is cleared', async (t) => {
  const { root, meetings, backup, copy } = await scratch(t)
  const outside = join(root, 'outside')
  await mkdir(outside)
  await put(join(meetings, 'sub', 'a.txt'), 'a')
  await put(join(meetings, 'b.txt'), 'b')
  await mkdir(copy)
  await symlink(outside, join(copy, 'sub'))
  await symlink(join(outside, 'b.txt'), join(copy, 'b.txt'))
  await writeFile(join(copy, '.mirror-leftover.part'), 'half a copy')
  t.mock.method(console, 'error', () => {})
  t.mock.method(console, 'log', () => {})
  const mirror = new Mirror([backup], meetings, settled)
  await pass(mirror, meetings)
  assert.deepEqual(await readdir(outside), [])
  assert.equal(mirror.status().failed, 2)
  assert.deepEqual((await readdir(copy)).sort(), ['b.txt', 'sub'])
})

test('mirror: a backup folder that would hold the meetings folder gets no copy', async (t) => {
  const { root } = await scratch(t)
  // BACKUP_DIR set to the folder above MEETINGS_DIR, which is itself named meetings
  const meetings = join(root, 'meetings')
  await put(join(meetings, 'a.txt'), 'a')
  const errors: string[] = []
  t.mock.method(console, 'error', (...args: unknown[]) => void errors.push(args.map(String).join(' ')))
  t.mock.method(console, 'log', () => {})
  const mirror = new Mirror([root], meetings, settled)
  await pass(mirror, meetings)
  assert.deepEqual(await readdir(meetings), ['a.txt'])
  assert.match(errors.join('\n'), /overlap the meetings folder/)
  assert.equal(mirror.status().failed, 1)
})

const config = (meetings: string, data: string, backup?: string) =>
  configFrom({ PORT: '8798', MEETINGS_DIR: meetings, DATA_DIR: data, DIARIZE_PYTHON: '', LOCAL_USER: 'Ada', EMBED_URL: '', RERANK_URL: '', ...(backup === undefined ? {} : { BACKUP_DIR: backup }) })

async function mirrored(app: Awaited<ReturnType<typeof createApp>>) {
  for (let n = 0; n < 250; n++) {
    const { mirror } = (await requestApp(app, '/api/lab')).json()
    if (mirror.lastRun && !mirror.running) return mirror
    await sleep(20)
  }
  throw new Error('the mirror never ran')
}

test('mirror: the server copies the folder after it starts and says how it went on /api/lab', async (t) => {
  const { root, backup, copy } = await scratch(t)
  const meetings = await realpath(await fixtureDir({ index: true }))
  t.after(() => rm(meetings, { recursive: true, force: true }))
  // the made-up recordings were just written: dated an hour ago, they are settled
  const when = new Date(Date.now() - hour)
  for (const f of await scanFiles(meetings)) await utimes(f.path, when, when)
  const data = join(root, 'data')
  await mkdir(data)
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'error', () => {})
  const app = await createApp(config(meetings, data, backup), { watch: false })
  await app.start()
  const status = await mirrored(app)
  const files = await scanFiles(meetings)
  assert.deepEqual({ ...status, lastRun: undefined }, { enabled: true, folders: 1, files: files.length, copied: files.length, waiting: 0, failed: 0, lastRun: undefined, running: false })
  assert.deepEqual((await readdir(copy)).sort(), files.map((f) => f.rel).sort())
  await app.close()
  // the made-up recordings are probed in the background: let that finish before the folders go
  await sleep(500)
})

test('mirror: an unwritable backup folder is reported, and the server still starts and answers', async (t) => {
  const { root, meetings, backup } = await scratch(t)
  await put(join(meetings, 'Ada Grace - Launch planning - 2026-10-02 - notes.txt'), 'MEETING NOTES: Launch planning\nOctober 2, 2026\n')
  await mkdir(join(root, 'data'))
  await chmod(backup, 0o500)
  const errors: string[] = []
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'error', (...args: unknown[]) => void errors.push(args.map(String).join(' ')))
  const app = await createApp(config(meetings, join(root, 'data'), backup), { watch: false })
  await app.start()
  assert.equal((await requestApp(app, '/api/library')).statusCode, 200)
  const status = await mirrored(app)
  assert.deepEqual([status.enabled, status.copied, status.failed], [true, 0, 1])
  assert.ok(errors.some((e) => e.startsWith(`mirror: no copy goes to ${join(backup, 'meetings')}`)), errors.join('\n'))
  assert.equal((await requestApp(app, '/api/library')).statusCode, 200)
  await app.close()

  // without BACKUP_DIR there is no copy, and the page is told so
  await mkdir(join(root, 'data-off'))
  const off = await createApp(config(meetings, join(root, 'data-off')), { watch: false })
  await off.start()
  assert.deepEqual((await requestApp(off, '/api/lab')).json().mirror, { enabled: false, folders: 0, files: 0, copied: 0, waiting: 0, failed: 0, lastRun: null, running: false })
  await off.close()
})
