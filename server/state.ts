// The little bit of shared, writable state: the board (which action items are done, canceled or on hold,
// the notes, evidence and trail on them, tasks added by hand or by an agent) and the video↔transcript clock
// sync someone confirmed for a wall-clock meeting. One JSON file, written atomically.
import { randomBytes } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { fields, is, isRecord, isString, itemOf, items, keyOf, maybe, mustFit, optional, PersistedJson, type Shape } from './persistence.ts'

export type Mark = { by: string; at: string }
// An item is open until someone marks it done or cancels it. Canceled means it stopped mattering (later
// meetings overtook it, say): it leaves the active list without anyone claiming the work was done.
export type Status = 'open' | 'done' | 'canceled'
export const STATUSES: Status[] = ['open', 'done', 'canceled']
// Where a claim comes from: a moment in a meeting, a notebook note, or a short pointer to something outside
// the archive ("vendor email, Nov 3"). A pointer, never the private text itself.
export type Source = { meeting?: string; at?: number; note?: string; ref?: string }
export type Proof = { evidence?: string; sources?: Source[] }
// One line of an item's trail: who did what, when, and on what grounds.
export type Entry = Mark & Proof & { did: string; text?: string }
type Kept = {
  done?: Mark & Proof
  canceled?: Mark & Proof & { reason?: string; replacedBy?: string }
  note?: Mark & { text: string }
  // parked: waiting on something said in words, and/or on other items finishing first
  hold?: Mark & { on?: string; after?: string[] }
  // someone looked for confirmation and found none; the status stays what it was
  checked?: Mark & { text: string; sources?: Source[] }
  // wording or owner corrected on the board (the notes keep what was written at the time)
  text?: string
  owner?: string
}
// rev counts changes so a stale edit can be refused; prev is the one step that undo goes back to
export type ActionState = Kept & { rev?: number; history?: Entry[]; prev?: Kept }
export type Change = {
  status?: Status
  reason?: string | null
  note?: string | null
  hold?: string | null
  after?: string[]
  evidence?: string | null
  sources?: Source[]
  notFound?: string
  replacedBy?: string | null
  text?: string | null
  owner?: string | null
  undo?: boolean
}
export type Task = {
  id: string
  text: string
  owner: string
  lane: 'us' | 'them'
  meetingId?: string
  createdBy: string
  createdAt: string
}
// What a notes item said when it was last seen, so it can be recognised after its wording changes.
export type Seen = { meeting: string; date: string; text: string }
export type State = {
  actions: Record<string, ActionState>
  tasks: Task[]
  // deleted tasks, kept so a mistaken delete can be undone
  trash: { task: Task; state?: ActionState; by: string; at: string }[]
  seen: Record<string, Seen>
  // the id a reworded notes item hashes to now → the id it has always answered to
  aliases: Record<string, string>
  sync: Record<string, Mark & { offset: number }>
  prefs: Record<string, { theme?: 'light' | 'dark' }>
}

const emptyState = (): State => ({ actions: {}, tasks: [], trash: [], seen: {}, aliases: {}, sync: {}, prefs: {} })

const str = is(isString)
const markFields = { by: str, at: str }
const sources = maybe(items(fields({ meeting: maybe(str), note: maybe(str), ref: maybe(str), at: maybe(is(Number.isFinite)) })))
const proofFields = { evidence: maybe(str), sources }
const keptFields = {
  done: maybe(fields({ ...markFields, ...proofFields })),
  canceled: maybe(fields({ ...markFields, ...proofFields, reason: maybe(str), replacedBy: maybe(str) })),
  note: maybe(fields({ ...markFields, text: str })),
  hold: maybe(fields({ ...markFields, on: maybe(str), after: maybe(items(str)) })),
  checked: maybe(fields({ ...markFields, text: str, sources })),
  text: maybe(str),
  owner: maybe(str),
}
const actionShape = fields({
  ...keptFields,
  prev: maybe(fields(keptFields)),
  rev: maybe(is((n) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0)),
  history: maybe(items(fields({ ...markFields, did: str, text: maybe(str), ...proofFields }))),
})
const taskShape = fields({ id: str, text: str, owner: str, lane: is((v) => v === 'us' || v === 'them'), meetingId: maybe(str), createdBy: str, createdAt: str })
const trashShape = fields({ ...markFields, task: taskShape, state: maybe(actionShape) })
const seenShape = fields({ meeting: str, date: str, text: str })
const syncShape = fields({ ...markFields, offset: is(Number.isFinite) })
const prefShape = fields({ theme: maybe(is((theme) => theme === 'light' || theme === 'dark')) })

// Each error names the record (its id or index) and the field that doesn't fit, so it can be found and fixed.
export function decodeState(value: unknown): State {
  const empty = emptyState()
  if (!isRecord(value) || (Object.keys(value).length > 0 && !Object.keys(empty).some((key) => Object.hasOwn(value, key)))) {
    throw new Error('expected a board object')
  }
  const saved = { ...empty, ...value }
  if (!isRecord(saved.actions)) throw new Error('invalid board actions')
  const actions = Object.fromEntries(Object.entries<unknown>(saved.actions).map(([id, raw]) => {
    let action = raw
    // The first format stored the completion flag and its attribution separately.
    if (isRecord(raw) && raw.done === true && isString(raw.by) && raw.by && optional(raw.at, isString)) {
      const { by, at, ...rest } = raw
      action = { ...rest, done: { by, at: at ?? new Date().toISOString() } }
    }
    mustFit(actionShape, action, `invalid board action record ${keyOf(id)}`)
    return [id, action as ActionState]
  }))
  if (!Array.isArray(saved.tasks)) throw new Error('invalid board tasks')
  saved.tasks.forEach((t, i) => mustFit(taskShape, t, `invalid board task ${itemOf(i, isRecord(t) && t.id)}`))
  if (!Array.isArray(saved.trash)) throw new Error('invalid board trash')
  saved.trash.forEach((e, i) => mustFit(trashShape, e, `invalid board trash entry ${itemOf(i, isRecord(e) && isRecord(e.task) && e.task.id)}`))
  const each = (records: unknown, shape: Shape, all: string, one: string) => {
    if (!isRecord(records)) throw new Error(`invalid board ${all}`)
    for (const [key, v] of Object.entries(records)) mustFit(shape, v, `invalid board ${one} ${keyOf(key)}`)
  }
  each(saved.seen, seenShape, 'seen records', 'seen record')
  each(saved.aliases, str, 'aliases', 'alias')
  each(saved.sync, syncShape, 'sync', 'sync')
  each(saved.prefs, prefShape, 'preferences', 'preference')
  return { ...saved, actions }
}

// tasksEach: the share of the added tasks one name may hold, so an agent in a loop can't fill the board for everyone
// sync: how far (in seconds) a confirmed clock sync may move a recording; a day is generous
export const LIMITS = { text: 600, note: 1000, reason: 300, owner: 80, tasks: 500, tasksEach: 200, hold: 300, evidence: 500, ref: 200, sources: 8, after: 10, history: 50, trash: 50, sync: 86_400 }

// Thrown when a change names the revision it was based on and the item has moved on since.
export class StaleError extends Error {}

const KEPT = ['done', 'canceled', 'note', 'hold', 'checked', 'text', 'owner'] as const
const kept = (a: ActionState): Kept => structuredClone(Object.fromEntries(KEPT.filter((k) => a[k] !== undefined).map((k) => [k, a[k]]))) as Kept
const statusOf = (a: Kept): Status => (a.canceled ? 'canceled' : a.done ? 'done' : 'open')
const proofOf = (p?: Proof): Proof => ({ ...(p?.evidence ? { evidence: p.evidence } : {}), ...(p?.sources?.length ? { sources: p.sources } : {}) })

// An item's trail. Marks made before trails were kept still tell who did what and when.
export const trailOf = (a: ActionState): Entry[] =>
  a.history ??
  [
    ...(a.done ? [{ at: a.done.at, by: a.done.by, did: 'done' }] : []),
    ...(a.canceled ? [{ at: a.canceled.at, by: a.canceled.by, did: 'canceled', ...(a.canceled.reason ? { text: a.canceled.reason } : {}) }] : []),
    ...(a.note ? [{ at: a.note.at, by: a.note.by, did: 'note', text: a.note.text }] : []),
  ].sort((x, y) => x.at.localeCompare(y.at))

// What a change did, read off the item before and after it, so the trail only says what really happened.
function entriesFor(was: Kept, now: Kept, proof: Proof): Omit<Entry, 'at' | 'by'>[] {
  const out: Omit<Entry, 'at' | 'by'>[] = []
  const status = statusOf(now)
  const mark = now.canceled ?? now.done
  if (status !== statusOf(was)) {
    out.push(status === 'open' ? { did: 'reopened', ...proof } : { did: status, ...(now.canceled?.reason ? { text: now.canceled.reason } : {}), ...proofOf(mark) })
  } else {
    if ((was.canceled?.reason ?? '') !== (now.canceled?.reason ?? '')) out.push({ did: 'reason', text: now.canceled?.reason ?? '' })
    if (!isDeepStrictEqual(proofOf(was.canceled ?? was.done), proofOf(mark))) out.push({ did: 'evidence', ...proofOf(mark) })
  }
  if (now.canceled && (was.canceled?.replacedBy ?? '') !== (now.canceled.replacedBy ?? '')) {
    out.push(now.canceled.replacedBy ? { did: 'linked', text: now.canceled.replacedBy } : { did: 'unlinked' })
  }
  if (!isDeepStrictEqual(was.note, now.note)) out.push(now.note ? { did: 'note', text: now.note.text } : { did: 'note-cleared' })
  if (!isDeepStrictEqual(was.hold, now.hold)) {
    const n = now.hold?.after?.length ?? 0
    if (now.hold) out.push({ did: 'hold', text: [now.hold.on, n ? `after ${n} other item${n === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ') })
    else if (status === 'open' && statusOf(was) === 'open') out.push({ did: 'released' })
  }
  if (now.checked && !isDeepStrictEqual(was.checked, now.checked)) out.push({ did: 'checked', text: now.checked.text, ...(now.checked.sources ? { sources: now.checked.sources } : {}) })
  if (was.text !== now.text || was.owner !== now.owner) out.push({ did: 'reworded', text: [now.owner, now.text].filter(Boolean).join(': ') })
  return out.length ? out : [{ did: 'edited' }]
}

// Small words say nothing about whether two wordings are the same item.
const SMALL = new Set('the a an and or to of for in on at by with from into about that this it its be is are was were will would should can as up then them their our we us you your'.split(' '))
const wordsOf = (s: string) => new Set((s.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []).filter((w) => !SMALL.has(w)))
// 1 when two wordings share all their words, 0 when they share none
export function alike(x: string, y: string) {
  const a = wordsOf(x)
  const b = wordsOf(y)
  let both = 0
  for (const w of a) if (b.has(w)) both++
  return both / Math.max(1, a.size + b.size - both)
}

export class Store {
  state: State = emptyState()
  private readonly file: PersistedJson

  constructor(path: string, onRecovered?: () => void) {
    this.file = new PersistedJson(path, 'state', onRecovered)
  }

  async load() {
    this.state = (await this.file.load(decodeState)) ?? emptyState()
  }

  // taken as the write starts, so a task change taken back after its save failed is never written
  private snapshot = () => JSON.stringify(this.state, null, 2)

  private save() {
    return this.file.save(this.snapshot)
  }

  // Adding, deleting and restoring a task are saved whole or not at all: when the save fails the change is taken
  // back, so the error means it did not happen and a retry doesn't do it twice.
  private commit<T>(apply: () => { value: T; undo?: () => void }) {
    return this.file.commit(apply, this.snapshot)
  }

  // Applies a change to one item and returns what it did ("done", "note", "hold"…), or nothing when the item
  // already looked like that. Checking off an item that's already done keeps the original mark, and so does
  // canceling one that's already canceled (a new reason or new evidence replaces the old). Every real change
  // adds to the trail, bumps the revision and remembers the step before it for undo. `expect` is the revision
  // the caller last saw: if the item has changed since, nothing is written and StaleError is thrown.
  async change(id: string, c: Change, by: string, expect?: number): Promise<string[]> {
    this.file.assertWritable()
    const at = new Date().toISOString()
    const old = this.state.actions[id] ?? {}
    const was = kept(old)
    let a = kept(old)
    const proof = proofOf({ evidence: c.evidence?.trim().slice(0, LIMITS.evidence), sources: c.sources?.slice(0, LIMITS.sources) })
    if (c.undo) {
      if (!old.prev) {
        await this.file.flush()
        return []
      }
      a = structuredClone(old.prev)
    } else {
      const before = statusOf(a)
      if (c.status === 'done' && !a.done) a.done = { by, at, ...proof }
      if (c.status === 'canceled' && !a.canceled) a.canceled = { by, at, ...proof }
      if (c.status && c.status !== 'done') delete a.done
      if (c.status && c.status !== 'canceled') delete a.canceled
      const moved = statusOf(a) !== before
      // a check that found nothing is about the status it was made under
      if (moved) delete a.checked
      const mark = a.canceled ?? a.done
      if (mark && !moved && !c.notFound) {
        if (c.evidence !== undefined) Object.assign(mark, { evidence: proof.evidence })
        if (c.sources !== undefined) Object.assign(mark, { sources: proof.sources })
        if (!mark.evidence) delete mark.evidence
        if (!mark.sources) delete mark.sources
      }
      if (a.canceled && c.reason !== undefined) {
        const reason = typeof c.reason === 'string' ? c.reason.trim().slice(0, LIMITS.reason) : ''
        if (reason) a.canceled.reason = reason
        else delete a.canceled.reason
      }
      if (a.canceled && c.replacedBy !== undefined) {
        if (c.replacedBy) a.canceled.replacedBy = c.replacedBy
        else delete a.canceled.replacedBy
      }
      const note = typeof c.note === 'string' ? c.note.trim().slice(0, LIMITS.note) : ''
      if (note && note !== a.note?.text) a.note = { text: note, by, at }
      else if (c.note === null || c.note === '') delete a.note
      if (c.hold !== undefined || c.after !== undefined) {
        // an empty hold lets go of everything, unless the same change names what to wait for
        const letGo = c.hold === null || c.hold === ''
        const on = typeof c.hold === 'string' ? c.hold.trim().slice(0, LIMITS.hold) : letGo ? '' : (a.hold?.on ?? '')
        const after = (c.after ?? (letGo ? [] : (a.hold?.after ?? []))).slice(0, LIMITS.after)
        if (!on && !after.length) delete a.hold
        else if (on !== (a.hold?.on ?? '') || !isDeepStrictEqual(after, a.hold?.after ?? [])) a.hold = { by, at, ...(on ? { on } : {}), ...(after.length ? { after } : {}) }
      }
      // only open work can be parked
      if (statusOf(a) !== 'open') delete a.hold
      const looked = c.notFound?.trim().slice(0, LIMITS.evidence)
      if (looked && !(a.checked?.text === looked && isDeepStrictEqual(a.checked.sources, proof.sources))) a.checked = { by, at, text: looked, ...(proof.sources ? { sources: proof.sources } : {}) }
      for (const k of ['text', 'owner'] as const) {
        if (c[k] === undefined) continue
        const v = (c[k] ?? '').trim().slice(0, LIMITS[k])
        if (v) a[k] = v
        else delete a[k]
      }
    }
    if (isDeepStrictEqual(was, a)) {
      await this.file.flush()
      return []
    }
    if (expect !== undefined && expect !== (old.rev ?? 0)) throw new StaleError()
    const trail = trailOf(old)
    // undoing an undo puts the change back
    const entries = c.undo ? [{ did: trail.at(-1)?.did === 'undone' ? 'redone' : 'undone' }] : entriesFor(was, a, proof)
    this.state.actions[id] = { ...a, rev: (old.rev ?? 0) + 1, history: [...trail, ...entries.map((e) => ({ at, by, ...e }))].slice(-LIMITS.history), prev: was }
    await this.save()
    return entries.map((e) => e.did)
  }

  // Returns whether anything changed.
  async setAction(id: string, patch: Change, by: string) {
    return (await this.change(id, patch, by)).length > 0
  }

  // How many added tasks `by` may still add: their own share, and room on the board as a whole.
  room(by: string) {
    const mine = this.state.tasks.filter((t) => t.createdBy === by).length
    return Math.max(0, Math.min(LIMITS.tasks - this.state.tasks.length, LIMITS.tasksEach - mine))
  }

  async addTask(t: { text: string; owner: string; lane: 'us' | 'them'; meetingId?: string }, by: string): Promise<Task> {
    return this.commit(() => {
      if (!this.room(by)) throw new Error(`no room for another task by ${by}`)
      const task: Task = {
        id: `t-${randomBytes(5).toString('hex')}`,
        text: t.text.trim().slice(0, LIMITS.text),
        owner: t.owner.trim().slice(0, LIMITS.owner),
        lane: t.lane,
        ...(t.meetingId ? { meetingId: t.meetingId } : {}),
        createdBy: by,
        createdAt: new Date().toISOString(),
      }
      this.state.tasks.push(task)
      return {
        value: task,
        undo: () => {
          this.state.tasks.splice(this.state.tasks.indexOf(task), 1)
          // anything written on it while it was being saved goes with it
          delete this.state.actions[task.id]
        },
      }
    })
  }

  // A deleted task goes to the trash with everything the board held for it, so restoreTask can bring it back.
  async deleteTask(id: string, by = '') {
    const deleted = await this.commit(() => {
      const i = this.state.tasks.findIndex((t) => t.id === id)
      if (i < 0) return { value: false }
      const trash = this.state.trash
      const [task] = this.state.tasks.splice(i, 1)
      const state = this.state.actions[id]
      delete this.state.actions[id]
      this.state.trash = [...trash, { task, ...(state ? { state } : {}), by, at: new Date().toISOString() }].slice(-LIMITS.trash)
      return {
        value: true,
        undo: () => {
          this.state.tasks.splice(i, 0, task)
          if (state) this.state.actions[id] = state
          this.state.trash = trash
        },
      }
    })
    // nothing to delete: an unchanged retry may still be waiting for an earlier change to reach disk
    if (!deleted) await this.file.flush()
    return deleted
  }

  async restoreTask(id: string, by: string): Promise<Task | undefined> {
    const restored = await this.commit(() => {
      const trash = this.state.trash
      const i = trash.findIndex((t) => t.task.id === id)
      if (i < 0) return { value: undefined }
      if (this.state.tasks.length >= LIMITS.tasks) throw new Error(`the board holds at most ${LIMITS.tasks} added tasks`)
      const { task, state = {} } = trash[i]
      this.state.trash = trash.filter((_, j) => j !== i)
      this.state.tasks.push(task)
      const before = this.state.actions[id]
      // it comes back with nothing to undo: the step it remembered would take back a change made before the delete
      const { prev: _, ...back } = state
      this.state.actions[id] = { ...back, rev: (state.rev ?? 0) + 1, history: [...trailOf(state), { at: new Date().toISOString(), by, did: 'restored' }].slice(-LIMITS.history) }
      return {
        value: task,
        undo: () => {
          this.state.tasks.splice(this.state.tasks.indexOf(task), 1)
          if (before) this.state.actions[id] = before
          else delete this.state.actions[id]
          this.state.trash = trash
        },
      }
    })
    if (!restored) await this.file.flush()
    return restored
  }

  // Action items from notes are named by a hash of their meeting and wording, so rewording one in the notes
  // (or renaming its meeting) would orphan everything the board holds for it. Every item is remembered by
  // what it said; when one vanishes and a new one much like it turns up in the same meeting, the new one
  // answers to the old id. `items` is every action item the notes produce right now, under its hash id.
  // Returns how many were relinked, once what it learned is saved (a failed save rejects, and the next
  // save writes it all).
  async reconcile(all: (Seen & { id: string })[]): Promise<number> {
    this.file.assertWritable()
    const { aliases, seen, actions } = this.state
    const before = JSON.stringify([aliases, seen])
    // ids are unique per meeting (a repeated wording is numbered), so this only guards against a hand-made list
    const items = [...new Map(all.map((i) => [i.id, i])).values()]
    const hashes = new Set(items.map((i) => i.id))
    // an alias steps aside when the id it borrowed is back in the notes under its own name
    for (const [from, to] of Object.entries(aliases)) if (hashes.has(to)) delete aliases[from]
    const named = (i: { id: string }) => aliases[i.id] ?? i.id
    const present = new Set(items.map(named))
    const meetings = new Set(items.map((i) => i.meeting))
    // new to the board: never seen, and nothing saved under its own id yet
    const fresh = items.filter((i) => !seen[named(i)] && !actions[i.id])
    const pairs: { id: string; item: Seen & { id: string }; score: number }[] = []
    for (const [id, was] of Object.entries(seen)) {
      if (present.has(id)) continue
      // same meeting, or the same day when the old meeting is gone (a renamed meeting gets a new id)
      const scored = fresh
        .filter((f) => f.meeting === was.meeting || (!meetings.has(was.meeting) && f.date === was.date))
        .map((f) => ({ id, item: f, score: alike(was.text, f.text), need: f.meeting === was.meeting ? 0.6 : 0.8 }))
        .sort((x, y) => y.score - x.score)
      const [best, next] = scored
      // a clear winner or nothing: carrying a status over to the wrong item is worse than losing it
      if (best && best.score >= best.need && (!next || best.score - next.score >= 0.15)) pairs.push(best)
    }
    const taken = new Set<string>()
    let relinked = 0
    for (const p of pairs.sort((x, y) => y.score - x.score)) {
      if (taken.has(p.item.id)) continue
      taken.add(p.item.id)
      for (const [from, to] of Object.entries(aliases)) if (to === p.id) delete aliases[from]
      aliases[p.item.id] = p.id
      relinked++
      const s = actions[p.id]
      if (s) actions[p.id] = { ...s, history: [...trailOf(s), { at: new Date().toISOString(), by: 'the notes', did: 'relinked', text: p.item.text }].slice(-LIMITS.history) }
    }
    for (const i of items) seen[named(i)] = { meeting: i.meeting, date: i.date, text: i.text }
    if (JSON.stringify([aliases, seen]) !== before) await this.save()
    else await this.file.flush()
    return relinked
  }

  async setTheme(name: string, theme: 'light' | 'dark') {
    this.file.assertWritable()
    this.state.prefs[name] = { ...this.state.prefs[name], theme }
    await this.save()
  }

  // formerly: the ids the meeting answered to before (its aliases); a sync saved under one moves to its id now
  async setSync(meetingId: string, offset: number | null, by: string, formerly: string[] = []) {
    this.file.assertWritable()
    if (offset !== null && !(Number.isFinite(offset) && Math.abs(offset) <= LIMITS.sync)) throw new Error(`a clock sync is at most ${LIMITS.sync} seconds either way`)
    for (const id of formerly) delete this.state.sync[id]
    if (offset === null) delete this.state.sync[meetingId]
    else this.state.sync[meetingId] = { offset, by, at: new Date().toISOString() }
    await this.save()
  }
}
