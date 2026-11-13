// Parser for the reviewed meeting notes (.txt): a "MEETING NOTES: title" line, a "date | Recording: mm:ss | ..."
// line, a few header paragraphs, then ALL-CAPS sections holding "1. Topic (02:18–04:28)" items and "- " bullets.
import { findRanges, normKind, parseLongDate, prettyHeading, type Range } from './text.ts'

// action: on a bullet of the action items, the id of the board item it is (set when the library is built)
export type Line = { text: string; ranges: Range[]; action?: string }
export type Item = { n: number; title: string; ranges: Range[]; bullets: Line[] }
export type Block = ({ kind: 'item' } & Item) | ({ kind: 'bullet' } & Line) | ({ kind: 'para' } & Line)
export type Role = 'summary' | 'actions' | 'next' | 'caveats' | 'source' | 'discussion'
export type Section = { heading: string; title: string; role: Role; blocks: Block[] }
export type Phase = { label: string; start: number; end: number }

export type Notes = {
  title: string
  date?: string
  // what sort of recording this is, from a "Kind: Demo" header line (normalised, see normKind)
  kind?: string
  meta: string[]
  intro: Line[]
  participants: string[]
  timeBase: 'offset' | 'clock'
  phases: Phase[]
  duration?: number
  sections: Section[]
}

const HEADING = /^[A-Z0-9][A-Z0-9 /,&()'’:;.+-]*[A-Z0-9)]$/

export const isHeading = (line: string) =>
  line.length <= 100 && HEADING.test(line) && /[A-Z]{3}/.test(line) && !/^\d+\.\s/.test(line)

function roleOf(heading: string): Role {
  if (/^(SUMMARY|OVERVIEW|TL;?DR)\b/.test(heading)) return 'summary'
  if (/^(ACTION ITEMS|ACTIONS|TO-?DOS?|FOLLOW-?UPS)\b/.test(heading)) return 'actions'
  if (/RECOMMENDED|NEXT STEPS/.test(heading)) return 'next'
  if (/UNCERTAINT|CAVEAT|OPEN QUESTIONS|RISKS/.test(heading)) return 'caveats'
  if (/^(SOURCE|TIMING|METHOD)/.test(heading)) return 'source'
  return 'discussion'
}

// "Owner text (02:42–03:30; 23:43–23:49)" → text without the trailing timestamp parenthetical, plus its ranges
function splitTrailingTimes(text: string, clock: boolean): Line {
  const m = /\s*\(([^()]*\d{1,2}:\d{2}[^()]*)\)\s*\.?$/.exec(text)
  if (m && /^[\d:.,;\s–—-]+$/.test(m[1])) return { text: text.slice(0, m.index).trim(), ranges: findRanges(m[1], clock) }
  return { text, ranges: findRanges(text, clock) }
}

// Clock wording first: clock-based notes say they are "NOT elapsed recording offsets".
function detectTimeBase(text: string): 'offset' | 'clock' {
  if (/clock timestamps|source-clock|original clock|not elapsed/i.test(text)) return 'clock'
  return 'offset'
}

// Names in the "Participants ...: A B, C D (Org); E F joins later." line, first sentence only.
export function participantsFrom(line: string): string[] {
  const afterColon = line.includes(':') ? line.slice(line.indexOf(':') + 1) : line
  const firstSentence = afterColon.split(/(?<=[a-z)])\.\s+(?=[A-Z])/)[0]
  const withoutAsides = firstSentence.replace(/\([^)]*\)/g, ' ')
  // \b is ASCII-only in JS, so bound names with letter lookarounds to keep "Núñez" whole
  const names = withoutAsides.match(/(?<!\p{L})\p{Lu}[\p{L}\p{M}'’-]+(?:\s+\p{Lu}[\p{L}\p{M}'’-]+){1,2}(?![\p{L}\p{M}])/gu) ?? []
  return [...new Set(names.filter((n) => !/^(The|An?|And|With|Participants?)\b/.test(n)))]
}

function phasesFrom(meta: string[], clock: boolean): { phases: Phase[]; duration?: number } {
  const phases: Phase[] = []
  let duration: number | undefined
  for (const part of meta) {
    for (const piece of part.split(/;\s*/)) {
      const ranges = findRanges(piece, clock)
      if (!ranges.length) continue
      const label = piece
        .slice(0, piece.search(/\d{1,2}:\d{2}/))
        .replace(/\b(approximately|approx\.?|about|at|from|in|~)\b/gi, ' ')
        .replace(/[:\s]+$/g, '')
        .replace(/\s+/g, ' ')
        .trim()
      const [start, end] = ranges[0]
      if (end > start) phases.push({ label: label ? label[0].toUpperCase() + label.slice(1) : 'Discussion', start, end })
      else if (/^recording$|duration|length/i.test(label)) duration = start
    }
  }
  return { phases, duration }
}

export function parseNotes(raw: string): Notes {
  raw = raw.normalize('NFC')
  const lines = raw.replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/\s+$/, ''))
  const timeBase = detectTimeBase(raw)
  const clock = timeBase === 'clock'

  let i = 0
  while (i < lines.length && !lines[i].trim()) i++
  const title = (lines[i] ?? '').replace(/^MEETING NOTES:\s*/i, '').trim() || 'Untitled meeting'
  i++
  // "Kind: Demo" among the header lines (before the first section) says what sort of recording this is.
  // It is taken out, so it is neither the date line nor an intro paragraph.
  let kind: string | undefined
  for (let k = i; k < lines.length; k++) {
    const m = /^\s*kind\s*:\s*(.*)$/i.exec(lines[k])
    if (m) {
      kind = normKind(m[1])
      lines.splice(k, 1)
      break
    }
    if (isHeading(lines[k].trim())) break
  }
  const metaLine = lines[i] && !isHeading(lines[i]) ? lines[i] : ''
  if (metaLine) i++
  const meta = metaLine.split(/\s+\|\s+/).map((s) => s.trim()).filter(Boolean)

  const intro: Line[] = []
  const sections: Section[] = []
  let section: Section | undefined
  let item: Item | undefined
  for (; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    if (isHeading(line)) {
      section = { heading: line, title: line, role: roleOf(line), blocks: [] }
      sections.push(section)
      item = undefined
      continue
    }
    const numbered = /^(\d{1,2})\.\s+(.*)$/.exec(line)
    const bullet = /^[-•*]\s+(.*)$/.exec(line)
    if (!section) {
      intro.push({ text: bullet ? bullet[1] : line, ranges: findRanges(line, clock) })
      continue
    }
    if (numbered) {
      const { text, ranges } = splitTrailingTimes(numbered[2], clock)
      item = { n: Number(numbered[1]), title: text, ranges, bullets: [] }
      section.blocks.push({ kind: 'item', ...item })
      continue
    }
    if (bullet) {
      const parsed = splitTrailingTimes(bullet[1], clock)
      if (item) (section.blocks[section.blocks.length - 1] as Item).bullets.push(parsed)
      else section.blocks.push({ kind: 'bullet', ...parsed })
      continue
    }
    item = undefined
    section.blocks.push({ kind: 'para', text: line, ranges: findRanges(line, clock) })
  }

  const body = lines.slice(1).filter((l) => l && !isHeading(l.trim())).join('\n')
  for (const s of sections) s.title = prettyHeading(s.heading, body)

  const participantsLine = intro.find((l) => /^Participants?\b/i.test(l.text))?.text ?? ''
  const { phases, duration } = phasesFrom(meta, clock)
  return {
    title,
    date: parseLongDate(metaLine) ?? parseLongDate(raw.slice(0, 400)),
    ...(kind ? { kind } : {}),
    meta,
    intro,
    participants: participantsFrom(participantsLine),
    timeBase,
    phases,
    duration,
    sections,
  }
}

export type Topic = { key: string; n?: number; title: string; group: string; ranges: Range[]; bullets: Line[] }

// Numbered discussion items become timeline topics; a discussion section with timed bullets but no
// numbered items (e.g. a separate debrief) becomes one topic of its own.
export function topicsOf(notes: Notes): Topic[] {
  const topics: Topic[] = []
  for (const s of notes.sections) {
    if (s.role !== 'discussion') continue
    const items = s.blocks.filter((b) => b.kind === 'item')
    if (items.length) {
      for (const b of items) topics.push({ key: `n${b.n}`, n: b.n, title: b.title, group: s.title, ranges: b.ranges, bullets: b.bullets })
      continue
    }
    const timed = s.blocks.filter((b) => b.kind !== 'item' && b.ranges.length) as Line[]
    if (timed.length) {
      topics.push({
        key: `s${notes.sections.indexOf(s)}`,
        title: s.title,
        group: s.title,
        ranges: timed.flatMap((b) => b.ranges),
        bullets: s.blocks.filter((b) => b.kind === 'bullet') as Line[],
      })
    }
  }
  return topics
}

export type ActionLine = { owner: string; text: string; ranges: Range[]; section: string; line: Line }

// "- Ada/Grace: Write the requirements... (02:18–02:39)" → owner "Ada/Grace"
export function actionsOf(notes: Notes): ActionLine[] {
  const out: ActionLine[] = []
  for (const s of notes.sections) {
    if (s.role !== 'actions') continue
    for (const b of s.blocks) {
      if (b.kind !== 'bullet') continue
      const m = /^([^:.]{2,70}):\s+(.+)$/.exec(b.text)
      out.push({ owner: m ? m[1].trim() : '', text: m ? m[2].trim() : b.text, ranges: b.ranges, section: s.title, line: b })
    }
  }
  return out
}
