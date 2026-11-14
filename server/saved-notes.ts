// Notes an agent saves for a meeting (the save_notes tool). They are checked before anything is kept, then placed
// beside the recording when the meeting has none, or put in place of its notes file in one step once the rev the
// agent read matches the file as it is now, so a newer edit by hand is never lost. Every version of a notes file
// the tool touched is kept in DATA_DIR/notes-history with who saved it, when and why, so undo can put the one
// before back and the pages can say who saved the notes. Only a notes file is ever written: never a transcript.
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, readdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { classify, NOFOLLOW, openScanned, StaleFile, type FileEntry, type Library, type Meeting } from './library.ts'
import { findSecrets } from './notebook.ts'
import { actionsOf, isHeading, parseNotes, topicsOf, type Notes } from './notes.ts'
import { syncFolder } from './persistence.ts'
import { placeBeside } from './place.ts'
import { TaskError } from './tasks.ts'
import { findRanges, fmtTime, localDay, normName, parseLongDate, shortHash, stripExt } from './text.ts'

// A long meeting's notes run to 20,000 characters; five times that is not notes.
export const NOTES_MAX = 100_000
const REASON_MAX = 200
// saves through the tool kept for each notes file, and versions taken back by undo
const KEEP = 20
// the line the server sets in the header on each save: "Saved by Ada's agent on 2026-11-14."
const SAVED_LINE = /^Saved by .{1,120} on \d{4}-\d{2}-\d{2}\.$/

// A version of a notes file: its text (null: there was no file), and who saved it through the tool, when and why
// (none for a version written by hand). size and mtimeMs: the file as that save left it, so a page can tell
// whether the notes are still that version without reading them.
type Version = { text: string | null; rev: string; by?: string; at?: string; reason?: string; size?: number; mtimeMs?: number }
type History = { file: string; versions: Version[]; undone: (Version & { undoneBy: string; undoneAt: string })[] }

// The versions a history keeps: the newest KEEP, and every version the tool did not write. Notes a person wrote are
// in no other place once a save replaces them (the copy of the folder is brought up to date too), so however many
// saves come after, they stay.
const keep = (versions: Version[]) => versions.filter((v, i) => !v.by || i >= versions.length - KEEP)

export type Saved = { by: string; at: string; reason?: string }
export type SaveResult = { file: string; rev: string | null; created: boolean; removed?: boolean; topics: number; actionItems: number; titleKept?: string }

export const notesRev = (text: string) => shortHash(text, 12)

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const longDate = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}, ${iso.slice(0, 4)}`

// The file to put new notes beside, and their name: the recording the player plays, else the transcript.
function newNotesFile(m: Meeting): { beside: FileEntry; name: string } | undefined {
  const shown = m.videos.find((v) => v.isDefault) ?? m.videos[0]
  const recording = shown && m.files.find((f) => f.id === shown.fileId)
  const transcript = m.files.find((f) => f.kind === 'transcript')
  const beside = recording ?? transcript
  if (!beside) return
  const stem = stripExt(beside.name).replace(/\s*-?\s*transcript$/i, '')
  return { beside, name: `${stem} - notes.txt` }
}

// Names the archive groups files by: a notes file that names another meeting's recording or transcript near its
// top would take that file over.
const othersNames = (lib: Library, m: Meeting) =>
  lib.meetings.filter((x) => x !== m).flatMap((x) => x.files.filter((f) => f.kind === 'video' || f.kind === 'audio' || f.kind === 'transcript').map((f) => f.name))

// The notes as they will be kept, or a refusal that says what to change. The title line stays the meeting's own,
// and the header gets the server's line saying who saved them and when, in place of any earlier one. kept: the
// lines of the notes being replaced, whose times are the writer's own and are not held against the agent.
export function checkNotes(raw: string, m: Meeting, by: string, day: string, others: string[] = [], kept: string[] = []): { text: string; notes: Notes; titleKept?: string } {
  const lines = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').normalize('NFC').split('\n').map((l) => l.replace(/\s+$/, ''))
  while (lines.length && !lines[0].trim()) lines.shift()
  while (lines.length && !lines.at(-1)!.trim()) lines.pop()
  if (!/^MEETING NOTES:/.test(lines[0] ?? '')) throw new TaskError('notes start with the line "MEETING NOTES: <title>"; nothing was saved')
  const whole = lines.join('\n')
  if (whole.length > NOTES_MAX) throw new TaskError(`notes are at most ${NOTES_MAX.toLocaleString('en-US')} characters, and these run to ${whole.length.toLocaleString('en-US')}`)
  const secrets = findSecrets(whole)
  if (secrets.length) throw new TaskError(`refused: the notes look like they contain a credential (${secrets.join(', ')}). Take it out and save again; notes never hold secrets`)
  const asked = lines[0].replace(/^MEETING NOTES:\s*/, '').trim()
  const first = lines.findIndex((l, i) => i > 0 && isHeading(l.trim()))
  if (first < 0) throw new TaskError('the notes have no sections: after the header come SUMMARY, sections of numbered topics, ACTION ITEMS and UNCERTAINTIES, each heading on its own line in capitals')
  const header = lines.slice(1, first).filter((l) => !SAVED_LINE.test(l.trim()))
  while (header.length && !header[0].trim()) header.shift()
  while (header.length && !header.at(-1)!.trim()) header.pop()
  const date = longDate(m.date)
  // the line after the title (a "Kind:" line may come first) gives the date, which is the meeting's own
  if (parseLongDate(header.find((l) => !/^\s*kind\s*:/i.test(l)) ?? '') !== m.date) {
    throw new TaskError(`the second line gives the meeting's date and length, as "${date} | Recording: ${fmtTime(m.duration ?? m.axis[1] - m.axis[0], false)} | Substantive discussion approximately <start>–<end>"`)
  }
  const text = [`MEETING NOTES: ${m.title}`, ...header, `Saved by ${by} on ${day}.`, '', ...lines.slice(first), ''].join('\n')
  const notes = parseNotes(text)
  if (notes.timeBase !== m.timeBase) {
    throw new TaskError(m.timeBase === 'clock'
      ? "this meeting's transcript runs on a wall clock: give times as HH:MM:SS from it, and say in the header that they are clock timestamps, not elapsed recording offsets"
      : "this meeting's times count from the start of the recording, and the notes call theirs clock times; give them as m:ss from the transcript and leave out words about a clock")
  }
  const summary = notes.sections.find((s) => s.role === 'summary')
  if (!summary?.blocks.some((b) => ('text' in b ? b.text : b.title).trim())) throw new TaskError('the notes need a SUMMARY section with a few sentences in it')
  if (!topicsOf(notes).some((t) => t.ranges.length)) throw new TaskError('the notes need at least one topic with its time, as "1. Holiday blend (0:15–0:52)" under a section in capitals')
  // Every time is a moment of this recording, except on a line the notes being replaced already have: a person's
  // notes can give the length of a longer original or a time on another clock, and an agent that leaves the line
  // as it was is not sent to change what they wrote.
  const clock = m.timeBase === 'clock'
  const [from, to] = m.axis
  if (!(to > from)) throw new TaskError("the recording's length isn't known yet (it is still being read); try again in a minute")
  const theirs = new Set(kept.map((l) => l.normalize('NFC').trim()).filter(Boolean))
  for (const line of text.split('\n').slice(1)) {
    if (theirs.has(line.trim())) continue
    for (const [s, e] of findRanges(line, clock)) {
      if (s >= from - 1 && e <= to + 5) continue
      const when = s === e ? fmtTime(s, clock) : `${fmtTime(s, clock)}–${fmtTime(e, clock)}`
      throw new TaskError(`${when} is outside the recording, which runs ${fmtTime(from, clock)}–${fmtTime(to, clock)}; take times from the transcript ("${line.trim().slice(0, 80)}")`)
    }
  }
  for (const a of actionsOf(notes)) {
    if (!a.owner) throw new TaskError(`each action item starts with its owner, as "- Ada: Send the price list. (1:10–1:25)", or "- Team: …" when nobody was named; this one has none: "${a.text.slice(0, 80)}"`)
  }
  const head = normName(text.slice(0, 4000))
  const named = others.find((n) => head.includes(normName(n)))
  if (named) throw new TaskError(`the notes name "${named}", a file of another meeting; the archive groups files by such names, so leave it out`)
  return { text, notes, ...(asked && asked !== m.title ? { titleKept: m.title } : {}) }
}

// Only a file the archive reads as notes is ever replaced. meetings-index.json can name any file as a meeting's
// notes, and one it names by mistake (the captions, a transcript, the recording) is never the tool's to write.
const readAsNotes = (file: FileEntry) => file.kind === 'notes'
const notTheirs = (file: FileEntry) =>
  new TaskError(`meetings-index.json gives "${file.name}" as this meeting's notes, and the archive does not read it as notes, so it is never written over; the index is put right by hand`)

export class SavedNotes {
  private dir: string
  private histories = new Map<string, History>() // notes file's path in the folder → its versions
  private queue: Promise<unknown> = Promise.resolve()

  constructor(dataDir: string) {
    this.dir = join(dataDir, 'notes-history')
  }

  async load() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    for (const name of await readdir(this.dir).catch(() => [] as string[])) {
      if (!name.endsWith('.json')) continue
      try {
        const h = JSON.parse(await readFile(join(this.dir, name), 'utf8')) as History
        if (typeof h?.file !== 'string' || !Array.isArray(h.versions)) throw new Error('not a notes history')
        this.histories.set(h.file, { file: h.file, versions: h.versions, undone: Array.isArray(h.undone) ? h.undone : [] })
      } catch (err) {
        // one damaged history loses only its own undo; the notes themselves are in the folder
        console.error(`notes history: left out ${name} (${(err as Error).message})`)
      }
    }
  }

  // Who saved the notes as they are now, when they are still the version the tool last put in place.
  saved(m: Meeting): Saved | undefined {
    const last = m.notesFile ? this.histories.get(m.notesFile.rel)?.versions.at(-1) : undefined
    if (!last?.by || !last.at || last.size !== m.notesFile!.size || last.mtimeMs !== m.notesFile!.mtimeMs) return
    return { by: last.by, at: last.at, ...(last.reason ? { reason: last.reason } : {}) }
  }

  // The notes file as it is at this moment, and its rev. A file swapped since the scan (saved by an editor, say)
  // is not read through: the agent is asked to read the meeting again.
  async read(file: FileEntry): Promise<{ text: string; rev: string; mode: number; size: number; mtimeMs: number }> {
    let fh
    try {
      fh = await openScanned(file)
    } catch (err) {
      if (err instanceof StaleFile) throw new TaskError('the notes file changed a moment ago; read the meeting again with get_meeting, then save')
      throw err
    }
    try {
      const text = (await fh.readFile()).toString('utf8')
      const s = await fh.stat()
      return { text, rev: notesRev(text), mode: s.mode & 0o777, size: s.size, mtimeMs: Math.round(s.mtimeMs) }
    } finally {
      await fh.close()
    }
  }

  // The rev of the notes the last scan read, which are the ones get_meeting shows: none while the file has changed
  // since (edited by hand a moment ago, say), so the rev an agent is given is always of the notes it was shown.
  async shownRev(file: FileEntry): Promise<string | undefined> {
    if (!readAsNotes(file)) return
    const now = await this.read(file).catch(() => undefined)
    return now && now.size === file.size && now.mtimeMs === file.mtimeMs ? now.rev : undefined
  }

  // Saves are made one at a time.
  private one<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work)
    this.queue = next.catch(() => {})
    return next
  }

  save(lib: Library, m: Meeting, input: { notes: string; ifRev?: unknown; reason?: unknown }, by: string, now = new Date()): Promise<SaveResult> {
    return this.one(async () => {
      const reason = cleanReason(input.reason)
      if (m.notesFile && !readAsNotes(m.notesFile)) throw notTheirs(m.notesFile)
      const current = m.notesFile ? await this.read(m.notesFile) : undefined
      // A refusal gives no rev: a rev comes only with the notes it is of, from get_meeting, so notes nobody has read
      // are never saved over.
      if (current) {
        if (input.ifRev === undefined || input.ifRev === null || input.ifRev === '') throw new TaskError('this meeting has notes already: read them with get_meeting and pass its notes_rev as if_rev')
        if (input.ifRev !== current.rev) throw new TaskError('the notes changed since you read them; read them again with get_meeting before saving')
      }
      const { text, notes, titleKept } = checkNotes(input.notes, m, by, localDay(now.getTime()), othersNames(lib, m), current?.text.split('\n'))
      const saved: Version = { text, rev: notesRev(text), by, at: now.toISOString(), ...(reason ? { reason } : {}) }
      const counts = { topics: topicsOf(notes).length, actionItems: actionsOf(notes).length, ...(titleKept ? { titleKept } : {}) }
      if (current) {
        const file = m.notesFile!
        const h = this.history(file.rel)
        // the version replaced is kept before anything changes, so it can't be lost
        if (h.versions.at(-1)?.rev !== current.rev) h.versions.push({ text: current.text, rev: current.rev })
        h.versions.push(saved)
        await this.store(h)
        try {
          await this.replace(file, text, current)
        } catch (err) {
          // not saved after all: the history says so too
          h.versions.pop()
          await this.store(h)
          throw err
        }
        Object.assign(saved, await this.left(file.path))
        await this.store(h)
        return { file: file.name, rev: saved.rev, created: false, ...counts }
      }
      // a meeting the index lists has the files the index gives it; a new notes file would be a meeting of its own
      if (m.fromIndex) throw new TaskError('meetings-index.json lists this meeting and says which files are its, so notes for it are added to the index by hand')
      const place = newNotesFile(m)
      if (!place) throw new TaskError('this meeting has no recording or transcript to put notes beside')
      if (classify(place.name) !== 'notes' || Buffer.byteLength(place.name) > 240) throw new TaskError(`notes for this recording would be called "${place.name}", which the archive can't take as notes; rename the recording`)
      const placed = await placeBeside(place.beside, [{ name: place.name, text }])
      if (!placed.length) throw new TaskError(`a file called "${place.name}" is already beside the recording and is not this meeting's notes; it is never written over`)
      const path = join(dirname(place.beside.path), place.name)
      const h = this.history(place.beside.rel.slice(0, place.beside.rel.length - place.beside.name.length) + place.name)
      if (h.versions.at(-1)?.text !== null) h.versions.push({ text: null, rev: '' })
      h.versions.push({ ...saved, ...(await this.left(path)) })
      await this.store(h)
      return { file: place.name, rev: saved.rev, created: true, ...counts }
    })
  }

  // Puts back the version before the last save through the tool: the earlier notes, or no notes file at all when
  // that save made it. Only while the notes are still what that save left.
  undo(m: Meeting, by: string, now = new Date()): Promise<SaveResult> {
    return this.one(async () => {
      const file = m.notesFile
      const h = file ? this.histories.get(file.rel) : undefined
      const last = h?.versions.at(-1)
      const before = h?.versions.at(-2)
      if (!file || !h || !last?.by || !before) throw new TaskError('no save through save_notes is left to undo for this meeting')
      if (!readAsNotes(file)) throw notTheirs(file)
      const current = await this.read(file)
      if (current.rev !== last.rev) throw new TaskError('the notes changed after the last save through save_notes (by hand, or another way), so undo leaves them as they are')
      const undone = h.undone
      h.versions.pop()
      h.undone = [...undone, { ...last, undoneBy: by, undoneAt: now.toISOString() }].slice(-KEEP)
      await this.store(h)
      try {
        if (before.text === null) await this.remove(file, current)
        else await this.replace(file, before.text, current)
      } catch (err) {
        // not undone after all: the history says so too, so the undo can be tried again
        h.versions.push(last)
        h.undone = undone
        await this.store(h)
        throw err
      }
      if (before.text === null) return { file: file.name, rev: null, created: false, removed: true, topics: 0, actionItems: 0 }
      Object.assign(before, await this.left(file.path))
      await this.store(h)
      const notes = parseNotes(before.text)
      return { file: file.name, rev: before.rev, created: false, topics: topicsOf(notes).length, actionItems: actionsOf(notes).length }
    })
  }

  private history(rel: string): History {
    let h = this.histories.get(rel)
    if (!h) this.histories.set(rel, (h = { file: rel, versions: [], undone: [] }))
    return h
  }

  private async store(h: History) {
    h.versions = keep(h.versions)
    const path = join(this.dir, `${shortHash(h.file, 16)}.json`)
    await writeFile(`${path}.tmp`, JSON.stringify(h), { mode: 0o600 })
    await rename(`${path}.tmp`, path)
  }

  // the file as a save or an undo left it
  private async left(path: string) {
    const s = await lstat(path)
    return { size: s.size, mtimeMs: Math.round(s.mtimeMs) }
  }

  // The notes file replaced in one step: the new text written whole under a hidden name beside it, then renamed
  // over it, once the file is still the version the check was made on.
  private async replace(file: FileEntry, text: string, current: { rev: string; mode: number }) {
    const tmp = join(dirname(file.path), `.${randomUUID()}.writing`)
    const fh = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600)
    try {
      try {
        await fh.writeFile(text)
        await fh.sync()
      } finally {
        await fh.close()
      }
      await chmod(tmp, current.mode)
      if ((await this.read(file)).rev !== current.rev) throw new TaskError('the notes changed while they were being saved; read them again with get_meeting')
      await rename(tmp, file.path)
    } finally {
      await rm(tmp, { force: true }).catch(() => {})
    }
    await syncFolder(file.path)
  }

  // A notes file the tool made, taken out again by undo.
  private async remove(file: FileEntry, current: { rev: string }) {
    if ((await this.read(file)).rev !== current.rev) throw new TaskError('the notes changed while they were being taken back; read them again with get_meeting')
    await unlink(file.path)
    await syncFolder(file.path)
  }
}

function cleanReason(v: unknown): string | undefined {
  if (v === undefined || v === null || v === '') return
  if (typeof v !== 'string') throw new TaskError('reason is a short sentence of text')
  const r = v.replace(/\s+/g, ' ').trim()
  if (r.length > REASON_MAX) throw new TaskError(`reason is at most ${REASON_MAX} characters`)
  if (findSecrets(r).length) throw new TaskError('refused: the reason looks like it contains a credential')
  return r || undefined
}
