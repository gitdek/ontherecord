// The screen indexer's lock and temporary frames, in both modes: a run stopped with Ctrl-C, a closed terminal or kill
// removes them, a lock whose process is gone is taken over, and a lock that is held names its file. No FFmpeg is
// needed: a stand-in ffprobe keeps a run busy, and the fixture's recordings are not real video.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { indexScreens } from '../scripts/index-screens.ts'
import { fixtureDir } from './fixtures.test-helper.ts'
import { buildLibrary, scanFiles } from './library.ts'

const meeting = '2026-10-02-launch'
const indexer = join(import.meta.dirname, '..', 'scripts', 'index-screens.ts')
const MODES = {
  local: { flag: '--index', env: { SCREEN_SEARCH: 'local', SCREENS_URL: 'http://127.0.0.1:9', SCREENS_MODEL: 'fixture-model' }, folder: ['screens', 'local'] },
  hosted: { flag: '--send-to-gemini', env: { SCREEN_SEARCH: '1', OPENROUTER_API_KEY: 'fixture' }, folder: ['screens'] },
}
// a child process that could reach the network fails instead
const offline = `data:text/javascript,globalThis.fetch = () => { throw new Error('no network in this test') }`

async function setup(t: TestContext) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'screens-indexer-')))
  const dir = await realpath(await fixtureDir({ index: true }))
  t.after(() => Promise.all([rm(base, { recursive: true, force: true }), rm(dir, { recursive: true, force: true })]))
  const past = new Date(Date.now() - 120_000)
  for (const f of (await scanFiles(dir)).filter((x) => x.kind === 'video')) await utimes(f.path, past, past)
  const lib = await buildLibrary(await scanFiles(dir), () => ({}), [], new Map())
  const video = lib.byId.get(meeting)!.videos.find((v) => v.isDefault && v.playable)!
  const data = join(base, 'data')
  const tmp = join(base, 'tmp')
  const bin = join(base, 'bin')
  await Promise.all([mkdir(data), mkdir(tmp), mkdir(bin)])
  // keeps the run busy picking frames until it is stopped
  await writeFile(join(bin, 'ffprobe'), '#!/bin/sh\ntouch "$TMPDIR/ffprobe-started"\nexec sleep 30\n')
  await chmod(join(bin, 'ffprobe'), 0o755)
  const lock = (mode: keyof typeof MODES) => join(data, ...MODES[mode].folder, `${video.fileId}.lock`)
  const env = (mode: keyof typeof MODES) => ({ MEETINGS_DIR: dir, DATA_DIR: data, DIARIZE_PYTHON: '', ...MODES[mode].env })
  return { dir, data, tmp, bin, lock, env }
}

const leftovers = async (tmp: string) => (await readdir(tmp)).filter((name) => name.startsWith('meetings-screens-'))

test('a run stopped with Ctrl-C, a closed terminal or kill removes its lock and its temporary frames, in both modes', async (t) => {
  const { tmp, bin, lock, env } = await setup(t)
  const stops: [NodeJS.Signals, 'group' | 'process'][] = [['SIGINT', 'group'], ['SIGTERM', 'process'], ['SIGHUP', 'group']]
  for (const mode of ['local', 'hosted'] as const) {
    for (const preview of [false, true]) {
      for (const [signal, target] of preview ? stops.slice(0, 1) : stops) {
        await rm(join(tmp, 'ffprobe-started'), { force: true })
        const args = preview ? [meeting] : [meeting, MODES[mode].flag]
        const child = spawn(process.execPath, ['--import', offline, indexer, ...args], {
          env: { ...env(mode), PATH: `${bin}:/usr/bin:/bin`, HOME: tmp, TMPDIR: tmp },
          detached: true,
          stdio: ['ignore', 'ignore', 'pipe'],
        })
        t.after(() => {
          try {
            process.kill(-child.pid!, 'SIGKILL')
          } catch {
            // the run and its stand-in ffprobe are gone already
          }
        })
        let stderr = ''
        child.stderr!.on('data', (d) => (stderr += d))
        const closed = new Promise<[number | null, NodeJS.Signals | null]>((resolve) => child.on('close', (code, sig) => resolve([code, sig])))
        for (let i = 0; i < 400 && !existsSync(join(tmp, 'ffprobe-started')); i++) await sleep(25)
        const label = `${mode}${preview ? ' preview' : ''}, ${signal} to the ${target}`
        assert.ok(existsSync(join(tmp, 'ffprobe-started')), `${label}: the run is picking frames`)
        assert.equal((await leftovers(tmp)).length, 1, label)
        assert.equal(existsSync(lock(mode)), !preview, label)
        if (!preview) assert.equal(JSON.parse(await readFile(lock(mode), 'utf8')).pid, child.pid, label)
        // Ctrl-C and a closed terminal reach the whole process group, kill only the indexer
        process.kill(target === 'group' ? -child.pid! : child.pid!, signal)
        assert.deepEqual(await closed, [null, signal], `${label}: ${stderr}`)
        assert.equal(existsSync(lock(mode)), false, label)
        assert.deepEqual(await leftovers(tmp), [], label)
        assert.match(stderr, preview ? /removed its temporary frames\.$/m : /removed its temporary frames and its lock\./, label)
      }
    }
  }
})

test('a lock whose process is gone is taken over, and a held lock names its process and its file', async (t) => {
  const { lock, env } = await setup(t)
  t.mock.method(globalThis, 'fetch', async () => assert.fail('nothing is sent before frames are picked'))
  const notLocked = (error: Error) => !/already being indexed/.test(error.message)
  // the run gets past the lock, then fails picking frames: the fixture's recording is not real video
  const takesOver = async (mode: keyof typeof MODES, content: string, mtime?: Date) => {
    await mkdir(join(lock(mode), '..'), { recursive: true })
    await writeFile(lock(mode), content)
    if (mtime) await utimes(lock(mode), mtime, mtime)
    await assert.rejects(indexScreens([meeting, MODES[mode].flag], env(mode)), notLocked)
    assert.equal(existsSync(lock(mode)), false)
  }
  const before = new Date().toISOString()
  const gone = spawnSync(process.execPath, ['-e', '']).pid
  for (const mode of ['local', 'hosted'] as const) {
    // its process has ended (kill -9, a crash)
    await takesOver(mode, JSON.stringify({ pid: gone, started: before }))
    // its process id now belongs to a process that started after the lock was taken
    await takesOver(mode, JSON.stringify({ pid: process.pid, started: '2020-01-02T03:04:05.000Z' }))
    // an older version's empty lock, left long ago
    await takesOver(mode, '', new Date(Date.now() - 120_000))
  }

  for (const mode of ['local', 'hosted'] as const) {
    const held = JSON.stringify({ pid: process.pid, started: new Date().toISOString() })
    await writeFile(lock(mode), held)
    const message = `this recording is already being indexed by process ${process.pid} since`
    await assert.rejects(indexScreens([meeting, MODES[mode].flag], env(mode)), (error: Error) =>
      error.message.startsWith(message) && error.message.endsWith(`If no indexer is running, remove ${lock(mode)}`))
    assert.equal(await readFile(lock(mode), 'utf8'), held)
    // a lock that has no holder yet, being written this moment, counts as held
    await writeFile(lock(mode), '')
    await assert.rejects(indexScreens([meeting, MODES[mode].flag], env(mode)), new RegExp(`already being indexed\\. If no indexer is running, remove ${lock(mode).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`))
    assert.equal(await readFile(lock(mode), 'utf8'), '')
    await rm(lock(mode))
  }
})
