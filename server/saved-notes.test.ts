// save_notes: an agent writes a meeting's notes, through the app's own MCP endpoint, on a temp copy of a made-up
// archive. What it saves is checked first, a newer edit is never written over, every version replaced is kept,
// and nothing but a notes file is ever written.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFile, chmod, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { createApp, type App } from './app.ts'
import { configFrom } from './config.ts'
import { fixtureDir, requestApp } from './fixtures.test-helper.ts'
import { localDay } from './text.ts'

const NORTHWIND = '2026-11-03-northwind-roast-review'
const NOTES_FILE = 'Northwind roast review 2026-11-03 - notes.txt'
const TRANSCRIPT = `MACHINE TRANSCRIPT: Northwind roast review
Source video: Northwind roast review 2026-11-03.mp4
Duration: 180.0 seconds

[00:00:01 - 00:00:05] The Ethiopia light roast sold out on Friday.
[00:00:06 - 00:00:11] Grace will order twenty more bags from the importer.
[00:02:40 - 00:02:50] Someone should update the menu board.
`
const NOTES = `MEETING NOTES: Roast review notes
November 3, 2026 | Recording: 3:00 | Substantive discussion approximately 0:01–2:50
Participants: Ada Byron, Grace Hopper

SUMMARY
The light roast sold out, and Grace will order more from the importer.

ROASTS AND ORDERS
1. Light roast sold out (0:01–0:05)
- The Ethiopia light roast sold out on Friday.
2. More bags from the importer (0:06–0:11)
- Grace will order twenty more bags.

ACTION ITEMS
- Grace: Order twenty more bags from the importer. (0:06–0:11)
- Team: Update the menu board. (2:40–2:50)

UNCERTAINTIES
- Nobody said when the bags arrive.
`

// The made-up archive: the launch meeting with its notes, a wall-clock demo, the Northwind roast review with a
// recording and a transcript but no notes, and an Acme demo the index lists, also without notes. extra: files a
// person put in the folder (or wrote over) before the server started; user: whose agent the calls are (each has its own write limit).
async function archive(t: TestContext, extra: Record<string, string> = {}, user = 'Ada') {
  const dir = await realpath(await fixtureDir())
  const data = await mkdtemp(join(tmpdir(), 'meetings-saved-notes-'))
  await writeFile(join(dir, 'Northwind roast review 2026-11-03.mp4'), Buffer.alloc(3000, 3))
  await writeFile(join(dir, 'Northwind roast review 2026-11-03 - transcript.txt'), TRANSCRIPT)
  await writeFile(join(dir, 'Acme demo 2026-11-07.mp4'), Buffer.alloc(2000, 4))
  await writeFile(join(dir, 'Acme demo 2026-11-07 - transcript.txt'), TRANSCRIPT.replaceAll('Northwind roast review 2026-11-03', 'Acme demo 2026-11-07').replace('Northwind roast review', 'Acme demo'))
  await writeFile(join(dir, 'meetings-index.json'), JSON.stringify({ sessions: [{ id: '2026-11-07-acme-demo', date: '2026-11-07', title: 'Acme demo', videos: ['Acme demo 2026-11-07.mp4'], transcript: 'Acme demo 2026-11-07 - transcript.txt' }] }))
  for (const [name, text] of Object.entries(extra)) await writeFile(join(dir, name), text)
  const config = configFrom({ PORT: '8798', MEETINGS_DIR: dir, DATA_DIR: data, CREW: 'Ada Byron,Grace Hopper', LOCAL_USER: user, DIARIZE_PYTHON: '', EMBED_URL: '', RERANK_URL: '' })
  const app = await createApp(config, { watch: false, backups: false })
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'warn', () => {})
  await app.start()
  t.after(async () => {
    await app.close()
    await rm(dir, { recursive: true, force: true })
    await rm(data, { recursive: true, force: true })
  })
  return { dir, data, app }
}

const call = async (app: App, name: string, args: Record<string, unknown>, door = '/mcp') => {
  const result = (await requestApp(app, door, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })).json().result
  return { ...result, data: result.structuredContent, text: result.content.map((c: { text: string }) => c.text).join('\n') }
}
const meta = async (app: App, id: string) => JSON.parse((await call(app, 'get_meeting', { meeting_id: id })).content[1].text)
// every file in the folder with a fingerprint of what it holds, to show what a call changed
const fingerprints = async (dir: string) => {
  const out: Record<string, string> = {}
  for (const name of (await readdir(dir)).sort()) out[name] = createHash('sha256').update(await readFile(join(dir, name))).digest('hex').slice(0, 16)
  return out
}

test("an agent saves a meeting's first notes beside its recording, and the board picks up their action items", async (t) => {
  const { dir, app } = await archive(t)
  assert.equal((await meta(app, NORTHWIND)).notes_rev, undefined, 'no notes, so no rev')
  const before = await fingerprints(dir)
  const saved = await call(app, 'save_notes', { meeting_id: NORTHWIND, notes: NOTES, reason: 'written from the transcript' })
  assert.equal(saved.isError, undefined, saved.text)
  assert.deepEqual(
    { ...saved.data, notes_rev: typeof saved.data.notes_rev },
    {
      saved: true,
      meeting: { id: NORTHWIND, title: 'Northwind roast review', link: `http://127.0.0.1:8798/m/${NORTHWIND}?tab=notes` },
      file: NOTES_FILE,
      notes_rev: 'string',
      topics: 2,
      action_items: 2,
      title_kept: 'The title line stays the meeting\'s own: "Northwind roast review".',
      board: 'The action items are on the board now: list_action_items shows them.',
    },
  )
  // one file added, nothing else touched
  const after = await fingerprints(dir)
  assert.deepEqual(Object.keys(after).filter((n) => !(n in before)), [NOTES_FILE])
  for (const name of Object.keys(before)) assert.equal(after[name], before[name], name)
  const kept = await readFile(join(dir, NOTES_FILE), 'utf8')
  assert.match(kept, /^MEETING NOTES: Northwind roast review\nNovember 3, 2026 \| Recording: 3:00 \| Substantive discussion approximately 0:01–2:50\nParticipants: Ada Byron, Grace Hopper\nSaved by Ada's agent on \d{4}-\d\d-\d\d\.\n\nSUMMARY\n/)
  assert.ok(kept.includes(`Saved by Ada's agent on ${localDay(Date.now())}.`))
  // the meeting has its notes under the same id, and says who saved them
  const page = (await requestApp(app, `/api/meetings/${NORTHWIND}`)).json()
  assert.equal(page.id, NORTHWIND)
  assert.equal(page.notes.sections.find((s: { role: string }) => s.role === 'summary').blocks[0].text, 'The light roast sold out, and Grace will order more from the importer.')
  assert.equal(page.notesSaved.by, "Ada's agent")
  assert.equal(page.notesSaved.reason, 'written from the transcript')
  const board = await call(app, 'list_action_items', { meeting_id: NORTHWIND, status: 'all' })
  assert.deepEqual(board.data.items.map((a: { owner: string; text: string; lane: string }) => [a.owner, a.text, a.lane]), [
    ['Grace', 'Order twenty more bags from the importer.', 'us'],
    ['Team', 'Update the menu board.', 'us'],
  ])
  const m = await meta(app, NORTHWIND)
  assert.equal(m.notes_rev, saved.data.notes_rev)
  assert.deepEqual({ ...m.notes_saved, at: typeof m.notes_saved.at }, { by: "Ada's agent", at: 'string', reason: 'written from the transcript' })
})

test('replacing notes takes the rev the agent read; without it, or with an older one, nothing changes', async (t) => {
  const { dir, app } = await archive(t)
  const first = (await call(app, 'save_notes', { meeting_id: NORTHWIND, notes: NOTES })).data
  const second = NOTES.replace('Nobody said when the bags arrive.', 'Nobody said when the bags arrive, or what they cost.')
  const untouched = await fingerprints(dir)
  const missing = await call(app, 'save_notes', { meeting_id: NORTHWIND, notes: second })
  assert.equal(missing.isError, true)
  assert.equal(missing.text, 'this meeting has notes already: read them with get_meeting and pass its notes_rev as if_rev')
  // Grace fixes a word by hand after the agent read the notes
  await appendFile(join(dir, NOTES_FILE), '- Grace checks the price list.\n')
  const edited = await fingerprints(dir)
  const stale = await call(app, 'save_notes', { meeting_id: NORTHWIND, notes: second, if_rev: first.notes_rev })
  assert.equal(stale.isError, true)
  assert.equal(stale.text, 'the notes changed since you read them; read them again with get_meeting before saving')
  assert.deepEqual(await fingerprints(dir), edited, 'her edit stands')
  assert.notDeepEqual(edited, untouched)
  // read again, and saved on top of her edit: her version is kept in the history, then replaced
  const rev = (await meta(app, NORTHWIND)).notes_rev
  const replaced = await call(app, 'save_notes', { meeting_id: NORTHWIND, notes: second, if_rev: rev, reason: 'cost is unclear too' })
  assert.equal(replaced.isError, undefined, replaced.text)
  assert.equal(replaced.data.saved, true)
  assert.notEqual(replaced.data.notes_rev, rev)
  assert.match(await readFile(join(dir, NOTES_FILE), 'utf8'), /or what they cost\./)
  assert.equal((await meta(app, NORTHWIND)).notes_saved.reason, 'cost is unclear too')
})

test('the rev get_meeting gives is of the notes it shows, even a moment after an edit by hand, and a refusal gives none', async (t) => {
  const { dir, app } = await archive(t)
  const first = (await call(app, 'save_notes', { meeting_id: NORTHWIND, notes: NOTES })).data
  // Grace adds a line by hand, in place, before the folder is read again (this archive has no watcher)
  await appendFile(join(dir, NOTES_FILE), '- Grace checks the price list.\n')
  const read = await call(app, 'get_meeting', { meeting_id: NORTHWIND })
  const rev = JSON.parse(read.content[1].text).notes_rev
  assert.match(read.content[0].text, /Grace checks the price list\./, 'the notes shown are the ones in the folder')
  assert.notEqual(rev, first.notes_rev)
  // an agent that has not read her line is never handed the rev that would write over it
  const second = NOTES.replace('Nobody said when the bags arrive.', 'Nobody said when the bags arrive, or what they cost.')
  for (const args of [{}, { if_rev: first.notes_rev }]) {
    const refused = await call(app, 'save_notes', { meeting_id: NORTHWIND, notes: second, ...args })
    assert.equal(refused.isError, true)
    assert.ok(!refused.text.includes(rev), refused.text)
  }
  assert.match(await readFile(join(dir, NOTES_FILE), 'utf8'), /Grace checks the price list\.\n$/)
  const saved = await call(app, 'save_notes', { meeting_id: NORTHWIND, notes: second, if_rev: rev })
  assert.equal(saved.isError, undefined, saved.text)
})

test("the times on a line a person wrote are theirs when an agent saves over their notes; a time the agent adds is checked", async (t) => {
  // Grace's own notes say the call ran on after the recording stopped, a time the recording does not have
  const hers = `MEETING NOTES: Northwind roast review
November 3, 2026 | Recording: 3:00 | Substantive discussion approximately 0:01–2:50
Participants: Ada Byron, Grace Hopper
The call went on to 3:25 after the recording stopped.

SUMMARY
The light roast sold out, and Grace will order more from the importer.

ROASTS AND ORDERS
1. Light roast sold out (0:01–0:05)
- The Ethiopia light roast sold out on Friday.

ACTION ITEMS
- Grace: Order twenty more bags from the importer. (0:06–0:11)
`
  const { dir, app } = await archive(t, { [NOTES_FILE]: hers })
  const rev = (await meta(app, NORTHWIND)).notes_rev
  assert.ok(rev, 'her notes are read')
  // an agent adds a sentence to her summary and leaves her lines as they were
  const edited = hers.replace('from the importer.\n\nROASTS', 'from the importer. Nobody said when the bags arrive.\n\nROASTS')
  const saved = await call(app, 'save_notes', { meeting_id: NORTHWIND, notes: edited, if_rev: rev })
  assert.equal(saved.isError, undefined, saved.text)
  const kept = await readFile(join(dir, NOTES_FILE), 'utf8')
  assert.ok(kept.includes('The call went on to 3:25 after the recording stopped.\n'))
  assert.ok(kept.includes('Nobody said when the bags arrive.'))
  // a line the agent writes is held to the recording, even one that repeats her time
  for (const line of ['- Team: Call the importer back. (4:10–4:20)', '- Team: Ask why the call went on to 3:25.']) {
    const added = await call(app, 'save_notes', { meeting_id: NORTHWIND, notes: `${kept}${line}\n`, if_rev: saved.data.notes_rev })
    assert.equal(added.isError, true, line)
    assert.match(added.text, /^(4:10–4:20|3:25) is outside the recording, which runs 0:00–3:00/)
  }
})

test("another meeting's file her notes name already is hers to name; one the agent adds is refused", async (t) => {
  // Grace's notes point at the Acme demo's recording, which the index keeps with the Acme demo
  const hers = NOTES.replace('Participants: Ada Byron, Grace Hopper', 'Participants: Ada Byron, Grace Hopper\nThe roast list is the one shown in Acme demo 2026-11-07.mp4.')
  const { dir, app } = await archive(t, { [NOTES_FILE]: hers })
  const rev = (await meta(app, NORTHWIND)).notes_rev
  assert.ok(rev, 'her notes are read')
  const saved = await call(app, 'save_notes', { meeting_id: NORTHWIND, notes: hers.replace('Nobody said when the bags arrive.', 'Nobody said when the bags arrive, or what they cost.'), if_rev: rev })
  assert.equal(saved.isError, undefined, saved.text)
  assert.ok((await readFile(join(dir, NOTES_FILE), 'utf8')).includes('The roast list is the one shown in Acme demo 2026-11-07.mp4.\n'))
  const kept = await readFile(join(dir, NOTES_FILE), 'utf8')
  const added = await call(app, 'save_notes', { meeting_id: NORTHWIND, notes: kept.replace('Participants:', 'See also Screen Recording 2026-10-02 at 9.15.00 AM.mp4.\nParticipants:'), if_rev: saved.data.notes_rev })
  assert.equal(added.isError, true)
  assert.match(added.text, /^the notes name "Screen Recording 2026-10-02 at 9\.15\.00\sAM\.mp4", a file of another meeting/)
  // and the meeting keeps the files it had: the Acme recording stays with the Acme demo
  const acme = (await requestApp(app, '/api/meetings/2026-11-07-acme-demo')).json()
  assert.deepEqual(acme.videos.map((v: { name: string }) => v.name), ['Acme demo 2026-11-07.mp4'])
})

test('a file the index gives as notes that the archive does not read as notes, captions say, is never written over', async (t) => {
  // the index names the meeting's captions where its notes go, by mistake
  const captions = 'Acme demo 2026-11-07 - captions.srt'
  const index = { sessions: [{ id: '2026-11-07-acme-demo', date: '2026-11-07', title: 'Acme demo', videos: ['Acme demo 2026-11-07.mp4'], transcript: 'Acme demo 2026-11-07 - transcript.txt', notes: captions }] }
  const { dir, app } = await archive(t, { 'meetings-index.json': JSON.stringify(index), [captions]: '1\n00:00:01,000 --> 00:00:05,000\nThe Ethiopia light roast sold out on Friday.\n' })
  const before = await fingerprints(dir)
  const read = await meta(app, '2026-11-07-acme-demo')
  assert.equal(read.notes_rev, undefined, 'no rev for a file that is not notes')
  // even with the rev of the file as it is, nothing is written
  const rev = createHash('sha1').update(await readFile(join(dir, captions), 'utf8')).digest('base64url').slice(0, 12)
  for (const args of [{ if_rev: rev }, { undo: true }]) {
    const r = await call(app, 'save_notes', { meeting_id: '2026-11-07-acme-demo', notes: NOTES.replace('November 3', 'November 7'), ...args })
    assert.equal(r.isError, true, JSON.stringify(args))
    if (args.if_rev) assert.equal(r.text, `meetings-index.json gives "${captions}" as this meeting's notes, and the archive does not read it as notes, so it is never written over; the index is put right by hand`)
  }
  assert.deepEqual(await fingerprints(dir), before)
})

test('undo puts back the version before the last save, and after the first save takes the notes out again', async (t) => {
  const { dir, data, app } = await archive(t)
  const first = (await call(app, 'save_notes', { meeting_id: NORTHWIND, notes: NOTES })).data
  const firstText = await readFile(join(dir, NOTES_FILE), 'utf8')
  const second = (await call(app, 'save_notes', { meeting_id: NORTHWIND, notes: NOTES.replace('Update the menu board', 'Repaint the menu board'), if_rev: first.notes_rev })).data
  assert.equal(second.saved, true)
  // a change by hand after the last save: undo leaves it alone
  const secondText = await readFile(join(dir, NOTES_FILE), 'utf8')
  await writeFile(join(dir, NOTES_FILE), `${secondText}- Ada adds a line.\n`)
  const refused = await call(app, 'save_notes', { meeting_id: NORTHWIND, undo: true })
  assert.equal(refused.text, 'the notes changed after the last save through save_notes (by hand, or another way), so undo leaves them as they are')
  await writeFile(join(dir, NOTES_FILE), secondText)
  const undone = await call(app, 'save_notes', { meeting_id: NORTHWIND, undo: true })
  assert.equal(undone.isError, undefined, undone.text)
  assert.deepEqual({ undone: undone.data.undone, rev: undone.data.notes_rev, actions: undone.data.action_items }, { undone: true, rev: first.notes_rev, actions: 2 })
  assert.equal(await readFile(join(dir, NOTES_FILE), 'utf8'), firstText)
  const board = await call(app, 'list_action_items', { meeting_id: NORTHWIND, status: 'all' })
  assert.deepEqual(board.data.items.map((a: { text: string }) => a.text), ['Order twenty more bags from the importer.', 'Update the menu board.'])
  // the save that made the notes, taken back: no notes at all
  const gone = await call(app, 'save_notes', { meeting_id: NORTHWIND, undo: true })
  assert.equal(gone.data.note, 'That save had made these notes, so the meeting has no notes now.')
  assert.ok(!(await readdir(dir)).includes(NOTES_FILE))
  assert.equal((await requestApp(app, `/api/meetings/${NORTHWIND}`)).json().notes, null)
  assert.equal((await call(app, 'save_notes', { meeting_id: NORTHWIND, undo: true })).text, 'no save through save_notes is left to undo for this meeting')
  // every version stays in the data folder, the ones taken back included
  const [history] = await readdir(join(data, 'notes-history'))
  const kept = JSON.parse(await readFile(join(data, 'notes-history', history), 'utf8'))
  assert.equal(kept.file, NOTES_FILE)
  assert.deepEqual(kept.undone.map((v: { by: string; undoneBy: string }) => [v.by, v.undoneBy]), [["Ada's agent", "Ada's agent"], ["Ada's agent", "Ada's agent"]])
})

test('notes a person wrote stay in the history however many saves come after them, and a failed undo can be tried again', { skip: process.getuid?.() === 0 && 'running as root' }, async (t) => {
  const { dir, data, app } = await archive(t, {}, 'Grace')
  let rev = (await call(app, 'save_notes', { meeting_id: NORTHWIND, notes: NOTES })).data.notes_rev
  // Grace adds a line by hand; then her agent saves on top of it 20 times, 21 saves in all
  await appendFile(join(dir, NOTES_FILE), '- Grace checks the price list.\n')
  rev = (await meta(app, NORTHWIND)).notes_rev
  for (let i = 1; i <= 20; i++) {
    const saved = await call(app, 'save_notes', { meeting_id: NORTHWIND, notes: NOTES.replace('when the bags arrive.', `when the bags arrive (draft ${i}).`), if_rev: rev })
    assert.equal(saved.isError, undefined, saved.text)
    rev = saved.data.notes_rev
  }
  const history = async () => {
    const [name] = await readdir(join(data, 'notes-history'))
    return JSON.parse(await readFile(join(data, 'notes-history', name), 'utf8')) as { versions: { text: string | null; by?: string }[] }
  }
  const { versions } = await history()
  // the folder had no notes before the first save, then Grace's; both stay, with the newest 20 saves
  assert.deepEqual(versions.filter((v) => !v.by).map((v) => v.text && /Grace checks the price list\.\n$/.test(v.text)), [null, true])
  assert.equal(versions.filter((v) => v.by).length, 20)
  assert.match(versions.at(-1)!.text!, /\(draft 20\)/)
  // an undo that can't put the notes back changes nothing, and can be tried again
  const now = await readFile(join(dir, NOTES_FILE), 'utf8')
  await chmod(dir, 0o555)
  let failed
  try {
    t.mock.method(console, 'error', () => {})
    failed = (await requestApp(app, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'save_notes', arguments: { meeting_id: NORTHWIND, undo: true } } })).json()
  } finally {
    await chmod(dir, 0o755)
  }
  assert.ok(failed.error || failed.result?.isError, 'the undo did not happen')
  assert.equal(await readFile(join(dir, NOTES_FILE), 'utf8'), now)
  assert.deepEqual((await history()).versions, versions)
  const undone = await call(app, 'save_notes', { meeting_id: NORTHWIND, undo: true })
  assert.equal(undone.isError, undefined, undone.text)
  assert.match(await readFile(join(dir, NOTES_FILE), 'utf8'), /\(draft 19\)/)
})

test('save_notes refuses notes it cannot keep, says what to change, and leaves the folder as it was', async (t) => {
  const { dir, app } = await archive(t)
  const untouched = await fingerprints(dir)
  const refusal = async (meeting: string, notes: string) => {
    const r = await call(app, 'save_notes', { meeting_id: meeting, notes })
    assert.equal(r.isError, true, notes.slice(0, 60))
    return r.text as string
  }
  const cases: [string, string, RegExp][] = [
    [NORTHWIND, 'Roast review\nThe light roast sold out.', /^notes start with the line "MEETING NOTES: <title>"; nothing was saved$/],
    [NORTHWIND, 'MEETING NOTES: Roast review\nNovember 3, 2026\nThe light roast sold out.', /^the notes have no sections: after the header come SUMMARY/],
    [NORTHWIND, NOTES.replace('November 3, 2026', 'November 4, 2026'), /^the second line gives the meeting's date and length, as "November 3, 2026 \| Recording: 3:00 \| Substantive discussion approximately <start>–<end>"$/],
    [NORTHWIND, NOTES.replace('SUMMARY\nThe light roast sold out, and Grace will order more from the importer.\n', ''), /^the notes need a SUMMARY section/],
    [NORTHWIND, NOTES.replace(' (0:01–0:05)', '').replace(' (0:06–0:11)\n- Grace will', '\n- Grace will'), /^the notes need at least one topic with its time/],
    [NORTHWIND, NOTES.replace('(2:40–2:50)', '(41:20–43:05)'), /^41:20–43:05 is outside the recording, which runs 0:00–3:00; take times from the transcript \("- Team: Update the menu board\. \(41:20–43:05\)"\)$/],
    [NORTHWIND, NOTES.replace('- Team: Update the menu board.', '- Update the menu board.'), /^each action item starts with its owner, as "- Ada: Send the price list\. \(1:10–1:25\)", or "- Team: …" when nobody was named; this one has none: "Update the menu board\."$/],
    [NORTHWIND, NOTES.replace('Nobody said when the bags arrive.', 'IMPORTER_API_KEY=made-up-value-not-a-key-0000'), /^refused: the notes look like they contain a credential \(credential assignment\)/],
    [NORTHWIND, NOTES + `\n${'Long. '.repeat(20_000)}`, /^notes are at most 100,000 characters, and these run to 1\d\d,\d{3}$/],
    [NORTHWIND, NOTES.replace('Participants:', 'Times are clock timestamps, not elapsed recording offsets.\nParticipants:'), /^this meeting's times count from the start of the recording, and the notes call theirs clock times/],
    [NORTHWIND, NOTES.replace('Nobody said when', 'Screen Recording 2026-10-02 at 9.15.00 AM.mp4 has more. Nobody said when'), /^the notes name "Screen Recording 2026-10-02 at 9\.15\.00\sAM\.mp4", a file of another meeting/],
    ['2026-11-07-acme-demo', NOTES.replace('November 3', 'November 7'), /^meetings-index\.json lists this meeting and says which files are its, so notes for it are added to the index by hand$/],
  ]
  for (const [meeting, notes, said] of cases) assert.match(await refusal(meeting, notes), said)
  assert.deepEqual(await fingerprints(dir), untouched)
  assert.equal((await requestApp(app, `/api/meetings/${NORTHWIND}`)).json().notes, null)
})

test('a read-only connection is not offered save_notes and cannot call it, and no tool writes a transcript', async (t) => {
  const { dir, app } = await archive(t)
  const list = async (door: string) => (await requestApp(app, door, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })).json().result.tools as { name: string; annotations: { readOnlyHint: boolean } }[]
  assert.ok(!(await list('/mcp/readonly')).some((tool) => tool.name === 'save_notes'))
  const refused = await call(app, 'save_notes', { meeting_id: NORTHWIND, notes: NOTES }, '/mcp/readonly')
  assert.deepEqual([refused.isError, refused.text], [true, 'save_notes changes things, and this connection is read-only.'])
  // the tools that change anything: the board, the notebook and a meeting's notes, nothing else
  assert.deepEqual((await list('/mcp')).filter((tool) => !tool.annotations.readOnlyHint).map((tool) => tool.name).sort(), ['add_action_item', 'delete_action_item', 'delete_note', 'save_note', 'save_notes', 'update_action_item', 'update_note'])
  // saving, replacing and taking back notes leaves every transcript as it was
  const transcripts = async () => Object.entries(await fingerprints(dir)).filter(([name]) => /transcript|source/.test(name))
  const before = await transcripts()
  const first = (await call(app, 'save_notes', { meeting_id: NORTHWIND, notes: NOTES })).data
  await call(app, 'save_notes', { meeting_id: NORTHWIND, notes: NOTES.replace('Friday', 'Thursday'), if_rev: first.notes_rev })
  await call(app, 'save_notes', { meeting_id: NORTHWIND, undo: true })
  assert.deepEqual(await transcripts(), before)
  // a transcript handed in as notes is not notes
  assert.match((await call(app, 'save_notes', { meeting_id: NORTHWIND, notes: TRANSCRIPT, if_rev: first.notes_rev })).text, /^notes start with the line "MEETING NOTES: <title>"/)
  // a wall-clock meeting's notes speak its clock
  assert.match((await call(app, 'save_notes', { meeting_id: '2026-10-05-demo-day', notes: NOTES.replace('November 3', 'October 5') })).text, /^this meeting's transcript runs on a wall clock/)
})
