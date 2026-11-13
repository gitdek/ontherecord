import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { PathLike } from 'node:fs'
import fs, { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { Notebook, versionOf } from './notebook.ts'
import { Speakers } from './speakers.ts'
import { Store, trailOf } from './state.ts'
import type { TranscriptSource } from './library.ts'

const look = { meeting: (id: string) => id, task: (id: string) => id }
const diarize = { python: '', segmentation: '', embedding: '', script: '', readText: '' }
const at = '2026-01-02T03:04:05.000Z'

async function scratch(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'meetings-recovery-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

// stops: the store refuses invalid data and leaves the file in place; otherwise it is moved aside
const cases = [
  {
    path: 'state.json',
    stops: true,
    invalid: '{"actions":{"legacy":{"done":{"by":false}}}}',
    open(dir: string) {
      const board = new Store(join(dir, 'state.json'))
      return { load: () => board.load(), save: () => board.setTheme('Ada', 'light') }
    },
  },
  {
    path: 'notebook.json',
    stops: true,
    invalid: '{"notes":{"some-id":{"title":"valid JSON"}}}',
    open(dir: string) {
      const nb = new Notebook(join(dir, 'notebook.json'))
      return { load: () => nb.load(), save: () => nb.create({ title: 'New', body: 'After recovery' }, 'Ada', look) }
    },
  },
  {
    path: 'speakers/names.json',
    stops: false,
    // not a map of names at all (a file with some bad entries keeps the rest: speakers.test.ts)
    invalid: '[{"earlier":{"0":{"name":"Grace","voiceprint":[1,0]}}}]',
    open(dir: string) {
      const speakers = new Speakers(dir, diarize, () => {})
      // After a failed load, the write guard runs before the transcript is examined.
      const unused = {} as TranscriptSource
      return { load: () => speakers.load(), save: () => speakers.rename(unused, '0', 'Grace', 'Ada'), known: () => speakers.known() }
    },
  },
]

for (const item of cases) {
  test(`${item.path}: absence works, I/O errors prevent writes, and JSON in an unexpected shape ${item.stops ? 'stops the load and stays in place' : 'survives being moved aside'}`, async (t) => {
    const dir = await scratch(t)
    const path = join(dir, item.path)
    await item.open(dir).load()
    await mkdir(dirname(path), { recursive: true })
    await symlink(path, path)
    const unreadable = item.open(dir)
    if (item.stops) await assert.rejects(unreadable.load(), /can't read/)
    else {
      // speaker names can be typed again: the server starts without them, and refuses changes until a restart
      await unreadable.load()
      if ('known' in unreadable) assert.deepEqual(unreadable.known(), [])
    }
    await rm(path)
    await assert.rejects(async () => unreadable.save(), item.stops ? /can't read/ : /couldn't be read when the server started/)
    await assert.rejects(stat(path), { code: 'ENOENT' })

    const invalid = Buffer.from(item.invalid)
    await writeFile(path, invalid, { mode: 0o600 })
    if (item.stops) {
      // nothing can rebuild these, and the records are probably fine: the server doesn't start empty over them
      for (let attempt = 0; attempt < 2; attempt++) {
        const instance = item.open(dir)
        await assert.rejects(instance.load(), /failed validation.*left as it is/)
        await assert.rejects(async () => instance.save(), /failed validation/)
      }
      assert.deepEqual(await readFile(path), invalid)
      assert.deepEqual(await readdir(dirname(path)), [item.path.split('/').at(-1)])
      return
    }
    const instance = item.open(dir)
    const rename = fs.rename
    const blocked = t.mock.method(fs, 'rename', async (from: PathLike, to: PathLike) => {
      if (from === path) throw Object.assign(new Error('injected access denied'), { code: 'EACCES' })
      return rename(from, to)
    })
    syncBuiltinESMExports()
    try {
      await assert.rejects(instance.load(), /can't quarantine.*injected access denied/)
    } finally {
      blocked.mock.restore()
      syncBuiltinESMExports()
    }
    await assert.rejects(async () => instance.save(), /can't quarantine/)
    assert.deepEqual(await readFile(path), invalid)
    assert.deepEqual(await readdir(dirname(path)), [item.path.split('/').at(-1)])

    await instance.load()
    if ('known' in instance) assert.deepEqual(instance.known(), [])
    await assert.rejects(stat(path), { code: 'ENOENT' })
    const aside = (await readdir(dirname(path))).find((name) => name.includes('.corrupt-'))
    assert.ok(aside)
    assert.deepEqual(await readFile(join(dirname(path), aside)), invalid)
  })
}

test('a board or notebook that stops startup names the record and the field, never what the record says', async (t) => {
  const dir = await scratch(t)
  const boardPath = join(dir, 'state.json')
  const notePath = join(dir, 'notebook.json')
  const id = (i: number) => `a${i.toString(16).padStart(9, '0')}`
  const actions: Record<string, unknown> = {}
  for (let i = 0; i < 300; i++) actions[id(i)] = { done: { by: 'Ada', at }, rev: 1, history: [{ by: 'Ada', at, did: 'done', text: 'Private wording' }] }
  actions[id(200)] = { done: { by: 'Ada', at }, rev: 1, history: [{ by: 'Ada', at: 1794443266021, did: 'done', text: 'Private wording' }] }
  await writeFile(boardPath, JSON.stringify({ actions }))
  const refused = async (load: () => Promise<void>, expected: string) => {
    const err = await load().then(() => assert.fail('the load should stop'), (e: Error) => e)
    assert.ok(err.message.includes(`failed validation (${expected})`), err.message)
    assert.doesNotMatch(err.message, /Private/)
  }
  await refused(() => new Store(boardPath).load(), `invalid board action record "${id(200)}": history[0].at`)

  const task = (i: number) => ({ id: `t-${String(i).padStart(10, '0')}`, text: 'Private task', owner: 'Ada', lane: 'us', createdBy: 'Ada', createdAt: at })
  const tasks = Array.from({ length: 120 }, (_, i) => task(i))
  tasks[57] = { ...task(57), lane: 'Private lane' }
  await writeFile(boardPath, JSON.stringify({ actions: {}, tasks }))
  await refused(() => new Store(boardPath).load(), 'invalid board task [57] "t-0000000057": lane')

  const note = (i: number) => ({
    id: `n-${String(i).padStart(10, '0')}`, title: 'Private title', body: 'Private body', tags: [], meetingIds: [], taskIds: [],
    author: 'Ada', createdAt: at, updatedAt: at, updatedBy: 'Ada', version: 3,
    revisions: [{ title: 'Private', body: 'Private', tags: ['plan'], by: 'Ada', at }, { title: 'Private', body: 'Private', tags: ['plan'], by: 'Ada', at }],
  })
  const notes = Array.from({ length: 200 }, (_, i) => note(i))
  notes[137].revisions[1].tags = ['plan', 'Private tag', 7 as unknown as string]
  await writeFile(notePath, JSON.stringify({ notes }))
  await refused(() => new Notebook(notePath).load(), 'invalid note [137] "n-0000000137": revisions[1].tags[2]')
})

test('malformed UTF-8 in otherwise parseable JSON is quarantined without exposing its contents', async (t) => {
  const path = join(await scratch(t), 'state.json')
  const bytes = Buffer.concat([Buffer.from('{"aliases":{"old":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}}')])
  await writeFile(path, bytes, { mode: 0o600 })
  await new Store(path).load()
  const [aside] = await readdir(dirname(path))
  assert.match(aside, /^state\.json\.corrupt-/)
  assert.deepEqual(await readFile(join(dirname(path), aside)), bytes)
})

test('board: a failed replacement rejects its caller and a concurrent pair saves the full board', async (t) => {
  const dir = await scratch(t)
  const path = join(dir, 'state.json')
  let recovered = 0
  const board = new Store(path, () => recovered++)
  await board.load()
  await board.setTheme('Ada', 'light')
  const before = await readFile(path)
  const rename = fs.rename
  const fault = t.mock.method(fs, 'rename', async (from: PathLike, to: PathLike) => {
    if (to === path) throw Object.assign(new Error('injected write failure'), { code: 'EIO' })
    return rename(from, to)
  })
  syncBuiltinESMExports()
  try {
    await assert.rejects(board.change('fixture-id', { status: 'done' }, 'Ada', 0), /injected write failure/)
    await assert.rejects(board.change('fixture-id', { status: 'done' }, 'Ada', 0), /injected write failure/)
  } finally {
    fault.mock.restore()
    syncBuiltinESMExports()
  }
  assert.deepEqual(await readFile(path), before)
  assert.deepEqual(await readdir(dir), ['state.json'])
  assert.equal(recovered, 0)
  assert.deepEqual(await board.change('fixture-id', { status: 'done' }, 'Ada', 0), [])
  assert.deepEqual(await board.change('fixture-id', { status: 'done' }, 'Ada', 0), [])
  assert.equal(recovered, 1, 'only a durable retry notifies readers')
  const retry = new Store(path)
  await retry.load()
  assert.equal(retry.state.actions['fixture-id'].rev, 1, 'an identical retry persists the original change once')
  const [change] = await Promise.all([
    board.change('fixture-id', { note: 'Decision stands' }, 'Grace', 1),
    board.setSync('meeting-id', -12.5, 'Ada'),
  ])
  assert.deepEqual(change, ['note'])
  const restored = new Store(path)
  await restored.load()
  assert.deepEqual(restored.state, board.state)
  assert.equal(restored.state.actions['fixture-id'].rev, 2)
  assert.deepEqual(trailOf(restored.state.actions['fixture-id']).map((entry) => entry.did), ['done', 'note'])
  assert.equal(restored.state.sync['meeting-id'].offset, -12.5)
})

test('a save syncs its folder after the rename, and a folder that cannot be synced is logged, not thrown', async (t) => {
  const dir = await scratch(t)
  const path = join(dir, 'state.json')
  const board = new Store(path)
  await board.load()
  const events: string[] = []
  const rename = fs.rename
  const open = fs.open
  let refuse = false
  const renames = t.mock.method(fs, 'rename', async (from: PathLike, to: PathLike) => {
    await rename(from, to)
    if (to === path) events.push('rename')
  })
  const opens = t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    if (args[0] !== dir) return open(...args)
    if (refuse) throw Object.assign(new Error('injected EACCES'), { code: 'EACCES' })
    const folder = await open(...args)
    const sync = folder.sync.bind(folder)
    folder.sync = async () => {
      await sync()
      events.push('sync folder')
    }
    events.push('open folder')
    return folder
  })
  const errors = t.mock.method(console, 'error', () => {})
  syncBuiltinESMExports()
  try {
    await board.setTheme('Ada', 'dark')
    assert.deepEqual(events, ['rename', 'open folder', 'sync folder'])
    refuse = true
    await board.setTheme('Ada', 'light')
    assert.equal(errors.mock.callCount(), 1)
    assert.match(String(errors.mock.calls[0].arguments[0]), /can't sync .* after writing state\.json \(injected EACCES\)/)
  } finally {
    renames.mock.restore()
    opens.mock.restore()
    syncBuiltinESMExports()
  }
  const reread = new Store(path)
  await reread.load()
  assert.equal(reread.state.prefs.Ada.theme, 'light')
})

test('a store removes its own temp files left by a killed save once they are an hour old, and nothing else', async (t) => {
  const dir = await scratch(t)
  await mkdir(join(dir, 'speakers'), { mode: 0o700 })
  const left = {
    board: `state.json.tmp-${randomUUID()}`,
    notebook: `notebook.json.tmp-${randomUUID()}`,
    names: `speakers/names.json.tmp-${randomUUID()}`,
  }
  const kept = [
    `state.json.tmp-${randomUUID()}.bak`,
    `state.json.tmp-${randomUUID().toUpperCase()}`,
    'state.json.tmp-not-a-uuid',
    'state.json.tmp',
    `other.json.tmp-${randomUUID()}`,
    `state.json.corrupt-1794443266021-${randomUUID()}`,
  ]
  const folder = `state.json.tmp-${randomUUID()}`
  const fresh = `state.json.tmp-${randomUUID()}`
  const anHourAgo = new Date(Date.now() - 3_600_000 - 60_000)
  for (const name of [...Object.values(left), ...kept, fresh]) await writeFile(join(dir, name), '{"partial":', { mode: 0o600 })
  await mkdir(join(dir, folder))
  for (const name of [...Object.values(left), ...kept, folder]) await utimes(join(dir, name), anHourAgo, anHourAgo)
  const present = async () => [...(await readdir(dir)), ...(await readdir(join(dir, 'speakers'))).map((n) => `speakers/${n}`)].filter((n) => n !== 'speakers').sort()

  await new Store(join(dir, 'state.json')).load()
  assert.deepEqual(await present(), [left.notebook, left.names, ...kept, folder, fresh].sort())
  await new Notebook(join(dir, 'notebook.json')).load()
  await new Speakers(dir, diarize, () => {}).load()
  assert.deepEqual(await present(), [...kept, folder, fresh].sort())
})

test('legacy board marks and versionless notebook records survive load and save', async (t) => {
  const dir = await scratch(t)
  const boardPath = join(dir, 'state.json')
  const notePath = join(dir, 'notebook.json')
  await writeFile(boardPath, JSON.stringify({ actions: { old: { done: true, by: 'Ada', at, note: { by: 'Grace', at, text: 'Original note' } } } }))
  const note = {
    id: 'n-0000000001', title: 'A note', body: 'Decision', tags: ['design'],
    meetingIds: ['meeting-id'], taskIds: ['old'], author: 'Ada', createdAt: at,
    updatedAt: at, updatedBy: 'Grace', revisions: [{ title: 'Earlier title', body: 'Earlier body', tags: [], by: 'Ada', at }],
  }
  await writeFile(notePath, JSON.stringify({ notes: [note] }))
  const board = new Store(boardPath)
  const nb = new Notebook(notePath)
  await Promise.all([board.load(), nb.load()])
  assert.deepEqual(trailOf(board.state.actions.old).map((entry) => [entry.did, entry.by]), [['done', 'Ada'], ['note', 'Grace']])
  assert.equal(versionOf(nb.notes[0]), 2)
  await Promise.all([
    board.change('old', { owner: 'Ada' }, 'Grace', 0),
    nb.update(note.id, { append: 'Follow-up', ifVersion: 2 }, 'Ada', look),
  ])
  const rereadBoard = new Store(boardPath)
  const rereadNote = new Notebook(notePath)
  await Promise.all([rereadBoard.load(), rereadNote.load()])
  assert.equal(rereadBoard.state.actions.old.rev, 1)
  assert.equal(rereadBoard.state.actions.old.note?.text, 'Original note')
  assert.deepEqual(rereadNote.notes[0].revisions.at(-1), note.revisions[0])
  assert.deepEqual(rereadNote.notes[0].taskIds, ['old'])
  assert.equal(versionOf(rereadNote.notes[0]), 3)
  assert.equal((await stat(boardPath)).mode & 0o777, 0o600)
  assert.equal((await stat(notePath)).mode & 0o777, 0o600)
})

// Fails the next `times` replacements of `path` with ENOSPC, the way a full disk would.
function diskFull(t: TestContext, path: string, times = Infinity) {
  const rename = fs.rename
  let left = times
  const fault = t.mock.method(fs, 'rename', async (from: PathLike, to: PathLike) => {
    if (to === path && left-- > 0) throw Object.assign(new Error('injected ENOSPC'), { code: 'ENOSPC' })
    return rename(from, to)
  })
  syncBuiltinESMExports()
  return () => {
    fault.mock.restore()
    syncBuiltinESMExports()
  }
}

test('a failed save of a new note, an append, a delete or a new task takes it back, so a retry saves it once', async (t) => {
  const dir = await scratch(t)
  const notePath = join(dir, 'notebook.json')
  const nb = new Notebook(notePath)
  await nb.load()
  const note = await nb.create({ title: 'Supplier', body: 'Start' }, "Ada's agent", look)
  let mended = diskFull(t, notePath)
  await assert.rejects(nb.update(note.id, { append: 'Price agreed at 40.' }, "Ada's agent", look), /ENOSPC/)
  await assert.rejects(nb.create({ title: 'Second supplier', body: 'Start' }, "Ada's agent", look), /ENOSPC/)
  await assert.rejects(nb.remove(note.id, 'Ada'), /ENOSPC/)
  mended()
  // nothing that failed is in memory, and the retries the agent makes are saved once
  assert.deepEqual([nb.list().map((n) => n.title), nb.get(note.id)!.body, versionOf(nb.get(note.id)!), nb.get(note.id)!.revisions], [['Supplier'], 'Start', 1, []])
  await nb.update(note.id, { append: 'Price agreed at 40.' }, "Ada's agent", look)
  await nb.create({ title: 'Second supplier', body: 'Start' }, "Ada's agent", look)
  const reread = new Notebook(notePath)
  await reread.load()
  assert.deepEqual([reread.list().map((n) => n.title).sort(), reread.get(note.id)!.body, versionOf(reread.get(note.id)!)], [['Second supplier', 'Supplier'], 'Start\n\nPrice agreed at 40.', 2])
  assert.deepEqual([nb.list().length, nb.get(note.id)!.body], [2, 'Start\n\nPrice agreed at 40.'])

  // the same for the board's tasks
  const boardPath = join(dir, 'state.json')
  let recovered = 0
  const board = new Store(boardPath, () => recovered++)
  await board.load()
  const kept = await board.addTask({ text: 'Book the courier', owner: 'Ada', lane: 'us' }, "Ada's agent")
  mended = diskFull(t, boardPath)
  await assert.rejects(board.addTask({ text: 'Call the supplier', owner: 'Ada', lane: 'us' }, "Ada's agent"), /ENOSPC/)
  await assert.rejects(board.deleteTask(kept.id, 'Ada'), /ENOSPC/)
  // a status change whose save fails stays, as before, for a retry to write
  await assert.rejects(board.change('fixture-id', { status: 'done' }, 'Ada'), /ENOSPC/)
  mended()
  assert.deepEqual([board.state.tasks.map((x) => x.text), board.state.trash], [['Book the courier'], []])
  // the retried status change writes what memory holds: the change, and neither the task nor the delete
  assert.deepEqual(await board.change('fixture-id', { status: 'done' }, 'Ada'), [])
  assert.equal(recovered, 1)
  await board.addTask({ text: 'Call the supplier', owner: 'Ada', lane: 'us' }, "Ada's agent")
  const rb = new Store(boardPath)
  await rb.load()
  assert.deepEqual([rb.state.tasks.map((x) => x.text), rb.state.trash, rb.state.actions['fixture-id'].done?.by], [['Book the courier', 'Call the supplier'], [], 'Ada'])

  // a save asked for while a task is being added never carries the task when that write fails
  mended = diskFull(t, boardPath, 1)
  const [added, noted] = await Promise.allSettled([board.addTask({ text: 'Order the labels', owner: 'Ada', lane: 'us' }, "Ada's agent"), board.change('other-id', { note: 'Labels are in the cupboard' }, 'Ada')])
  mended()
  assert.deepEqual([added.status, noted.status], ['rejected', 'fulfilled'])
  const after = new Store(boardPath)
  await after.load()
  assert.deepEqual([after.state.tasks.map((x) => x.text), after.state.actions['other-id'].note?.text], [['Book the courier', 'Call the supplier'], 'Labels are in the cupboard'])
  assert.deepEqual(board.state.tasks.map((x) => x.text), ['Book the courier', 'Call the supplier'])
})
