// The running app and the meetings folder over time: a meeting whose id changes as its files arrive, and a
// folder moved while the server runs, through the app's own handler on temp copies of the synthetic folder.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { createApp } from './app.ts'
import { configFrom } from './config.ts'
import { fixtureDir, requestApp } from './fixtures.test-helper.ts'

test('a meeting the index renames keeps its clock sync, its shared link and its notebook links', async (t) => {
  // real paths: the server refuses a meetings folder reached through a symlink
  const dir = await realpath(await fixtureDir())
  const data = await realpath(await mkdtemp(join(tmpdir(), 'meetings-ids-')))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
    await rm(data, { recursive: true, force: true })
  })
  const cfg = configFrom({ PORT: '8798', MEETINGS_DIR: dir, DATA_DIR: data, DIARIZE_PYTHON: '', LOCAL_USER: 'Ada' })
  // the request log
  t.mock.method(console, 'log', () => {})
  const first = await createApp(cfg, { watch: false, backups: false })
  await first.start()
  const before = first.lib().meetings.find((m) => m.timeBase === 'clock')!.id
  assert.equal(before, '2026-10-05-demo-day')
  assert.equal((await requestApp(first, `/api/meetings/${before}/sync`, { offset: 13 * 3600 })).statusCode, 200)
  assert.equal((await requestApp(first, '/api/notebook', { title: 'Demo follow-up', body: 'What the demo showed.', meetingIds: [before] })).statusCode, 200)
  await first.close()

  // the next day the index lists the meeting under an id of its own
  await writeFile(join(dir, 'meetings-index.json'), JSON.stringify({ sessions: [{ id: '2026-10-05-demo', date: '2026-10-05', title: 'Demo day', transcript: 'Demo day - 2026-10-05 - source.txt' }] }))
  const app = await createApp(cfg, { watch: false, backups: false })
  await app.start()
  t.after(() => app.close())
  const demo = app.lib().meetings.find((m) => m.timeBase === 'clock')!
  assert.equal(demo.id, '2026-10-05-demo')
  assert.equal((await requestApp(app, `/api/meetings/${demo.id}`)).json().sync?.offset, 13 * 3600, 'the confirmed sync still applies')
  const old = await requestApp(app, `/api/meetings/${before}`)
  assert.equal(old.statusCode, 200, 'a link shared under the old id still opens the meeting')
  assert.equal(old.json().id, demo.id)
  const note = (await requestApp(app, '/api/notebook')).json().notes.find((n: { title: string }) => n.title === 'Demo follow-up')
  assert.equal(app.lib().byId.get(note.meetingIds[0]), demo, 'the notebook link still finds it')

  // the next sync someone writes is kept under the id the meeting has now
  assert.equal((await requestApp(app, `/api/meetings/${demo.id}/sync`, { offset: 13 * 3600 + 5 })).statusCode, 200)
  assert.deepEqual(Object.keys(app.store.state.sync), [demo.id])
  assert.equal((await requestApp(app, `/api/meetings/${before}`)).json().sync?.offset, 13 * 3600 + 5)
  assert.equal((await requestApp(app, `/api/meetings/${before}/sync`, { offset: null })).statusCode, 200)
  assert.deepEqual(app.store.state.sync, {})
})

// elsewhere a file still opens through a link above it, so nothing sends the server to scan again
const skip = process.platform !== 'darwin' && 'only macOS refuses a link anywhere in a path'
test('a meetings folder moved and linked back while the server runs keeps the archive it had, and says so once', { skip }, async (t) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'meetings-moved-')))
  t.after(() => rm(base, { recursive: true, force: true }))
  const folder = join(base, 'meetings')
  await rename(await realpath(await fixtureDir({ index: true })), folder)
  const data = join(base, 'data')
  await mkdir(data)
  const errors: string[] = []
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'error', (...args: unknown[]) => void errors.push(args.map(String).join(' ')))
  const app = await createApp(configFrom({ PORT: '8798', MEETINGS_DIR: folder, DATA_DIR: data, DIARIZE_PYTHON: '' }), { watch: false, backups: false })
  await app.start()
  t.after(() => app.close())
  const before = app.lib()
  const video = [...before.files.values()].find((f) => f.kind === 'video')!
  await rename(folder, join(base, 'moved'))
  await symlink(join(base, 'moved'), folder)
  // a file that won't open through the link sends the server to scan again at once, twice here
  for (let i = 1; i <= 2; i++) {
    assert.equal((await requestApp(app, `/media/${video.id}`)).statusCode, 404)
    for (let n = 0; n < 100 && errors.filter((e) => e.includes('rebuild failed')).length < i; n++) await sleep(20)
  }
  assert.equal(app.lib(), before, 'the last good library keeps serving')
  assert.equal(app.lib().meetings.length, 2)
  assert.equal(errors.filter((e) => e.startsWith('library: the meetings folder')).length, 1)
})
