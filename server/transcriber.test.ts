// Transcripts the server writes for recordings that have none, with stand-ins for FFmpeg and the speech model
// (run by /usr/bin/python3, as the speaker tests do), and once through the app with the real FFmpeg.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, utimes, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { createApp } from './app.ts'
import { configFrom } from './config.ts'
import { requestApp, TRANSCRIPT_TXT } from './fixtures.test-helper.ts'
import { buildLibrary, scanFiles, type FileEntry, type MediaFacts, type Probe } from './library.ts'
import { run } from './media.ts'
import { placeBeside } from './place.ts'
import { modelPath, readHeard, Transcriber, transcriptFiles, transcriptNames } from './transcriber.ts'
import { parseTranscript } from './transcripts.ts'

const PYTHON = '/usr/bin/python3'
const NORTHWIND = 'Northwind roast review 2026-11-03.mp4'
const KESTREL = 'Kestrel Freight call 2026-11-04.m4a'
const PROBES: Record<string, Probe> = {
  [NORTHWIND]: { duration: 180, hasAudio: true, width: 1280, height: 720 },
  [KESTREL]: { duration: 120, hasAudio: true },
  'Silent screen 2026-11-05.mp4': { duration: 300, hasAudio: false, width: 1280, height: 720 },
  'Clip 2026-11-06.mp4': { duration: 3, hasAudio: true, width: 640, height: 360 },
  'Acme demo 2026-11-07.mp4': { duration: 600, hasAudio: true, width: 1280, height: 720 },
  'Screen Recording 2026-10-02 at 9.15.00 AM.mp4': { duration: 1200, hasAudio: true, width: 1920, height: 1080 },
}
const facts = (f: FileEntry): MediaFacts => (PROBES[f.name] ? { probe: PROBES[f.name] } : {})
const HEARD = {
  language: 'en',
  segments: [
    { id: 0, start: 1.2, end: 5.8, text: ' The Ethiopia light roast sold out on Friday.' },
    { id: 1, start: 6.1, end: 11.4, text: ' Grace will order twenty more bags from the importer.' },
  ],
}

// A small archive: recordings without a transcript (a video, a sound file, one with no sound, one too short, one the
// index lists), and a meeting that has its transcript already.
async function archive(t: TestContext, names = Object.keys(PROBES)) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'meetings-transcribe-')))
  const data = await realpath(await mkdtemp(join(tmpdir(), 'meetings-transcribe-data-')))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
    await rm(data, { recursive: true, force: true })
  })
  for (const name of names) await writeFile(join(dir, name), Buffer.alloc(1000 + name.length, 1))
  await writeFile(join(dir, 'Ada Grace - Launch planning - 2026-10-02 - transcript.txt'), TRANSCRIPT_TXT)
  await writeFile(join(dir, 'meetings-index.json'), JSON.stringify({ sessions: [{ id: '2026-11-07-acme-demo', date: '2026-11-07', title: 'Acme demo', videos: ['Acme demo 2026-11-07.mp4'] }] }))
  const model = join(data, 'whisper-model')
  await mkdir(model)
  const build = async () => buildLibrary(await scanFiles(dir), facts, ['Ada Byron', 'Grace Hopper'], new Map())
  const meetingOf = (lib: Awaited<ReturnType<typeof build>>, file: string) => lib.meetings.find((m) => m.videos.some((v) => v.name === file))!
  return { dir, data, model, build, meetingOf }
}

// Stand-ins on PATH and in the data folder. FFmpeg writes something where the sound goes. The speech model says, for --check, that it has mlx_whisper; otherwise it notes what it was given and acts
// on a rule file the test leaves in the data folder (rule-<file id>: hold until it is gone, then fail or answer).
async function standIns(t: TestContext, data: string, opts: { check?: number; ffmpeg?: boolean } = {}) {
  if (opts.ffmpeg ?? true) {
    const bin = join(data, 'bin')
    await mkdir(bin)
    await writeFile(join(bin, 'ffmpeg'), '#!/bin/sh\nfor last; do :; done\nprintf sound > "$last"\n')
    await chmod(join(bin, 'ffmpeg'), 0o755)
    const path = process.env.PATH
    process.env.PATH = `${bin}:${path}`
    t.after(() => void (process.env.PATH = path))
  }
  const script = join(data, 'fake-transcribe.py')
  await writeFile(
    script,
    `import json, os, sys, time
args = sys.argv[1:]
if '--check' in args:
    sys.exit(${opts.check ?? 0})
sound = args[args.index('--input') + 1]
data = os.path.dirname(os.path.dirname(sound))
with open(os.path.join(data, 'heard.jsonl'), 'a') as log:
    log.write(json.dumps({'args': args, 'env': sorted(os.environ), 'sound': open(sound, 'rb').read(4).decode('latin-1')}) + '\\n')
for rule in [n for n in os.listdir(data) if n.startswith('rule-') and os.path.basename(sound).startswith(n[5:] + '-')]:
    while os.path.exists(os.path.join(data, rule, 'hold')):
        time.sleep(0.02)
    if os.path.exists(os.path.join(data, rule, 'fail')):
        print('ValueError: Unsupported language: xx', file=sys.stderr)
        sys.exit(1)
print(${JSON.stringify(JSON.stringify(HEARD))})
`,
  )
  const rule = async (file: FileEntry, ...parts: ('hold' | 'fail')[]) => {
    await mkdir(join(data, `rule-${file.id}`), { recursive: true })
    for (const p of parts) await writeFile(join(data, `rule-${file.id}`, p), '')
  }
  const heard = async () => (await readFile(join(data, 'heard.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  return { script, rule, heard }
}

// What the job told the pages, and a way to wait until a meeting's job has ended so many times (a job says when it
// starts and when it ends).
function events() {
  const seen: [string, boolean][] = []
  const waiters: (() => void)[] = []
  const onChange = (ids: string[], placed: boolean) => {
    seen.push([ids[0], placed])
    for (const wake of waiters.splice(0)) wake()
  }
  const ended = async (id: string, times = 1) => {
    while (seen.filter(([i]) => i === id).length < times * 2) await new Promise<void>((r) => waiters.push(r))
  }
  return { seen, onChange, ended }
}

const quiet = (t: TestContext) => {
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'warn', () => {})
}

const until = async (what: string, ok: () => Promise<boolean> | boolean, ms = 10_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 25))) if (await ok()) return
  assert.fail(`timed out waiting until ${what}`)
}

test('settings: transcripts are off unless TRANSCRIBE_PYTHON is set, and a model given as a path is a folder', () => {
  const off = configFrom({}).transcribe
  assert.deepEqual([off.python, off.model, off.language], ['', 'mlx-community/whisper-large-v3-turbo', ''])
  assert.match(off.script, /scripts\/transcribe\.py$/)
  const on = configFrom({ TRANSCRIBE_PYTHON: ' /opt/whisper/bin/python ', TRANSCRIBE_MODEL: '~/models/whisper-small', TRANSCRIBE_LANGUAGE: 'EN' }).transcribe
  assert.deepEqual([on.python, on.model, on.language], ['/opt/whisper/bin/python', join(homedir(), 'models/whisper-small'), 'en'])
  assert.equal(configFrom({ TRANSCRIBE_MODEL: 'mlx-community/whisper-small-mlx' }).transcribe.model, 'mlx-community/whisper-small-mlx', 'a name stays a name')
})

test('a transcript the server writes is found beside its recording, and the meeting keeps its id and title', async (t) => {
  const a = await archive(t, [NORTHWIND, KESTREL, 'Release notes walkthrough 2026-11-08.mp4'])
  PROBES['Release notes walkthrough 2026-11-08.mp4'] = { duration: 240, hasAudio: true, width: 1280, height: 720 }
  t.after(() => void delete PROBES['Release notes walkthrough 2026-11-08.mp4'])
  const before = await a.build()
  for (const name of [NORTHWIND, KESTREL, 'Release notes walkthrough 2026-11-08.mp4']) {
    const m = a.meetingOf(before, name)
    assert.equal(m.transcripts.length, 0)
    const file = before.files.get(m.videos[0].fileId)!
    assert.deepEqual(await placeBeside(file, transcriptFiles(file, m.title, PROBES[name].duration!, HEARD, 'whisper-large-v3-turbo')), transcriptNames(file))
  }
  const after = await a.build()
  for (const name of [NORTHWIND, KESTREL, 'Release notes walkthrough 2026-11-08.mp4']) {
    const was = a.meetingOf(before, name)
    const m = a.meetingOf(after, name)
    assert.equal(m.id, was.id, name)
    assert.equal(m.title, was.title, name)
    assert.equal(m.transcripts.length, 1, name)
    assert.ok(m.transcripts[0].synced && m.transcripts[0].videoIds.includes(m.videos[0].fileId), `${name}: timed against its recording`)
    assert.equal(m.words, 17, name)
  }
  assert.equal(after.meetings.length, before.meetings.length, 'no meeting of its own for any transcript')
  // the text twin says what a person needs; the JSON keeps the finer times
  const [txt, json] = transcriptFiles(before.files.get(a.meetingOf(before, KESTREL).videos[0].fileId)!, 'Kestrel Freight call', 120, HEARD, 'whisper-large-v3-turbo')
  const parsed = parseTranscript(txt.text, txt.name)
  assert.equal(parsed.title, 'Kestrel Freight call')
  assert.equal(parsed.sourceVideo, KESTREL, 'a sound file is named on a "Source recording:" line')
  assert.equal(parsed.duration, 120)
  assert.deepEqual(parsed.segments.map((s) => [s.s, s.e, s.t]), [[1, 5, 'The Ethiopia light roast sold out on Friday.'], [6, 11, 'Grace will order twenty more bags from the importer.']])
  assert.deepEqual(parseTranscript(json.text, json.name).segments.map((s) => s.s), [1.2, 6.1])
  // a recording whose own name would make "<name> - transcript.txt" read as notes goes by its id instead
  const notes = before.files.get(a.meetingOf(before, 'Release notes walkthrough 2026-11-08.mp4').videos[0].fileId)!
  assert.deepEqual(transcriptNames(notes), [`Transcript ${notes.id} - transcript.txt`, `Transcript ${notes.id} - transcript.json`])
})

test('the job hears the copy the player plays and places its transcript, with none of the server settings', { skip: !existsSync(PYTHON) }, async (t) => {
  quiet(t)
  const a = await archive(t)
  const s = await standIns(t, a.data)
  process.env.MADE_UP_SERVER_SECRET = 'not-for-the-speech-model'
  t.after(() => void delete process.env.MADE_UP_SERVER_SECRET)
  const e = events()
  const transcriber = new Transcriber(a.data, { python: PYTHON, script: s.script, model: a.model, language: 'en' }, e.onChange)
  await transcriber.load()
  assert.equal(transcriber.enabled, true)
  const lib = await a.build()
  const northwind = a.meetingOf(lib, NORTHWIND)
  const kestrel = a.meetingOf(lib, KESTREL)
  transcriber.plan(lib)
  // newest first: the Kestrel call is newer, so it runs while the Northwind review waits
  assert.deepEqual(transcriber.view(kestrel.id), { state: 'running' })
  assert.deepEqual(transcriber.view(northwind.id), { state: 'queued' })
  for (const m of lib.meetings.filter((x) => x !== northwind && x !== kestrel)) assert.equal(transcriber.view(m.id), undefined, `${m.title}: already has one, is in the index, has no sound or is too short`)
  assert.deepEqual(transcriber.status(), { enabled: true, model: 'whisper-model', waiting: 2, writing: true, failed: 0 })
  await e.ended(northwind.id)
  const who = (id: string) => (id === kestrel.id ? 'kestrel' : id === northwind.id ? 'northwind' : id)
  assert.deepEqual(e.seen.map(([id, placed]) => [who(id), placed]), [['kestrel', false], ['kestrel', true], ['northwind', false], ['northwind', true]], 'pages hear when each starts and ends')

  const heard = await s.heard()
  assert.equal(heard.length, 2)
  // what of the server's environment may reach the speech model: where to find things on this Mac. (macOS gives
  // every process its text encoding, and its /usr/bin/python3 adds developer paths the server never had.)
  const allowed = new Set(['PATH', 'HOME', 'TMPDIR', 'LANG', 'HF_HOME', 'HF_HUB_CACHE', '__CF_USER_TEXT_ENCODING'])
  for (const h of heard) {
    assert.equal(h.sound, 'soun', 'the script hears what FFmpeg wrote')
    assert.deepEqual(h.args.slice(0, 2), ['--model', a.model])
    assert.deepEqual(h.args.slice(-2), ['--language', 'en'])
    assert.deepEqual(h.env.filter((k: string) => k in process.env && !allowed.has(k)), [])
    assert.ok(h.env.includes('HF_HUB_OFFLINE') && !h.env.includes('MADE_UP_SERVER_SECRET'))
  }
  assert.deepEqual(await readdir(join(a.data, 'transcribe')), [], 'the sound taken out is gone')
  const after = await a.build()
  assert.ok(a.meetingOf(after, NORTHWIND).transcripts.length && a.meetingOf(after, KESTREL).transcripts.length)
  assert.match(await readFile(join(a.dir, 'Northwind roast review 2026-11-03 - transcript.txt'), 'utf8'), /^MACHINE TRANSCRIPT: Northwind roast review\nSource video: Northwind roast review 2026-11-03\.mp4\nDuration: 180\.0 seconds\n/)
  transcriber.plan(after)
  assert.deepEqual(transcriber.status(), { enabled: true, model: 'whisper-model', waiting: 0, writing: false, failed: 0 })
  assert.equal(transcriber.view(northwind.id), undefined)
})

test('a job that fails says why and waits for a restart or a changed recording; a taken name fails it before anything is heard', { skip: !existsSync(PYTHON) }, async (t) => {
  quiet(t)
  const a = await archive(t, [NORTHWIND, KESTREL])
  const s = await standIns(t, a.data)
  const e = events()
  const transcriber = new Transcriber(a.data, { python: PYTHON, script: s.script, model: a.model, language: '' }, e.onChange)
  await transcriber.load()
  // a JSON file with nothing in it stands under the name the Northwind transcript would take
  await writeFile(join(a.dir, 'Northwind roast review 2026-11-03 - transcript.json'), '{"segments": []}')
  const lib = await a.build()
  const kestrel = a.meetingOf(lib, KESTREL)
  const northwind = a.meetingOf(lib, NORTHWIND)
  await s.rule(lib.files.get(kestrel.videos[0].fileId)!, 'fail')
  transcriber.plan(lib)
  await e.ended(northwind.id)
  assert.deepEqual(transcriber.view(kestrel.id), { state: 'failed', error: 'the speech model stopped: ValueError: Unsupported language: xx' })
  assert.deepEqual(transcriber.view(northwind.id), {
    state: 'failed',
    error: 'a file called "Northwind roast review 2026-11-03 - transcript.json" is already beside the recording, and it is never written over',
  })
  assert.equal((await s.heard()).length, 1, 'only the Kestrel call was heard')
  assert.equal(await readFile(join(a.dir, 'Northwind roast review 2026-11-03 - transcript.json'), 'utf8'), '{"segments": []}')
  assert.deepEqual(transcriber.status(), { enabled: true, model: 'whisper-model', waiting: 0, writing: false, failed: 2 })
  // the next scan starts neither again
  const count = e.seen.length
  transcriber.plan(await a.build())
  assert.equal(e.seen.length, count)
  // the recording copied in again (a new modification time) is a new job
  await rm(join(a.data, `rule-${kestrel.videos[0].fileId}`), { recursive: true })
  await utimes(join(a.dir, KESTREL), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000))
  transcriber.plan(await a.build())
  await e.ended(kestrel.id, 2)
  assert.deepEqual(e.seen.at(-1), [kestrel.id, true])
  assert.equal(a.meetingOf(await a.build(), KESTREL).transcripts.length, 1)
})

test('a transcript someone drops in while one is being written stops the job, and theirs is the one kept', { skip: !existsSync(PYTHON) }, async (t) => {
  quiet(t)
  const a = await archive(t, [NORTHWIND])
  const s = await standIns(t, a.data)
  const e = events()
  const transcriber = new Transcriber(a.data, { python: PYTHON, script: s.script, model: a.model, language: '' }, e.onChange)
  await transcriber.load()
  const lib = await a.build()
  const northwind = a.meetingOf(lib, NORTHWIND)
  await s.rule(lib.files.get(northwind.videos[0].fileId)!, 'hold')
  transcriber.plan(lib)
  await until('the speech model is listening', async () => (await s.heard()).length === 1)
  const theirs = 'MACHINE TRANSCRIPT: Northwind roast review\nSource video: Northwind roast review 2026-11-03.mp4\n\n[00:00:01 - 00:00:05] Typed up by Grace.\n'
  await writeFile(join(a.dir, 'Northwind roast review 2026-11-03 - transcript.txt'), theirs)
  transcriber.plan(await a.build())
  await e.ended(northwind.id)
  await rm(join(a.data, `rule-${northwind.videos[0].fileId}`), { recursive: true })
  assert.deepEqual(e.seen.at(-1), [northwind.id, false])
  assert.deepEqual((await readdir(a.dir)).filter((n) => n.includes('transcript')).sort(), ['Ada Grace - Launch planning - 2026-10-02 - transcript.txt', 'Northwind roast review 2026-11-03 - transcript.txt'])
  assert.equal(await readFile(join(a.dir, 'Northwind roast review 2026-11-03 - transcript.txt'), 'utf8'), theirs)
  assert.deepEqual(transcriber.status(), { enabled: true, model: 'whisper-model', waiting: 0, writing: false, failed: 0 }, 'stopped on purpose is not a failure')
})

test('without a Python that has mlx_whisper, or without the model on this Mac, transcripts stay off and the Lab hears why', { skip: !existsSync(PYTHON) }, async (t) => {
  quiet(t)
  const a = await archive(t, [NORTHWIND])
  const lib = await a.build()
  const off = async (cfg: { python: string; script: string; model: string }) => {
    const transcriber = new Transcriber(a.data, { ...cfg, language: '' }, () => {})
    await transcriber.load()
    transcriber.plan(lib)
    assert.equal(transcriber.enabled, false)
    assert.equal(transcriber.view(a.meetingOf(lib, NORTHWIND).id), undefined)
    return transcriber.status()
  }
  const s = await standIns(t, a.data)
  assert.deepEqual(await off({ python: '', script: s.script, model: a.model }), { enabled: false, waiting: 0, writing: false, failed: 0 }, 'not asked for')
  assert.match((await off({ python: join(a.data, 'no-python'), script: s.script, model: a.model })).problem!, /no-python, the Python that TRANSCRIBE_PYTHON names, isn't there$/)
  assert.match((await off({ python: PYTHON, script: s.script, model: join(a.data, 'no-model') })).problem!, /^the model .*no-model isn't on this Mac \(it is never downloaded by the server\)$/)
  const other = await realpath(await mkdtemp(join(tmpdir(), 'meetings-transcribe-none-')))
  t.after(() => rm(other, { recursive: true, force: true }))
  const none = await standIns(t, other, { check: 3, ffmpeg: false })
  assert.equal((await off({ python: PYTHON, script: none.script, model: a.model })).problem, `${PYTHON} has no mlx_whisper (pip install mlx-whisper)`)
  // the model's folder in the Hugging Face cache, wherever the cache is kept
  assert.equal(modelPath('mlx-community/whisper-large-v3-turbo', { HOME: '/Users/ada' }), '/Users/ada/.cache/huggingface/hub/models--mlx-community--whisper-large-v3-turbo')
  assert.equal(modelPath('mlx-community/whisper-large-v3-turbo', { HOME: '/Users/ada', HF_HOME: '/Volumes/Models/hf' }), '/Volumes/Models/hf/hub/models--mlx-community--whisper-large-v3-turbo')
  assert.equal(modelPath('mlx-community/whisper-large-v3-turbo', { HF_HUB_CACHE: '/Volumes/Models/hub' }), '/Volumes/Models/hub/models--mlx-community--whisper-large-v3-turbo')
  assert.equal(modelPath('/Users/ada/models/whisper'), '/Users/ada/models/whisper')
})

test('the script prints only the JSON, whatever the model library prints, and says in one line why it failed', { skip: !existsSync(PYTHON) }, async (t) => {
  const lib = await realpath(await mkdtemp(join(tmpdir(), 'meetings-fake-mlx-')))
  t.after(() => rm(lib, { recursive: true, force: true }))
  await mkdir(join(lib, 'mlx_whisper'))
  // times that come back as another kind of number, a value that is not a number, a line with no words and one
  // before the start, as a model library can hand them over
  await writeFile(
    join(lib, 'mlx_whisper', '__init__.py'),
    `class Time:
    def __init__(self, v): self.v = v
    def __float__(self): return self.v
def transcribe(path, **options):
    print('Detected language: English')
    if path.endswith('broken.wav'):
        raise RuntimeError('the model folder\\n holds no weights')
    assert options['path_or_hf_repo'] == 'model-folder' and options['condition_on_previous_text'] is False
    return {'language': 'en', 'segments': [
        {'start': Time(0.5), 'end': Time(2.25), 'text': '  Hello   from Kestrel Freight. ', 'avg_logprob': float('nan'), 'no_speech_prob': 0.01},
        {'start': 3, 'end': 4, 'text': '   '},
        {'start': -1, 'end': 1, 'text': 'before the start'},
        {'start': 5, 'end': 4, 'text': 'The van comes on Tuesday.'},
    ]}
`,
  )
  const script = join(import.meta.dirname, '..', 'scripts', 'transcribe.py')
  const env = { PATH: '/usr/bin:/bin', PYTHONPATH: lib, LANG: 'en_US.UTF-8' }
  const ok = spawnSync(PYTHON, [script, '--model', 'model-folder', '--input', 'call.wav'], { env, encoding: 'utf8' })
  assert.equal(ok.status, 0, ok.stderr)
  assert.match(ok.stderr, /Detected language: English/)
  assert.deepEqual(readHeard(ok.stdout), {
    language: 'en',
    segments: [
      { id: 0, start: 0.5, end: 2.25, text: ' Hello from Kestrel Freight.', no_speech_prob: 0.01 },
      { id: 1, start: 5, end: 5, text: ' The van comes on Tuesday.' },
    ],
  })
  const broken = spawnSync(PYTHON, [script, '--model', 'model-folder', '--input', 'broken.wav'], { env, encoding: 'utf8' })
  assert.equal(broken.status, 1)
  assert.equal(broken.stdout, '')
  assert.equal(broken.stderr.trim().split('\n').at(-1), 'RuntimeError: the model folder holds no weights')
  assert.equal(spawnSync(PYTHON, [script, '--check'], { env }).status, 0)
})

test('the meeting page, the Lab and agents say where a transcript being written stands', { timeout: 60_000, skip: !existsSync(PYTHON) }, async (t) => {
  if (!(await run('ffmpeg', ['-version'], 5000).catch(() => undefined)) || !(await run('ffprobe', ['-version'], 5000).catch(() => undefined))) {
    return t.skip('ffmpeg and ffprobe are required for the recording fixture')
  }
  const a = await archive(t, [])
  const s = await standIns(t, a.data, { ffmpeg: false })
  // two real recordings with sound, an hour old so neither counts as still being written
  for (const [name, seconds] of [[NORTHWIND, 6], [KESTREL, 7]] as const) {
    await run('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`, ...(name.endsWith('.mp4') ? ['-f', 'lavfi', '-i', `color=c=black:s=160x90:d=${seconds}`, '-c:v', 'mpeg4', '-shortest'] : []), '-c:a', 'aac', join(a.dir, name)], 30_000)
    await utimes(join(a.dir, name), new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000))
  }
  const files = await scanFiles(a.dir)
  await s.rule(files.find((f) => f.name === KESTREL)!, 'hold')
  const config = configFrom({ PORT: '8798', MEETINGS_DIR: a.dir, DATA_DIR: a.data, CREW: 'Ada Byron,Grace Hopper', LOCAL_USER: 'Ada', DIARIZE_PYTHON: '', EMBED_URL: '', RERANK_URL: '', TRANSCRIBE_PYTHON: PYTHON, TRANSCRIBE_MODEL: a.model })
  config.transcribe.script = s.script
  const app = await createApp(config, { watch: false, backups: false })
  quiet(t)
  await app.start()
  t.after(() => app.close())
  const meeting = async (name: string) => {
    const id = app.lib().meetings.find((m) => m.videos.some((v) => v.name === name))!.id
    return (await requestApp(app, `/api/meetings/${id}`)).json()
  }
  const transcript = async (name: string) => {
    const id = app.lib().meetings.find((m) => m.videos.some((v) => v.name === name))!.id
    return (await requestApp(app, '/mcp/readonly', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_transcript', arguments: { meeting_id: id } } })).json().result
  }
  const lab = async () => (await requestApp(app, '/api/lab')).json().transcripts
  await until('the Kestrel call is being written', async () => (await meeting(KESTREL)).transcribing?.state === 'running')
  assert.deepEqual((await meeting(NORTHWIND)).transcribing, { state: 'queued' })
  assert.deepEqual(await lab(), { enabled: true, model: 'whisper-model', waiting: 2, writing: true, failed: 0 })
  const running = await transcript(KESTREL)
  assert.equal(running.isError, true)
  assert.equal(running.content[0].text, "this meeting has no transcript yet: one is being written on the archive's Mac now, which takes about 1 minute for this recording; call again after that")
  assert.equal((await transcript(NORTHWIND)).content[0].text, "this meeting has no transcript yet: one is waiting to be written on the archive's Mac, after the recordings ahead of it; call again later")
  // the Kestrel call fails, and the Northwind review is written and found
  await writeFile(join(a.data, `rule-${files.find((f) => f.name === KESTREL)!.id}`, 'fail'), '')
  await rm(join(a.data, `rule-${files.find((f) => f.name === KESTREL)!.id}`, 'hold'))
  await until('the Northwind transcript is found', async () => (await meeting(NORTHWIND)).transcripts.length === 1)
  const northwind = await meeting(NORTHWIND)
  assert.equal(northwind.transcribing, null)
  assert.equal(northwind.words, 17)
  assert.deepEqual((await meeting(KESTREL)).transcribing, { state: 'failed', error: 'the speech model stopped: ValueError: Unsupported language: xx' })
  assert.equal((await transcript(KESTREL)).content[0].text, "this meeting has no transcript yet: writing one on the archive's Mac failed (the speech model stopped: ValueError: Unsupported language: xx); it is tried again when the server restarts")
  assert.deepEqual(await lab(), { enabled: true, model: 'whisper-model', waiting: 0, writing: false, failed: 1 })
  assert.match((await transcript(NORTHWIND)).content[0].text, /^\[0:01\] The Ethiopia light roast sold out on Friday\.\n\[0:06\] Grace will order/)
  assert.deepEqual((await s.heard()).map((h) => h.sound), ['RIFF', 'RIFF'], 'FFmpeg took the sound out as a WAV, from the open file')
})
