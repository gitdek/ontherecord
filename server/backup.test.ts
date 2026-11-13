import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import type { PathLike } from 'node:fs'
import fs, { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { createServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { backup, keepBackups, nameOf, stale, verifyBackup } from './backup.ts'
import { Notebook, versionOf } from './notebook.ts'
import { Speakers } from './speakers.ts'
import { Store } from './state.ts'

const at = '2026-01-02T03:04:05.000Z'
const stamp = (day: number) => new Date(Date.UTC(2026, 10, day, 12))
const look = { meeting: (id: string) => id, task: (id: string) => id }

async function scratch(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'meetings-backup-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

test('backup: an unavailable destination retries independently and overlapping startup runs produce one recent copy', async (t) => {
  const data = await scratch(t)
  const local = join(data, 'backups')
  const external = join(data, 'external')
  const newExternal = join(data, 'new-external')
  await writeFile(join(data, 'state.json'), '{"actions":{}}')
  await writeFile(external, 'a file blocks directory listing')
  const stopFailed = await keepBackups(data, [external])
  stopFailed()
  // startup waits for data/backups only; the other folders' first copies settle in the background
  await stopFailed.elsewhere
  const localBefore = await readdir(local)
  assert.equal(localBefore.length, 1)
  await verifyBackup(join(local, localBefore[0]))
  assert.equal(await readFile(external, 'utf8'), 'a file blocks directory listing')

  await rm(external)
  const stops = await Promise.all([
    keepBackups(data, [external, newExternal]),
    keepBackups(data, [external, newExternal]),
  ])
  stops.forEach((stop) => stop())
  await Promise.all(stops.map((stop) => stop.elsewhere))
  assert.deepEqual(await readdir(local), localBefore)
  for (const dest of [external, newExternal]) {
    const names = await readdir(dest)
    assert.equal(names.length, 1)
    assert.deepEqual((await verifyBackup(join(dest, names[0]))).map((file) => file.path), ['state.json'])
  }
})

test('backup: a folder on a disk that cannot keep files private is named once, with what to do, and not tried again', async (t) => {
  const data = await scratch(t)
  const local = join(data, 'backups')
  const exfat = join(data, 'exfat', 'meetings')
  const day = 24 * 3_600_000
  await writeFile(join(data, 'state.json'), '{"tasks":[]}')
  // exFAT: every file and folder reads back as 0700 whatever it was written as, and macOS adds an AppleDouble
  // ._ file beside each entry
  const onExfat = (path: unknown) => String(path).startsWith(exfat)
  const lstat = fs.lstat
  const readdirReal = fs.readdir
  const stats = t.mock.method(fs, 'lstat', async (...args: Parameters<typeof fs.lstat>) => {
    const info = await lstat(...args)
    if (onExfat(args[0])) info.mode = (Number(info.mode) & ~0o777) | 0o700
    return info
  })
  const listings = t.mock.method(fs, 'readdir', async (...args: Parameters<typeof fs.readdir>) => {
    const names = await (readdirReal as (...a: unknown[]) => Promise<unknown[]>)(...args)
    return onExfat(args[0]) && names.every((n) => typeof n === 'string') ? [...names, ...names.map((n) => `._${n}`)] : names
  })
  const errors = t.mock.method(console, 'error', () => {})
  syncBuiltinESMExports()
  try {
    const first = await backup(data, [local, exfat], stamp(1), 3_600_000)
    assert.deepEqual(first.map(dirname), [local])
    assert.equal(errors.mock.callCount(), 1)
    const said = String(errors.mock.calls[0].arguments[0])
    assert.ok(said.includes(exfat), said)
    assert.match(said, /reads back as 700.*APFS or Mac OS Extended/)
    const [statsBefore, listingsBefore] = [stats.mock.callCount(), listings.mock.callCount()]
    const next = await backup(data, [local, exfat], stamp(2), day)
    assert.deepEqual(next.map(dirname), [local])
    assert.equal(errors.mock.callCount(), 1, 'reported once')
    const calls = [...stats.mock.calls.slice(statsBefore), ...listings.mock.calls.slice(listingsBefore)]
    assert.ok(!calls.some((c) => onExfat(c.arguments[0])), 'not tried again')
  } finally {
    stats.mock.restore()
    listings.mock.restore()
    syncBuiltinESMExports()
  }
  assert.deepEqual(await readdir(exfat), [])
})

// Without the fix, keepBackups never resolves and the timeout fails the test.
test('backup: startup waits only for the copy in data/backups, and a folder that never answers fails its run after the limit', { timeout: 5000 }, async (t) => {
  const data = await scratch(t)
  const local = join(data, 'backups')
  const share = join(data, 'asleep-share')
  await writeFile(join(data, 'state.json'), '{"actions":{}}')
  // a network share whose host is asleep: listing it never returns
  const list = fs.readdir as (...args: unknown[]) => Promise<unknown>
  const asleep = t.mock.method(fs, 'readdir', (path: PathLike, ...rest: unknown[]) => (String(path).startsWith(share) ? new Promise(() => {}) : list(path, ...rest)))
  syncBuiltinESMExports()
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const errors = t.mock.method(console, 'error', () => {})
  try {
    const stop = await keepBackups(data, [share])
    stop()
    const [copy] = await readdir(local)
    await verifyBackup(join(local, copy))
    assert.ok(asleep.mock.calls.some((c) => String(c.arguments[0]) === share), 'the share was asked and has not answered')
    assert.equal(errors.mock.callCount(), 0)
    t.mock.timers.tick(10 * 60_000)
    await stop.elsewhere
    assert.deepEqual(errors.mock.calls.map((c) => c.arguments[0]), [`backup: failed in ${share} (no answer in 10 minutes)`])
  } finally {
    asleep.mock.restore()
    syncBuiltinESMExports()
  }
})

test('backup: missing source files are allowed, and a read error or invalid saved record stops the entire copy', async (t) => {
  const data = await scratch(t)
  const dest = join(data, 'backups')
  const state = join(data, 'state.json')
  await writeFile(join(data, 'notebook.json'), '{"notes":[]}')
  const [good] = await backup(data, [dest], stamp(1))
  assert.deepEqual((await verifyBackup(good)).map((file) => file.path), ['notebook.json'])

  await symlink(state, state)
  assert.deepEqual(await backup(data, [dest], stamp(2)), [])
  assert.deepEqual(await readdir(dest), [basename(good)])
  await rm(state)
  await writeFile(state, '{"tasks":{}}')
  assert.deepEqual(await backup(data, [dest], stamp(2)), [])
  assert.deepEqual(await readdir(dest), [basename(good)])
  await verifyBackup(good)
})

test('backup: a failed startup attempt stays due at the next hourly check', async (t) => {
  const data = await scratch(t)
  const local = join(data, 'backups')
  const external = join(data, 'external')
  const now = stamp(1)
  const hour = 3_600_000
  await writeFile(join(data, 'state.json'), '{}')
  const [oldExternal] = await backup(data, [external], new Date(now.getTime() - 2 * hour))
  const rename = fs.rename
  const patch = t.mock.method(fs, 'rename', async (from: PathLike, to: PathLike) => {
    if (typeof to === 'string' && dirname(to) === external) throw new Error('injected external publication failure')
    return rename(from, to)
  })
  syncBuiltinESMExports()
  let created: string[]
  try {
    created = await backup(data, [local, external], now, hour)
    assert.deepEqual(created.map(dirname), [local])
    assert.deepEqual(await readdir(external), [basename(oldExternal)])
  } finally {
    patch.mock.restore()
    syncBuiltinESMExports()
  }
  const nextHour = new Date(now.getTime() + hour)
  const retried = await backup(data, [local, external], nextHour, 24 * hour)
  assert.deepEqual(retried.map(dirname), [external])
  await verifyBackup(retried[0])
  assert.deepEqual(await readdir(local), created.map((path) => basename(path)))
  assert.deepEqual(await backup(data, [local, external], nextHour, 24 * hour), [])
})

test('backup: a copy taken while the clock ran ahead is kept and named, and the daily copies go on', async (t) => {
  const data = await scratch(t)
  const dest = join(data, 'backups')
  const day = 24 * 3_600_000
  await writeFile(join(data, 'state.json'), '{"tasks":[]}')
  const daily: string[] = []
  for (let d = 1; d <= 7; d++) daily.push(basename((await backup(data, [dest], stamp(d), day))[0]))
  // the clock jumps a year ahead for one hourly check, and the retention it runs under keeps only three
  const [future] = (await backup(data, [dest], new Date(Date.UTC(2027, 10, 7, 12)), day)).map((path) => basename(path))
  assert.ok(future)
  assert.deepEqual((await readdir(dest)).sort(), [daily[5], daily[6], future].sort())

  // the clock is corrected and the board keeps changing: a copy is due every day again
  const warnings = t.mock.method(console, 'warn', () => {})
  for (let d = 8; d <= 30; d++) {
    await writeFile(join(data, 'state.json'), JSON.stringify({ tasks: [], prefs: { Ada: { theme: d % 2 ? 'dark' : 'light' } } }))
    const [copy] = await backup(data, [dest], stamp(d), day)
    assert.ok(copy, `day ${d}: a copy`)
    daily.push(basename(copy))
  }
  const named = warnings.mock.calls.map((c) => String(c.arguments[0]))
  assert.equal(named.length, 1)
  assert.ok(named[0].includes(join(dest, future)), named[0])
  // the copy dated ahead stays, without taking one of the three newest places or a real day's
  assert.deepEqual((await readdir(dest)).sort(), [...daily.slice(-8), future].sort())
  assert.deepEqual(stale([...daily.slice(-3), future], stamp(30).getTime()), [])
})

test('backup: partial writes and checksum failures leave verified snapshots intact, and retention ignores unrelated paths', async (t) => {
  const data = await scratch(t)
  const dest = join(data, 'backups')
  await writeFile(join(data, 'state.json'), '{"tasks":[]}')
  await writeFile(join(data, 'notebook.json'), '{"notes":[]}')
  const retained = []
  for (const day of [1, 2, 3]) {
    const [snapshot] = await backup(data, [dest], stamp(day))
    retained.push(snapshot)
  }
  const unrelated = ['unrelated.partial', nameOf(stamp(1)), `${nameOf(stamp(1))}-${'0'.repeat(32)}`]
  for (const name of unrelated) {
    await mkdir(join(dest, name))
    await writeFile(join(dest, name, 'keep'), 'keep me')
  }
  // New-looking but damaged. It must count neither as a recent success nor as a retention candidate.
  const damaged = `${nameOf(stamp(20))}-${'f'.repeat(32)}`
  await cp(retained[2], join(dest, damaged), { recursive: true })
  await writeFile(join(dest, damaged, 'state.json'), '{"prefs":{}}')
  await assert.rejects(verifyBackup(join(dest, damaged)), /checksum mismatch/)
  const before = (await readdir(dest)).sort()

  for (const fault of ['write', 'checksum']) {
    let injected = false
    const write = fs.writeFile
    const patch = t.mock.method(fs, 'writeFile', async (...args: Parameters<typeof writeFile>) => {
      const [path, , options] = args
      if (typeof path !== 'string' || !path.startsWith(join(dest, '.meetings-backup-')) || basename(path) !== 'notebook.json') return write(...args)
      await stat(join(dirname(path), 'state.json'))
      injected = true
      await write(path, '{"partial":', options)
      if (fault === 'write') throw Object.assign(new Error('injected partial write'), { code: 'EIO' })
    })
    syncBuiltinESMExports()
    try {
      assert.deepEqual(await backup(data, [dest], stamp(20)), [])
    } finally {
      patch.mock.restore()
      syncBuiltinESMExports()
    }
    assert.ok(injected)
    assert.deepEqual((await readdir(dest)).sort(), before)
    for (const snapshot of retained) await verifyBackup(snapshot)
  }

  const [current] = await backup(data, [dest], stamp(20), 3_600_000)
  await verifyBackup(current)
  await assert.rejects(stat(retained[0]), { code: 'ENOENT' })
  for (const snapshot of retained.slice(1)) await verifyBackup(snapshot)
  for (const name of unrelated) assert.equal(await readFile(join(dest, name, 'keep'), 'utf8'), 'keep me')
  await assert.rejects(verifyBackup(join(dest, damaged)), /checksum mismatch/)
})

test('backup: copies in the earlier format go after a week once three verified copies exist, and only if they hold what it copied', async (t) => {
  const data = await scratch(t)
  const dest = join(data, 'backups')
  await writeFile(join(data, 'state.json'), '{"tasks":[]}')
  const earlier = async (day: number, files: string[]) => {
    const dir = join(dest, nameOf(stamp(day)))
    await mkdir(join(dir, 'speakers'), { recursive: true })
    for (const file of files) await writeFile(join(dir, file), '{}')
    return dir
  }
  const old = await earlier(1, ['state.json', 'notebook.json'])
  const recent = await earlier(18, ['state.json'])
  const foreign = join(dest, nameOf(stamp(2)))
  await mkdir(foreign)
  await writeFile(join(foreign, 'notes.txt'), 'keep me')
  const [current] = await backup(data, [dest], stamp(20))
  await verifyBackup(current)
  // the newest three earlier copies stay until three verified copies are here
  assert.ok((await stat(old)).isDirectory())
  for (const day of [21, 22]) await backup(data, [dest], stamp(day))
  await assert.rejects(stat(old), { code: 'ENOENT' })
  assert.ok((await stat(recent)).isDirectory())
  assert.equal(await readFile(join(foreign, 'notes.txt'), 'utf8'), 'keep me')
})

test('backup: after a gap of more than a week, the newest three earlier-format copies stay until three verified copies exist', async (t) => {
  const data = await scratch(t)
  const dest = join(data, 'backups')
  const day = 24 * 3_600_000
  await writeFile(join(data, 'state.json'), '{"tasks":[]}')
  await writeFile(join(data, 'notebook.json'), '{"notes":[]}')
  // what the earlier version left on a disk that was then not mounted for weeks: its copies hold the board,
  // the notebook and the whole speakers folder
  const earlier = [new Date(Date.UTC(2026, 9, 1, 6)), ...[20, 21, 22].map((d) => new Date(Date.UTC(2026, 9, d, 6)))].map(nameOf)
  for (const name of earlier) {
    await mkdir(join(dest, name, 'speakers'), { recursive: true })
    for (const file of ['state.json', 'notebook.json', 'speakers/names.json', 'speakers/f1-0123.json']) await writeFile(join(dest, name, file), '{"notes":[]}')
  }
  const left = async () => (await readdir(dest)).filter((n) => earlier.includes(n)).sort()
  await backup(data, [dest], stamp(11), day)
  assert.deepEqual(await left(), earlier.slice(1), 'only the oldest, beyond the newest three, goes')
  await backup(data, [dest], stamp(12), day)
  assert.deepEqual(await left(), earlier.slice(1))
  await backup(data, [dest], stamp(13), day)
  assert.deepEqual(await left(), [], 'with three verified copies here, a week is the limit again')
  assert.equal((await readdir(dest)).length, 3)
})

test('backup: a snapshot opened in Finder still verifies and is pruned on schedule, and other extra entries still fail', async (t) => {
  const data = await scratch(t)
  const dest = join(data, 'backups')
  const day = 24 * 3_600_000
  await writeFile(join(data, 'state.json'), '{"tasks":[]}')
  await mkdir(join(data, 'speakers'), { mode: 0o700 })
  await writeFile(join(data, 'speakers', 'names.json'), '{}')
  const finder = 'Finder view settings'
  // an earlier-format copy someone browsed, from before the first verified copy
  const earlier = join(dest, nameOf(new Date(Date.UTC(2026, 9, 25, 12))))
  await mkdir(earlier, { recursive: true })
  await writeFile(join(earlier, 'state.json'), '{"tasks":[]}')
  await writeFile(join(earlier, '.DS_Store'), finder)
  const [first] = await backup(data, [dest], stamp(1), day)
  await writeFile(join(first, '.DS_Store'), finder)
  await writeFile(join(first, '._state.json'), finder)
  const [second] = await backup(data, [dest], stamp(2), day)
  await writeFile(join(second, 'speakers', '.DS_Store'), finder)
  await writeFile(join(second, 'speakers', '._names.json'), finder)
  for (const snapshot of [first, second]) assert.deepEqual((await verifyBackup(snapshot)).map((f) => f.path), ['state.json', 'speakers/names.json'])
  const [other] = await backup(data, [dest], stamp(3), day)
  await writeFile(join(other, 'notes.txt'), 'not part of a copy')
  await assert.rejects(verifyBackup(other), /unexpected backup directory entries/)
  await rm(join(other, 'notes.txt'))

  // the newest of each day stays for a week, then goes
  for (let d = 4; d <= 8; d++) await backup(data, [dest], stamp(d), day)
  assert.ok((await stat(first)).isDirectory())
  await backup(data, [dest], stamp(9), day)
  await assert.rejects(stat(first), { code: 'ENOENT' })
  assert.ok((await stat(second)).isDirectory())
  await backup(data, [dest], stamp(10), day)
  await assert.rejects(stat(second), { code: 'ENOENT' })
  await assert.rejects(stat(earlier), { code: 'ENOENT' })
})

test('backup: publishing a copy syncs its folder after the rename', async (t) => {
  const data = await scratch(t)
  const dest = join(data, 'backups')
  await writeFile(join(data, 'state.json'), '{"tasks":[]}')
  const events: string[] = []
  const rename = fs.rename
  const open = fs.open
  const renames = t.mock.method(fs, 'rename', async (from: PathLike, to: PathLike) => {
    await rename(from, to)
    if (typeof to === 'string' && dirname(to) === dest) events.push(`rename ${basename(to)}`)
  })
  const opens = t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args)
    if (args[0] !== dest) return handle
    const sync = handle.sync.bind(handle)
    handle.sync = async () => {
      await sync()
      events.push('sync folder')
    }
    return handle
  })
  syncBuiltinESMExports()
  try {
    const [copy] = await backup(data, [dest], stamp(1))
    assert.deepEqual(events, [`rename ${basename(copy)}`, 'sync folder'])
  } finally {
    renames.mock.restore()
    opens.mock.restore()
    syncBuiltinESMExports()
  }
})

test('backup: concurrent forced copies at the same timestamp have distinct verified paths', async (t) => {
  const data = await scratch(t)
  const dest = join(data, 'backups')
  await writeFile(join(data, 'state.json'), '{}')
  const results = (await Promise.all(Array.from({ length: 3 }, () => backup(data, [dest, dest], stamp(1))))).flat()
  assert.equal(results.length, 3)
  assert.equal(new Set(results).size, 3)
  for (const path of results) {
    assert.match(basename(path), /^2026-11-01T120000Z-[a-f0-9]{32}$/)
    await verifyBackup(path)
  }
  assert.equal((await readdir(dest)).length, 3)
})

test('backup restore: fixture board, notebook and speaker names load and round-trip with private permissions', async (t) => {
  const root = await scratch(t)
  const data = join(root, 'source')
  const namesPath = 'speakers/names.json'
  const boardPath = join(data, 'state.json')
  const notePath = join(data, 'notebook.json')
  await mkdir(join(data, 'speakers'), { recursive: true, mode: 0o700 })
  const aliases = { 'renamed-id': 'legacy-id' }
  const seen = { 'legacy-id': { meeting: 'meeting-id', date: '2026-01-02', text: 'Review the decision' } }
  await writeFile(boardPath, JSON.stringify({ aliases, seen, actions: { 'legacy-id': { done: true, by: 'Ada', at } } }))
  const speakerNames = {
    'recording-id': {
      0: { name: 'Grace', by: 'Ada', at, voiceprint: [0.9, -0.2, 0.1] },
      1: { name: 'Ada' },
    },
  }
  await writeFile(join(data, namesPath), JSON.stringify(speakerNames))
  await writeFile(join(data, 'speakers', 'cache.json'), '{}')
  await writeFile(join(data, 'generated.key'), 'not part of the backup')

  const board = new Store(boardPath)
  const nb = new Notebook(notePath)
  await Promise.all([board.load(), nb.load()])
  const task = await board.addTask({ text: 'Write the report', owner: 'Grace', lane: 'us', meetingId: 'meeting-id' }, 'Ada')
  await board.change(task.id, { status: 'done', evidence: 'Reviewed' }, 'Grace')
  await board.deleteTask(task.id, 'Ada')
  await Promise.all([board.setSync('meeting-id', -14.25, 'Grace'), board.setTheme('Ada', 'dark')])
  const note = await nb.create({ title: 'Design choice', body: 'Original', meetingIds: ['meeting-id'], taskIds: ['legacy-id'] }, 'Ada', look)
  await nb.update(note.id, { body: 'Revised', ifVersion: 1 }, 'Grace', look)
  await nb.remove(note.id, 'Ada')
  await nb.restore(note.id, 'Grace')

  const [snapshot] = await backup(data, [join(root, 'backups')], stamp(1))
  const files = await verifyBackup(snapshot)
  assert.deepEqual(files.map(({ path }) => path), ['state.json', 'notebook.json', namesPath])
  const restored = join(root, 'restore')
  await mkdir(join(restored, 'speakers'), { recursive: true, mode: 0o700 })
  for (const { path } of files) {
    const source = join(snapshot, path)
    const destination = join(restored, path)
    await writeFile(destination, await readFile(source), { mode: 0o600 })
    assert.equal((await stat(source)).mode & 0o777, 0o600)
    assert.equal((await stat(destination)).mode & 0o777, 0o600)
    assert.deepEqual(await readFile(destination), await readFile(join(data, path)))
  }
  for (const dir of [snapshot, join(snapshot, 'speakers'), restored, join(restored, 'speakers')]) {
    assert.equal((await stat(dir)).mode & 0o777, 0o700)
  }

  const copyBoard = new Store(join(restored, 'state.json'))
  const copyNotes = new Notebook(join(restored, 'notebook.json'))
  const cfg = { python: '', segmentation: '', embedding: '', script: '', readText: '' }
  const copySpeakers = new Speakers(restored, cfg, () => {})
  await Promise.all([copyBoard.load(), copyNotes.load(), copySpeakers.load()])
  assert.deepEqual(copyBoard.state, board.state)
  assert.deepEqual(copyBoard.state.aliases, aliases)
  assert.equal(copyBoard.state.sync['meeting-id'].offset, -14.25)
  assert.equal(copyBoard.state.actions['legacy-id'].done?.by, 'Ada')
  assert.equal(copyBoard.state.trash.length, 1)
  assert.equal(copyBoard.state.trash[0].task.id, task.id)
  assert.equal(copyBoard.state.trash[0].state?.rev, 1)
  assert.deepEqual(copyNotes.list(), [note])
  assert.equal(versionOf(copyNotes.get(note.id)!), 2)
  assert.equal(copyNotes.get(note.id)?.revisions[0].body, 'Original')
  assert.deepEqual(copySpeakers.known(), ['Ada', 'Grace'])
  assert.deepEqual(JSON.parse(await readFile(join(restored, namesPath), 'utf8')), speakerNames)
  assert.deepEqual(await copyBoard.restoreTask(task.id, 'Grace'), task)
  const reread = new Store(join(restored, 'state.json'))
  await reread.load()
  assert.deepEqual(reread.state.tasks, [task])
  assert.equal(reread.state.actions[task.id].rev, 2)
  assert.deepEqual(reread.state.trash, [])
})

test('npm run backup: a verified snapshot now of a made-up data folder, refused while something answers on the port', async (t) => {
  const root = await scratch(t)
  const data = join(root, 'data')
  const elsewhere = join(root, 'elsewhere')
  await mkdir(join(data, 'speakers'), { recursive: true, mode: 0o700 })
  await writeFile(join(data, 'state.json'), JSON.stringify({ tasks: [{ id: 't-0123456789', text: 'Order the banner', owner: 'Ada', lane: 'us', createdBy: 'Ada', createdAt: at }] }))
  await writeFile(join(data, 'notebook.json'), JSON.stringify({ notes: [] }))
  await writeFile(join(data, 'speakers', 'names.json'), JSON.stringify({ 'recording-id': { 0: { name: 'Grace', by: 'Ada', at, voiceprint: [0.5, 0.5] } } }))
  // a stand-in for the server: something that answers on the port
  const server = createServer((socket) => socket.end())
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  t.after(() => { if (server.listening) server.close() })
  const port = String((server.address() as AddressInfo).port)
  const command = (dataDir: string, ...args: string[]) => new Promise<{ code: number; out: string; err: string }>((done) => {
    // only what the command reads: never the live port, data folder or .env
    const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: root, HOST: '127.0.0.1', PORT: port, DATA_DIR: dataDir, BACKUP_DIR: elsewhere }
    execFile(process.execPath, [join(import.meta.dirname, '..', 'scripts', 'backup.ts'), ...args], { env }, (error, out, err) => done({ code: error ? Number(error.code) : 0, out, err }))
  })

  const refused = await command(data)
  assert.equal(refused.code, 1)
  assert.match(refused.err, /answers on 127\.0\.0\.1:\d+.*\n.*launchctl bootout gui\/\$\(id -u\)\/ontherecord\.server/)
  await assert.rejects(stat(join(data, 'backups')), { code: 'ENOENT' })
  const anyway = await command(data, '--while-running')
  assert.equal(anyway.code, 0, anyway.err)

  await new Promise((done) => server.close(done))
  const made = await command(data)
  assert.equal(made.code, 0, made.err)
  const copies = [...made.out.matchAll(/^backup: verified copy in (.+)$/gm)].map((m) => m[1])
  assert.deepEqual(copies.map(dirname), [join(data, 'backups'), elsewhere])
  for (const copy of copies) {
    assert.deepEqual((await verifyBackup(copy)).map((file) => file.path), ['state.json', 'notebook.json', 'speakers/names.json'])
    assert.deepEqual(await readFile(join(copy, 'state.json')), await readFile(join(data, 'state.json')))
  }
  assert.equal((await readdir(join(data, 'backups'))).length, 2, 'one copy each run')

  // the copy checks the files with this checkout's readers: a board it can't start on fails here, named
  await writeFile(join(data, 'state.json'), JSON.stringify({ actions: { a1b2c3d4e5: { done: { by: 'Ada', at: 1794443266021 } } } }))
  const invalid = await command(data)
  assert.equal(invalid.code, 1)
  assert.match(invalid.err, /invalid board action record "a1b2c3d4e5": done\.at/)
  assert.match(invalid.err, /no copy in .*data\/backups; the reason is above/)

  const empty = await command(join(root, 'no-data'))
  assert.equal(empty.code, 1)
  assert.match(empty.err, /Nothing to copy: .*no-data holds no board, notebook or speaker names/)
})
