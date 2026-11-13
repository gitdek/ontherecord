// The shared notebook: research, decisions and context that the crew or their agents save so it sits
// next to the meetings. Notes are markdown, linked to meetings and action items, credited to whoever
// saved them, and keep their earlier versions. One JSON file, written atomically, never with secrets.
import { randomBytes } from 'node:crypto'
import { fields, is, isRecord, isString, itemOf, items, maybe, mustFit, PersistedJson } from './persistence.ts'

// An earlier version: what the note said, how it was tagged and linked, and who saved it when. The links are
// optional: versions saved before they were kept have none of their own.
export type Revision = { title: string; body: string; tags: string[]; meetingIds?: string[]; taskIds?: string[]; source?: string; by: string; at: string }
export type Note = {
  id: string
  title: string
  body: string
  tags: string[]
  meetingIds: string[]
  taskIds: string[]
  author: string
  source?: string
  createdAt: string
  updatedAt: string
  updatedBy: string
  revisions: Revision[]
  // counts changes, so an edit made on an older copy of the note can be refused (if_version)
  version?: number
  deleted?: { by: string; at: string }
  restored?: { by: string; at: string }
}

const str = is(isString)
const strings = items(str)
const markShape = fields({ by: str, at: str })
// an earlier version keeps the links it had (files written before that have none)
const revisionShape = fields({ by: str, at: str, title: str, body: str, tags: strings, meetingIds: maybe(strings), taskIds: maybe(strings), source: maybe(str) })
const noteShape = fields({
  id: str, title: str, body: str, tags: strings, meetingIds: strings, taskIds: strings, author: str,
  source: maybe(str), createdAt: str, updatedAt: str, updatedBy: str, revisions: items(revisionShape),
  deleted: maybe(markShape), restored: maybe(markShape), version: maybe(is((n) => typeof n === 'number' && Number.isSafeInteger(n) && n > 0)),
})

// An error names the note (its place in the list and its id) and the field that doesn't fit.
export function decodeNotes(value: unknown): Note[] {
  if (!isRecord(value) || !Array.isArray(value.notes)) throw new Error('expected a notebook with valid note records')
  value.notes.forEach((n, i) => mustFit(noteShape, n, `invalid note ${itemOf(i, isRecord(n) && n.id)}`))
  return value.notes as Note[]
}

// notes counts the notes in view; notesEach is the share of them one name may hold, so an agent in a loop can't
// fill the notebook for everyone; deleted is how many deleted notes stay restorable; chars is the most text the
// notes in view and their earlier versions keep, far below what one save can write (deleted notes give up their
// room when it is needed)
export const NOTE_LIMITS = { title: 200, body: 60_000, tags: 12, tag: 40, links: 30, source: 200, notes: 2000, notesEach: 800, deleted: 500, revisions: 20, chars: 64 * 2 ** 20 }

// The text a note keeps: its title and body and those of its earlier versions. Tags and links have limits of their own.
const charsOf = (n: { title: string; body: string; revisions: { title: string; body: string }[] }) =>
  n.revisions.reduce((sum, r) => sum + r.title.length + r.body.length, n.title.length + n.body.length)

export class NoteError extends Error {}

// The note changed after the caller read it. Carries the note as it stands, so the caller can look again.
export class NoteConflict extends NoteError {
  note: Note
  constructor(note: Note) {
    super(`${note.updatedBy} changed this note after you opened it (it is at version ${versionOf(note)} now), so nothing was saved. Look at it as it stands and save again if your change still applies.`)
    this.note = note
  }
}

// Notes saved before versions were counted start from the number of changes they remember.
export const versionOf = (n: Note) => n.version ?? n.revisions.length + 1

// Credentials that turn up in coding sessions. A note that contains one is refused outright.
const SECRETS: [string, RegExp][] = [
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['AWS access key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ['Stripe key', /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/],
  ['API key (sk-…)', /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35,}/],
  ['JSON web token', /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
  ['bearer token', /\bbearer\s+[A-Za-z0-9._~+/=-]{24,}/i],
  ['Cloudflare Access client secret', /CF-Access-Client-Secret\s*[:=]\s*[A-Za-z0-9]{20,}/i],
  // postgres://admin:…@host, redis://:…@host; a placeholder such as <password> or ${DB_PASSWORD} is no password
  ['password in a connection address', /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/?#@]*:(?![<${*])[^\s/?#@]+@/i],
  // GEMINI_API_KEY=…, "client_secret": "…", password: … (names may carry a prefix like GEMINI_)
  ['credential assignment', /[A-Za-z0-9_]*(?:api[_-]?key|secret|access[_-]?token|auth[_-]?token|password|passwd)\b["']?\s*[:=]\s*["']?[A-Za-z0-9/+_=.-]{16,}/i],
]

export function findSecrets(text: string): string[] {
  return SECRETS.filter(([, re]) => re.test(text)).map(([name]) => name)
}

const cleanTags = (tags: unknown): string[] => {
  if (tags === undefined || tags === null) return []
  if (!Array.isArray(tags)) throw new NoteError('tags must be a list of short words')
  const out = [...new Set(tags.map((t) => String(t).toLowerCase().trim().replace(/[^\p{L}\p{N} _-]+/gu, '').replace(/\s+/g, '-')).filter(Boolean))]
  if (out.length > NOTE_LIMITS.tags) throw new NoteError(`at most ${NOTE_LIMITS.tags} tags`)
  if (out.some((t) => t.length > NOTE_LIMITS.tag)) throw new NoteError(`tags are at most ${NOTE_LIMITS.tag} characters`)
  return out
}

const cleanIds = (ids: unknown, name: string, exists: (id: string) => string | undefined): string[] => {
  if (ids === undefined || ids === null) return []
  if (!Array.isArray(ids)) throw new NoteError(`${name} must be a list of ids`)
  if (ids.length > NOTE_LIMITS.links) throw new NoteError(`at most ${NOTE_LIMITS.links} ${name}`)
  return [
    ...new Set(
      ids.map((id) => {
        const real = typeof id === 'string' ? exists(id) : undefined
        if (!real) throw new NoteError(`unknown ${name.replace(/s$/, '')}: ${String(id).slice(0, 80)}`)
        return real
      }),
    ),
  ]
}

const text = (v: unknown, name: string, max: number, required: boolean) => {
  if (v === undefined || v === null) {
    if (required) throw new NoteError(`${name} is required`)
    return undefined
  }
  if (typeof v !== 'string') throw new NoteError(`${name} must be text`)
  const t = v.replace(/\r\n?/g, '\n').trim()
  if (required && !t) throw new NoteError(`${name} is required`)
  if (t.length > max) throw new NoteError(`${name} is limited to ${max.toLocaleString()} characters`)
  return t
}

export type Lookups = { meeting: (id: string) => string | undefined; task: (id: string) => string | undefined }
export type NoteInput = { title?: unknown; body?: unknown; append?: unknown; tags?: unknown; meetingIds?: unknown; taskIds?: unknown; source?: unknown; ifVersion?: unknown }

export class Notebook {
  notes: Note[] = []
  private readonly file: PersistedJson

  constructor(path: string) {
    this.file = new PersistedJson(path, 'notebook')
  }

  async load() {
    this.notes = (await this.file.load(decodeNotes)) ?? []
  }

  // Every change to the notebook is made once the saves before it have finished, and saved whole or not at all: a
  // failed save puts the notebook back as it was, so the error means it did not happen and a retry isn't saved twice.
  private commit<T>(apply: () => { value: T; undo: () => void }) {
    return this.file.commit(() => {
      const { value, undo } = apply()
      // a deleted note stays restorable until 500 newer deletions push it out, or the notes in view need its room
      const notes = this.notes
      const gone = notes.filter((n) => n.deleted).sort((a, b) => a.deleted!.at.localeCompare(b.deleted!.at))
      let chars = notes.reduce((sum, n) => sum + charsOf(n), 0)
      const drop = new Set<Note>()
      for (const n of gone) {
        if (gone.length - drop.size <= NOTE_LIMITS.deleted && chars <= NOTE_LIMITS.chars) break
        drop.add(n)
        chars -= charsOf(n)
      }
      if (drop.size) this.notes = notes.filter((n) => !drop.has(n))
      return {
        value,
        undo: () => {
          this.notes = notes
          undo()
        },
      }
    }, () => JSON.stringify({ notes: this.notes }, null, 1))
  }

  list({ deleted = false } = {}) {
    return this.notes.filter((n) => Boolean(n.deleted) === deleted).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  get(id: string) {
    return this.notes.find((n) => n.id === id && !n.deleted)
  }

  // Refuses a change that would take the text the notes in view keep past the most the notebook keeps.
  private room(more: number) {
    const used = this.notes.reduce((sum, n) => sum + (n.deleted ? 0 : charsOf(n)), 0)
    if (more > 0 && used + more > NOTE_LIMITS.chars) throw new NoteError(`the notebook is full: its notes and their earlier versions hold ${Math.round(NOTE_LIMITS.chars / 2 ** 20)} MB of text, the most it keeps. Delete notes nobody needs any more to make room`)
  }

  private guard(...parts: (string | undefined)[]) {
    const found = findSecrets(parts.filter(Boolean).join('\n'))
    if (found.length) throw new NoteError(`refused: this looks like it contains a credential (${found.join(', ')}). Remove it and save again; the notebook never stores secrets.`)
  }

  async create(input: NoteInput, by: string, look: Lookups): Promise<Note> {
    return this.commit(() => {
      const live = this.notes.filter((n) => !n.deleted)
      if (live.length >= NOTE_LIMITS.notes) throw new NoteError(`the notebook holds at most ${NOTE_LIMITS.notes} notes; delete some first`)
      if (live.filter((n) => n.author === by).length >= NOTE_LIMITS.notesEach) throw new NoteError(`${by} already has ${NOTE_LIMITS.notesEach} notes in the notebook, the most one name may hold; delete some first`)
      const title = text(input.title, 'title', NOTE_LIMITS.title, true)!
      const body = text(input.body, 'body', NOTE_LIMITS.body, true)!
      const source = text(input.source, 'source', NOTE_LIMITS.source, false)
      this.guard(title, body, source)
      this.room(title.length + body.length)
      const now = new Date().toISOString()
      const note: Note = {
        id: `n-${randomBytes(5).toString('hex')}`,
        title,
        body,
        tags: cleanTags(input.tags),
        meetingIds: cleanIds(input.meetingIds, 'meeting_ids', look.meeting),
        taskIds: cleanIds(input.taskIds, 'task_ids', look.task),
        author: by,
        ...(source ? { source } : {}),
        createdAt: now,
        updatedAt: now,
        updatedBy: by,
        revisions: [],
        version: 1,
      }
      this.notes.push(note)
      return { value: note, undo: () => void this.notes.splice(this.notes.indexOf(note), 1) }
    })
  }

  async update(id: string, input: NoteInput, by: string, look: Lookups): Promise<Note> {
    return this.commit(() => {
      const note = this.get(id)
      if (!note) throw new NoteError(`no note with id ${id}`)
      const version = versionOf(note)
      const title = text(input.title, 'title', NOTE_LIMITS.title, false)
      const body = text(input.body, 'body', NOTE_LIMITS.body, false)
      const append = text(input.append, 'append', NOTE_LIMITS.body, false)
      const source = text(input.source, 'source', NOTE_LIMITS.source, false)
      if (body !== undefined && append !== undefined) throw new NoteError('send either body (replace) or append (add to the end), not both')
      const nextBody = append !== undefined ? `${note.body}\n\n${append}` : (body ?? note.body)
      if (nextBody.length > NOTE_LIMITS.body) throw new NoteError(`the note would exceed ${NOTE_LIMITS.body.toLocaleString()} characters; start a new note`)
      this.guard(title, append ?? body, source)
      if (!title && body === undefined && append === undefined && input.tags === undefined && input.meetingIds === undefined && input.taskIds === undefined && source === undefined)
        throw new NoteError('nothing to change')
      // the version the editor started from: a change made on top of someone else's newer one is refused
      if (input.ifVersion !== undefined && input.ifVersion !== null) {
        if (!(typeof input.ifVersion === 'number' && Number.isInteger(input.ifVersion) && input.ifVersion > 0)) throw new NoteError('the version must be the whole number the note came with')
        if (input.ifVersion !== version) throw new NoteConflict(note)
      }
      // everything is checked before anything changes, so a refused edit leaves the note as it was
      const tags = input.tags !== undefined ? cleanTags(input.tags) : undefined
      const meetingIds = input.meetingIds !== undefined ? cleanIds(input.meetingIds, 'meeting_ids', look.meeting) : undefined
      const taskIds = input.taskIds !== undefined ? cleanIds(input.taskIds, 'task_ids', look.task) : undefined
      const revisions = [{ title: note.title, body: note.body, tags: note.tags, meetingIds: [...note.meetingIds], taskIds: [...note.taskIds], ...(note.source ? { source: note.source } : {}), by: note.updatedBy, at: note.updatedAt }, ...note.revisions].slice(0, NOTE_LIMITS.revisions)
      this.room(charsOf({ title: title || note.title, body: nextBody, revisions }) - charsOf(note))
      // every field is replaced, none changed in place, so the note as it was can be put back
      const was = { ...note }
      note.revisions = revisions
      if (title) note.title = title
      note.body = nextBody
      if (tags) note.tags = tags
      if (meetingIds) note.meetingIds = meetingIds
      if (taskIds) note.taskIds = taskIds
      if (source !== undefined) note.source = source || undefined
      note.updatedAt = new Date().toISOString()
      note.updatedBy = by
      note.version = version + 1
      return {
        value: note,
        undo: () => {
          for (const k of Object.keys(note) as (keyof Note)[]) if (!(k in was)) delete note[k]
          Object.assign(note, was)
        },
      }
    })
  }

  // Deleting only hides a note; it stays restorable from the web app until 500 newer deletions push it out.
  async remove(id: string, by: string) {
    return this.commit(() => {
      const note = this.get(id)
      if (!note) throw new NoteError(`no note with id ${id}`)
      note.deleted = { by, at: new Date().toISOString() }
      return { value: note, undo: () => void delete note.deleted }
    })
  }

  async restore(id: string, by: string) {
    return this.commit(() => {
      const note = this.notes.find((n) => n.id === id && n.deleted)
      if (!note) throw new NoteError(`no deleted note with id ${id}`)
      // deleting makes room, so bringing one back must not overfill the notebook
      if (this.notes.filter((n) => !n.deleted).length >= NOTE_LIMITS.notes) throw new NoteError(`the notebook holds at most ${NOTE_LIMITS.notes} notes; delete one before restoring another`)
      this.room(charsOf(note))
      const { deleted, restored } = note
      delete note.deleted
      note.restored = { by, at: new Date().toISOString() }
      return {
        value: note,
        undo: () => {
          note.deleted = deleted
          if (restored) note.restored = restored
          else delete note.restored
        },
      }
    })
  }
}
