// "Who said they'd do what": action items from every set of notes plus tasks added by hand or by an agent,
// with their shared status (open, done or canceled), what they wait on, the evidence behind a change and the
// trail of who changed what. The board, the JSON API and the MCP tools all go through here.
import type { Library } from './library.ts'
import { findSecrets } from './notebook.ts'
import { LIMITS, STATUSES, StaleError, trailOf, type ActionState, type Entry, type Mark, type Proof, type Source, type Status, type Store } from './state.ts'
import { parseTime, type Range } from './text.ts'

// Another item, as much of it as a link needs.
export type Ref = { id: string; text: string; owner: string; status: Status }
export type ActionView = {
  id: string
  source: 'notes' | 'added'
  owner: string
  people: string[]
  lane: 'us' | 'them'
  text: string
  ranges: Range[]
  section?: string
  meeting: { id: string; title: string; date: string; hue: number; timeBase: 'offset' | 'clock' } | null
  status: Status
  done: (Mark & Proof) | null
  canceled: (Mark & Proof & { reason?: string }) | null
  note: (Mark & { text: string }) | null
  // on hold (open items only): what it waits on in words, the items that come first, and ready once all of those have finished
  hold: (Mark & { on: string; after: Ref[]; ready: boolean }) | null
  // someone looked for confirmation and found none
  checked: (Mark & { text: string; sources?: Source[] }) | null
  // a canceled duplicate or outdated item points at the one that stands, and that one lists what it replaces
  replacedBy: Ref | null
  replaces: Ref[]
  // what the notes or the task said, when the board has since corrected the wording or the owner
  original: { text: string; owner: string } | null
  rev: number
  history: Entry[]
  // whether the last change can still be taken back
  undoable: boolean
  createdBy?: string
  createdAt?: string
}
type Base = Pick<ActionView, 'id' | 'source' | 'owner' | 'people' | 'lane' | 'text' | 'ranges' | 'section' | 'meeting' | 'createdBy' | 'createdAt'>

const refOf = (a: ActionView): Ref => ({ id: a.id, text: a.text, owner: a.owner, status: a.status })

// The id an item answers to: a notes item that was reworded keeps the id it had before (see Store.reconcile).
export const canonical = (store: Store, id: string) => store.state.aliases[id] ?? id

export function allActions(lib: Library, store: Store): ActionView[] {
  const { actions, tasks } = store.state
  const meetingRef = (id?: string) => {
    const m = id ? lib.byId.get(id) : undefined
    return m ? { id: m.id, title: m.title, date: m.date, hue: m.hue, timeBase: m.timeBase } : null
  }
  // what the board holds for an item, laid over what the notes or the task say
  const view = (base: Base, first: Entry[] = []): ActionView => {
    const s: ActionState = actions[base.id] ?? {}
    // one status per item: a cancel outranks a check-off if a hand-edited file ever holds both
    const canceled = s.canceled ? { ...s.canceled } : null
    delete canceled?.replacedBy
    const done = canceled ? null : (s.done ?? null)
    const text = s.text ?? base.text
    const owner = s.owner ?? base.owner
    return {
      ...base,
      text,
      owner,
      ...(s.owner ? { people: lib.people.mentioned(owner), lane: laneFor(lib, owner) } : {}),
      status: canceled ? 'canceled' : done ? 'done' : 'open',
      done,
      canceled,
      note: s.note ?? null,
      hold: null,
      checked: s.checked ?? null,
      replacedBy: null,
      replaces: [],
      original: text !== base.text || owner !== base.owner ? { text: base.text, owner: base.owner } : null,
      rev: s.rev ?? 0,
      history: [...first, ...trailOf(s)],
      // a task just brought back has nothing to undo, even one whose restore kept the step from before its delete
      undoable: !!s.prev && trailOf(s).at(-1)?.did !== 'restored',
    }
  }
  const fromNotes = lib.meetings.flatMap((m) => m.actions.map((a) => view({ ...a, id: canonical(store, a.id), source: 'notes', meeting: meetingRef(m.id) })))
  const added = tasks.map((t) =>
    view(
      { id: t.id, source: 'added', owner: t.owner, people: lib.people.mentioned(t.owner), lane: t.lane, text: t.text, ranges: [], meeting: meetingRef(t.meetingId), createdBy: t.createdBy, createdAt: t.createdAt },
      [{ at: t.createdAt, by: t.createdBy, did: 'added' }],
    ),
  )
  const list = [...added, ...fromNotes]
  // links between items need every item's status, so they go in last; a link to an item that's gone is left out
  const byId = new Map(list.map((a) => [a.id, a]))
  // An item waited on has finished once it is done or canceled, but one canceled as replaced by another lives
  // on in that item, so the wait follows the link. It ends, finished, at an item that is gone, at the waiting
  // item itself, or where the links go round in a circle.
  const finished = (id: string, waiting: string) => {
    const seen = new Set<string>()
    for (let r = byId.get(id); r && r.id !== waiting && !seen.has(r.id); ) {
      if (r.status === 'open') return false
      seen.add(r.id)
      const next = r.status === 'canceled' ? actions[r.id]?.canceled?.replacedBy : undefined
      r = next ? byId.get(next) : undefined
    }
    return true
  }
  for (const a of list) {
    const s = actions[a.id]
    if (a.status === 'open' && s?.hold) {
      const after = (s.hold.after ?? []).flatMap((id) => (byId.has(id) ? [refOf(byId.get(id)!)] : []))
      const on = s.hold.on ?? ''
      if (on || after.length) a.hold = { by: s.hold.by, at: s.hold.at, on, after, ready: after.length > 0 && after.every((r) => finished(r.id, a.id)) }
    }
    const stands = a.status === 'canceled' && s?.canceled?.replacedBy ? byId.get(s.canceled.replacedBy) : undefined
    if (stands) {
      a.replacedBy = refOf(stands)
      stands.replaces.push(refOf(a))
    }
  }
  return list
}

export const findAction = (lib: Library, store: Store, id: string) => allActions(lib, store).find((a) => a.id === canonical(store, id))

// Parked: open, waiting, and not yet free to start. Such an item is still open, so "open" lists it too.
export const onHold = (a: ActionView) => a.status === 'open' && !!a.hold && !a.hold.ready

// "Open on us" on the shelf, the nav badge and a cassette's chip: what the owners can pick up today. A parked
// item is left out, the way the board's own counter leaves it out, and shows under "on hold" instead.
export const openOnUs = (actions: ActionView[]) => actions.filter((a) => a.lane === 'us' && a.status === 'open' && !onHold(a)).length

export type Filter = { status?: Status | 'all' | 'on_hold'; lane?: 'us' | 'them' | 'all'; person?: string; meetingId?: string }

export function filterActions(lib: Library, list: ActionView[], f: Filter): ActionView[] {
  const people = f.person ? lib.people.mentioned(f.person) : []
  const meeting = f.meetingId ? lib.byId.get(f.meetingId) : undefined
  return list.filter(
    (a) =>
      (f.status === 'all' || (f.status === 'on_hold' ? onHold(a) : a.status === (f.status ?? 'open'))) &&
      (!f.lane || f.lane === 'all' || a.lane === f.lane) &&
      (!f.person || (people.length ? people.some((p) => a.people.includes(p)) : a.owner.toLowerCase().includes(f.person.toLowerCase()))) &&
      (!f.meetingId || a.meeting?.id === meeting?.id),
  )
}

export class TaskError extends Error {}

// The item changed after the caller last read it. Carries the item as it stands, so the caller can look again.
export class ConflictError extends TaskError {
  action: ActionView
  constructor(action: ActionView) {
    const last = action.history.at(-1)
    super(`${last ? `${last.by} changed this item` : 'this item changed'} after you read it (it is at revision ${action.rev} now), so nothing was saved. Look at it as it stands and send the change again if it still applies.`)
    this.action = action
  }
}

// "cancelled" is the same word, and agents and people spell it both ways.
export const statusOf = (v: unknown) => (v === 'cancelled' ? 'canceled' : v)

// Crew-owned work lands in "on us"; anything else waits on them, unless the caller says otherwise.
export function laneFor(lib: Library, owner: string, lane?: string): 'us' | 'them' {
  if (lane === 'us' || lane === 'them') return lane
  return lib.people.mentionsCrew(owner) || /^(team|all|we|us)\b/i.test(owner) ? 'us' : 'them'
}

// Control characters add nothing to a task but can bloat the shared board (each is six bytes as JSON).
const clean = (s: string) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')

// The board is shared and read by agents, so like the notebook it never takes a credential.
function noSecrets(s: string) {
  const found = findSecrets(s)
  if (found.length) throw new TaskError(`refused: this looks like it contains a credential (${found.join(', ')}). Remove it and try again; the board never stores secrets.`)
}

// Free text for the board: undefined leaves the field alone, null or empty clears it.
function textOf(v: unknown, name: string, max: number): string | null | undefined {
  if (v === undefined || v === null) return v
  if (typeof v !== 'string') throw new TaskError(`${name} must be text (or empty to clear it)`)
  // checked as it would be saved, so a control character inside a token can't hide it
  const t = clean(v).trim()
  if (t.length > max) throw new TaskError(`${name} is limited to ${max} characters`)
  noSecrets(t)
  return t
}

const SOURCE = 'each source is { meeting_id, at? } for a moment in a meeting, { note_id } for a notebook note, or { ref } for a short pointer to something outside the archive'

// A pointer to something the archive doesn't hold ("vendor's email of Nov 3"): enough to find it again, never its text.
function pointer(v: string) {
  const ref = clean(v).replace(/\s+/g, ' ').trim()
  if (!ref) throw new TaskError(SOURCE)
  if (ref.length > LIMITS.ref) throw new TaskError(`a source ref is a short pointer (at most ${LIMITS.ref} characters), not the text itself`)
  noSecrets(ref)
  return ref
}

function sourcesOf(lib: Library, v: unknown, noteOk?: (id: string) => boolean): Source[] | undefined {
  if (v === undefined) return undefined
  if (v === null) return []
  if (!Array.isArray(v)) throw new TaskError(`sources must be a list: ${SOURCE}`)
  if (v.length > LIMITS.sources) throw new TaskError(`at most ${LIMITS.sources} sources per change`)
  return v.map((raw): Source => {
    if (typeof raw === 'string') return { ref: pointer(raw) }
    if (!raw || typeof raw !== 'object') throw new TaskError(SOURCE)
    const r = raw as Record<string, unknown>
    const meeting = r.meeting_id ?? r.meetingId ?? r.meeting
    const note = r.note_id ?? r.noteId ?? r.note
    if (meeting !== undefined && meeting !== null) {
      const m = typeof meeting === 'string' ? lib.byId.get(meeting) : undefined
      if (!m) throw new TaskError(`no meeting with id ${String(meeting)}`)
      if (r.at === undefined || r.at === null || r.at === '') return { meeting: m.id }
      const at = typeof r.at === 'number' ? r.at : typeof r.at !== 'string' ? undefined : /^\s*\d+(\.\d+)?\s*$/.test(r.at) ? Number(r.at) : parseTime(r.at, m.timeBase === 'clock')
      if (at === undefined || !Number.isFinite(at) || at < 0) throw new TaskError(`"${String(r.at)}" isn't a time in that meeting; use seconds or a timestamp such as 12:34`)
      return { meeting: m.id, at: Math.floor(at) }
    }
    if (note !== undefined && note !== null) {
      if (typeof note !== 'string' || !noteOk?.(note)) throw new TaskError(`no notebook note with id ${String(note)}`)
      return { note }
    }
    if (typeof r.ref === 'string') return { ref: pointer(r.ref) }
    throw new TaskError(SOURCE)
  })
}

// Whether `from` waits, directly or through other items, on `to`.
function waitsOn(store: Store, from: string, to: string, seen = new Set<string>()): boolean {
  if (from === to) return true
  if (seen.has(from)) return false
  seen.add(from)
  return (store.state.actions[from]?.hold?.after ?? []).some((next) => waitsOn(store, next, to, seen))
}

function afterOf(store: Store, list: ActionView[], id: string, v: unknown): string[] | undefined {
  if (v === undefined) return undefined
  if (v === null) return []
  const ids = typeof v === 'string' ? [v] : v
  if (!Array.isArray(ids) || ids.some((x) => typeof x !== 'string')) throw new TaskError('the items it waits on must be a list of action item ids')
  const out = [...new Set((ids as string[]).map((x) => canonical(store, x)))]
  if (out.length > LIMITS.after) throw new TaskError(`an item can wait on at most ${LIMITS.after} others`)
  for (const dep of out) {
    if (dep === id) throw new TaskError("an item can't wait on itself")
    if (!list.some((a) => a.id === dep)) throw new TaskError(`no action item with id ${dep}`)
    if (waitsOn(store, dep, id)) throw new TaskError(`that would go in a circle: ${dep} already waits on this item`)
  }
  return out
}

// Everything a caller may change about an item. The JSON API takes these names; the MCP tool maps its own onto them.
export type Patch = {
  status?: unknown
  done?: unknown
  reason?: unknown
  note?: unknown
  hold?: unknown
  blockedBy?: unknown
  evidence?: unknown
  sources?: unknown
  notFound?: unknown
  replacedBy?: unknown
  text?: unknown
  owner?: unknown
  undo?: unknown
  rev?: unknown
}

// changed: false when the item already looked like that, so callers can skip telling everyone; did says what
// the change amounted to ("done", "note", "hold"…). `done` is the older way to set the status: true means
// "done", false means "open". `rev` is the revision the caller last saw: when the item has moved on since,
// nothing is saved and ConflictError carries the item as it stands.
export async function updateAction(lib: Library, store: Store, rawId: string, patch: Patch, by: string, opts: { noteOk?: (id: string) => boolean } = {}) {
  const id = canonical(store, rawId)
  const list = allActions(lib, store)
  const exists = list.find((a) => a.id === id)
  if (patch.rev !== undefined && patch.rev !== null && !(typeof patch.rev === 'number' && Number.isInteger(patch.rev) && patch.rev >= 0)) throw new TaskError('the revision must be the whole number the item came with')
  const rev = typeof patch.rev === 'number' ? patch.rev : undefined
  const result = (did: string[]) => {
    const action = findAction(lib, store, id)
    // a delete of the same task finished while this change was being saved, and took the change to the trash with it
    if (!action) throw new TaskError('that task was deleted while this change was being saved; it is under Recently deleted on the board, with the change, and an undo brings it back')
    return { action, changed: did.length > 0, did }
  }
  const guarded = async (run: () => Promise<string[]>) => {
    try {
      return result(await run())
    } catch (err) {
      if (err instanceof StaleError) throw new ConflictError(findAction(lib, store, id)!)
      throw err
    }
  }

  if (patch.undo !== undefined && patch.undo !== null && patch.undo !== false) {
    if (patch.undo !== true) throw new TaskError('undo must be true')
    const { undo: _, rev: __, ...rest } = patch
    if (Object.values(rest).some((v) => v !== undefined)) throw new TaskError('undo goes alone: it takes back the last change to the item')
    if (!exists) {
      // a deleted task comes back with everything the board held for it
      if (!store.state.trash.some((t) => t.task.id === id)) throw new TaskError(`no action item with id ${rawId}`)
      if (store.state.tasks.length >= LIMITS.tasks) throw new TaskError(`the board holds at most ${LIMITS.tasks} added tasks`)
      await store.restoreTask(id, by)
      return result(['restored'])
    }
    const s = store.state.actions[id]
    // a second undo, or a restore retried after its answer was lost, would take back a change made before the delete
    if (s && trailOf(s).at(-1)?.did === 'restored') throw new TaskError('that task is already back on the board, and nothing has changed on it since it was restored, so there is nothing to undo')
    if (!s?.prev) throw new TaskError('nothing to undo on this item')
    // the step it goes back to can hold a wait that would now go in a circle, which a direct change is refused
    const loop = (s.prev.hold?.after ?? []).find((dep) => waitsOn(store, dep, id))
    if (loop) throw new TaskError(`that undo would go in a circle: it would make this item wait on ${loop} again, and ${loop} now waits on this item, so nothing was changed`)
    return guarded(() => store.change(id, { undo: true }, by, rev))
  }
  if (!exists) throw new TaskError(`no action item with id ${rawId}`)

  const wanted = statusOf(patch.status) as Status | undefined
  if (wanted !== undefined && !STATUSES.includes(wanted)) throw new TaskError('status must be "open", "done" or "canceled"')
  if (patch.done !== undefined && typeof patch.done !== 'boolean') throw new TaskError('done must be true or false')
  if (wanted !== undefined && patch.done !== undefined && patch.done !== (wanted === 'done')) throw new TaskError('status and done disagree; pass only status')
  const status = wanted ?? (patch.done === undefined ? undefined : patch.done ? 'done' : 'open')
  // where this change leaves the item
  const ends = status ?? exists.status

  const reason = textOf(patch.reason, 'the reason', LIMITS.reason)
  if (reason && ends !== 'canceled') throw new TaskError('a reason goes with status "canceled"; use note for anything else')
  const note = textOf(patch.note, 'the note', LIMITS.note)

  const hold = textOf(patch.hold, 'what it waits on', LIMITS.hold)
  const after = afterOf(store, list, id, patch.blockedBy)
  if ((hold || after?.length) && ends !== 'open') throw new TaskError('only an open item can be on hold; reopen it first')

  const notFound = textOf(patch.notFound, 'what was checked', LIMITS.evidence) || undefined
  if (notFound && (ends !== exists.status || reason || patch.evidence || patch.replacedBy)) {
    throw new TaskError('a check that found nothing leaves the status as it is, so it goes without status, reason, evidence or a replacement; say where you looked in sources')
  }
  const evidence = textOf(patch.evidence, 'the evidence', LIMITS.evidence)
  const sources = sourcesOf(lib, patch.sources, opts.noteOk)
  if ((evidence || sources?.length) && ends === 'open' && ends === exists.status && !notFound) {
    throw new TaskError('evidence and sources say why an item was marked done or canceled, reopened, or checked without a result; use note for anything else')
  }

  let replacedBy: string | null | undefined
  if (patch.replacedBy === null || patch.replacedBy === '') replacedBy = null
  else if (patch.replacedBy !== undefined) {
    const other = typeof patch.replacedBy === 'string' ? canonical(store, patch.replacedBy) : ''
    const stands = list.find((a) => a.id === other)
    if (!stands) throw new TaskError(`no action item with id ${String(patch.replacedBy)}`)
    if (other === id) throw new TaskError("an item can't replace itself")
    if (ends !== 'canceled') throw new TaskError('a replacement goes with status "canceled": cancel the duplicate or outdated item and point it at the one that stands')
    // two duplicates each canceled as replaced by the other would leave nothing standing
    if (stands.status === 'canceled') throw new TaskError(`${other} is canceled too, so it can't stand in for this item; point the replacement at the item that stands`)
    replacedBy = other
  }

  // a correction that matches what the notes or the task say is no correction
  const base = exists.original ?? exists
  let text = textOf(patch.text, 'the wording', LIMITS.text)
  if (text === base.text) text = ''
  let owner = textOf(patch.owner, 'the owner', LIMITS.owner)
  if (owner === base.owner) owner = ''

  return guarded(() => store.change(id, { status, reason, note, hold, after, evidence, sources, notFound, replacedBy, text, owner }, by, rev))
}

export async function addAction(lib: Library, store: Store, input: { text?: unknown; owner?: unknown; lane?: unknown; meetingId?: unknown }, by: string) {
  const text = typeof input.text === 'string' ? clean(input.text).trim() : ''
  const owner = typeof input.owner === 'string' ? clean(input.owner).trim() : ''
  if (!text) throw new TaskError('text is required')
  if (text.length > LIMITS.text) throw new TaskError(`task text is limited to ${LIMITS.text} characters`)
  if (!owner) throw new TaskError('owner is required (a name, names joined with "/", or "Team")')
  if (owner.length > LIMITS.owner) throw new TaskError(`owner is limited to ${LIMITS.owner} characters`)
  noSecrets(`${text}\n${owner}`)
  let meetingId: string | undefined
  if (input.meetingId !== undefined && input.meetingId !== null && input.meetingId !== '') {
    const m = typeof input.meetingId === 'string' ? lib.byId.get(input.meetingId) : undefined
    if (!m) throw new TaskError(`no meeting with id ${String(input.meetingId)}`)
    meetingId = m.id
  }
  if (store.state.tasks.length >= LIMITS.tasks) throw new TaskError(`the board holds at most ${LIMITS.tasks} added tasks; delete some first`)
  if (!store.room(by)) throw new TaskError(`${by} already has ${LIMITS.tasksEach} added tasks on the board, the most one name may hold; delete some first`)
  const task = await store.addTask({ text, owner, lane: laneFor(lib, owner, typeof input.lane === 'string' ? input.lane : undefined), meetingId }, by)
  return allActions(lib, store).find((a) => a.id === task.id)!
}

// Only added tasks can be deleted, and a deleted one can be brought back (updateAction with undo).
export async function removeAction(lib: Library, store: Store, id: string, by: string) {
  const a = findAction(lib, store, id)
  if (!a) throw new TaskError(`no action item with id ${id}`)
  if (a.source !== 'added') throw new TaskError('items from meeting notes cannot be deleted; mark them done or canceled instead')
  await store.deleteTask(a.id, by)
  return a
}

// What everyone watching the board is told about a change: the item as it now stands and what was done to it.
export type BoardEvent = { kind: 'action' | 'task-added' | 'task-deleted'; id: string; text: string; by: string; did?: string[] } & Partial<Pick<ActionView, 'status' | 'done' | 'canceled' | 'note' | 'hold' | 'rev'>>
export const actionEvent = (a: ActionView, did: string[], by: string): BoardEvent => ({ kind: 'action', id: a.id, text: a.text, did, status: a.status, done: a.done, canceled: a.canceled, note: a.note, hold: a.hold, rev: a.rev, by })

// Keeps reworded notes items answering to the id they always had. Run whenever the library is rebuilt,
// before anything reads the board. Resolves to how many items were relinked, once that is saved.
export const reconcile = (lib: Library, store: Store) => store.reconcile(lib.meetings.flatMap((m) => m.actions.map((a) => ({ id: a.id, meeting: m.id, date: m.date, text: a.text }))))
