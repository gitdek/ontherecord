import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fixtureDir, NOTES } from './fixtures.test-helper.ts'
import { buildLibrary, scanFiles } from './library.ts'
import { runTool } from './mcp-tools.ts'
import { Notebook } from './notebook.ts'
import { SearchIndex } from './search.ts'
import { Reranker, Semantic } from './semantic.ts'
import { Speakers } from './speakers.ts'
import { LIMITS, Store } from './state.ts'
import { actionEvent, addAction, allActions, canonical, ConflictError, filterActions, findAction, onHold, openOnUs, reconcile, removeAction, TaskError, updateAction, type Patch } from './tasks.ts'

const MEETING = '2026-10-02-launch'
const NOTES_FILE = 'Ada Grace - Launch planning - 2026-10-02 - notes.txt'

// A board over the synthetic launch meeting. Its notes hold three items: one for the crew ("Ada/Grace"),
// one for a guest ("Linus") and one for everybody ("Team").
async function board() {
  const dir = await fixtureDir({ index: true })
  const scratch = await mkdtemp(join(tmpdir(), 'meetings-board-'))
  const build = async () => buildLibrary(await scanFiles(dir), (f) => (f.name.endsWith('.mp4') ? { probe: { duration: 1200, hasAudio: true } } : {}), ['Ada Byron', 'Grace Hopper'], new Map())
  const lib = await build()
  const store = new Store(join(scratch, 'state.json'))
  await reconcile(lib, store)
  const [ours, theirs, team] = allActions(lib, store)
  return {
    dir,
    scratch,
    build,
    lib,
    store,
    ours,
    theirs,
    team,
    all: () => allActions(lib, store),
    get: (id: string) => findAction(lib, store, id)!,
    set: (id: string, patch: Patch, by = 'Ada', opts: { noteOk?: (id: string) => boolean } = {}) => updateAction(lib, store, id, patch, by, opts),
    close: () => Promise.all([rm(dir, { recursive: true }), rm(scratch, { recursive: true })]),
  }
}

test('board: an open item can wait on something said in words, on other items, or both', async () => {
  const b = await board()
  try {
    // words alone, no date: parked until someone releases it
    let r = await b.set(b.ours.id, { hold: '  Waiting for the signed contract ' })
    assert.deepEqual(r.did, ['hold'])
    assert.deepEqual([r.action.status, r.action.hold?.on, r.action.hold?.by, r.action.hold?.ready, onHold(r.action)], ['open', 'Waiting for the signed contract', 'Ada', false, true])
    // it is still open, so the open list has it too
    assert.ok(filterActions(b.lib, b.all(), { status: 'open' }).some((a) => a.id === b.ours.id))
    assert.deepEqual(filterActions(b.lib, b.all(), { status: 'on_hold' }).map((a) => a.id), [b.ours.id])

    // the item that has to finish first; the words stay when only the dependencies change
    r = await b.set(b.ours.id, { blockedBy: [b.theirs.id] }, 'Grace')
    assert.deepEqual(r.action.hold?.after, [{ id: b.theirs.id, text: 'Share sandbox credentials process.', owner: 'Linus', status: 'open' }])
    assert.deepEqual([r.action.hold?.on, r.action.hold?.ready], ['Waiting for the signed contract', false])
    assert.equal(r.action.history.at(-1)?.text, 'Waiting for the signed contract · after 1 other item')

    // done or canceled, the blocker has finished: the item is free to start and no longer counts as on hold
    await b.set(b.theirs.id, { status: 'done' }, 'Grace')
    assert.deepEqual([b.get(b.ours.id).hold?.ready, onHold(b.get(b.ours.id))], [true, false])
    assert.deepEqual(filterActions(b.lib, b.all(), { status: 'on_hold' }), [])
    await b.set(b.theirs.id, { status: 'canceled' }, 'Grace')
    assert.equal(b.get(b.ours.id).hold?.ready, true)
    await b.set(b.theirs.id, { status: 'open' }, 'Grace')
    assert.equal(b.get(b.ours.id).hold?.ready, false)

    // an empty hold lets go of the words and the dependencies together
    r = await b.set(b.ours.id, { hold: '' })
    assert.deepEqual([r.did, r.action.hold], [['released'], null])
    assert.equal((await b.set(b.ours.id, { hold: '' })).changed, false)

    // finishing a parked item takes it off hold without a word
    await b.set(b.ours.id, { hold: 'Waiting for Acme' })
    r = await b.set(b.ours.id, { status: 'done' })
    assert.deepEqual([r.did, r.action.hold, b.store.state.actions[b.ours.id].hold], [['done'], null, undefined])
  } finally {
    await b.close()
  }
})

test('board: an item waiting on a duplicate waits on through the item that replaced it', async () => {
  const b = await board()
  try {
    const stands = await addAction(b.lib, b.store, { text: 'Share the sandbox credentials process with Ada', owner: 'Linus' }, "Grace's agent")
    // team waits on theirs, and theirs turns out to be a duplicate of an item that is still open
    await b.set(b.team.id, { blockedBy: [b.theirs.id] })
    await b.set(b.theirs.id, { status: 'canceled', reason: 'Same as the added task', replacedBy: stands.id }, "Grace's agent")
    const team = b.get(b.team.id)
    assert.deepEqual([team.hold?.after.map((r) => r.status), team.hold?.ready, onHold(team), openOnUs(b.all())], [['canceled'], false, true, 1])
    assert.deepEqual(filterActions(b.lib, b.all(), { status: 'on_hold' }).map((a) => a.id), [b.team.id])
    // the work it waits for is finished once the item that stands is
    await b.set(stands.id, { status: 'done', evidence: 'Sent on Friday' })
    assert.deepEqual([b.get(b.team.id).hold?.ready, openOnUs(b.all())], [true, 2])
    // along a longer chain: the one that stood is canceled in turn, as replaced by another that is still open
    const third = await addAction(b.lib, b.store, { text: 'Send the sandbox credentials process to Ada and Grace', owner: 'Linus' }, "Grace's agent")
    await b.set(stands.id, { status: 'canceled', reason: 'Wider than this', replacedBy: third.id })
    assert.equal(b.get(b.team.id).hold?.ready, false)
    // canceled with no replacement, an item has finished, as before
    await b.set(third.id, { status: 'canceled', reason: 'Acme handles it now' })
    assert.equal(b.get(b.team.id).hold?.ready, true)
    // links that lead back to the waiting item, or go round in a circle (saved before such links were refused), leave nothing to wait for
    await b.set(third.id, { replacedBy: b.team.id })
    assert.equal(b.get(b.team.id).hold?.ready, true)
    b.store.state.actions[third.id].canceled!.replacedBy = stands.id
    assert.equal(b.get(b.team.id).hold?.ready, true)
  } finally {
    await b.close()
  }
})

test('board: a hold that could never clear is refused', async () => {
  const b = await board()
  try {
    await assert.rejects(b.set(b.ours.id, { blockedBy: [b.ours.id] }), /can't wait on itself/)
    await assert.rejects(b.set(b.ours.id, { blockedBy: ['nope'] }), /no action item with id nope/)
    await assert.rejects(b.set(b.ours.id, { blockedBy: 7 }), /list of action item ids/)
    await assert.rejects(b.set(b.ours.id, { blockedBy: Array.from({ length: LIMITS.after + 1 }, (_, i) => `x${i}`) }), /at most 10 others/)
    // a circle, direct or through a third item
    await b.set(b.ours.id, { blockedBy: [b.theirs.id] })
    await assert.rejects(b.set(b.theirs.id, { blockedBy: [b.ours.id] }), /go in a circle/)
    await b.set(b.theirs.id, { blockedBy: [b.team.id] })
    await assert.rejects(b.set(b.team.id, { blockedBy: b.ours.id }), /go in a circle/)
    // only open work can be parked
    await b.set(b.team.id, { status: 'done' })
    await assert.rejects(b.set(b.team.id, { hold: 'Waiting for Acme' }), /only an open item can be on hold/)
    await assert.rejects(b.set(b.team.id, { hold: 'x'.repeat(LIMITS.hold + 1), status: 'open' }), /limited to 300 characters/)
    assert.equal(b.get(b.team.id).rev, 1, 'a refused change saves nothing')
  } finally {
    await b.close()
  }
})

test('board: an undo that would bring back a hold going in a circle is refused, as the direct change is', async () => {
  const b = await board()
  try {
    // ours waits on theirs, is taken off hold, then theirs is put on hold after ours
    await b.set(b.ours.id, { blockedBy: [b.theirs.id] }, 'Ada')
    await b.set(b.ours.id, { hold: '' }, 'Ada')
    await b.set(b.theirs.id, { blockedBy: [b.ours.id] }, 'Grace')
    await assert.rejects(b.set(b.ours.id, { blockedBy: [b.theirs.id] }, 'Ada'), /go in a circle/)
    const [ours, theirs] = [b.get(b.ours.id), b.get(b.theirs.id)]
    await assert.rejects(b.set(b.ours.id, { undo: true }, 'Ada'), /that undo would go in a circle/)
    assert.deepEqual([b.get(b.ours.id), b.get(b.theirs.id)], [ours, theirs])
    // the same when the change being undone was a check-off that let go of the hold, and through a third item
    await b.set(b.team.id, { blockedBy: [b.theirs.id] }, 'Ada')
    await b.set(b.team.id, { status: 'done' }, 'Ada')
    await b.set(b.ours.id, { blockedBy: [b.team.id] }, 'Grace')
    const team = b.get(b.team.id)
    await assert.rejects(b.set(b.team.id, { undo: true }, 'Ada'), /that undo would go in a circle/)
    assert.deepEqual(b.get(b.team.id), team)
    // once the circle is gone, the same undo goes through
    await b.set(b.theirs.id, { hold: '' }, 'Grace')
    const r = await b.set(b.team.id, { undo: true }, 'Ada')
    assert.deepEqual([r.did, r.action.status, r.action.hold?.after.map((x) => x.id)], [['undone'], 'open', [b.theirs.id]])
  } finally {
    await b.close()
  }
})

test('board: a status change says how anyone knows, with sources that point and never quote', async () => {
  const b = await board()
  try {
    const noteOk = (id: string) => id === 'n-1'
    const sources = [{ meeting_id: MEETING, at: '5:00' }, { note_id: 'n-1' }, '  Acme email thread,\n Oct 3 ', { meeting_id: MEETING }]
    let r = await b.set(b.theirs.id, { status: 'done', evidence: 'Linus walked through the process on the call', sources }, "Ada's agent", { noteOk })
    const kept = [{ meeting: MEETING, at: 300 }, { note: 'n-1' }, { ref: 'Acme email thread, Oct 3' }, { meeting: MEETING }]
    assert.deepEqual(r.did, ['done'])
    assert.deepEqual(r.action.done, { by: "Ada's agent", at: r.action.done!.at, evidence: 'Linus walked through the process on the call', sources: kept })
    assert.deepEqual(r.action.history.at(-1), { at: r.action.done!.at, by: "Ada's agent", did: 'done', evidence: 'Linus walked through the process on the call', sources: kept })

    // better evidence replaces the old without touching the sources or who finished the item
    r = await b.set(b.theirs.id, { evidence: 'Confirmed again in the follow-up' }, 'Grace')
    assert.deepEqual([r.did, r.action.done?.by, r.action.done?.evidence, r.action.done?.sources], [['evidence'], "Ada's agent", 'Confirmed again in the follow-up', kept])
    r = await b.set(b.theirs.id, { evidence: '', sources: [] }, 'Grace')
    assert.deepEqual([r.did, Object.keys(r.action.done!).sort()], [['evidence'], ['at', 'by']])

    // reopening can say why; on an item that stays open, evidence has nothing to be evidence of
    r = await b.set(b.theirs.id, { status: 'open', evidence: 'The link Linus sent has expired' }, 'Grace')
    assert.deepEqual([r.did, r.action.done, r.action.history.at(-1)?.evidence], [['reopened'], null, 'The link Linus sent has expired'])
    await assert.rejects(b.set(b.theirs.id, { evidence: 'Seen in the notes' }), /evidence and sources say why/)
    await assert.rejects(b.set(b.theirs.id, { sources: ['Acme thread'] }), /evidence and sources say why/)

    const bad: [unknown, RegExp][] = [
      [[{ meeting_id: 'nope' }], /no meeting with id nope/],
      [[{ note_id: 'n-2' }], /no notebook note with id n-2/],
      [[{ meeting_id: MEETING, at: 'soon' }], /isn't a time in that meeting/],
      [[{ meeting_id: MEETING, at: -5 }], /isn't a time in that meeting/],
      [[{ title: 'the email' }], /each source is/],
      [[''], /each source is/],
      ['Acme thread', /sources must be a list/],
      [Array.from({ length: LIMITS.sources + 1 }, (_, i) => `thread ${i}`), /at most 8 sources/],
      [['x'.repeat(LIMITS.ref + 1)], /short pointer/],
      [['key: sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345'], /credential/],
    ]
    for (const [s, why] of bad) await assert.rejects(b.set(b.theirs.id, { status: 'done', sources: s }, 'Ada', { noteOk }), why, JSON.stringify(s).slice(0, 60))
    assert.equal(b.get(b.theirs.id).status, 'open')
  } finally {
    await b.close()
  }
})

test('board: looking for confirmation and finding none is recorded without changing the status', async () => {
  const b = await board()
  try {
    const looked = { notFound: 'No sign of the process in the notes or the Acme thread', sources: ['Acme email thread, Oct 3'] }
    let r = await b.set(b.theirs.id, looked, "Grace's agent")
    assert.deepEqual(r.did, ['checked'])
    assert.deepEqual([r.action.status, r.action.done, r.action.canceled], ['open', null, null])
    assert.deepEqual(r.action.checked, { by: "Grace's agent", at: r.action.checked!.at, text: looked.notFound, sources: [{ ref: 'Acme email thread, Oct 3' }] })
    assert.equal((await b.set(b.theirs.id, looked, 'Ada')).changed, false, 'the same check again adds nothing')

    // it is neither completion nor cancellation, so it can't ride along with one
    for (const extra of [{ status: 'done' }, { status: 'canceled', reason: 'never sent' }, { evidence: 'nothing there' }, { replacedBy: b.team.id }]) {
      await assert.rejects(b.set(b.theirs.id, { notFound: 'Looked again', ...extra }), /found nothing leaves the status as it is/, JSON.stringify(extra))
    }

    // a check is about the status it was made under: once the item moves, it is history
    r = await b.set(b.theirs.id, { status: 'done', evidence: 'Linus sent it after all' }, 'Grace')
    assert.equal(r.action.checked, null)
    assert.deepEqual(r.action.history.map((e) => e.did), ['checked', 'done'])
    // on a finished item it questions the finish without undoing it or its evidence
    r = await b.set(b.theirs.id, { notFound: 'The email is not in the shared inbox', sources: ['shared inbox search'] }, "Ada's agent")
    assert.deepEqual([r.did, r.action.status, r.action.done?.evidence, r.action.done?.sources, r.action.checked?.sources], [['checked'], 'done', 'Linus sent it after all', undefined, [{ ref: 'shared inbox search' }]])
  } finally {
    await b.close()
  }
})

test('board: a duplicate or outdated item is canceled and pointed at the one that stands', async () => {
  const b = await board()
  try {
    const dup = await addAction(b.lib, b.store, { text: 'Send Linus the Widget API requirements', owner: 'Ada' }, "Ada's agent")
    await assert.rejects(b.set(dup.id, { replacedBy: b.ours.id }), /goes with status "canceled"/)
    await assert.rejects(b.set(dup.id, { status: 'canceled', replacedBy: dup.id }), /can't replace itself/)
    await assert.rejects(b.set(dup.id, { status: 'canceled', replacedBy: 'nope' }), /no action item with id nope/)
    assert.equal(b.get(dup.id).status, 'open')

    let r = await b.set(dup.id, { status: 'canceled', reason: 'Same as the item from the notes', replacedBy: b.ours.id })
    assert.deepEqual(r.did, ['canceled', 'linked'])
    assert.deepEqual(r.action.replacedBy, { id: b.ours.id, text: b.ours.text, owner: 'Ada/Grace', status: 'open' })
    assert.deepEqual(b.get(b.ours.id).replaces, [{ id: dup.id, text: 'Send Linus the Widget API requirements', owner: 'Ada', status: 'canceled' }])
    assert.equal('replacedBy' in r.action.canceled!, false, 'the link is given as an item, not as a bare id')

    // the link can be taken away or put back on its own; reopening the item drops it
    r = await b.set(dup.id, { replacedBy: null })
    assert.deepEqual([r.did, r.action.replacedBy, b.get(b.ours.id).replaces], [['unlinked'], null, []])
    r = await b.set(dup.id, { replacedBy: b.ours.id })
    assert.deepEqual([r.did, r.action.replacedBy?.id], [['linked'], b.ours.id])
    r = await b.set(dup.id, { status: 'open' })
    assert.deepEqual([r.action.replacedBy, b.get(b.ours.id).replaces], [null, []])

    // a link to a task that was deleted since is left out rather than dangling
    await b.set(b.team.id, { status: 'canceled', replacedBy: dup.id })
    await removeAction(b.lib, b.store, dup.id, 'Ada')
    assert.deepEqual([b.get(b.team.id).status, b.get(b.team.id).replacedBy], ['canceled', null])
  } finally {
    await b.close()
  }
})

test('board: a duplicate points at an item that stands, never at one that is canceled too', async () => {
  const b = await board()
  try {
    const dup = await addAction(b.lib, b.store, { text: 'Write the Widget API requirements', owner: 'Ada' }, "Ada's agent")
    await b.set(dup.id, { status: 'canceled', reason: 'Duplicate of the notes item', replacedBy: b.ours.id }, "Ada's agent")
    // a second agent, working from the list it read before, cancels the notes item the other way round
    const before = b.get(b.ours.id)
    await assert.rejects(b.set(b.ours.id, { status: 'canceled', reason: 'Duplicate of the added task', replacedBy: dup.id }, "Grace's agent"), /is canceled too.*point the replacement at the item that stands/)
    assert.deepEqual(b.get(b.ours.id), before)
    assert.deepEqual([b.get(b.ours.id).status, b.get(b.ours.id).rev, b.get(dup.id).replacedBy?.id], ['open', 0, b.ours.id])
    // and a canceled item can't be pointed at another canceled one later either
    await b.set(b.team.id, { status: 'canceled', reason: 'No follow-up needed' })
    await assert.rejects(b.set(dup.id, { replacedBy: b.team.id }), /is canceled too/)
    assert.equal(b.get(dup.id).replacedBy?.id, b.ours.id)
  } finally {
    await b.close()
  }
})

test('board: wording and owner can be corrected while the id, the status and the original stay', async () => {
  const b = await board()
  try {
    await b.set(b.theirs.id, { status: 'done' })
    let r = await b.set(b.theirs.id, { text: 'Share the sandbox credentials process with Ada.', owner: 'Linus/Mary' }, 'Grace')
    assert.deepEqual(r.did, ['reworded'])
    assert.deepEqual([r.action.id, r.action.status, r.action.text, r.action.owner], [b.theirs.id, 'done', 'Share the sandbox credentials process with Ada.', 'Linus/Mary'])
    assert.deepEqual(r.action.original, { text: 'Share sandbox credentials process.', owner: 'Linus' })
    assert.deepEqual([r.action.people, r.action.lane], [['linus-pauling', 'mary-shelley'], 'them'])
    assert.equal(r.action.history.at(-1)?.text, 'Linus/Mary: Share the sandbox credentials process with Ada.')

    // the lane follows a corrected owner
    r = await b.set(b.theirs.id, { owner: 'Grace' })
    assert.deepEqual([r.action.lane, r.action.people, r.action.original?.owner], ['us', ['grace-hopper'], 'Linus'])

    // sending back what the notes say is no correction, and neither is ""
    r = await b.set(b.theirs.id, { text: 'Share sandbox credentials process.' })
    assert.deepEqual([r.action.text, r.action.original], ['Share sandbox credentials process.', { text: 'Share sandbox credentials process.', owner: 'Linus' }])
    r = await b.set(b.theirs.id, { owner: '' })
    assert.deepEqual([r.action.owner, r.action.lane, r.action.original, r.action.status], ['Linus', 'them', null, 'done'])
    await assert.rejects(b.set(b.theirs.id, { text: 'x'.repeat(LIMITS.text + 1) }), /limited to 600 characters/)
    await assert.rejects(b.set(b.theirs.id, { text: 7 }), /must be text/)
  } finally {
    await b.close()
  }
})

test('board: the last change to an item can be undone, an undo can be undone, and a deleted task comes back', async () => {
  const b = await board()
  try {
    // an item says whether there is a change to take back, so a page can offer it only then
    assert.equal(b.team.undoable, false)
    let r = await b.set(b.team.id, { status: 'canceled', reason: 'No follow-up needed' })
    assert.equal(r.action.undoable, true)
    r = await b.set(b.team.id, { undo: true }, 'Grace')
    assert.deepEqual([r.did, r.action.status, r.action.canceled, r.action.undoable], [['undone'], 'open', null, true])
    r = await b.set(b.team.id, { undo: true }, 'Grace')
    assert.deepEqual([r.did, r.action.status, r.action.canceled?.reason, r.action.canceled?.by], [['redone'], 'canceled', 'No follow-up needed', 'Ada'])
    assert.deepEqual(r.action.history.map((e) => [e.did, e.by]), [['canceled', 'Ada'], ['undone', 'Grace'], ['redone', 'Grace']])
    assert.equal(r.action.rev, 3)
    await assert.rejects(b.set(b.team.id, { undo: true, note: 'and another thing' }), /undo goes alone/)
    await assert.rejects(b.set(b.team.id, { undo: 'yes' }), /undo must be true/)
    await assert.rejects(b.set(b.ours.id, { undo: true }), /nothing to undo/)
    await assert.rejects(b.set('nope', { undo: true }), /no action item with id nope/)

    // one change that did several things goes back in one step
    await b.set(b.ours.id, { status: 'done', note: 'Sent on Friday', evidence: 'In the shared folder' })
    r = await b.set(b.ours.id, { undo: true })
    assert.deepEqual([r.action.status, r.action.note, r.action.done], ['open', null, null])

    // a deleted task goes to the trash with everything the board held for it
    const t = await addAction(b.lib, b.store, { text: 'Ask Linus about the audit log', owner: 'Grace', meetingId: MEETING }, "Grace's agent")
    await b.set(t.id, { note: 'Ask on Thursday' }, 'Grace')
    await removeAction(b.lib, b.store, t.id, 'Ada')
    assert.equal(findAction(b.lib, b.store, t.id), undefined)
    assert.deepEqual(b.store.state.trash.map((x) => [x.task.id, x.by]), [[t.id, 'Ada']])
    await assert.rejects(b.set(t.id, { note: 'still there?' }), /no action item with id/)
    r = await b.set(t.id, { undo: true }, 'Grace')
    assert.deepEqual([r.did, r.action.note?.text, r.action.meeting?.id, r.action.createdBy], [['restored'], 'Ask on Thursday', MEETING, "Grace's agent"])
    assert.deepEqual(r.action.history.map((e) => e.did), ['added', 'note', 'restored'])
    assert.deepEqual(b.store.state.trash, [])
    // items from the notes are never deleted, only finished or canceled
    await assert.rejects(removeAction(b.lib, b.store, b.ours.id, 'Ada'), /cannot be deleted/)
  } finally {
    await b.close()
  }
})

test('board: a task brought back has nothing to undo, so a second undo takes back nothing older', async () => {
  const b = await board()
  try {
    const t = await addAction(b.lib, b.store, { text: 'Order the conference badges', owner: 'Grace' }, 'Grace')
    await b.set(t.id, { status: 'done', evidence: 'Badges arrived Tuesday' }, 'Grace')
    await removeAction(b.lib, b.store, t.id, 'Ada')
    const back = await b.set(t.id, { undo: true }, 'Ada')
    assert.deepEqual([back.did, back.action.status, back.action.done?.evidence, back.action.undoable], [['restored'], 'done', 'Badges arrived Tuesday', false])
    assert.equal(b.store.state.actions[t.id].prev, undefined)
    // pressing undo again, or an agent retrying a restore whose answer it lost, is refused and changes nothing
    await assert.rejects(b.set(t.id, { undo: true }, 'Grace'), /already back on the board/)
    await assert.rejects(b.set(t.id, { undo: true, rev: back.action.rev }, "Grace's agent"), /already back on the board/)
    const now = b.get(t.id)
    assert.deepEqual([now.status, now.done?.evidence, now.rev, now.history.map((e) => e.did)], ['done', 'Badges arrived Tuesday', back.action.rev, ['added', 'done', 'restored']])
    // once it changes again, that change can be taken back as usual
    await b.set(t.id, { note: 'Handed out at the door' }, 'Grace')
    const undone = await b.set(t.id, { undo: true }, 'Grace')
    assert.deepEqual([undone.did, undone.action.status, undone.action.note, undone.action.done?.evidence], [['undone'], 'done', null, 'Badges arrived Tuesday'])

    // a task restored before this, which kept the step from before its delete, is refused the same way
    const old = await addAction(b.lib, b.store, { text: 'Print the name tags', owner: 'Grace' }, 'Grace')
    await b.set(old.id, { status: 'done', evidence: 'Printed on Monday' }, 'Grace')
    await removeAction(b.lib, b.store, old.id, 'Ada')
    await b.set(old.id, { undo: true }, 'Ada')
    b.store.state.actions[old.id].prev = {}
    assert.equal(b.get(old.id).undoable, false)
    await assert.rejects(b.set(old.id, { undo: true }, 'Grace'), /already back on the board/)
    assert.deepEqual([b.get(old.id).status, b.get(old.id).done?.evidence], ['done', 'Printed on Monday'])
  } finally {
    await b.close()
  }
})

test('board: an update overtaken by a delete of the same task while it saves is refused clearly, never a server error', async () => {
  const b = await board()
  try {
    const t = await addAction(b.lib, b.store, { text: 'Order the conference badges', owner: 'Grace' }, 'Grace')
    // a delete waits for the save ahead of it, and an update of the same task lands in between: the delete takes the
    // update's change to the trash, and the update's own save finds the task gone
    const [, d, u] = await Promise.allSettled([b.set(b.ours.id, { note: 'Draft is in the shared folder' }), removeAction(b.lib, b.store, t.id, 'Ada'), b.set(t.id, { note: 'Ordered from the Leeds printer' }, "Grace's agent")])
    assert.equal(d.status, 'fulfilled')
    assert.ok(u.status === 'rejected' && u.reason instanceof TaskError, String(u.status === 'rejected' ? u.reason : 'it answered as if saved, with no item to show'))
    assert.match(u.reason.message, /^that task was deleted while this change was being saved; it is under Recently deleted on the board, with the change/)
    // the change went to the trash with the task, and bringing it back brings both
    const back = await b.set(t.id, { undo: true }, 'Ada')
    assert.deepEqual([back.did, back.action.note?.text], [['restored'], 'Ordered from the Leeds printer'])

    // the same two calls through the MCP tools: one goes through, the other is a refusal the agent can read
    const notebook = new Notebook(join(b.scratch, 'notebook.json'))
    const index = new SearchIndex(b.lib, [], b.all(), (id) => canonical(b.store, id))
    const ctx = {
      lib: () => b.lib,
      index: () => index,
      store: b.store,
      publicUrl: 'https://example.test',
      originOk: () => true,
      changed: () => index.setBoard(b.all()),
      notebook,
      semantic: new Semantic(b.scratch, { url: '', key: '', model: '' }),
      reranker: new Reranker({ url: '', key: '' }),
      speakers: new Speakers(b.scratch, { python: '', segmentation: '', embedding: '', script: '', readText: '' }, () => {}),
      lookups: { meeting: (id: string) => b.lib.byId.get(id)?.id, task: (id: string) => findAction(b.lib, b.store, id)?.id },
      notebookChanged: () => {},
    }
    const agent = { name: "Grace's agent", email: '', local: false, agent: true, scope: 'write' as const }
    const call = (name: string, args: Record<string, unknown>) => runTool({ name, arguments: args }, agent, ctx) as Promise<{ content: { text: string }[]; isError?: boolean }>
    const log = console.log
    console.log = () => {}
    try {
      const [, remove, update] = await Promise.all([call('update_action_item', { id: b.ours.id, note: 'Shared folder updated' }), call('delete_action_item', { id: t.id }), call('update_action_item', { id: t.id, note: 'Ordered again' })])
      assert.deepEqual([remove.isError, JSON.parse(remove.content[0].text)], [undefined, { deleted: t.id, restorable: true }])
      assert.equal(update.isError, true)
      assert.match(update.content[0].text, /^that task was deleted while this change was being saved/)
      // in the order the audit found it, the update is saved first and the delete after it, and both go through
      await call('update_action_item', { id: t.id, undo: true })
      const [first, second] = await Promise.all([call('update_action_item', { id: t.id, note: 'Ordered a third time' }), call('delete_action_item', { id: t.id })])
      assert.deepEqual([first.isError, second.isError, b.store.state.trash.at(-1)?.state?.note?.text], [undefined, undefined, 'Ordered a third time'])
    } finally {
      console.log = log
    }
  } finally {
    await b.close()
  }
})

test('board: a change based on an older revision is refused and hands back the item as it stands', async () => {
  const b = await board()
  try {
    const seen = b.get(b.ours.id).rev
    assert.equal(seen, 0)
    await b.set(b.ours.id, { note: 'Draft is in the shared folder' }, 'Grace')
    const err = await b.set(b.ours.id, { status: 'done', rev: seen }, "Ada's agent").then(() => null, (e: unknown) => e)
    assert.ok(err instanceof ConflictError)
    assert.match(err.message, /^Grace changed this item after you read it \(it is at revision 1 now\), so nothing was saved\./)
    assert.deepEqual([err.action.status, err.action.rev, err.action.note?.text], ['open', 1, 'Draft is in the shared folder'])
    assert.equal(b.get(b.ours.id).status, 'open')

    // with the revision it has now the change goes through; one that would alter nothing is no conflict
    const r = await b.set(b.ours.id, { status: 'done', rev: 1 }, "Ada's agent")
    assert.deepEqual([r.action.status, r.action.rev], ['done', 2])
    // what open pages are told: what the change did and the revision it left, so their next change builds on it
    const event = actionEvent(r.action, r.did, "Ada's agent")
    assert.deepEqual([event.kind, event.id, event.did, event.rev, event.status, event.by], ['action', b.ours.id, ['done'], 2, 'done', "Ada's agent"])
    assert.equal((await b.set(b.ours.id, { status: 'done', rev: 0 })).changed, false)
    await assert.rejects(b.set(b.ours.id, { undo: true, rev: 1 }), ConflictError)
    assert.equal(b.get(b.ours.id).status, 'done')
    for (const rev of [-1, 1.5, '2', true]) await assert.rejects(b.set(b.ours.id, { note: 'x', rev }), /whole number/, String(rev))
    // without a revision the last writer wins, as before
    assert.equal((await b.set(b.ours.id, { note: 'Sent' }, 'Grace')).action.rev, 3)
  } finally {
    await b.close()
  }
})

test('board: free text is checked before anything is saved', async () => {
  const b = await board()
  try {
    const secret = 'key: sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345'
    for (const patch of [{ note: secret }, { hold: secret }, { status: 'canceled', reason: secret }, { status: 'done', evidence: secret }, { notFound: secret }, { text: secret }, { owner: secret }]) {
      await assert.rejects(b.set(b.ours.id, patch), /credential/, Object.keys(patch).join())
    }
    await assert.rejects(addAction(b.lib, b.store, { text: secret, owner: 'Ada' }, 'Ada'), /credential/)
    await assert.rejects(b.set(b.ours.id, { note: 'x'.repeat(LIMITS.note + 1) }), /limited to 1000 characters/)
    await assert.rejects(b.set(b.ours.id, { status: 'done', evidence: 'x'.repeat(LIMITS.evidence + 1) }), /limited to 500 characters/)
    await assert.rejects(b.set(b.ours.id, { note: 7 }), /must be text/)
    assert.deepEqual([b.get(b.ours.id).rev, b.store.state.actions[b.ours.id]], [0, undefined])
    // control characters are dropped, ordinary punctuation and line breaks stay
    const r = await b.set(b.ours.id, { note: 'Line one\u0007\nLine two' })
    assert.equal(r.action.note?.text, 'Line one\nLine two')
  } finally {
    await b.close()
  }
})

test('board: a credential is refused even with a control character inside it, in every free-text field', async () => {
  const b = await board()
  try {
    // checked as it would be saved: the control character is dropped, and the token it split is whole again
    for (const hidden of ['token ghp_\u0000abcdefghijklmnopqrstuvwxyz0123456789', 'AKIA\u0007ABCDEFGHIJKLMNOP is the key']) {
      for (const patch of [{ note: hidden }, { hold: hidden }, { status: 'canceled', reason: hidden }, { status: 'done', evidence: hidden }, { notFound: hidden }, { text: hidden }, { owner: hidden }]) {
        await assert.rejects(b.set(b.ours.id, patch), /credential/, `${Object.keys(patch).join()}: ${JSON.stringify(hidden)}`)
      }
    }
    // the two shapes the patterns missed: a lowercase bearer header and a password inside a connection address
    await assert.rejects(b.set(b.ours.id, { note: 'authorization: bearer abcdefghijklmnopqrstuvwxyz0123456789' }), /bearer token/)
    await assert.rejects(b.set(b.ours.id, { note: 'Connect with postgres://admin:hunter2@db.example.test:5432/app' }), /password in a connection address/) // gitleaks:allow (made up, to test the guard)
    assert.deepEqual([b.get(b.ours.id).rev, b.store.state.actions[b.ours.id]], [0, undefined])
    // a length is the length of what is saved
    assert.equal((await b.set(b.ours.id, { note: ` ${'x'.repeat(LIMITS.note)} ` })).action.note?.text.length, LIMITS.note)
  } finally {
    await b.close()
  }
})

test('board: marks saved before trails were kept still tell their story, and a trail keeps its newest entries', async () => {
  const b = await board()
  try {
    const path = join(b.scratch, 'old.json')
    // the two formats that came before: a bare done flag, and marks without revision or history
    await writeFile(path, JSON.stringify({ actions: { [b.ours.id]: { done: true, by: 'Ada', at: '2026-10-03T10:00:00.000Z' }, [b.theirs.id]: { canceled: { by: 'Grace', at: '2026-10-05T09:00:00.000Z', reason: 'Acme handles it' }, note: { text: 'see thread', by: 'Ada', at: '2026-10-04T09:00:00.000Z' } } }, tasks: [] }))
    const store = new Store(path)
    await store.load()
    assert.deepEqual([store.state.trash, store.state.seen, store.state.aliases], [[], {}, {}])
    const old = allActions(b.lib, store)
    assert.deepEqual(old.map((a) => [a.status, a.rev]), [['done', 0], ['canceled', 0], ['open', 0]])
    assert.deepEqual(old[0].history, [{ at: '2026-10-03T10:00:00.000Z', by: 'Ada', did: 'done' }])
    assert.deepEqual(old[1].history.map((e) => [e.did, e.by, e.text]), [['note', 'Ada', 'see thread'], ['canceled', 'Grace', 'Acme handles it']])
    // the first change after that adds to the story instead of replacing it
    const r = await updateAction(b.lib, store, b.theirs.id, { status: 'open' }, 'Grace')
    assert.deepEqual([r.action.history.map((e) => e.did), r.action.rev], [['note', 'canceled', 'reopened'], 1])
    const saved = JSON.parse(await readFile(path, 'utf8'))
    assert.deepEqual(saved.actions[b.ours.id], { done: { by: 'Ada', at: '2026-10-03T10:00:00.000Z' } }, 'an item nobody touched is written back as it was read')

    for (let i = 0; i < LIMITS.history + 5; i++) await updateAction(b.lib, store, b.team.id, { note: `note ${i}` }, 'Ada')
    const long = findAction(b.lib, store, b.team.id)!
    assert.deepEqual([long.history.length, long.rev, long.history.at(-1)?.text, long.history[0].text], [LIMITS.history, LIMITS.history + 5, `note ${LIMITS.history + 4}`, 'note 5'])
  } finally {
    await b.close()
  }
})

test('board: an item reworded in the notes keeps its id, its status and its trail', async () => {
  const b = await board()
  try {
    await b.set(b.theirs.id, { status: 'done', note: 'Sent on Friday' }, 'Grace')
    await b.set(b.team.id, { status: 'canceled', reason: 'No follow-up needed' }, 'Grace')
    // one line is reworded; another is replaced by two that are equally like it
    const edited = NOTES.replace('Linus: Share sandbox credentials process.', 'Linus: Share the sandbox credentials process with Ada.').replace('- Team: Book the follow-up call. (17:00–17:10)', '- Team: Book the follow-up call with Acme. (17:00–17:10)\n- Team: Book the follow-up call with Mary. (17:20–17:30)')
    assert.notEqual(edited, NOTES)
    await writeFile(join(b.dir, NOTES_FILE), edited)
    let lib = await b.build()
    const hashed = lib.byId.get(MEETING)!.actions.map((a) => a.id)
    assert.equal(hashed.length, 4)
    assert.ok(!hashed.includes(b.theirs.id) && !hashed.includes(b.team.id), 'new wording hashes to a new id')

    assert.equal(await reconcile(lib, b.store), 1)
    let now = allActions(lib, b.store)
    const moved = now.find((a) => a.text === 'Share the sandbox credentials process with Ada.')!
    assert.deepEqual([moved.id, moved.status, moved.note?.text, moved.original], [b.theirs.id, 'done', 'Sent on Friday', null])
    assert.deepEqual(moved.history.at(-1) && [moved.history.at(-1)!.by, moved.history.at(-1)!.did, moved.history.at(-1)!.text], ['the notes', 'relinked', 'Share the sandbox credentials process with Ada.'])
    // the id the new wording hashes to answers for the same item
    assert.equal(canonical(b.store, hashed[1]), b.theirs.id)
    assert.equal(findAction(lib, b.store, hashed[1])?.id, b.theirs.id)
    // with no clear winner nothing is carried over: a status on the wrong item is worse than a lost one
    const calls = now.filter((a) => a.text.startsWith('Book the follow-up call with'))
    assert.deepEqual(calls.map((a) => [a.status, a.rev]), [['open', 0], ['open', 0]])
    assert.equal(await reconcile(lib, b.store), 0, 'a second pass finds nothing new')

    // the old wording comes back: the borrowed id returns to its owner and both stand as they were
    await writeFile(join(b.dir, NOTES_FILE), NOTES)
    lib = await b.build()
    assert.equal(await reconcile(lib, b.store), 0)
    now = allActions(lib, b.store)
    assert.deepEqual(now.map((a) => [a.id, a.status]), [[b.ours.id, 'open'], [b.theirs.id, 'done'], [b.team.id, 'canceled']])
    assert.deepEqual(b.store.state.aliases, {})
  } finally {
    await b.close()
  }
})

test('board: a renamed meeting keeps what the board held for its items', async () => {
  const b = await board()
  try {
    await b.set(b.ours.id, { hold: 'Waiting for the signed contract' })
    await b.set(b.theirs.id, { status: 'done' }, 'Grace')
    const index = join(b.dir, 'meetings-index.json')
    await writeFile(index, (await readFile(index, 'utf8')).replace(`"${MEETING}"`, '"2026-10-02-kickoff"'))
    const lib = await b.build()
    assert.equal(lib.byId.get(MEETING), undefined)
    assert.equal(await reconcile(lib, b.store), 3)
    const now = allActions(lib, b.store)
    assert.deepEqual(now.map((a) => [a.id, a.status, a.meeting?.id]), [[b.ours.id, 'open', '2026-10-02-kickoff'], [b.theirs.id, 'done', '2026-10-02-kickoff'], [b.team.id, 'open', '2026-10-02-kickoff']])
    assert.equal(now[0].hold?.on, 'Waiting for the signed contract')
    await b.store.setTheme('Ada', 'dark')
  } finally {
    await b.close()
  }
})

test('search: what the board says about an item is found, under the item it belongs to', async () => {
  const b = await board()
  try {
    const index = new SearchIndex(b.lib, [], b.all(), (id) => canonical(b.store, id))
    const find = (q: string) => {
      index.setBoard(b.all())
      return index.search(q, { limit: 10, typing: false }).hits
    }
    assert.deepEqual(find('procurement'), [])
    await b.set(b.theirs.id, { status: 'canceled', reason: 'Acme procurement handles credentials now' }, 'Grace')
    let [h] = find('procurement')
    assert.deepEqual([h.kind, h.part, h.actionId, h.board, h.meetingId, h.text], ['update', 'reason', b.theirs.id, true, MEETING, 'Acme procurement handles credentials now'])
    // reopened, the reason is gone from the board and from the index
    await b.set(b.theirs.id, { status: 'open' })
    assert.deepEqual(find('procurement'), [])

    // evidence, notes, what an item waits on and a check that found nothing
    await b.set(b.ours.id, { hold: 'Waiting for the countersigned paperwork' })
    await b.set(b.theirs.id, { status: 'done', evidence: 'Linus demonstrated the vault handover', note: 'Rotate quarterly' })
    await b.set(b.team.id, { notFound: 'No calendar invitation anywhere' })
    const parts = (q: string) => find(q).map((x) => [x.part, x.actionId])
    assert.deepEqual(parts('countersigned'), [['hold', b.ours.id]])
    assert.deepEqual(parts('vault handover'), [['evidence', b.theirs.id]])
    assert.deepEqual(parts('quarterly'), [['note', b.theirs.id]])
    assert.deepEqual(parts('invitation'), [['checked', b.team.id]])

    // a task added to the board is found by its own words; in:updates keeps to what was written since
    const t = await addAction(b.lib, b.store, { text: 'Order the conference badges', owner: 'Grace', meetingId: MEETING }, "Grace's agent")
    await b.set(t.id, { note: 'Badges ship from the Leeds printer' })
    assert.deepEqual(find('badges').map((x) => [x.kind, x.actionId, x.board]).sort(), [['action', t.id, true], ['update', t.id, true]])
    assert.deepEqual(find('badges in:updates').map((x) => x.kind), ['update'])
    // corrected wording is found as well as the wording in the notes, both under the one id
    await b.set(b.team.id, { text: 'Schedule the retrospective with Acme.' })
    assert.deepEqual(find('retrospective').map((x) => [x.kind, x.actionId, x.board]), [['action', b.team.id, true]])
    ;[h] = find('"Book the follow-up call" in:actions')
    assert.deepEqual([h.actionId, h.board], [b.team.id, undefined])
    // nothing the board holds outlives the board
    index.setBoard([])
    assert.deepEqual(index.search('badges', { limit: 10, typing: false }).hits, [])
  } finally {
    await b.close()
  }
})

test('board: "open on us" counts what can be picked up today', async () => {
  const b = await board()
  try {
    const mine = () => b.all().filter((a) => a.lane === 'us')
    assert.deepEqual([mine().length, openOnUs(b.all())], [2, 2])
    // parked behind the guest's item: still open, not ours to start
    await b.set(b.ours.id, { hold: 'Waiting for the signed contract', blockedBy: [b.theirs.id] })
    assert.deepEqual([openOnUs(b.all()), mine().filter((a) => a.status === 'open').length], [1, 2])
    // what it waited on is finished, so it counts again
    await b.set(b.theirs.id, { status: 'done' }, 'Grace')
    assert.equal(openOnUs(b.all()), 2)
    // canceled is not open, and neither is done
    await b.set(b.ours.id, { status: 'canceled', reason: 'No longer needed' })
    assert.equal(openOnUs(b.all()), 1)
    await b.set(mine().find((a) => a.status === 'open')!.id, { status: 'done' })
    assert.equal(openOnUs(b.all()), 0)
  } finally {
    await b.close()
  }
})
