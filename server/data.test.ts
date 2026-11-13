// What keeps the board, the notebook and the speaker names safe: saves that recover, files that are never
// replaced by empty ones, ids that never mix up two items, a fair share of the task cap, and the backups.
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { backup, KEEP, nameOf, stale } from './backup.ts'
import { fixtureDir, NOTES } from './fixtures.test-helper.ts'
import { buildLibrary, scanFiles } from './library.ts'
import { Notebook } from './notebook.ts'
import { SearchIndex } from './search.ts'
import { chunksOf } from './semantic.ts'
import { LIMITS, Store } from './state.ts'
import { addAction, allActions, reconcile, TaskError } from './tasks.ts'
import { normName, shortHash } from './text.ts'

const MEETING = '2026-10-02-launch'
const look = { meeting: () => undefined, task: () => undefined }
const scratch = () => mkdtemp(join(tmpdir(), 'meetings-data-'))

test('notebook: after a failed write the next save goes through, and the note whose save failed is not in it', async () => {
  const dir = await scratch()
  const path = join(dir, 'notebook.json')
  const nb = new Notebook(path)
  await nb.load()
  // Put a directory at the final path so the atomic replacement fails.
  await mkdir(path)
  await assert.rejects(nb.create({ title: 'First', body: 'one' }, 'Ada', look))
  // the caller was told it failed, so it did not happen: a retry would otherwise save it twice
  assert.deepEqual(nb.list(), [])
  await rm(path, { recursive: true })
  await nb.create({ title: 'Second', body: 'two' }, 'Ada', look)
  const saved = JSON.parse(await readFile(path, 'utf8')) as { notes: { title: string }[] }
  assert.deepEqual(saved.notes.map((n) => n.title), ['Second'])
  await rm(dir, { recursive: true, force: true })
})

test('notebook: a file that exists but cannot be read stops the load; a missing one is a fresh start', async () => {
  const dir = await scratch()
  const path = join(dir, 'notebook.json')
  await new Notebook(path).load()
  await writeFile(path, JSON.stringify({ notes: [{ id: 'n-0000000001' }] }))
  await chmod(path, 0o000)
  try {
    await assert.rejects(new Notebook(path).load(), /can't read/)
  } finally {
    await chmod(path, 0o600)
  }
  await rm(dir, { recursive: true, force: true })
})

test('notebook: a refused edit leaves the note exactly as it was', async () => {
  const dir = await scratch()
  const nb = new Notebook(join(dir, 'notebook.json'))
  const n = await nb.create({ title: 'Kept', body: 'as written' }, 'Ada', look)
  await assert.rejects(nb.update(n.id, { body: 'changed', meetingIds: ['no-such-meeting'] }, 'Grace', look), /unknown meeting/)
  assert.deepEqual([n.body, n.revisions.length, n.version, n.updatedBy], ['as written', 0, 1, 'Ada'])
  // notes saved before versions were counted start from the changes they remember
  delete n.version
  n.revisions.push({ title: 'Kept', body: 'older', tags: [], by: 'Ada', at: '' })
  await assert.rejects(nb.update(n.id, { body: 'stale', ifVersion: 1 }, 'Grace', look), /changed this note/)
  assert.equal((await nb.update(n.id, { body: 'fresh', ifVersion: 2 }, 'Grace', look)).version, 3)
  await rm(dir, { recursive: true, force: true })
})

// The fixture's notes with two more action items: one worded exactly like another, and one whose wording
// ends with another's.
const twins = NOTES.replace(
  '- Team: Book the follow-up call. (17:00–17:10)',
  '- Team: Book the follow-up call. (17:00–17:10)\n- Ada: Book the follow-up call. (17:20–17:30)\n- Grace: Confirm the agenda and Book the follow-up call. (17:40–17:50)',
)

async function twinsLibrary() {
  const dir = await fixtureDir({ index: true })
  await writeFile(join(dir, 'Ada Grace - Launch planning - 2026-10-02 - notes.txt'), twins)
  return buildLibrary(await scanFiles(dir), () => ({}), ['Ada Byron', 'Grace Hopper'], new Map())
}

test('ids: two items worded alike in one meeting are two items, and the first keeps its id', async () => {
  const lib = await twinsLibrary()
  const items = lib.byId.get(MEETING)!.actions
  const calls = items.filter((a) => a.text === 'Book the follow-up call.')
  assert.equal(calls.length, 2)
  assert.notEqual(calls[0].id, calls[1].id)
  assert.equal(calls[0].id, shortHash(`${MEETING}|${normName('Book the follow-up call.')}`, 10), 'the id it always had')
  // checking one off leaves the other open
  const store = new Store(join(await scratch(), 'state.json'))
  await reconcile(lib, store)
  await store.change(calls[1].id, { status: 'done' }, 'Ada')
  const board = allActions(lib, store).filter((a) => a.text === 'Book the follow-up call.')
  assert.deepEqual(board.map((a) => a.status), ['open', 'done'])
})

test('ids: every line of the notes, search hit and passage carries its own item, never a look-alike', async () => {
  const lib = await twinsLibrary()
  const m = lib.byId.get(MEETING)!
  const lines = m.notes!.sections.find((s) => s.role === 'actions')!.blocks.flatMap((b) => (b.kind === 'bullet' ? [b] : []))
  assert.deepEqual(lines.map((l) => l.action), m.actions.map((a) => a.id))
  const longer = m.actions.find((a) => a.text.startsWith('Confirm the agenda'))!
  const hit = new SearchIndex(lib).search('confirm agenda').hits.find((h) => h.kind === 'action')!
  assert.equal(hit.actionId, longer.id)
  const passage = chunksOf(lib, [], '').find((c) => c.kind === 'action' && c.text.includes('Confirm the agenda'))!
  assert.equal(passage.actionId, longer.id)
})

test('tasks: one name can hold only its share of the board, so a loop can’t fill it for everyone', async () => {
  const dir = await fixtureDir({ index: true })
  const lib = await buildLibrary(await scanFiles(dir), () => ({}), ['Ada Byron', 'Grace Hopper'], new Map())
  const store = new Store(join(await scratch(), 'state.json'))
  for (let i = 0; i < LIMITS.tasksEach; i++) store.state.tasks.push({ id: `t-${i}`, text: `task ${i}`, owner: 'Ada', lane: 'us', createdBy: "Ada's agent", createdAt: '' })
  await assert.rejects(addAction(lib, store, { text: 'one more', owner: 'Ada' }, "Ada's agent"), (err: Error) => err instanceof TaskError && /the most one name may hold/.test(err.message))
  const fine = await addAction(lib, store, { text: 'still room for Grace', owner: 'Grace' }, 'Grace')
  assert.equal(fine.createdBy, 'Grace')
  assert.equal(store.room('Grace'), LIMITS.tasksEach - 1)
})

test('backups: the newest of each of the last days, and the newest few of all', () => {
  const now = Date.parse('2026-11-10T12:00:00Z')
  const at = (iso: string) => nameOf(new Date(iso))
  const names = [
    at('2026-11-10T11:00:00Z'),
    at('2026-11-10T09:00:00Z'),
    at('2026-11-09T22:00:00Z'),
    at('2026-11-09T08:00:00Z'),
    at('2026-11-05T08:00:00Z'),
    at('2026-10-20T08:00:00Z'),
    at('2026-10-01T08:00:00Z'),
  ]
  assert.equal(names[0], '2026-11-10T110000Z')
  // kept: the three newest, then one a day back to a week ago; October is gone
  assert.deepEqual(stale(names, now).sort(), [at('2026-10-01T08:00:00Z'), at('2026-10-20T08:00:00Z'), at('2026-11-09T08:00:00Z')].sort())
  // a server that was off for a month still keeps its last few
  assert.deepEqual(stale(names.slice(5), now), [])
  assert.equal(KEEP.days, 7)
})

test('backups: a copy holds the board, the notebook and the speaker names; with nothing saved, no copy', async () => {
  const data = await scratch()
  const dests = [join(data, 'backups'), join(await scratch(), 'elsewhere')]
  assert.deepEqual(await backup(data, dests), [])
  await writeFile(join(data, 'state.json'), '{"tasks":[]}')
  await writeFile(join(data, 'notebook.json'), '{"notes":[]}')
  await mkdir(join(data, 'speakers'))
  await writeFile(join(data, 'speakers', 'names.json'), '{}')
  await writeFile(join(data, 'embed.key'), 'not copied')
  const done = await backup(data, dests, new Date('2026-11-10T12:00:00Z'))
  assert.equal(done.length, 2)
  for (const d of done) assert.deepEqual((await readdir(d)).sort(), ['manifest.json', 'notebook.json', 'speakers', 'state.json'])
  assert.equal(await readFile(join(done[1], 'speakers', 'names.json'), 'utf8'), '{}')
})
