// Streaming a file: every handle it opens is closed by the time the answer is over, also when the browser
// gives up partway (a seek, a closed tab). On Node 26 a handle left for the garbage collector ends the process.
import assert from 'node:assert/strict'
import { copyFile, mkdtemp, open, rm, utimes, writeFile, type FileHandle } from 'node:fs/promises'
import { createServer, request, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import v8 from 'node:v8'
import vm from 'node:vm'
import { buildLibrary, scanFiles } from './library.ts'
import { Media, run, sendFile } from './media.ts'

test('media: a stream cut off partway, or never read, still closes its file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'meetings-media-'))
  const path = join(dir, 'clip.mp4')
  await writeFile(path, Buffer.alloc(8_000_000, 7))
  const handles: FileHandle[] = []
  const finished: Promise<void>[] = []
  const server = createServer((req, res) => {
    const opener = async () => {
      const fh = await open(path, 'r')
      handles.push(fh)
      return fh
    }
    finished.push(sendFile(req, res, opener, { size: 8_000_000, mtimeMs: 1, type: 'video/mp4' }))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address() as AddressInfo
  const ask = (opts: { method?: string; headers?: Record<string, string> }, cut: (res: IncomingMessage, req: ReturnType<typeof request>) => void) =>
    new Promise<void>((resolve) => {
      const req = request({ port, host: '127.0.0.1', ...opts }, (res) => {
        cut(res, req)
        res.on('close', resolve)
      })
      req.on('error', () => resolve())
      req.end()
    })
  try {
    // hang up after the first bytes (a seek), on the headers (a closed tab), and a HEAD that reads nothing
    await ask({}, (res, req) => res.once('data', () => req.destroy()))
    await ask({ headers: { Range: 'bytes=4000000-' } }, (_, req) => req.destroy())
    await ask({ method: 'HEAD' }, (res) => res.resume())
    await Promise.all(finished)
    assert.equal(handles.length, 3)
    assert.deepEqual(handles.map((fh) => fh.fd), [-1, -1, -1], 'every handle closed')
  } finally {
    server.closeAllConnections()
    server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('media: many cut-off streams leave no handle for the garbage collector', async () => {
  // what a browser does to a video when someone seeks and reloads quickly, with the collector run between rounds
  v8.setFlagsFromString('--expose-gc')
  const gc = vm.runInNewContext('gc') as () => void
  const dir = await mkdtemp(join(tmpdir(), 'meetings-media-'))
  const path = join(dir, 'clip.mp4')
  await writeFile(path, Buffer.alloc(4_000_000, 7))
  const server = createServer((req, res) => void sendFile(req, res, path, { size: 4_000_000, mtimeMs: 1, type: 'video/mp4' }))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address() as AddressInfo
  const shot = (i: number) =>
    new Promise<void>((resolve) => {
      const req = request({ port, host: '127.0.0.1', headers: i % 2 ? { Range: `bytes=${(i * 7919) % 3_000_000}-` } : {} }, (res) => {
        if (i % 3 === 0) return void (req.destroy(), resolve())
        res.once('data', () => (req.destroy(), resolve()))
      })
      req.on('error', () => resolve())
      req.end()
      if (i % 5 === 0) setImmediate(() => (req.destroy(), resolve()))
    })
  try {
    for (let round = 0; round < 24; round++) {
      await Promise.all(Array.from({ length: 25 }, (_, i) => shot(round * 25 + i)))
      gc()
      await new Promise((r) => setTimeout(r, 10))
    }
    await new Promise((r) => setTimeout(r, 200))
    gc()
    await new Promise((r) => setTimeout(r, 200))
  } finally {
    server.closeAllConnections()
    server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('media: a copy ffprobe cannot read is reported as failed, left out of playing, and tried again after a restart', { timeout: 120_000 }, async (t) => {
  if (!(await run('ffmpeg', ['-version'], 5000).catch(() => undefined)) || !(await run('ffprobe', ['-version'], 5000).catch(() => undefined))) {
    return t.skip('ffmpeg and ffprobe are required for the recording fixture')
  }
  const dir = await mkdtemp(join(tmpdir(), 'meetings-media-'))
  const data = await mkdtemp(join(tmpdir(), 'meetings-media-data-'))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
    await rm(data, { recursive: true, force: true })
  })
  const original = join(dir, 'Screen Recording 2026-11-03 at 4.07.09 PM.mov')
  await run('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=s=320x180:d=20:r=10', '-c:v', 'mpeg4', original], 60_000)
  // the lighter copy's ffmpeg run was stopped halfway: its index, written last, never made it
  const cut = join(dir, 'Screen Recording 2026-11-03 at 4.07.09 PM - compressed.mp4')
  await copyFile(original, cut)
  const fh = await open(cut, 'r+')
  await fh.truncate(Math.floor((await fh.stat()).size / 2))
  await fh.close()
  const past = Date.now() / 1000 - 3600
  for (const p of [original, cut]) await utimes(p, past, past)
  const files = await scanFiles(dir)
  const cutFile = files.find((f) => f.name.endsWith('compressed.mp4'))!
  // a Media that says when n probes have come back
  const counted = async (n: number) => {
    let finish!: () => void
    const done = new Promise<void>((resolve) => (finish = resolve))
    const media = new Media(data, (kind) => kind === 'probe' && --n === 0 && finish())
    await media.load()
    return { media, done }
  }

  const first = await counted(2)
  for (const f of files) first.media.facts(f)
  await first.done
  assert.equal(first.media.facts(cutFile).failed, true)
  const m = (await buildLibrary(files, (f) => first.media.facts(f), [], new Map())).meetings[0]
  assert.deepEqual(m.videos.map((v) => [v.label, v.playable, v.isDefault, v.probe?.width]), [
    ['compressed', false, false, undefined],
    ['original', true, true, 320],
  ])

  // after a restart the failure is looked at again before it counts
  const second = await counted(1)
  assert.equal(second.media.facts(cutFile).failed, undefined)
  await second.done
  assert.equal(second.media.facts(cutFile).failed, true)
})

test('media: a recording dated ahead of this Mac\'s clock is finished, not still being written', { timeout: 60_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'meetings-media-'))
  const data = await mkdtemp(join(tmpdir(), 'meetings-media-data-'))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
    await rm(data, { recursive: true, force: true })
  })
  const ahead = join(dir, 'Screen Recording 2026-11-03 at 4.07.09 PM.mov')
  const fresh = join(dir, 'Screen Recording 2026-11-04 at 9.00.00 AM.mov')
  for (const p of [ahead, fresh]) await writeFile(p, Buffer.alloc(2000, 1))
  // three hours ahead, and five seconds ago (a copy still being written)
  await utimes(ahead, Date.now() / 1000 + 3 * 3600, Date.now() / 1000 + 3 * 3600)
  await utimes(fresh, Date.now() / 1000 - 5, Date.now() / 1000 - 5)
  let finish!: () => void
  const probed = new Promise<void>((resolve) => (finish = resolve))
  const media = new Media(data, (kind) => kind === 'probe' && finish())
  await media.load()
  const lib = await buildLibrary(await scanFiles(dir), (f) => media.facts(f), [], new Map())
  const video = (name: string) => lib.meetings.flatMap((m) => m.videos).find((v) => v.name === name)!
  assert.deepEqual([video('Screen Recording 2026-11-03 at 4.07.09 PM.mov').growing, video('Screen Recording 2026-11-03 at 4.07.09 PM.mov').playable], [undefined, true])
  assert.deepEqual([video('Screen Recording 2026-11-04 at 9.00.00 AM.mov').growing, video('Screen Recording 2026-11-04 at 9.00.00 AM.mov').playable], [true, false])
  // it is probed like any other finished copy
  await probed
})
