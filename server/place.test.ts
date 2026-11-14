// Placing files beside a recording, the only writing the server does in the meetings folder: it adds, it never
// writes over anything, and the files of one transcript go in together or not at all.
import assert from 'node:assert/strict'
import fs, { mkdtemp, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { scanFiles, StaleFile } from './library.ts'
import { placeBeside } from './place.ts'

const RECORDING = 'Northwind roast review 2026-11-03.mp4'
const TXT = 'Northwind roast review 2026-11-03 - transcript.txt'
const JSON_NAME = 'Northwind roast review 2026-11-03 - transcript.json'
const files = (tag: string) => [
  { name: TXT, text: `MACHINE TRANSCRIPT: Roast review (${tag})\n\n[00:00:01 - 00:00:04] Ada: The light roast sold out.\n` },
  { name: JSON_NAME, text: `{"segments":[{"start":1,"end":4,"text":" The light roast sold out. (${tag})"}]}\n` },
]

async function folder() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'meetings-place-')))
  await writeFile(join(dir, RECORDING), Buffer.alloc(2000, 1))
  const recording = (await scanFiles(dir)).find((f) => f.name === RECORDING)!
  return { dir, recording, done: () => rm(dir, { recursive: true, force: true }) }
}

// what is in the folder, hidden names included, and what each file says
const contents = async (dir: string) => {
  const out: Record<string, string> = {}
  for (const name of (await readdir(dir)).sort()) out[name] = name === RECORDING ? '(recording)' : await readFile(join(dir, name), 'utf8')
  return out
}

// link() behaving as the disk in question would, for the length of one test
function linkAs(t: TestContext, fake: (from: string, to: string, real: typeof fs.link) => Promise<void>) {
  const real = fs.link
  const mocked = t.mock.method(fs, 'link', (from: string, to: string) => fake(from, to, real))
  syncBuiltinESMExports()
  t.after(() => {
    mocked.mock.restore()
    syncBuiltinESMExports()
  })
}

test('files are placed beside the recording whole, and a name that is taken is never written over', async () => {
  const f = await folder()
  try {
    assert.deepEqual(await placeBeside(f.recording, files('first')), [TXT, JSON_NAME])
    const first = await contents(f.dir)
    assert.deepEqual(Object.keys(first), [JSON_NAME, TXT, RECORDING], 'no hidden file is left behind')
    assert.match(first[TXT], /\(first\)/)
    // the same names again: nothing changes
    assert.deepEqual(await placeBeside(f.recording, files('second')), [])
    assert.deepEqual(await contents(f.dir), first)
    // a transcript someone dropped in by hand under one of the names: neither file goes in
    await rm(join(f.dir, TXT))
    await rm(join(f.dir, JSON_NAME))
    await writeFile(join(f.dir, TXT), 'typed by Grace')
    assert.deepEqual(await placeBeside(f.recording, files('third')), [])
    assert.deepEqual(await contents(f.dir), { [RECORDING]: '(recording)', [TXT]: 'typed by Grace' }, 'its twin is not added either')
  } finally {
    await f.done()
  }
})

test('the hidden name a file is written under first is never scanned as part of the archive', async (t) => {
  const f = await folder()
  try {
    let seen: string[] | undefined
    linkAs(t, async (from, to, real) => {
      // the moment both files are written and neither is named yet: the scan sees the folder as it was
      if (!seen) {
        seen = (await scanFiles(f.dir)).map((x) => x.name)
        assert.equal((await readdir(f.dir)).filter((n) => /^\.[0-9a-f-]{36}\.writing$/.test(n)).length, 2, 'the hidden files are there')
      }
      return real(from, to)
    })
    await placeBeside(f.recording, files('hidden'))
    assert.deepEqual(seen, [RECORDING])
    assert.deepEqual((await scanFiles(f.dir)).map((x) => x.name).sort(), [JSON_NAME, TXT, RECORDING])
  } finally {
    await f.done()
  }
})

test('a name taken while the files go in takes back the ones already placed, and only those', async (t) => {
  const f = await folder()
  try {
    linkAs(t, async (from, to, real) => {
      // someone saves a JSON transcript of their own just as the first file goes in
      if (to.endsWith('.json')) await writeFile(to, 'saved by Linus')
      return real(from, to)
    })
    assert.deepEqual(await placeBeside(f.recording, files('race')), [])
    assert.deepEqual(await contents(f.dir), { [RECORDING]: '(recording)', [JSON_NAME]: 'saved by Linus' })
  } finally {
    await f.done()
  }
})

test('on a disk without hard links each file is created under its own name, still only where none is', async (t) => {
  const f = await folder()
  try {
    let tries = 0
    linkAs(t, async () => {
      tries++
      throw Object.assign(new Error('operation not supported on this disk'), { code: 'ENOTSUP' })
    })
    assert.deepEqual(await placeBeside(f.recording, files('exfat')), [TXT, JSON_NAME])
    assert.equal(tries, 1, 'once the disk says it has no links, the rest are not tried')
    const placed = await contents(f.dir)
    assert.deepEqual(Object.keys(placed), [JSON_NAME, TXT, RECORDING])
    assert.match(placed[JSON_NAME], /\(exfat\)/)
    assert.deepEqual(await placeBeside(f.recording, files('again')), [])
    assert.deepEqual(await contents(f.dir), placed)
  } finally {
    await f.done()
  }
})

test('a recording that changed since the scan, or a name that is not a plain file name, is refused', async () => {
  const f = await folder()
  try {
    for (const name of ['', '.hidden.txt', 'sub/notes.txt', '..', `${'x'.repeat(241)}.txt`]) {
      await assert.rejects(placeBeside(f.recording, [{ name, text: 'x' }]), /is not a name a file can be placed under/)
    }
    await assert.rejects(placeBeside(f.recording, [files('a')[0], files('b')[0]]), /same name/)
    // the recording swapped for another file under its name. The new one is written first and renamed over it, so
    // the two exist at once and can't share an inode number: Linux gives a deleted file's number to the next new one.
    await writeFile(join(f.dir, 'replacement.part'), Buffer.alloc(10, 2))
    await rename(join(f.dir, 'replacement.part'), join(f.dir, RECORDING))
    await assert.rejects(placeBeside(f.recording, files('stale')), StaleFile)
    assert.deepEqual(await readdir(f.dir), [RECORDING])
  } finally {
    await f.done()
  }
})
