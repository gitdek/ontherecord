import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { CLOCK_TXT, fixtureDir, NOTES, TRANSCRIPT_TXT, WHISPER } from './fixtures.test-helper.ts'
import { buildLibrary, nameTitle, pinFolder, scanFiles, StaleFile, type FileEntry, type MediaFacts } from './library.ts'
import { SearchIndex } from './search.ts'
import { normKind } from './text.ts'

const probes: Record<string, MediaFacts> = {
  'Screen Recording 2026-10-02 at 9.15.00 AM.mp4': { probe: { duration: 1200, width: 3456, height: 2234, hasAudio: true, rotation: 90 }, faststart: true },
  'Screen Recording 2026-10-02 at 9.15.00 AM compressed.mp4': { probe: { duration: 1199, width: 1920, height: 1242, hasAudio: true }, faststart: true },
}
const facts = (f: FileEntry) => probes[f.name] ?? {}

test('without an index: files group into meetings by their names and Source video lines', async () => {
  const dir = await fixtureDir()
  try {
    const lib = await buildLibrary(await scanFiles(dir), facts, ['Ada Byron', 'Grace Hopper'], new Map())
    assert.equal(lib.meetings.length, 2)
    const launch = lib.meetings.find((m) => m.title === 'Launch planning')!
    assert.equal(launch.date, '2026-10-02')
    assert.equal(launch.videos.length, 2)
    // the smaller, upright copy is the one to stream
    assert.equal(launch.videos.find((v) => v.isDefault)?.label, 'compressed')
    assert.equal(launch.transcripts.length, 1)
    assert.deepEqual(
      launch.actions.map((a) => [a.owner, a.lane]),
      [
        ['Ada/Grace', 'us'],
        ['Linus', 'them'],
        ['Team', 'us'],
      ],
    )
    const demo = lib.meetings.find((m) => m.timeBase === 'clock')!
    assert.ok(demo, 'the wall-clock transcript becomes its own meeting')
    assert.ok(lib.byId.get('ada-grace-launch-planning-2026-10-02'), 'file-stem aliases resolve')
  } finally {
    await rm(dir, { recursive: true })
  }
})

test('with meetings-index.json: the index decides grouping, ids and titles', async () => {
  const dir = await fixtureDir({ index: true })
  try {
    const lib = await buildLibrary(await scanFiles(dir), facts, ['Ada Byron', 'Grace Hopper'], new Map())
    const m = lib.byId.get('2026-10-02-launch')!
    assert.equal(m.title, 'Launch planning')
    assert.equal(m.blurb, 'Widget API pilot with Acme.')
    assert.equal(m.fromIndex, true)
    assert.equal(m.videos.find((v) => v.isDefault)?.label, 'compressed')
    assert.equal(m.videos.find((v) => v.isDefault)?.synced, true)
    assert.deepEqual(lib.cautions, ['Synthetic test data.'])
    assert.deepEqual(
      lib.people.list().map((p) => [p.short, p.crew]),
      [
        ['Ada', true],
        ['Grace', true],
        ['Linus', false],
        ['Mary', false],
      ],
    )
  } finally {
    await rm(dir, { recursive: true })
  }
})

test('a copy trimmed at the start: one meeting, and its video and transcript sit on the notes clock', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'meetings-test-'))
  const w = (name: string, data: string | Buffer) => writeFile(join(dir, name), data)
  const stem = 'Ada Grace - Launch planning - 2026-10-02 evening'
  const srt = '1\n00:00:00,000 --> 00:00:04,000\nThank you.\n\n2\n00:02:10,000 --> 00:02:20,000\nAda will write the requirements.\n'
  try {
    await w(`${stem} - notes.txt`, NOTES)
    for (const cut of ['', ' - meeting only']) {
      await w(`${stem}${cut} - transcript.json`, WHISPER)
      await w(`${stem}${cut} - transcript.srt`, srt)
    }
    await w(`${stem} - meeting only.mp4`, Buffer.alloc(900, 1))
    await w(`${stem} - compressed.mp4`, Buffer.alloc(1000, 2))
    await w(`${stem} - verification.json`, '{"checked":true}')
    await w(
      'meetings-index.json',
      JSON.stringify({
        sessions: [
          {
            id: '2026-10-02-launch',
            date: '2026-10-02',
            time_local: '18:30',
            title: 'Launch planning',
            notes: `${stem} - notes.txt`,
            videos: [`${stem} - meeting only.mp4`, `${stem} - compressed.mp4`],
            transcript_json: `${stem} - transcript.json`,
            subtitles: `${stem} - transcript.srt`,
            video_transcripts: [
              {
                video: `${stem} - meeting only.mp4`,
                transcript_json: `${stem} - meeting only - transcript.json`,
                subtitles: `${stem} - meeting only - transcript.srt`,
                synchronization: 'Recording offsets reset from source offset 60 seconds',
                source_offset_seconds: 60,
              },
              { video: `${stem} - compressed.mp4`, transcript_json: `${stem} - transcript.json`, synchronization: 'Full-recording offsets', source_offset_seconds: 0 },
            ],
            verification: `${stem} - verification.json`,
          },
        ],
      }),
    )
    const durations: Record<string, number> = { [`${stem} - meeting only.mp4`]: 1140, [`${stem} - compressed.mp4`]: 1200 }
    const facts = (f: FileEntry): MediaFacts => (durations[f.name] ? { probe: { duration: durations[f.name], hasAudio: true } } : {})
    const lib = await buildLibrary(await scanFiles(dir), facts, ['Ada Byron', 'Grace Hopper'], new Map())
    assert.deepEqual(
      lib.meetings.map((m) => m.id),
      ['2026-10-02-launch'],
      'subtitles and the report make no meetings of their own',
    )
    assert.deepEqual(lib.loose, [])
    const m = lib.meetings[0]
    assert.equal(m.time, 18.5 * 3600)
    const playing = m.videos.find((v) => v.isDefault)!
    assert.ok(playing.name.endsWith('meeting only.mp4'))
    assert.deepEqual(
      m.videos.map((v) => v.offset),
      [60, 0],
    )
    assert.deepEqual(m.axis, [60, 1200])
    assert.deepEqual(
      m.transcripts.map((t) => [t.offset, t.videoIds[0] === playing.fileId]),
      [
        [60, true],
        [0, false],
      ],
    )
    assert.ok(m.files.some((f) => f.name.endsWith('verification.json')))
    // a line 130 s into the trimmed copy is 190 s into the recording the notes are timed on
    const hit = new SearchIndex(lib).search('sandbox access', { typing: false }).hits.find((h) => h.kind === 'transcript')
    assert.equal(hit?.t, 190)
  } finally {
    await rm(dir, { recursive: true })
  }
})

// What the fixture archive built before the fixes to how the folder is read (afbe37c). Those fixes must leave
// every meeting here with the id, date, files and action items it had.
test('the fixture archive builds the meetings, ids, dates, files and action items it always has', async () => {
  const demo = { id: '2026-10-05-demo-day', title: 'Demo day', date: '2026-10-05', files: ['Demo day - 2026-10-05 - source.txt'], actions: [] }
  const launch = (id: string, transcripts: string[], actions: string[]) => ({
    id,
    title: 'Launch planning',
    date: '2026-10-02',
    files: ['Ada Grace - Launch planning - 2026-10-02 - notes.txt', 'Screen Recording 2026-10-02 at 9.15.00\u202fAM compressed.mp4', 'Screen Recording 2026-10-02 at 9.15.00\u202fAM.mp4', ...transcripts],
    actions,
  })
  const json = 'Ada Grace - Launch planning - 2026-10-02 - transcript.json'
  const txt = 'Ada Grace - Launch planning - 2026-10-02 - transcript.txt'
  const expected = {
    without: { meetings: [demo, launch('2026-10-02-launch-planning', [json, txt], ['Gp922Gpjbr', 'yuN_bWHi6R', 'I-C4beB9fI'])], loose: [], cautions: [] },
    with: { meetings: [demo, launch('2026-10-02-launch', [txt, json], ['vf2MrgRgQW', 'I8PDjnpUhT', 'dz5V9driim'])], loose: [], cautions: ['Synthetic test data.'] },
  }
  for (const index of [false, true]) {
    const dir = await fixtureDir({ index })
    try {
      const lib = await buildLibrary(await scanFiles(dir), () => ({}), ['Ada Byron', 'Grace Hopper'], new Map())
      const built = {
        meetings: lib.meetings.map((m) => ({ id: m.id, title: m.title, date: m.date, files: m.files.map((f) => f.rel), actions: m.actions.map((a) => a.id) })),
        loose: lib.loose.map((f) => f.rel),
        cautions: lib.cautions,
      }
      assert.deepEqual(built, index ? expected.with : expected.without)
      for (const m of lib.meetings) assert.equal(lib.byId.get(m.id), m)
    } finally {
      await rm(dir, { recursive: true })
    }
  }
})

test('search: ranking, phrases, filters, typos and highlights', async () => {
  const dir = await fixtureDir({ index: true })
  try {
    const lib = await buildLibrary(await scanFiles(dir), facts, ['Ada Byron', 'Grace Hopper'], new Map())
    const index = new SearchIndex(lib)

    // every word must match: only the transcript line has both
    const r = index.search('sandbox access', { typing: false })
    assert.equal(r.total, 1)
    assert.ok(r.hits.some((h) => h.kind === 'transcript' && h.t === 130))
    assert.ok(index.search('sandbox', { typing: false }).total >= 3)
    const top = r.hits[0]
    assert.ok(top.marks.length > 0, 'hits come with highlight ranges')

    assert.equal(index.search('"widget api sandbox"', { typing: false }).hits.length > 0, true)
    assert.equal(index.search('soc 2 in:actions', { typing: false }).total, 0)
    assert.ok(index.search('requirements in:actions', { typing: false }).hits.every((h) => h.kind === 'action'))
    assert.ok(index.search('sandbx', { typing: false }).total > 0, 'one typo away still finds it')
    assert.ok(Object.keys(index.search('sandbx', { typing: false }).fuzzy).length > 0)
    assert.equal(index.search('pilot person:linus', { typing: false }).total > 0, true)
    assert.equal(index.search('pilot person:nobody', { typing: false }).total, 0)
    assert.equal(index.search('pilot before:2026-09-01', { typing: false }).total, 0)
  } finally {
    await rm(dir, { recursive: true })
  }
})

test('a meeting answers to the ids it had while its files arrived, and after the index lists it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'meetings-test-'))
  const video = 'Screen Recording 2026-10-02 at 9.15.00\u202fAM.mp4'
  const transcript = 'Ada Grace - Launch planning - 2026-10-02 - transcript.txt'
  const notes = 'Ada Grace - Launch planning - 2026-10-02 - notes.txt'
  const build = async () => buildLibrary(await scanFiles(dir), () => ({}), [], new Map())
  try {
    const ids: string[] = []
    await writeFile(join(dir, video), Buffer.alloc(1000, 1))
    ids.push((await build()).meetings[0].id)
    await writeFile(join(dir, transcript), TRANSCRIPT_TXT)
    ids.push((await build()).meetings[0].id)
    await writeFile(join(dir, notes), NOTES)
    const lib = await build()
    ids.push(lib.meetings[0].id)
    // the recording's name, then the transcript's title, then the notes' title
    assert.deepEqual(ids, ['2026-10-02-screen-recording-at-9-15-00-am', '2026-10-02-launch-planning-2026-10-02', '2026-10-02-launch-planning'])
    assert.equal(lib.meetings.length, 1)
    for (const id of ids) assert.equal(lib.byId.get(id), lib.meetings[0], id)

    await writeFile(join(dir, 'meetings-index.json'), JSON.stringify({ sessions: [{ id: '2026-10-02-launch', date: '2026-10-02', title: 'Launch planning', notes, videos: [video], transcript }] }))
    const listed = await build()
    assert.deepEqual(listed.meetings.map((m) => m.id), ['2026-10-02-launch'])
    for (const id of ids) assert.equal(listed.byId.get(id), listed.meetings[0], id)
  } finally {
    await rm(dir, { recursive: true })
  }
})

test("an id wins over another meeting's alias, and an alias two meetings could claim goes to neither", async () => {
  const dir = await mkdtemp(join(tmpdir(), 'meetings-test-'))
  const w = (name: string, data: string | Buffer) => writeFile(join(dir, name), data)
  const notes = (title: string, date: string) => `MEETING NOTES: ${title}\n${date} | Recording: 10:00\n\nSUMMARY\n${title}.\n`
  const transcript = (title: string, video = '') => `MACHINE TRANSCRIPT: ${title}\n${video ? `Source video: ${video}\n` : ''}\n[00:00:01 - 00:00:05] Hello everyone.\n`
  try {
    // its transcript was once titled "Weekly", which is the title of another meeting that day
    await w('Launch call 2026-10-02.mp4', Buffer.alloc(500, 1))
    await w('Launch call 2026-10-02 - transcript.txt', transcript('Weekly', 'Launch call 2026-10-02.mp4'))
    await w('Launch call 2026-10-02 - notes.txt', notes('Launch planning', 'October 2, 2026'))
    await w('Weekly 2026-10-02 - notes.txt', notes('Weekly', 'October 2, 2026'))
    // two meetings whose transcripts were both once titled "Standup"
    for (const name of ['Alpha', 'Beta']) {
      await w(`${name} 2026-10-03 - transcript.txt`, transcript('Standup'))
      await w(`${name} 2026-10-03 - notes.txt`, notes(`${name} review`, 'October 3, 2026'))
    }
    const lib = await buildLibrary(await scanFiles(dir), () => ({}), [], new Map())
    const titled = (title: string) => lib.meetings.find((m) => m.title === title)!
    assert.deepEqual(lib.meetings.map((m) => m.id).sort(), ['2026-10-02-launch-planning', '2026-10-02-weekly', '2026-10-03-alpha-review', '2026-10-03-beta-review'])
    for (const m of lib.meetings) assert.equal(lib.byId.get(m.id), m)
    assert.ok(titled('Launch planning').aliases.includes('2026-10-02-launch-call'), 'the recording on its own')
    assert.equal(lib.byId.get('2026-10-02-weekly'), titled('Weekly'))
    assert.ok(!titled('Launch planning').aliases.includes('2026-10-02-weekly'))
    assert.equal(lib.byId.get('2026-10-03-standup'), undefined)
    assert.ok(!titled('Alpha review').aliases.includes('2026-10-03-standup') && !titled('Beta review').aliases.includes('2026-10-03-standup'))
  } finally {
    await rm(dir, { recursive: true })
  }
})

test('the copy the player streams by default is one that can be read and has a picture', async () => {
  const dir = await fixtureDir()
  const original = 'Screen Recording 2026-10-02 at 9.15.00\u202fAM.mp4'
  const compressed = 'Screen Recording 2026-10-02 at 9.15.00\u202fAM compressed.mp4'
  const sound = 'Screen Recording 2026-10-02 at 9.15.00\u202fAM.m4a'
  try {
    // the audio a transcription step kept, the lightest copy of all
    await writeFile(join(dir, sound), Buffer.alloc(300, 4))
    const picture = { duration: 1200, width: 1920, height: 1080, hasAudio: true }
    const launch = async (facts: (f: FileEntry) => MediaFacts) =>
      (await buildLibrary(await scanFiles(dir), facts, [], new Map())).meetings.find((m) => m.title === 'Launch planning')!
    const probed = await launch((f) => (f.kind === 'audio' ? { probe: { duration: 1200, hasAudio: true } } : f.kind === 'video' ? { probe: picture } : {}))
    assert.equal(probed.videos.find((v) => v.isDefault)?.name, compressed)
    assert.ok(probed.videos.find((v) => v.name === sound)?.playable, 'the sound-only copy can still be played')
    // not probed yet (or no ffprobe on this Mac): the file names say which copies have a picture
    assert.equal((await launch(() => ({}))).videos.find((v) => v.isDefault)?.name, compressed)
    // ffprobe couldn't read the lighter copy (its compression was cut off): it is left out
    const cut = await launch((f) => (f.name === compressed ? { failed: true } : f.kind === 'video' ? { probe: picture } : { probe: { duration: 1200, hasAudio: true } }))
    assert.deepEqual(cut.videos.map((v) => [v.name, v.playable, v.isDefault]), [
      [compressed, false, false],
      [sound, true, false],
      [original, true, true],
    ])
    assert.equal(cut.videos.find((v) => v.name === compressed)?.failed, true)
  } finally {
    await rm(dir, { recursive: true })
  }
})

for (const which of ['the folder', 'a folder above it']) {
  // elsewhere only the last part of a path is checked for a link, and the files still open through one above it
  const skip = which === 'a folder above it' && process.platform !== 'darwin' && 'only macOS refuses a link anywhere in a path'
  test(`the meetings folder pinned at startup: ${which} moved on the same disk and linked back stops the scan`, { skip }, async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'meetings-test-')))
    const parent = join(dir, 'Screenshots')
    const folder = join(parent, 'meetings')
    const [from, to] = which === 'the folder' ? [folder, join(dir, 'moved')] : [parent, join(dir, 'Screenshots moved')]
    try {
      await mkdir(folder, { recursive: true })
      await writeFile(join(folder, 'Weekly - 2026-11-03 - notes.txt'), 'MEETING NOTES: Weekly\nNovember 3, 2026 | Recording: 10:00\n')
      await writeFile(join(folder, 'Screen Recording 2026-11-03 at 4.07.09 PM.mov'), Buffer.alloc(1000, 1))
      const pinned = await pinFolder(folder)
      assert.equal((await scanFiles(pinned)).length, 2)
      await rename(from, to)
      await symlink(to, from)
      await assert.rejects(scanFiles(pinned), StaleFile)
      // put back as it was, it still waits for a restart
      await rm(from)
      await rename(to, from)
      await assert.rejects(scanFiles(pinned), StaleFile)
      assert.equal((await scanFiles(await pinFolder(folder))).length, 2)
      // a link the owner says is intended (MEETINGS_DIR_ALLOW_LINK=1) is pinned at the folder it leads to
      await rename(from, to)
      await symlink(to, from)
      assert.equal((await scanFiles(await pinFolder(folder, true))).length, 2)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
}

// root opens a folder whatever its permissions
test('the meetings folder pinned at startup: one that cannot be opened for a while stops that scan only', { skip: process.getuid?.() === 0 && 'running as root' }, async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'meetings-test-')))
  const folder = join(dir, 'meetings')
  try {
    await mkdir(folder)
    await writeFile(join(folder, 'Weekly - 2026-11-03 - notes.txt'), 'MEETING NOTES: Weekly\nNovember 3, 2026 | Recording: 10:00\n')
    const pinned = await pinFolder(folder)
    await chmod(folder, 0o000)
    await assert.rejects(scanFiles(pinned), StaleFile)
    await chmod(folder, 0o700)
    assert.equal((await scanFiles(pinned)).length, 1)
  } finally {
    await chmod(folder, 0o700).catch(() => {})
    await rm(dir, { recursive: true, force: true })
  }
})

test('a file that cannot be read is named among the cautions, and a broken index says meetings are grouped by name', async (t) => {
  const dir = await fixtureDir({ index: true })
  t.after(() => rm(dir, { recursive: true }))
  t.mock.method(console, 'warn', () => {})
  const build = async () => buildLibrary(await scanFiles(dir), () => ({}), [], new Map())
  // a transcript cut off partway through
  await writeFile(join(dir, 'Weekly sync 2026-10-09 - transcript.json'), '{"segments": [{"start": 0, "end": 4, "text": "hello every')
  const cut = await build()
  assert.deepEqual(cut.cautions, ['Synthetic test data.', "Weekly sync 2026-10-09 - transcript.json can't be read, so what it holds is left out"])

  // one missing colon in the index
  const index = join(dir, 'meetings-index.json')
  await writeFile(index, (await readFile(index, 'utf8')).replace('"sessions":', '"sessions"'))
  const broken = await build()
  assert.ok(broken.cautions.includes("meetings-index.json can't be read, so meetings are grouped by name until it is fixed"))
  assert.ok(broken.cautions.every((c) => !/hello|Launch planning|Synthetic/.test(c)), 'names only, never what the files say')
  // grouped by name, the meeting answers to the ids its files give it
  assert.ok(broken.byId.get('2026-10-02-launch-planning'))
})

test('a session of the index nested too deep to read is skipped with a caution, and the rest builds', async () => {
  const dir = await fixtureDir()
  try {
    // about 40 KB of brackets, which JSON.parse takes
    const deep = '['.repeat(20_000) + ']'.repeat(20_000)
    const notes = 'Ada Grace - Launch planning - 2026-10-02 - notes.txt'
    await writeFile(join(dir, 'meetings-index.json'), `{"sessions":[{"id":"odd","title":"odd","extra":${deep}},{"id":"2026-10-02-launch","date":"2026-10-02","title":"Launch planning","notes":"${notes}"}]}`)
    const lib = await buildLibrary(await scanFiles(dir), () => ({}), [], new Map())
    assert.ok(lib.byId.get('2026-10-02-launch')?.notesFile)
    assert.equal(lib.byId.get('odd'), undefined)
    assert.equal(lib.cautions.length, 1)
    assert.match(lib.cautions[0], /^meetings-index\.json session 1 skipped: /)
  } finally {
    await rm(dir, { recursive: true })
  }
})

// An archive whose file names are all different, kept in subfolders: notes, the two halves of a transcript and
// two copies of a recording each in a folder of their own, and an index that names files with and without their
// folder. Looking files up by their path changes nothing here; what it builds is what it built before.
async function spreadOut(index: boolean) {
  const dir = await mkdtemp(join(tmpdir(), 'meetings-test-'))
  const w = async (rel: string, data: string | Buffer) => {
    await mkdir(join(dir, dirname(rel)), { recursive: true })
    await writeFile(join(dir, rel), data)
  }
  const stem = 'Ada Grace - Launch planning - 2026-10-02'
  const original = 'Screen Recording 2026-10-02 at 9.15.00 AM.mp4'
  const compressed = 'Screen Recording 2026-10-02 at 9.15.00 AM compressed.mp4'
  await w(`Notes/${stem} - notes.txt`, NOTES)
  await w(`Transcripts/${stem} - transcript.json`, WHISPER)
  await w(`Text/${stem} - transcript.txt`, TRANSCRIPT_TXT)
  await w(original, Buffer.alloc(4000, 1))
  await w(`Copies/${compressed}`, Buffer.alloc(1000, 2))
  await w('Demo/Demo day - 2026-10-05 - source.txt', CLOCK_TXT)
  await w('Docs/Launch budget 2026-10-02.txt', 'Two clinics, one quarter, per-seat pricing.\n')
  await w('Review/Retro 2026-10-07 - notes.txt', 'MEETING NOTES: Retro\nOctober 7, 2026 | Recording: 30:00\n\nACTION ITEMS\n- Ada: Write up the retro. (01:00-02:00)\n')
  await w('Review/Clips/Retro 2026-10-07.mp4', Buffer.alloc(700, 3))
  await w('Review/Retro 2026-10-07 - transcript.srt', '1\n00:00:01,000 --> 00:00:04,000\nWelcome to the retro.\n')
  // a Source video line that gives a folder too was never matched by name, and still isn't
  await w('Vendor call 2026-10-28 - transcript.txt', 'MACHINE TRANSCRIPT: Vendor call\nSource video: Calls/Vendor call 2026-10-28.mov\n\n[00:00:01 - 00:00:05] Hello.\n')
  await w('Calls/Vendor call 2026-10-28.mov', Buffer.alloc(900, 4))
  await w('Misc/Pilot pricing worksheet.txt', 'Per-seat pricing for two clinics.\n')
  const noon = new Date(2026, 9, 9, 12, 0)
  await utimes(join(dir, 'Misc/Pilot pricing worksheet.txt'), noon, noon)
  if (index)
    await w('meetings-index.json', JSON.stringify({
      sessions: [
        { id: '2026-10-02-launch', date: '2026-10-02', title: 'Launch planning', notes: `Notes/${stem} - notes.txt`, videos: [original, `Copies/${compressed}`], transcript: `${stem} - transcript.txt`, transcript_json: `Transcripts/${stem} - transcript.json`, video_transcripts: [{ video: compressed, transcript_json: `${stem} - transcript.json`, synchronization: 'recording offsets' }] },
        { id: '2026-10-07-retro', date: '2026-10-07', title: 'Retro', notes: 'Retro 2026-10-07 - notes.txt', videos: ['Retro 2026-10-07.mp4'], subtitles: 'Review/Retro 2026-10-07 - transcript.srt' },
      ],
    }))
  return dir
}

test('an archive with no repeated names, spread over subfolders, builds exactly the library it built before', async () => {
  const without = {
    meetings: [
      {
        id: '2026-10-28-vendor-call-2',
        aliases: [],
        title: 'Vendor call',
        date: '2026-10-28',
        files: ['Calls/Vendor call 2026-10-28.mov'],
        videos: [['Calls/Vendor call 2026-10-28.mov', true, null, false]],
        transcripts: [],
        docs: [],
        actions: [],
      },
      {
        id: '2026-10-28-vendor-call',
        aliases: ['vendor-call-2026-10-28'],
        title: 'Vendor call',
        date: '2026-10-28',
        files: ['Vendor call 2026-10-28 - transcript.txt'],
        videos: [],
        transcripts: [['i3yse7lig2L8', 'Transcript', ['Vendor call 2026-10-28 - transcript.txt'], []]],
        docs: [],
        actions: [],
      },
      {
        id: '2026-10-07-retro',
        aliases: ['retro-2026-10-07'],
        title: 'Retro',
        date: '2026-10-07',
        files: ['Review/Retro 2026-10-07 - notes.txt', 'Review/Clips/Retro 2026-10-07.mp4', 'Review/Retro 2026-10-07 - transcript.srt'],
        videos: [['Review/Clips/Retro 2026-10-07.mp4', true, null, false]],
        transcripts: [['HkuLxyjra-XO', 'Transcript', ['Review/Retro 2026-10-07 - transcript.srt'], []]],
        docs: [],
        actions: ['HI-f98wueN'],
      },
      {
        id: '2026-10-05-demo-day',
        aliases: ['2026-10-05-demo-day-source', 'demo-day-2026-10-05'],
        title: 'Demo day',
        date: '2026-10-05',
        files: ['Demo/Demo day - 2026-10-05 - source.txt'],
        videos: [],
        transcripts: [['otUVIRECOuR7', 'Source transcript (wall clock)', ['Demo/Demo day - 2026-10-05 - source.txt'], []]],
        docs: [],
        actions: [],
      },
      {
        id: '2026-10-02-launch-planning',
        aliases: [
          '2026-10-02-launch-planning-2026-10-02',
          '2026-10-02-screen-recording-at-9-15-00-am',
          '2026-10-02-screen-recording-at-9-15-00-am-compressed',
          'ada-grace-launch-planning-2026-10-02',
          'screen-recording-2026-10-02-at-9-15-00-am',
        ],
        title: 'Launch planning',
        date: '2026-10-02',
        files: [
          'Notes/Ada Grace - Launch planning - 2026-10-02 - notes.txt',
          'Copies/Screen Recording 2026-10-02 at 9.15.00\u202fAM compressed.mp4',
          'Screen Recording 2026-10-02 at 9.15.00\u202fAM.mp4',
          'Text/Ada Grace - Launch planning - 2026-10-02 - transcript.txt',
          'Transcripts/Ada Grace - Launch planning - 2026-10-02 - transcript.json',
          'Docs/Launch budget 2026-10-02.txt',
        ],
        videos: [
          ['Copies/Screen Recording 2026-10-02 at 9.15.00\u202fAM compressed.mp4', true, null, false],
          ['Screen Recording 2026-10-02 at 9.15.00\u202fAM.mp4', false, 'pLyA2DR1q4Pr', true],
        ],
        transcripts: [
          [
            'pLyA2DR1q4Pr',
            'Transcript',
            [
              'Text/Ada Grace - Launch planning - 2026-10-02 - transcript.txt',
              'Transcripts/Ada Grace - Launch planning - 2026-10-02 - transcript.json',
            ],
            ['Screen Recording 2026-10-02 at 9.15.00\u202fAM.mp4'],
          ],
        ],
        docs: ['Docs/Launch budget 2026-10-02.txt'],
        actions: ['Gp922Gpjbr', 'yuN_bWHi6R', 'I-C4beB9fI'],
      },
    ],
    loose: ['Misc/Pilot pricing worksheet.txt'],
    cautions: [],
    ids: [
      '2026-10-02-launch-planning',
      '2026-10-02-launch-planning-2026-10-02',
      '2026-10-02-screen-recording-at-9-15-00-am',
      '2026-10-02-screen-recording-at-9-15-00-am-compressed',
      '2026-10-05-demo-day',
      '2026-10-05-demo-day-source',
      '2026-10-07-retro',
      '2026-10-28-vendor-call',
      '2026-10-28-vendor-call-2',
      'ada-grace-launch-planning-2026-10-02',
      'demo-day-2026-10-05',
      'retro-2026-10-07',
      'screen-recording-2026-10-02-at-9-15-00-am',
      'vendor-call-2026-10-28',
    ],
  }
  const withIndex = {
    meetings: [
      {
        id: '2026-10-28-vendor-call-2',
        aliases: [],
        title: 'Vendor call',
        date: '2026-10-28',
        files: ['Calls/Vendor call 2026-10-28.mov'],
        videos: [['Calls/Vendor call 2026-10-28.mov', true, null, false]],
        transcripts: [],
        docs: [],
        actions: [],
      },
      {
        id: '2026-10-28-vendor-call',
        aliases: ['vendor-call-2026-10-28'],
        title: 'Vendor call',
        date: '2026-10-28',
        files: ['Vendor call 2026-10-28 - transcript.txt'],
        videos: [],
        transcripts: [['i3yse7lig2L8', 'Transcript', ['Vendor call 2026-10-28 - transcript.txt'], []]],
        docs: [],
        actions: [],
      },
      {
        id: '2026-10-07-retro',
        aliases: ['retro-2026-10-07'],
        title: 'Retro',
        date: '2026-10-07',
        files: ['Review/Retro 2026-10-07 - notes.txt', 'Review/Clips/Retro 2026-10-07.mp4', 'Review/Retro 2026-10-07 - transcript.srt'],
        videos: [['Review/Clips/Retro 2026-10-07.mp4', true, null, false]],
        transcripts: [['HkuLxyjra-XO', 'Transcript', ['Review/Retro 2026-10-07 - transcript.srt'], []]],
        docs: [],
        actions: ['HI-f98wueN'],
      },
      {
        id: '2026-10-05-demo-day',
        aliases: ['2026-10-05-demo-day-source', 'demo-day-2026-10-05'],
        title: 'Demo day',
        date: '2026-10-05',
        files: ['Demo/Demo day - 2026-10-05 - source.txt'],
        videos: [],
        transcripts: [['otUVIRECOuR7', 'Source transcript (wall clock)', ['Demo/Demo day - 2026-10-05 - source.txt'], []]],
        docs: [],
        actions: [],
      },
      {
        id: '2026-10-02-launch',
        aliases: [
          '2026-10-02-launch-planning',
          '2026-10-02-launch-planning-2026-10-02',
          '2026-10-02-screen-recording-at-9-15-00-am',
          '2026-10-02-screen-recording-at-9-15-00-am-compressed',
          'ada-grace-launch-planning-2026-10-02',
          'screen-recording-2026-10-02-at-9-15-00-am',
        ],
        title: 'Launch planning',
        date: '2026-10-02',
        files: [
          'Notes/Ada Grace - Launch planning - 2026-10-02 - notes.txt',
          'Screen Recording 2026-10-02 at 9.15.00\u202fAM.mp4',
          'Copies/Screen Recording 2026-10-02 at 9.15.00\u202fAM compressed.mp4',
          'Text/Ada Grace - Launch planning - 2026-10-02 - transcript.txt',
          'Transcripts/Ada Grace - Launch planning - 2026-10-02 - transcript.json',
          'Docs/Launch budget 2026-10-02.txt',
        ],
        videos: [
          ['Screen Recording 2026-10-02 at 9.15.00\u202fAM.mp4', false, null, false],
          ['Copies/Screen Recording 2026-10-02 at 9.15.00\u202fAM compressed.mp4', true, 'pLyA2DR1q4Pr', true],
        ],
        transcripts: [
          [
            'pLyA2DR1q4Pr',
            'Transcript',
            [
              'Text/Ada Grace - Launch planning - 2026-10-02 - transcript.txt',
              'Transcripts/Ada Grace - Launch planning - 2026-10-02 - transcript.json',
            ],
            ['Copies/Screen Recording 2026-10-02 at 9.15.00\u202fAM compressed.mp4'],
          ],
        ],
        docs: ['Docs/Launch budget 2026-10-02.txt'],
        actions: ['vf2MrgRgQW', 'I8PDjnpUhT', 'dz5V9driim'],
      },
    ],
    loose: ['Misc/Pilot pricing worksheet.txt'],
    cautions: [],
    ids: [
      '2026-10-02-launch',
      '2026-10-02-launch-planning',
      '2026-10-02-launch-planning-2026-10-02',
      '2026-10-02-screen-recording-at-9-15-00-am',
      '2026-10-02-screen-recording-at-9-15-00-am-compressed',
      '2026-10-05-demo-day',
      '2026-10-05-demo-day-source',
      '2026-10-07-retro',
      '2026-10-28-vendor-call',
      '2026-10-28-vendor-call-2',
      'ada-grace-launch-planning-2026-10-02',
      'demo-day-2026-10-05',
      'retro-2026-10-07',
      'screen-recording-2026-10-02-at-9-15-00-am',
      'vendor-call-2026-10-28',
    ],
  }
  for (const index of [false, true]) {
    const dir = await spreadOut(index)
    try {
      const lib = await buildLibrary(await scanFiles(dir), () => ({}), ['Ada Byron', 'Grace Hopper'], new Map())
      const rel = (id: string) => lib.files.get(id)!.rel
      const built = {
        meetings: lib.meetings.map((m) => ({
          id: m.id,
          aliases: [...m.aliases].sort(),
          title: m.title,
          date: m.date,
          files: m.files.map((f) => f.rel),
          videos: m.videos.map((v) => [rel(v.fileId), v.isDefault, v.transcriptId ?? null, v.synced]),
          transcripts: m.transcripts.map((t) => [t.id, t.label, lib.transcripts.get(t.id)!.files.map((f) => f.rel), t.videoIds.map(rel)]),
          docs: m.docs.map((f) => f.rel),
          actions: m.actions.map((a) => a.id),
        })),
        loose: lib.loose.map((f) => f.rel),
        cautions: lib.cautions,
        ids: [...lib.byId.keys()].sort(),
      }
      assert.deepEqual(built, index ? withIndex : without)
    } finally {
      await rm(dir, { recursive: true })
    }
  }
})

test('two meetings kept in subfolders under the same file names keep their own files, with or without an index', async () => {
  const notes = (title: string, date: string) => `MEETING NOTES: ${title}\n${date} | Recording: 10:00\n\nSUMMARY\n${title} summary.\n`
  const folders = [
    ['2026-11-03 Weekly', 'Weekly sync', 'November 3, 2026', 'pricing for the clinic pilot'],
    ['2026-11-10 Weekly', 'Weekly sync two', 'November 10, 2026', 'hiring plan for next quarter'],
  ]
  for (const withIndex of [false, true]) {
    const dir = await mkdtemp(join(tmpdir(), 'meetings-test-'))
    try {
      for (const [folder, title, date, words] of folders) {
        await mkdir(join(dir, folder))
        await writeFile(join(dir, folder, 'notes.txt'), notes(title, date))
        await writeFile(join(dir, folder, 'transcript.json'), JSON.stringify({ segments: [{ start: 1, end: 5, text: words }] }))
        await writeFile(join(dir, folder, 'recording.mp4'), Buffer.alloc(100 + words.length))
      }
      if (withIndex)
        await writeFile(join(dir, 'meetings-index.json'), JSON.stringify({ sessions: folders.map(([f], i) => ({ id: `m${i + 1}`, date: f.slice(0, 10), title: f, notes: `${f}/notes.txt`, videos: [`${f}/recording.mp4`], transcript_json: `${f}/transcript.json` })) }))
      const lib = await buildLibrary(await scanFiles(dir), () => ({}), [], new Map())
      for (const m of lib.meetings) assert.equal(new Set(m.files.map((f) => dirname(f.rel))).size, 1, `${m.title} holds one folder's files`)
      for (const [folder, , , words] of folders) {
        const m = lib.meetings.find((x) => x.notesFile?.rel === `${folder}/notes.txt`)!
        assert.deepEqual(m.transcripts.map((t) => lib.transcripts.get(t.id)!.parsed.segments.map((s) => s.t).join(' ')), [words])
        // with the index, the recording too; without it nothing ties recording.mp4 to notes.txt, as in one folder
        assert.deepEqual(m.videos.map((v) => lib.files.get(v.fileId)!.rel), withIndex ? [`${folder}/recording.mp4`] : [])
      }
      assert.equal(lib.meetings.length, withIndex ? 2 : 4)
    } finally {
      await rm(dir, { recursive: true })
    }
  }
})

test('the recording a transcript names gone, an untrimmed copy of it left: still one meeting, timed by that copy', async () => {
  const dir = await fixtureDir()
  const compressed = 'Screen Recording 2026-10-02 at 9.15.00\u202fAM compressed.mp4'
  try {
    const build = async () => buildLibrary(await scanFiles(dir), () => ({}), [], new Map())
    const both = await build()
    // the lighter copy the Lab suggested was made, and the original deleted to save space
    await rm(join(dir, 'Screen Recording 2026-10-02 at 9.15.00\u202fAM.mp4'))
    const lib = await build()
    assert.equal(lib.meetings.length, both.meetings.length)
    const launch = lib.meetings.find((m) => m.title === 'Launch planning')!
    assert.equal(launch.id, both.meetings.find((m) => m.title === 'Launch planning')!.id)
    assert.deepEqual(launch.videos.map((v) => [v.name, v.transcriptId, v.synced]), [[compressed, launch.transcripts[0].id, true]])
    // the id the copy had while it was a meeting of its own still leads here
    assert.equal(lib.byId.get('2026-10-02-screen-recording-at-9-15-00-am-compressed'), launch)

    // a trimmed copy runs on other times than the transcript, so it doesn't stand in
    await rename(join(dir, compressed), join(dir, 'Screen Recording 2026-10-02 at 9.15.00\u202fAM meeting only.mp4'))
    const trimmed = await build()
    assert.deepEqual(trimmed.meetings.find((m) => m.title === 'Launch planning')!.videos, [])
    assert.equal(trimmed.meetings.length, both.meetings.length + 1)
  } finally {
    await rm(dir, { recursive: true })
  }
})

test('a document the index names under a key of its own is one of the meeting\'s documents, and searched', async () => {
  const dir = await fixtureDir({ index: true })
  try {
    await writeFile(join(dir, 'Launch agenda 2026-10-02.txt'), 'Agenda: confirm the zebrafish pricing tier.\n')
    const index = join(dir, 'meetings-index.json')
    const j = JSON.parse(await readFile(index, 'utf8'))
    j.sessions[0].agenda = 'Launch agenda 2026-10-02.txt'
    await writeFile(index, JSON.stringify(j))
    const lib = await buildLibrary(await scanFiles(dir), () => ({}), [], new Map())
    const m = lib.byId.get('2026-10-02-launch')!
    assert.deepEqual(m.docs.map((f) => f.name), ['Launch agenda 2026-10-02.txt'])
    assert.equal(m.files.filter((f) => f.name === 'Launch agenda 2026-10-02.txt').length, 1)
    assert.deepEqual(new SearchIndex(lib).search('zebrafish', { typing: false }).hits.map((h) => h.meetingId), ['2026-10-02-launch'])
  } finally {
    await rm(dir, { recursive: true })
  }
})

test('a document with no date in its name, saved on the evening of a meeting, goes with that meeting', async (t) => {
  // an evening on the east coast is already the next day in UTC
  const tz = process.env.TZ
  process.env.TZ = 'America/New_York'
  t.after(() => {
    if (tz === undefined) delete process.env.TZ
    else process.env.TZ = tz
  })
  const dir = await fixtureDir({ index: true })
  t.after(() => rm(dir, { recursive: true }))
  const doc = join(dir, 'Pilot pricing worksheet.txt')
  await writeFile(doc, 'Two clinics, one quarter, per-seat pricing.\n')
  const evening = new Date(2026, 9, 2, 21, 30)
  await utimes(doc, evening, evening)
  const lib = await buildLibrary(await scanFiles(dir), () => ({}), [], new Map())
  assert.deepEqual(lib.byId.get('2026-10-02-launch')!.docs.map((d) => d.name), ['Pilot pricing worksheet.txt'])
  assert.deepEqual(lib.loose, [])
})

// ---------- what a file is, and what its name says ----------

test("someone's own notes file goes with its meeting as a document: no meeting of its own, nothing on the board", async () => {
  const dir = await fixtureDir({ index: true })
  try {
    const name = 'Grace notes from the Acme call 2026-10-02.md'
    await writeFile(join(dir, name), 'Thoughts after the Acme call\n\nPricing felt high to them.\n\nTODO\n- Grace: send the revised deck\n- Ask Linus about the sandbox\n')
    const lib = await buildLibrary(await scanFiles(dir), () => ({}), ['Ada Byron', 'Grace Example'], new Map())
    const launch = lib.byId.get('2026-10-02-launch')!
    assert.ok(launch.docs.some((d) => d.name === name), 'it is one of the meeting it is dated for')
    assert.deepEqual(lib.meetings.filter((m) => m.date === '2026-10-02').map((m) => m.id), ['2026-10-02-launch'])
    assert.ok(!lib.meetings.some((m) => m.actions.some((a) => /send the revised deck|Ask Linus about the sandbox/.test(a.text))), 'its bullets are not action items')
    assert.match(lib.docText.get(launch.docs.find((d) => d.name === name)!.id) ?? '', /Pricing felt high/, 'and its words are searched with the meeting')
  } finally {
    await rm(dir, { recursive: true })
  }
})

test('an agenda or a pasted chat with times in brackets is a document, and the day keeps its other documents', async () => {
  const dir = await fixtureDir({ index: true })
  try {
    await writeFile(join(dir, 'Launch planning budget 2026-10-02.txt'), 'Budget for the pilot: two clinics, one quarter.\n')
    await writeFile(join(dir, 'Launch planning agenda 2026-10-02.txt'), 'Agenda\n\n[9:15] Intro and goals\n[9:30] Pricing\n[9:50] Next steps\n')
    await writeFile(join(dir, 'Launch planning chat transcript 2026-10-02.txt'), '[10:02 AM] Grace: can everyone see the deck?\n[10:03 AM] Ada: yes\n')
    await writeFile(join(dir, 'Launch planning captions 2026-10-02.srt'), '')
    const lib = await buildLibrary(await scanFiles(dir), () => ({}), ['Ada Byron'], new Map())
    assert.deepEqual(lib.meetings.filter((m) => m.date === '2026-10-02').map((m) => m.id), ['2026-10-02-launch'], 'neither file became a meeting')
    const docs = lib.byId.get('2026-10-02-launch')!.docs.map((d) => d.name).sort()
    assert.deepEqual(docs, ['Launch planning agenda 2026-10-02.txt', 'Launch planning budget 2026-10-02.txt', 'Launch planning chat transcript 2026-10-02.txt'])
    assert.deepEqual(lib.loose.map((f) => f.name), ['Launch planning captions 2026-10-02.srt'], 'subtitles with nothing in them are left out and listed')
  } finally {
    await rm(dir, { recursive: true })
  }
})

test('a recording with no date in its name is dated by the day it was made on this Mac', async () => {
  const dir = await fixtureDir()
  try {
    const video = join(dir, 'Grace intro call.mp4')
    await writeFile(video, Buffer.alloc(500, 3))
    const evening = new Date(2026, 10, 3, 20, 15) // 3 November 2026, 8:15 pm here; already 4 November in UTC from a zone west of it
    await utimes(video, evening, evening)
    const lib = await buildLibrary(await scanFiles(dir), () => ({}), [], new Map())
    const m = lib.meetings.find((x) => x.videos.some((v) => v.name === 'Grace intro call.mp4'))!
    assert.deepEqual([m.title, m.date, m.id], ['Grace intro call', '2026-11-03', '2026-11-03-grace-intro-call'])
    // the id the UTC day gave it, wherever that was another day, still opens it
    assert.equal(lib.byId.get(`${evening.toISOString().slice(0, 10)}-grace-intro-call`), m)
  } finally {
    await rm(dir, { recursive: true })
  }
})

test("a file name's title leaves out its date, the words of a lighter copy and the role it ends in", () => {
  const titles: [string, string][] = [
    ['Demo day - 2026-10-05 - source.txt', 'Demo day'],
    ['Screen Recording 2026-10-02 at 9.15.00 AM.mp4', 'Screen Recording at 9.15.00 AM'],
    ['Screen Recording 2026-10-02 at 9.15.00 AM compressed.mp4', 'Screen Recording at 9.15.00 AM'],
    ['Ada Grace - Launch planning - 2026-10-02 - notes.txt', 'Ada Grace - Launch planning'],
    ['Acme_Product_Demo_2026_04_09_10_30_CDT_Recording_1.mp4', 'Acme Product Demo'],
    ['Weekly sync (2026-10-09 14:30 GMT-5) - Recording.mp4', 'Weekly sync'],
    ['Kickoff (Acme) 2026.10.02 meeting only crf 28.mp4', 'Kickoff (Acme)'],
    ['Vendor call 2026-10-28 (2).mp4', 'Vendor call'],
    ['2026-10-03 Standup.mov', 'Standup'],
    // words that are ordinary titles stay, and so does the one name a recording has
    ['Portal for web 2026-10-02.mp4', 'Portal for web'],
    ['Footnotes review 2026-10-02.txt', 'Footnotes review'],
    ['Budget 2026-10-02 10.30 QA sync.mp4', 'Budget QA sync'],
    ['Screen Recording 2026-10-02.mov', 'Screen Recording'],
    ['2026-10-02.mp4', ''],
  ]
  for (const [name, title] of titles) assert.equal(nameTitle(name), title, name)
})

test('a recording exported with underscores in its name gets the date and the title its name carries', async () => {
  const dir = await fixtureDir()
  try {
    await writeFile(join(dir, 'Acme_Product_Demo_2026_04_09_10_30_CDT_Recording_1.mp4'), Buffer.alloc(500, 4))
    await writeFile(join(dir, '2026-10-02.mp4'), Buffer.alloc(500, 5))
    const lib = await buildLibrary(await scanFiles(dir), () => ({}), [], new Map())
    const demo = lib.meetings.find((m) => m.videos.some((v) => v.name.startsWith('Acme_Product')))!
    assert.deepEqual([demo.title, demo.date, demo.id], ['Acme Product Demo', '2026-04-09', '2026-04-09-acme-product-demo'])
    const bare = lib.meetings.find((m) => m.videos.some((v) => v.name === '2026-10-02.mp4'))!
    assert.deepEqual([bare.title, bare.id], ['Recording', '2026-10-02-recording'], 'a name that is only a date still gets a title')
  } finally {
    await rm(dir, { recursive: true })
  }
})

test('ids made while titles kept their separators and copy words still open their meetings', async () => {
  const dir = await fixtureDir()
  try {
    // only the Demo day transcript and the lighter copy of the recording are left
    for (const f of await scanFiles(dir)) if (/^Ada Grace/.test(f.name) || (f.kind === 'video' && !/compressed/.test(f.name))) await rm(f.path)
    const lib = await buildLibrary(await scanFiles(dir), facts, [], new Map())
    const demo = lib.meetings.find((m) => m.timeBase === 'clock')!
    assert.equal(demo.id, '2026-10-05-demo-day')
    assert.equal(lib.byId.get('2026-10-05-demo-day-source'), demo)
    // a lighter copy left on its own was named with the copy's word
    const copy = lib.meetings.find((m) => m.videos.length === 1 && m.videos[0].name.endsWith('compressed.mp4'))!
    assert.equal(copy.id, '2026-10-02-screen-recording-at-9-15-00-am')
    assert.equal(lib.byId.get('2026-10-02-screen-recording-at-9-15-00-am-compressed'), copy)
  } finally {
    await rm(dir, { recursive: true })
  }
})

test('an entry says what sort of recording it is: the index first, then a Kind: line in the notes, else a meeting', async () => {
  const dir = await fixtureDir({ index: true })
  const notesName = 'Ada Grace - Launch planning - 2026-10-02 - notes.txt'
  const index = join(dir, 'meetings-index.json')
  const build = async () => buildLibrary(await scanFiles(dir), facts, [], new Map())
  const kinds = (lib: Awaited<ReturnType<typeof build>>) => lib.meetings.map((m) => [m.title, m.kind]).sort()
  const setIndexKind = async (kind: unknown) => {
    const j = JSON.parse(await readFile(index, 'utf8'))
    j.sessions[0].kind = kind
    await writeFile(index, JSON.stringify(j))
  }
  try {
    // nothing says otherwise: a meeting, even one whose title and file name say "Demo day"
    assert.deepEqual(kinds(await build()), [['Demo day', 'meeting'], ['Launch planning', 'meeting']])

    // a Kind: line among the header lines of the notes, taken out of the intro and leaving the date line alone
    await writeFile(join(dir, notesName), NOTES.replace('Participants visible', 'Kind: Demo\nParticipants visible'))
    let lib = await build()
    let m = lib.byId.get('2026-10-02-launch')!
    assert.equal(m.kind, 'demo')
    assert.equal(m.notes?.kind, 'demo')
    assert.ok(!m.notes?.intro.some((l) => /kind/i.test(l.text)))
    assert.equal(m.notes?.meta[0], 'October 2, 2026')
    assert.equal(lib.meetings.find((x) => x.title === 'Demo day')?.kind, 'meeting')

    // right under the title it is still the kind, not the date line
    await writeFile(join(dir, notesName), NOTES.replace('\nOctober 2, 2026', '\nKind: Training\nOctober 2, 2026'))
    m = (await build()).byId.get('2026-10-02-launch')!
    assert.deepEqual([m.kind, m.date, m.notes?.meta[0], m.phases.length], ['training', '2026-10-02', 'October 2, 2026', 1])

    // a Kind: line inside a section is only words
    await writeFile(join(dir, notesName), NOTES.replace('UNCERTAINTIES\n', 'UNCERTAINTIES\nKind: demo\n'))
    assert.equal((await build()).byId.get('2026-10-02-launch')!.kind, 'meeting')

    // the index wins over the notes
    await writeFile(join(dir, notesName), NOTES.replace('Participants visible', 'Kind: Demo\nParticipants visible'))
    await setIndexKind('Site visit')
    lib = await build()
    assert.equal(lib.byId.get('2026-10-02-launch')!.kind, 'site visit')
    // ...and the key names no file: the meeting keeps exactly the files it had
    assert.equal(lib.byId.get('2026-10-02-launch')!.files.length, 5)

    // a value the index can't use leaves the word to the notes, and then to the default
    await setIndexKind('  !!! ')
    assert.equal((await build()).byId.get('2026-10-02-launch')!.kind, 'demo')
    await writeFile(join(dir, notesName), NOTES)
    for (const odd of [42, '', '---', ['demo'], null]) {
      await setIndexKind(odd)
      assert.equal((await build()).byId.get('2026-10-02-launch')!.kind, 'meeting', JSON.stringify(odd))
    }
  } finally {
    await rm(dir, { recursive: true })
  }
})

test('a kind is normalised once: lowercase words of letters, digits and hyphens, one space apart, 24 characters at most', () => {
  const cases: [unknown, string | undefined][] = [
    ['Demo', 'demo'],
    ['  Product   DEMO ', 'product demo'],
    ['site_visit', 'site visit'],
    ['Training (v2)!', 'training v2'],
    ['-walk-through-', 'walk-through'],
    ['a - b', 'a b'],
    ['Réunion', 'réunion'],
    ['A very long kind of recording indeed', 'a very long kind of reco'],
    ['abcdefghijklmnopqrstuvw yz', 'abcdefghijklmnopqrstuvw'],
    ['<script>', 'script'],
    ['', undefined],
    ['!!!', undefined],
    ['---', undefined],
    [42, undefined],
    [undefined, undefined],
  ]
  for (const [v, want] of cases) assert.equal(normKind(v), want, JSON.stringify(v))
})

test('adding a demo, even one older than every meeting, changes no meeting\'s colour', async () => {
  const dir = await fixtureDir({ index: true })
  try {
    const hues = async () => Object.fromEntries((await buildLibrary(await scanFiles(dir), () => ({}), [], new Map())).meetings.map((m) => [m.id, m.hue]))
    const before = await hues()
    await writeFile(join(dir, 'Acme walkthrough - 2026-04-09 - notes.txt'), 'MEETING NOTES: Acme walkthrough\nApril 9, 2026 | Recording: 10:00\nKind: Demo\n\nSUMMARY\nA demo of the product.\n')
    const after = await hues()
    const demo = '2026-04-09-acme-walkthrough'
    assert.ok(demo in after && !(demo in before))
    for (const [id, hue] of Object.entries(before)) assert.equal(after[id], hue, id)
    assert.ok(!Object.values(before).includes(after[demo]), 'and the demo gets a colour of its own')
  } finally {
    await rm(dir, { recursive: true })
  }
})
