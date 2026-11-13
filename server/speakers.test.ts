import assert from 'node:assert/strict'
import { existsSync, type PathLike } from 'node:fs'
import fs, { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { backup } from './backup.ts'
import { fixtureDir } from './fixtures.test-helper.ts'
import { buildLibrary, scanFiles, type FileEntry, type MediaFacts, type ParseCache } from './library.ts'
import { cleanName, decodeSavedNames, resultKey, SpeakerError, speakerPerLine, Speakers, type Turn, type Voice } from './speakers.ts'
import { shortHash } from './text.ts'

const facts = (f: FileEntry): MediaFacts => (/\.mp4$/.test(f.name) ? { probe: { duration: 1200, hasAudio: true } } : {})
const RESULT = {
  version: 1,
  duration: 1199,
  turns: [
    [58, 66, 0],
    [69, 76, 1],
    [129, 141, 0],
    [249, 263, 1],
  ],
  speakers: { '0': { seconds: 20, voiceprint: [1, 0, 0] }, '1': { seconds: 21, voiceprint: [0, 1, 0] } },
}

async function setup() {
  const dir = await fixtureDir({ index: true })
  const data = await mkdtemp(join(tmpdir(), 'meetings-speakers-'))
  const cache: ParseCache = new Map()
  const lib = await buildLibrary(await scanFiles(dir), facts, ['Ada Byron'], cache)
  const launch = lib.meetings.find((m) => m.id === '2026-10-02-launch')!
  const src = lib.transcripts.get(launch.primaryTranscript!)!
  const recording = lib.files.get(launch.videos.find((v) => v.transcriptId === src.id)!.fileId)!
  const key = resultKey(recording, src.parsed.segments)
  const done = async () => rm(dir, { recursive: true }).then(() => rm(data, { recursive: true }))
  return { dir, data, cache, lib, launch, src, recording, key, done }
}

test('each line goes to the voice heard most while it was spoken', () => {
  const turns: Turn[] = [
    [0, 1.5, 0],
    [1.5, 4.6, 1],
    [6.2, 9, 0],
    [30, 90, 2],
  ]
  const lines = [
    { s: 0, e: 2, t: 'mostly the first voice' },
    { s: 2, e: 5, t: 'the second' },
    { s: 5.5, e: 6, t: 'between turns, nearest wins' },
    { s: 20, e: 21, t: 'nobody near' },
    { s: 7, e: 7, t: 'an instant inside a turn' },
    { s: 40, e: 44, t: 'inside a long turn that started well before' },
    { s: 50, e: 80, t: 'Thank you.', q: 'silence' as const },
  ]
  assert.deepEqual(speakerPerLine(lines, turns), [0, 1, 0, undefined, 0, 2, undefined])
})

test("a line's own voice overrides its turn only when it clearly belongs to someone else", () => {
  const turns: Turn[] = [[0, 30, 0]]
  const lines = [
    { s: 0, e: 4, t: 'a long point' },
    { s: 4, e: 5, t: 'Exactly!' },
    { s: 5, e: 8, t: 'muddled' },
    { s: 8, e: 9, t: 'too short to judge' },
  ]
  const voices = { speakers: [0, 1], sims: [[0.8, 0.1], [0.05, 0.62], [0.3, 0.5], null] }
  assert.deepEqual(speakerPerLine(lines, turns, voices), [0, 1, 0, 0])
  assert.deepEqual(speakerPerLine(lines, turns, { ...voices, sims: voices.sims.slice(1) }), [0, 0, 0, 0], 'line voices for some other set of lines are ignored')
})

test('names are tidied, and a trailing ? (how a guess is shown) is dropped', () => {
  assert.equal(cleanName('  Ada?? '), 'Ada')
  assert.equal(cleanName('Grace\u0007  Hopper'), 'Grace Hopper')
  assert.equal(cleanName(42), '')
  assert.equal(cleanName('x'.repeat(100)).length, 60)
})

test('a name cleaned twice comes out as it did once, and one typed that cleans to nothing is refused', async () => {
  // sixty "?" then a letter: cut to sixty "?" and saved, it loaded back as no name, which stopped the backups
  const odd = '?'.repeat(60) + 'b'
  let seed = 7
  const pick = (chars: string) => chars[(seed = (seed * 16807) % 2147483647) % chars.length]
  const tricky = [odd, `${'x'.repeat(59)}?abc`, `${'x'.repeat(58)} ?b`, '  Ada?? ', ' ? ', '\u0007', 'Grace\u0007  Hopper']
  for (let i = 0; i < 500; i++) tricky.push(Array.from({ length: i % 90 }, () => pick('a? \u0007\u00a0…b')).join(''))
  for (const raw of tricky) assert.equal(cleanName(cleanName(raw)), cleanName(raw), JSON.stringify(raw))
  assert.equal(cleanName(odd), '')

  const t = await setup()
  try {
    const cfg = { python: '', segmentation: '', embedding: '', script: '', readText: '' }
    await writeFile(join(t.data, 'state.json'), '{"tasks":[]}')
    await writeFile(join(t.data, 'notebook.json'), '{"notes":[]}')
    const speakers = new Speakers(t.data, cfg, () => {})
    await speakers.load()
    await writeFile(join(t.data, 'speakers', `${t.key}.json`), JSON.stringify(RESULT))
    await speakers.plan(t.lib)
    assert.equal(await speakers.rename(t.src, '1', 'Grace', 'Ada'), true)
    const names = join(t.data, 'speakers', 'names.json')
    const saved = await readFile(names)
    for (const typed of [odd, '???', '\u0007']) {
      await assert.rejects(speakers.rename(t.src, '0', typed, 'Grace'), (err) => err instanceof SpeakerError && /empty once/.test(err.message))
    }
    assert.deepEqual(await readFile(names), saved, 'nothing was saved')
    // the board, the notebook and the names are still copied, and a restart keeps the names
    assert.equal((await backup(t.data, [join(t.data, 'backups')])).length, 1)
    const restarted = new Speakers(t.data, cfg, () => {})
    await restarted.load()
    assert.deepEqual(restarted.known(), ['Grace'])
    // an empty name still goes back to the automatic one
    assert.equal(await speakers.rename(t.src, '1', '  ', 'Grace'), true)
    assert.deepEqual(speakers.view(t.src).voices!.map((v) => v.name), ['Speaker 1', 'Speaker 2'])
  } finally {
    await t.done()
  }
})

test('voices worked out for a recording label its transcript, and naming one relabels without touching the parse', async () => {
  const t = await setup()
  try {
    const speakers = new Speakers(t.data, { python: '', segmentation: '', embedding: '', script: '', readText: '' }, () => {})
    await speakers.load()
    await speakers.plan(t.lib)
    assert.equal(speakers.view(t.src).state, 'off', 'with diarization off and nothing on disk, the page says so')

    await writeFile(join(t.data, 'speakers', `${t.key}.json`), JSON.stringify(RESULT))
    await speakers.plan(t.lib)
    speakers.apply(t.lib)
    const view = speakers.view(t.src)
    assert.equal(view.state, 'done')
    assert.deepEqual(
      view.voices!.map((v) => [v.key, v.name, v.confirmed]),
      [
        ['0', 'Speaker 1', false],
        ['1', 'Speaker 2', false],
      ],
    )
    const said = () => t.src.parsed.segments.filter((s) => !s.q).map((s) => s.sp)
    assert.deepEqual(said(), ['Speaker 1', 'Speaker 2', 'Speaker 1', 'Speaker 2'])

    assert.equal(await speakers.rename(t.src, '0', 'Ada', 'Ada'), true)
    assert.equal(await speakers.rename(t.src, '0', 'Ada', 'Ada'), false, 'the same name again changes nothing')
    await assert.rejects(speakers.rename(t.src, '7', 'Nobody', 'Ada'), SpeakerError)
    await assert.rejects(speakers.rename(t.src, 'constructor', 'Nobody', 'Ada'), SpeakerError)
    speakers.apply(t.lib)
    assert.deepEqual(said(), ['Ada', 'Speaker 2', 'Ada', 'Speaker 2'])
    assert.equal(speakers.view(t.src).voices![0].by, 'Ada')

    // the parse cache still holds the lines as the file had them
    const cached = [...t.cache.values()].flatMap((c) => c.value.transcript?.segments ?? [])
    assert.ok(cached.length && cached.every((s) => s.sp === undefined || /^Speaker \d$/.test(s.sp)), 'parsed lines are never labelled in place')

    const saved = join(t.data, 'speakers', 'names.json')
    assert.equal((await stat(saved)).mode & 0o777, 0o600)
    assert.equal(JSON.parse(await readFile(saved, 'utf8'))[t.key]['0'].name, 'Ada')

    assert.equal(await speakers.rename(t.src, '0', null, 'Grace'), true)
    speakers.apply(t.lib)
    assert.deepEqual(said(), ['Speaker 1', 'Speaker 2', 'Speaker 1', 'Speaker 2'], 'clearing a name goes back to the automatic one')

    const clock = [...t.lib.transcripts.values()].find((s) => s.parsed.timeBase === 'clock')!
    const labelled = speakers.view(clock)
    assert.equal(labelled.source, 'labels', 'a transcript that came with speaker labels keeps them')
    assert.deepEqual(labelled.voices!.map((v) => v.name), ['Speaker 1', 'Speaker 2'])
  } finally {
    await t.done()
  }
})

test('a voice named in another recording is recognised by its voiceprint, as a guess', async () => {
  const t = await setup()
  try {
    await new Speakers(t.data, { python: '', segmentation: '', embedding: '', script: '', readText: '' }, () => {}).load()
    await writeFile(join(t.data, 'speakers', `${t.key}.json`), JSON.stringify(RESULT))
    await writeFile(
      join(t.data, 'speakers', 'names.json'),
      JSON.stringify({
        'other-recording': {
          '3': { name: 'Grace', by: 'Grace', at: '2026-11-01T00:00:00Z', voiceprint: [0.1, 0.99, 0] },
          // a placeholder name and an unlike voice recognise nobody
          '4': { name: 'Speaker 9', by: 'Grace', at: '2026-11-01T00:00:00Z', voiceprint: [0.99, 0.1, 0] },
          '5': { name: 'Linus', by: 'Grace', at: '2026-11-01T00:00:00Z', voiceprint: [0, 0, 1] },
        },
      }),
    )
    const speakers = new Speakers(t.data, { python: '', segmentation: '', embedding: '', script: '', readText: '' }, () => {})
    await speakers.load()
    await speakers.plan(t.lib)
    speakers.apply(t.lib)
    const [first, second] = speakers.view(t.src).voices!
    assert.equal(first.name, 'Speaker 1')
    assert.equal(second.name, 'Grace')
    assert.equal(second.confirmed, false)
    assert.ok(second.match! > 0.9)
    assert.deepEqual(
      t.src.parsed.segments.filter((s) => !s.q).map((s) => s.sp),
      ['Speaker 1', 'Grace?', 'Speaker 1', 'Grace?'],
      'a guess carries its ? into captions, search and agents',
    )
    assert.deepEqual(speakers.known(), ['Grace', 'Linus'])

    // naming someone else Grace here means the guess can't also be Grace
    await speakers.rename(t.src, '0', 'Grace', 'Ada')
    const after = speakers.view(t.src).voices!
    assert.deepEqual(
      after.map((v) => [v.name, v.confirmed]),
      [
        ['Grace', true],
        ['Speaker 2', false],
      ],
    )
  } finally {
    await t.done()
  }
})

test('speaker names: a failed write is retried before reporting an unchanged name, and concurrent saves keep all names', async () => {
  const t = await setup()
  try {
    const dir = join(t.data, 'speakers')
    const path = join(dir, 'names.json')
    await mkdir(dir)
    await writeFile(path, JSON.stringify({ 'old-recording': { 0: { name: 'Ada' } } }))
    await writeFile(join(dir, `${t.key}.json`), JSON.stringify(RESULT))
    const cfg = { python: '', segmentation: '', embedding: '', script: '', readText: '' }
    const recovered: string[][] = []
    const speakers = new Speakers(t.data, cfg, (ids, relabel) => {
      if (relabel) recovered.push(ids)
    })
    await speakers.load()
    await speakers.plan(t.lib)
    const before = recovered.length
    await rm(path)
    await mkdir(path)
    await assert.rejects(speakers.rename(t.src, '0', 'Grace', 'Ada'))
    await assert.rejects(speakers.rename(t.src, '0', 'Grace', 'Ada'))
    await rm(path, { recursive: true })
    assert.equal(await speakers.rename(t.src, '0', 'Grace', 'Ada'), false)
    assert.equal(await speakers.rename(t.src, '0', 'Grace', 'Ada'), false)
    assert.equal(recovered.length, before + 1)
    assert.ok(recovered.at(-1)?.includes(t.src.id))
    let names = JSON.parse(await readFile(path, 'utf8'))
    assert.deepEqual(names[t.key]['0'].voiceprint, RESULT.speakers['0'].voiceprint)
    assert.deepEqual(await Promise.all([
      speakers.rename(t.src, '0', 'Grace Hopper', 'Ada'),
      speakers.rename(t.src, '1', 'Linus', 'Grace'),
    ]), [true, true])
    names = JSON.parse(await readFile(path, 'utf8'))
    assert.deepEqual(names['old-recording']['0'], { name: 'Ada', by: '', at: '', voiceprint: null })
    assert.deepEqual(Object.values(names[t.key]).map((entry) => (entry as { name: string }).name), ['Grace Hopper', 'Linus'])
    const copy = new Speakers(t.data, cfg, () => {})
    await copy.load()
    assert.deepEqual(copy.known(), ['Ada', 'Grace Hopper', 'Linus'])
  } finally {
    await t.done()
  }
})

test('a saved entry that fails validation is left out, the other names load, and the file as it was is kept aside once', async (ctx) => {
  const t = await setup()
  try {
    const cfg = { python: '', segmentation: '', embedding: '', script: '', readText: '' }
    const dir = join(t.data, 'speakers')
    const path = join(dir, 'names.json')
    await mkdir(dir, { mode: 0o700 })
    await writeFile(join(dir, `${t.key}.json`), JSON.stringify(RESULT))
    // a hand edit left one name empty; nothing else is wrong
    const original = JSON.stringify({
      [t.key]: { '0': { name: 'Ada Byron', by: 'Ada', at: '2026-11-01T00:00:00Z', voiceprint: [1, 0, 0] }, '1': { name: '', by: 'Ada', at: '2026-11-02T00:00:00Z', voiceprint: null } },
      'f2-a-b-87654321': { '0': { name: 'Grace Hopper', by: 'Grace', at: '2026-11-03T00:00:00Z', voiceprint: [0, 0, 1] } },
    })
    await writeFile(path, original, { mode: 0o600 })
    const logged: string[] = []
    ctx.mock.method(console, 'error', (line: string) => void logged.push(line.replaceAll(t.data, '<data>')))
    const asides = async () => (await readdir(dir)).filter((n) => n.startsWith('names.json.corrupt-'))
    const speakers = new Speakers(t.data, cfg, () => {})
    await speakers.load()
    await speakers.plan(t.lib)
    assert.deepEqual(speakers.known(), ['Ada Byron', 'Grace Hopper'])
    assert.deepEqual(speakers.view(t.src).voices!.map((v) => v.name), ['Ada Byron', 'Speaker 2'])
    // one line, which names the entry by its key only
    assert.deepEqual(logged, [`speaker names: left out 1 saved entry of <data>/speakers/names.json that failed validation ("${t.key}/1"); preserved the original at <data>/speakers/${(await asides())[0]}`])
    assert.equal(await readFile(join(dir, (await asides())[0]), 'utf8'), original)
    // the names that loaded are written back: a backup's check takes them, and the next start leaves nothing out
    const kept = JSON.parse(await readFile(path, 'utf8'))
    assert.deepEqual(Object.keys(kept[t.key]), ['0'])
    assert.equal(decodeSavedNames(kept).size, 2)
    const again = new Speakers(t.data, cfg, () => {})
    await again.load()
    assert.deepEqual(again.known(), ['Ada Byron', 'Grace Hopper'])
    assert.equal(logged.length, 1)
    assert.equal((await asides()).length, 1)

    // when no copy can be made, the names that loaded show and nothing writes over the file until a restart
    await rm(join(dir, (await asides())[0]))
    await writeFile(path, original, { mode: 0o600 })
    const blocked = ctx.mock.method(fs, 'copyFile', async () => {
      throw Object.assign(new Error('injected access denied'), { code: 'EACCES' })
    })
    syncBuiltinESMExports()
    const stuck = new Speakers(t.data, cfg, () => {})
    try {
      await stuck.load()
    } finally {
      blocked.mock.restore()
      syncBuiltinESMExports()
    }
    await stuck.plan(t.lib)
    assert.deepEqual(stuck.known(), ['Ada Byron', 'Grace Hopper'])
    assert.match(logged.at(-1)!, /left out 1 saved entry .* and can't copy the file aside \(injected access denied\); started with the rest, and every change is refused/)
    await assert.rejects(stuck.rename(t.src, '1', 'Linus', 'Grace'), (err) => err instanceof SpeakerError && /copied aside/.test(err.message))
    assert.equal(await readFile(path, 'utf8'), original)
    assert.deepEqual(await asides(), [])
  } finally {
    await t.done()
  }
})

test("a names file that can't be read starts the archive without names, and no change writes over it", { skip: process.getuid?.() === 0 }, async (ctx) => {
  const t = await setup()
  try {
    const cfg = { python: '', segmentation: '', embedding: '', script: '', readText: '' }
    const dir = join(t.data, 'speakers')
    const path = join(dir, 'names.json')
    await mkdir(dir, { mode: 0o700 })
    await writeFile(join(dir, `${t.key}.json`), JSON.stringify(RESULT))
    // restored as the wrong owner or mode
    const original = JSON.stringify({ [t.key]: { '0': { name: 'Ada', by: 'Ada', at: '2026-11-01T00:00:00Z', voiceprint: [1, 0, 0] } } })
    await writeFile(path, original, { mode: 0o600 })
    await chmod(path, 0o000)
    const logged: string[] = []
    ctx.mock.method(console, 'error', (line: string) => void logged.push(line.replaceAll(t.data, '<data>')))
    const speakers = new Speakers(t.data, cfg, () => {})
    await speakers.load()
    await speakers.plan(t.lib)
    assert.deepEqual(speakers.view(t.src).voices!.map((v) => v.name), ['Speaker 1', 'Speaker 2'])
    assert.equal(logged.length, 1)
    assert.match(logged[0], /^speaker names: can't read <data>\/speakers\/names\.json \(EACCES.*\); started without them, and every change to them is refused until the file is fixed and the server restarted$/)
    for (const name of ['Grace', null]) {
      await assert.rejects(speakers.rename(t.src, '0', name, 'Grace'), (err) => err instanceof SpeakerError && /couldn't be read when the server started/.test(err.message))
    }
    assert.equal((await stat(path)).mode & 0o777, 0o000)
    await chmod(path, 0o600)
    assert.equal(await readFile(path, 'utf8'), original)
    assert.deepEqual((await readdir(dir)).sort(), [`${t.key}.json`, 'names.json'])
    // fixed, a restart has the names again
    const restarted = new Speakers(t.data, cfg, () => {})
    await restarted.load()
    await restarted.plan(t.lib)
    assert.deepEqual(restarted.view(t.src).voices!.map((v) => v.name), ['Ada', 'Speaker 2'])
  } finally {
    await t.done()
  }
})

test('the background job runs the script on the recording and keeps what it prints', { skip: !existsSync('/usr/bin/python3') }, async () => {
  const t = await setup()
  try {
    const script = join(t.data, 'fake-diarize.py')
    await writeFile(script, `import json, sys\nassert '--input' in sys.argv\njson.dump(${JSON.stringify(RESULT)}, sys.stdout)\n`)
    const events: [string[], boolean][] = []
    let finished: () => void
    const ended = new Promise<void>((r) => (finished = r))
    const speakers = new Speakers(t.data, { python: '/usr/bin/python3', segmentation: script, embedding: script, script, readText: '' }, (ids, relabel) => {
      events.push([ids, relabel])
      if (relabel) finished()
    })
    await speakers.load()
    assert.equal(speakers.enabled, true)
    await speakers.plan(t.lib)
    await ended
    assert.deepEqual(events[0], [[t.src.id], false], 'pages hear when the job starts')
    assert.deepEqual(events.at(-1), [[t.src.id], true])
    speakers.apply(t.lib)
    assert.equal(speakers.view(t.src).state, 'done')
    const kept = join(t.data, 'speakers', `${t.key}.json`)
    assert.equal((await stat(kept)).mode & 0o777, 0o600)
    assert.ok(speakers.diarized().includes(t.src.id))
  } finally {
    await t.done()
  }
})

test('voices are named from the Meet tile highlighted while they talked, as the people list knows them', async () => {
  const t = await setup()
  try {
    const screen = { '0': { name: 'Ada Byron', votes: 5, of: 6 }, '1': { name: 'Linu…', votes: 2, of: 6 } }
    await new Speakers(t.data, { python: '', segmentation: '', embedding: '', script: '', readText: '' }, () => {}).load()
    await writeFile(join(t.data, 'speakers', `${t.key}.json`), JSON.stringify({ ...RESULT, screen }))
    const speakers = new Speakers(t.data, { python: '', segmentation: '', embedding: '', script: '', readText: '' }, () => {}, 'Grace')
    await speakers.load()
    await speakers.plan(t.lib)
    speakers.apply(t.lib)
    const [ada, other] = speakers.view(t.src).voices!
    assert.equal(ada.name, 'Ada', 'the tile says "Ada Byron"; the people list calls her Ada')
    assert.deepEqual(ada.seen, { as: 'Ada Byron', votes: 5, of: 6 })
    assert.equal(ada.confirmed, false)
    assert.equal(other.name, 'Linus', 'a name the tile cut short is finished from the one person it can be')
    assert.deepEqual(
      t.src.parsed.segments.filter((s) => !s.q).map((s) => s.sp),
      ['Ada', 'Linus', 'Ada', 'Linus'],
      'a name off the screen is not a guess: no ?',
    )

    // a person's own name wins over the screen
    await speakers.rename(t.src, '1', 'Mary', 'Ada')
    assert.deepEqual(speakers.view(t.src).voices!.map((v) => [v.name, Boolean(v.seen)]), [
      ['Ada', true],
      ['Mary', false],
    ])
    assert.ok(speakers.known().includes('Ada') && speakers.known().includes('Mary'))
  } finally {
    await t.done()
  }
})

test("a person's name stays with its voice when the recording changes, within that transcript only", async () => {
  const t = await setup()
  try {
    const cfg = { python: '', segmentation: '', embedding: '', script: '', readText: '' }
    // the tile reads "Mary Shelley" for voice 1; another transcript named a voice like this one's voice 0
    const result = JSON.stringify({ ...RESULT, screen: { '1': { name: 'Mary Shelley', votes: 4, of: 6 } } })
    await new Speakers(t.data, cfg, () => {}).load()
    await writeFile(join(t.data, 'speakers', `${t.key}.json`), result)
    const other = { name: 'Ada', by: 'Grace', at: '2026-11-01T00:00:00Z', voiceprint: [1, 0, 0], transcript: 'another-transcript' }
    await writeFile(join(t.data, 'speakers', 'names.json'), JSON.stringify({ 'other-recording': { '2': other } }))
    const speakers = new Speakers(t.data, cfg, () => {})
    await speakers.load()
    await speakers.plan(t.lib)
    assert.equal(await speakers.rename(t.src, '1', 'Linus', 'Ada'), true, 'Ada knows voice 1 is Linus, not Mary')
    const saved = JSON.parse(await readFile(join(t.data, 'speakers', 'names.json'), 'utf8'))
    assert.equal(saved[t.key]['1'].transcript, t.src.id, 'a name keeps the transcript it was given in')

    // the recording is touched (copied back from a backup, say): same voices, a new key, and the job runs again
    const touch = async (ago: number) => {
      await utimes(t.recording.path, Date.now() / 1000 - ago, Date.now() / 1000 - ago)
      const lib = await buildLibrary(await scanFiles(t.dir), facts, ['Ada Byron'], new Map())
      const src = lib.transcripts.get(t.src.id)!
      await writeFile(join(t.data, 'speakers', `${resultKey(lib.files.get(t.recording.id)!, src.parsed.segments)}.json`), result)
      const restarted = new Speakers(t.data, cfg, () => {})
      await restarted.load()
      await restarted.plan(lib)
      restarted.apply(lib)
      const shown = () => restarted.view(src).voices!.map((v) => `${v.name}${v.confirmed ? ` (named by ${v.by})` : v.seen ? ' (tile)' : v.match ? '?' : ''}`)
      return { src, restarted, shown, lines: () => src.parsed.segments.filter((s) => !s.q).map((s) => s.sp) }
    }
    let after = await touch(30)
    assert.deepEqual(after.shown(), ['Ada?', 'Linus (named by Ada)'], "Ada's name still wins over the tile; a name from another transcript is only a guess")
    assert.deepEqual(after.lines(), ['Ada?', 'Linus', 'Ada?', 'Linus'])

    // a newer name given after the change is the one that carries on
    assert.equal(await after.restarted.rename(after.src, '1', 'Linus Pauling', 'Grace'), true)
    assert.equal(await after.restarted.rename(after.src, '1', 'Linus Pauling', 'Grace'), false)
    after = await touch(60)
    assert.deepEqual(after.shown(), ['Ada?', 'Linus Pauling (named by Grace)'])

    // forgetting it goes back to the tile, and stays forgotten
    assert.equal(await after.restarted.rename(after.src, '1', null, 'Grace'), true)
    assert.deepEqual(after.shown(), ['Ada?', 'Mary (tile)'])
    after = await touch(90)
    assert.deepEqual(after.shown(), ['Ada?', 'Mary (tile)'])
    assert.deepEqual(after.restarted.known(), ['Ada', 'Mary'])
  } finally {
    await t.done()
  }
})

test('names saved before they kept their transcript are given it under their current key, in one save, and then carry over', async (ctx) => {
  const t = await setup()
  try {
    const cfg = { python: '', segmentation: '', embedding: '', script: '', readText: '' }
    const dir = join(t.data, 'speakers')
    const path = join(dir, 'names.json')
    await mkdir(dir, { mode: 0o700 })
    const result = JSON.stringify({ ...RESULT, screen: { '1': { name: 'Mary Shelley', votes: 4, of: 6 } } })
    await writeFile(join(dir, `${t.key}.json`), result)
    // as the pull request head writes it: Ada's correction of the tile under this recording's current key, and a
    // name under a key no recording has any more
    const written = {
      [t.key]: { '1': { name: 'Linus', by: 'Ada', at: '2026-11-01T00:00:00.000Z', voiceprint: [0, 1, 0] } },
      [`${t.recording.id}-gone`]: { '0': { name: 'Ada', by: 'Grace', at: '2026-10-01T00:00:00.000Z', voiceprint: [1, 0, 0] } },
    }
    await writeFile(path, JSON.stringify(written), { mode: 0o600 })
    const logged: string[] = []
    ctx.mock.method(console, 'log', (line: string) => void logged.push(line))
    ctx.mock.method(console, 'error', (line: string) => void logged.push(line))
    const start = async (lib = t.lib) => {
      const speakers = new Speakers(t.data, cfg, () => {})
      await speakers.load()
      await speakers.plan(lib)
      const src = lib.transcripts.get(t.src.id)!
      return speakers.view(src).voices!.map((v) => `${v.name}${v.confirmed ? ` (named by ${v.by})` : v.seen ? ' (tile)' : v.match ? '?' : ''}`)
    }

    // a save that fails leaves the file as it was, and every name as it was shown
    const rename = fs.rename
    const blocked = ctx.mock.method(fs, 'rename', async (from: PathLike, to: PathLike) => {
      if (to === path) throw Object.assign(new Error('injected write failure'), { code: 'EIO' })
      return rename(from, to)
    })
    syncBuiltinESMExports()
    try {
      assert.deepEqual(await start(), ['Ada?', 'Linus (named by Ada)'])
    } finally {
      blocked.mock.restore()
      syncBuiltinESMExports()
    }
    assert.equal(await readFile(path, 'utf8'), JSON.stringify(written))
    assert.match(logged.at(-1)!, /couldn't note the transcript on 1 older name \(injected write failure\); the file is as it was/)

    // the next start gives the current key's names their transcript, and nothing else in the file changes
    assert.deepEqual(await start(), ['Ada?', 'Linus (named by Ada)'])
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { ...written, [t.key]: { '1': { ...written[t.key]['1'], transcript: t.src.id } } })
    assert.equal(logged.at(-1), 'speaker names: noted the transcript on 1 name saved before names kept it')
    // a second start writes nothing
    const saved = await stat(path)
    const lines = logged.length
    await start()
    assert.deepEqual(await stat(path).then((s) => [s.ino, s.mtimeMs]), [saved.ino, saved.mtimeMs])
    assert.equal(logged.length, lines)

    // the recording is touched: Ada's correction, made before names kept their transcript, still wins over the tile
    await utimes(t.recording.path, Date.now() / 1000 - 30, Date.now() / 1000 - 30)
    const lib = await buildLibrary(await scanFiles(t.dir), facts, ['Ada Byron'], new Map())
    await writeFile(join(dir, `${resultKey(lib.files.get(t.recording.id)!, lib.transcripts.get(t.src.id)!.parsed.segments)}.json`), result)
    assert.deepEqual(await start(lib), ['Ada?', 'Linus (named by Ada)'])

    // a file that holds more than a save writes (here, an entry without its author) isn't rewritten at start:
    // the transcript goes with the next change
    await writeFile(path, JSON.stringify({ [t.key]: { '1': { name: 'Linus', voiceprint: [0, 1, 0] } } }), { mode: 0o600 })
    const plain = await stat(path)
    const speakers = new Speakers(t.data, cfg, () => {})
    await speakers.load()
    await speakers.plan(t.lib)
    assert.deepEqual(await stat(path).then((s) => [s.ino, s.mtimeMs]), [plain.ino, plain.mtimeMs])
    assert.equal(await speakers.rename(t.src, '0', 'Ada', 'Grace'), true)
    assert.equal(JSON.parse(await readFile(path, 'utf8'))[t.key]['1'].transcript, t.src.id)
  } finally {
    await t.done()
  }
})

test('a tile two voices shared (one microphone) names the voice that sounds like that person; the other is matched by voice', async () => {
  const t = await setup()
  try {
    const cfg = { python: '', segmentation: '', embedding: '', script: '', readText: '' }
    await new Speakers(t.data, cfg, () => {}).load()
    const known = {
      'other-recording': {
        '0': { name: 'Ada', by: 'Grace', at: '', voiceprint: [1, 0, 0] },
        '1': { name: 'Grace', by: 'Grace', at: '', voiceprint: [0, 1, 0] },
      },
    }
    await writeFile(join(t.data, 'speakers', 'names.json'), JSON.stringify(known))
    const read = async (screen: Record<string, { name: string; votes: number; of: number }>) => {
      await writeFile(join(t.data, 'speakers', `${t.key}.json`), JSON.stringify({ ...RESULT, screen }))
      const speakers = new Speakers(t.data, cfg, () => {})
      await speakers.load()
      await speakers.plan(t.lib)
      return speakers.view(t.src).voices!.map((v) => `${v.name}${v.seen ? ' (tile)' : v.match ? '?' : ''}`)
    }
    // read off Ada's tile for both voices, more often for Grace's: the voices settle it
    assert.deepEqual(await read({ '0': { name: 'Ada Byron', votes: 3, of: 6 }, '1': { name: 'Ada Byron', votes: 5, of: 6 } }), ['Ada (tile)', 'Grace?'])
    // Ada's tile lit while Grace talked and Ada never spoke: Grace's voice wins over the tile
    assert.deepEqual(await read({ '1': { name: 'Ada Byron', votes: 6, of: 6 } }), ['Ada?', 'Grace?'])
  } finally {
    await t.done()
  }
})

test('a guest keeps the whole tile name when a known person or another name on the call has that first name', async () => {
  const t = await setup()
  try {
    const cfg = { python: '', segmentation: '', embedding: '', script: '', readText: '' }
    const tile = (name: string) => ({ name, votes: 5, of: 6 })
    const read = async (screen: Record<string, ReturnType<typeof tile>>) => {
      const data = await mkdtemp(join(t.data, 'case-'))
      await mkdir(join(data, 'speakers'))
      await writeFile(join(data, 'speakers', `${t.key}.json`), JSON.stringify({ ...RESULT, screen }))
      const lib = await buildLibrary(await scanFiles(t.dir), facts, ['Ada Byron'], new Map())
      const speakers = new Speakers(data, cfg, () => {})
      await speakers.load()
      await speakers.plan(lib)
      speakers.apply(lib)
      const src = lib.transcripts.get(t.src.id)!
      return { voices: speakers.view(src).voices!.map((v) => v.name), lines: src.parsed.segments.filter((s) => !s.q).map((s) => s.sp), known: speakers.known() }
    }
    // the people list knows Grace Hopper, so a guest on Grace Kim's tile isn't shown as her, nor matched as her elsewhere
    assert.deepEqual(await read({ '0': tile('Ada Byron'), '1': tile('Grace Kim') }), {
      voices: ['Ada', 'Grace Kim'],
      lines: ['Ada', 'Grace Kim', 'Ada', 'Grace Kim'],
      known: ['Ada', 'Grace Kim'],
    })
    assert.deepEqual((await read({ '0': tile('Ada Byron'), '1': tile('Grace K…') })).voices, ['Ada', 'Grace K…'], 'a tile cut short that is not her')
    // two guests on the call share a first name: each keeps a whole name (one first name would make them one tile)
    assert.deepEqual((await read({ '0': tile('Wren Ashby'), '1': tile('Wren Cole') })).voices, ['Wren Ashby', 'Wren Cole'])
    // guests whose first names nobody else goes by are still shown by them
    assert.deepEqual((await read({ '0': tile('Wren Ashby'), '1': tile('Hollis Grey') })).voices, ['Wren', 'Hollis'])

    // a caption export's labels read the same way
    const data = join(t.data, 'labels')
    await mkdir(join(data, 'speakers'), { recursive: true })
    const lib = await buildLibrary(await scanFiles(t.dir), facts, ['Ada Byron'], new Map())
    const demo = lib.meetings.find((m) => m.timeBase === 'clock')!
    const video = lib.meetings.find((m) => m.id === t.launch.id)!.videos[0]
    demo.videos = [{ ...video, probe: { duration: 600, hasAudio: false } }]
    const file = lib.files.get(video.fileId)!
    const job = `${file.id}-${file.size.toString(36)}-${file.mtimeMs.toString(36)}-${shortHash(JSON.stringify([[1, 4, 0], [10, 12, 1]]), 8)}`
    const labels = async (screen: Record<string, ReturnType<typeof tile>>) => {
      await writeFile(join(data, 'speakers', `${job}.json`), JSON.stringify({ version: 1, screen }))
      const speakers = new Speakers(data, cfg, () => {})
      await speakers.load()
      await speakers.plan(lib, (id) => (id === demo.id ? 13 * 3600 : undefined))
      return speakers.view(lib.transcripts.get(demo.primaryTranscript!)!).voices!.map((v) => v.name)
    }
    assert.deepEqual(await labels({ '0': tile('Grace Kim'), '1': tile('Hollis Grey') }), ['Grace Kim', 'Hollis'])
    assert.deepEqual(await labels({ '0': tile('Wren Ashby'), '1': tile('Wren Cole') }), ['Wren Ashby', 'Wren Cole'])
  } finally {
    await t.done()
  }
})

test("a known person's own tile keeps her short name when the rest of it fits: a misreading, an initial, a decoration", async () => {
  const t = await setup()
  try {
    const cfg = { python: '', segmentation: '', embedding: '', script: '', readText: '' }
    const tile = (name: string) => ({ name, votes: 5, of: 6 })
    // the fixture's people list knows Grace Hopper; more people can be added for a case
    const read = async (first: string, second: string, more: string[] = []) => {
      const data = await mkdtemp(join(t.data, 'case-'))
      await mkdir(join(data, 'speakers'))
      await writeFile(join(data, 'speakers', `${t.key}.json`), JSON.stringify({ ...RESULT, screen: { '0': tile(first), '1': tile(second) } }))
      const lib = await buildLibrary(await scanFiles(t.dir), facts, ['Ada Byron'], new Map())
      for (const name of more) lib.people.add(name, t.launch.id)
      const speakers = new Speakers(data, cfg, () => {})
      await speakers.load()
      await speakers.plan(lib)
      return speakers.view(lib.transcripts.get(t.src.id)!).voices!.map((v) => v.name)
    }
    // the text reader's slips, a shortened last name, what the call adds, a middle initial
    for (const variant of ['Grace Hoper', 'Grace Hoppor', 'Grace H', 'Grace H.', 'Grace Hopper (Presenting)', 'Grace Hopper (she/her)', 'Grace B. Hopper']) {
      assert.deepEqual(await read('Ada Byron', variant), ['Ada', 'Grace'], variant)
    }
    // a guest is still a guest, and on the same call as her the known Grace's own tile still reads as her
    assert.deepEqual(await read('Ada Byron', 'Grace Kim'), ['Ada', 'Grace Kim'])
    assert.deepEqual(await read('Grace Kim', 'Grace Hopper (Presenting)'), ['Grace Kim', 'Grace'])
    // the accepted limit: a guest a letter away from her last name is taken for her; two letters off six is not
    assert.deepEqual(await read('Ada Byron', 'Grace Hooper'), ['Ada', 'Grace'])
    assert.deepEqual(await read('Ada Byron', 'Grace Harper'), ['Ada', 'Grace Harper'])
    // someone the list knows by first name only can't be told from a guest; with two known Graces, the rest decides
    assert.deepEqual(await read('Ada Byron', 'Hollis Grey', ['Hollis']), ['Ada', 'Hollis'])
    assert.deepEqual(await read('Ada Byron', 'Grace Hoper', ['Grace Lee']), ['Ada', 'Grace'])
    assert.deepEqual(await read('Ada Byron', 'Grace Kim', ['Grace Lee']), ['Ada', 'Grace Kim'])
  } finally {
    await t.done()
  }
})

test("a caption export's labels are named from the tile lit while each one talks, on the meeting's clock", { skip: !existsSync('/usr/bin/python3') }, async () => {
  const t = await setup()
  try {
    // the demo's captions run on a wall clock (13:00:01-13:00:12); its meeting gets a silent video started at 13:00:00
    const demo = t.lib.meetings.find((m) => m.timeBase === 'clock')!
    const clock = t.lib.transcripts.get(demo.primaryTranscript!)!
    demo.videos = [{ ...t.launch.videos[0], probe: { duration: 600, hasAudio: false } }]
    const script = join(t.data, 'fake-diarize.py')
    await writeFile(
      script,
      [
        'import json, sys',
        "if '--turns' not in sys.argv:",
        `    json.dump(${JSON.stringify(RESULT)}, sys.stdout)`,
        '    sys.exit()',
        "turns = json.load(open(sys.argv[sys.argv.index('--turns') + 1]))",
        'assert turns == [[1, 4, 0], [10, 12, 1]], turns',
        "json.dump({'version': 1, 'screen': {'0': {'name': 'Ada Byron', 'votes': 3, 'of': 3}}}, sys.stdout)",
      ].join('\n'),
    )
    let finished: () => void
    const ended = new Promise<void>((r) => (finished = r))
    const speakers = new Speakers(t.data, { python: '/usr/bin/python3', segmentation: script, embedding: script, script, readText: '' }, (ids, relabel) => {
      if (relabel && ids.includes(clock.id)) finished()
    })
    await speakers.load()
    await speakers.plan(t.lib, (id) => (id === demo.id ? 13 * 3600 : undefined))
    await ended
    speakers.apply(t.lib)
    const view = speakers.view(clock)
    assert.equal(view.state, 'done')
    assert.equal(view.source, 'labels')
    assert.deepEqual(
      view.voices!.map((v) => [v.name, v.seen?.as ?? null]),
      [
        ['Ada', 'Ada Byron'],
        ['Speaker 2', null],
      ],
    )
    assert.deepEqual(
      clock.parsed.segments.map((s) => [s.sp, s.spk]),
      [
        ['Ada', 0],
        ['Speaker 2', 1],
      ],
    )
    // a label nobody could read can still be named by hand
    assert.equal(await speakers.rename(clock, '1', 'Grace', 'Grace'), true)
    await assert.rejects(speakers.rename(clock, '2', 'Nobody', 'Grace'), SpeakerError)
    speakers.apply(t.lib)
    assert.deepEqual(
      clock.parsed.segments.map((s) => s.sp),
      ['Ada', 'Grace'],
    )
  } finally {
    await t.done()
  }
})

// Who the fixtures show speaking on each line, recorded before four fixes to how voices are named: a person's
// name lost when the recording changes, a guest shown under a known person's first name, a name that couldn't
// be loaded back, and one bad saved entry losing every name. None of these cases is one of those, so none changes.
test('the fixtures show the same speaker on every line: tiles, guesses, names people gave and caption labels', async () => {
  const t = await setup()
  try {
    const cfg = { python: '', segmentation: '', embedding: '', script: '', readText: '' }
    const at = '2026-11-01T00:00:00Z'
    const named = (name: string, voiceprint: number[] | null, by = 'Grace') => ({ name, by, at, voiceprint })
    const tile = (name: string, votes = 5) => ({ name, votes, of: 6 })
    const elsewhere = { '0': named('Ada', [1, 0, 0]), '1': named('Grace', [0, 1, 0]) }
    const shown = (v: Voice) => `${v.name}${v.confirmed ? ` (named by ${v.by})` : v.seen ? ` (tile ${v.seen.as})` : v.match !== undefined ? ` (guess ${v.match})` : ''}`
    type Case = { screen?: Record<string, ReturnType<typeof tile>>; names?: (key: string) => object; lines: string[]; voices: string[] }
    const cases: Case[] = [
      { lines: ['Speaker 1', 'Speaker 2', 'Speaker 1', 'Speaker 2'], voices: ['Speaker 1', 'Speaker 2'] },
      // a voice named in another recording is a guess; a placeholder name or an unlike voice recognises nobody
      {
        names: () => ({ 'other-recording': { '3': named('Grace', [0.1, 0.99, 0]), '4': named('Speaker 9', [0.99, 0.1, 0]), '5': named('Linus', [0, 0, 1]) } }),
        lines: ['Speaker 1', 'Grace?', 'Speaker 1', 'Grace?'],
        voices: ['Speaker 1', 'Grace (guess 0.99)'],
      },
      // tiles the people list knows, cut short, or naming whoever made the recording
      { screen: { '0': tile('Ada Byron'), '1': tile('Linu…', 2) }, lines: ['Ada', 'Linus', 'Ada', 'Linus'], voices: ['Ada (tile Ada Byron)', 'Linus (tile Linu…)'] },
      { screen: { '0': tile('You', 4), '1': tile('Mary Sh…', 3) }, lines: ['Grace', 'Mary', 'Grace', 'Mary'], voices: ['Grace (tile You)', 'Mary (tile Mary Sh…)'] },
      // a guest whose first name nobody on the call or in the people list shares goes by it
      { screen: { '0': tile('Wren Ashby'), '1': tile('Grace Hopper') }, lines: ['Wren', 'Grace', 'Wren', 'Grace'], voices: ['Wren (tile Wren Ashby)', 'Grace (tile Grace Hopper)'] },
      // one tile read for two voices goes to the one that sounds like that person; a tile over another's voice is dropped
      { names: () => ({ 'other-recording': elsewhere }), screen: { '0': tile('Ada Byron', 3), '1': tile('Ada Byron', 5) }, lines: ['Ada', 'Grace?', 'Ada', 'Grace?'], voices: ['Ada (tile Ada Byron)', 'Grace (guess 1)'] },
      { names: () => ({ 'other-recording': elsewhere }), screen: { '1': tile('Ada Byron', 6) }, lines: ['Ada?', 'Grace?', 'Ada?', 'Grace?'], voices: ['Ada (guess 1)', 'Grace (guess 1)'] },
      // a person's name for a voice of this recording wins over its tile; the other voice is still guessed
      {
        names: (key) => ({ [key]: { '1': named('Linus', [0, 1, 0], 'Ada') }, 'other-recording': { '0': named('Mary', [1, 0, 0]) } }),
        screen: { '1': tile('Mary Shelley', 4) },
        lines: ['Mary?', 'Linus', 'Mary?', 'Linus'],
        voices: ['Mary (guess 1)', 'Linus (named by Ada)'],
      },
      // a name saved under an earlier key of this recording, as names were saved before they noted their
      // transcript: it only feeds guesses, so the tile still names the voice
      {
        names: () => ({ [`${t.recording.id}-earlier`]: { '1': named('Linus', [0, 1, 0], 'Ada') } }),
        screen: { '1': tile('Mary Shelley', 4) },
        lines: ['Speaker 1', 'Mary', 'Speaker 1', 'Mary'],
        voices: ['Speaker 1', 'Mary (tile Mary Shelley)'],
      },
    ]
    for (const [i, c] of cases.entries()) {
      const data = join(t.data, `case-${i}`)
      await mkdir(join(data, 'speakers'), { recursive: true })
      await writeFile(join(data, 'speakers', `${t.key}.json`), JSON.stringify({ ...RESULT, ...(c.screen ? { screen: c.screen } : {}) }))
      if (c.names) await writeFile(join(data, 'speakers', 'names.json'), JSON.stringify(c.names(t.key)))
      const lib = await buildLibrary(await scanFiles(t.dir), facts, ['Ada Byron'], new Map())
      const src = lib.transcripts.get(t.src.id)!
      const speakers = new Speakers(data, cfg, () => {}, 'Grace')
      await speakers.load()
      await speakers.plan(lib)
      speakers.apply(lib)
      assert.deepEqual(
        { lines: src.parsed.segments.filter((s) => !s.q).map((s) => s.sp), voices: speakers.view(src).voices!.map(shown) },
        { lines: c.lines, voices: c.voices },
        `case ${i}`,
      )
    }

    // a caption export's labels, named from the tile lit while each one talks and by a person
    const data = join(t.data, 'labels')
    await mkdir(join(data, 'speakers'), { recursive: true })
    const lib = await buildLibrary(await scanFiles(t.dir), facts, ['Ada Byron'], new Map())
    const demo = lib.meetings.find((m) => m.timeBase === 'clock')!
    const clock = lib.transcripts.get(demo.primaryTranscript!)!
    const video = lib.meetings.find((m) => m.id === t.launch.id)!.videos[0]
    demo.videos = [{ ...video, probe: { duration: 600, hasAudio: false } }]
    const file = lib.files.get(video.fileId)!
    const job = `${file.id}-${file.size.toString(36)}-${file.mtimeMs.toString(36)}-${shortHash(JSON.stringify([[1, 4, 0], [10, 12, 1]]), 8)}`
    await writeFile(join(data, 'speakers', `${job}.json`), JSON.stringify({ version: 1, screen: { '0': tile('Ada Byron', 3) } }))
    const speakers = new Speakers(data, cfg, () => {}, 'Grace')
    await speakers.load()
    await speakers.plan(lib, (id) => (id === demo.id ? 13 * 3600 : undefined))
    speakers.apply(lib)
    assert.deepEqual(clock.parsed.segments.map((s) => s.sp), ['Ada', 'Speaker 2'])
    assert.deepEqual(speakers.view(clock).voices!.map(shown), ['Ada (tile Ada Byron)', 'Speaker 2'])
    assert.equal(await speakers.rename(clock, '1', 'Linus', 'Grace'), true)
    speakers.apply(lib)
    assert.deepEqual(clock.parsed.segments.map((s) => s.sp), ['Ada', 'Linus'])
    assert.deepEqual(speakers.view(clock).voices!.map(shown), ['Ada (tile Ada Byron)', 'Linus (named by Grace)'])
  } finally {
    await t.done()
  }
})
