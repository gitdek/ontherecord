// Everyone named in a notes "Participants" line, with the nicknames transcripts and owners use.
import { shortHash, slug } from './text.ts'

export type Person = {
  id: string
  name: string
  short: string
  crew: boolean
  hue: number
  meetings: string[]
  aliases: string[]
}

// Maps, not object literals: a first name like "Constructor" must not find Object's built-in properties.
// A few names people commonly go by. An archive adds its own, other spellings included, under "nicknames" in
// meetings-index.json (docs/finding-meetings.md). Every nickname is one word that is matched in running text,
// so a name that is also an ordinary word ("will", "rob") would count as a mention each time it is used.
const NICKNAMES = new Map<string, string[]>([
  ['joseph', ['joe', 'joey']],
  ['william', ['bill']],
  ['michael', ['mike']],
])
const SHORT = new Map([
  ['joseph', 'Joe'],
  ['william', 'Bill'],
  ['michael', 'Mike'],
])

// What an index file may add: { "sonja": ["sonia"] }. Anything else in it is left out.
export function nicknamesOf(listed: unknown): Map<string, string[]> {
  const out = new Map<string, string[]>()
  if (!listed || typeof listed !== 'object' || Array.isArray(listed)) return out
  const name = (v: unknown) => (typeof v === 'string' && /^\p{L}{2,30}$/u.test(v.trim()) ? v.trim().toLowerCase() : undefined)
  for (const [key, value] of Object.entries(listed).slice(0, 200)) {
    const formal = name(key)
    const nicks = [...new Set((Array.isArray(value) ? value : [value]).map(name))].filter((n): n is string => !!n && n !== formal).slice(0, 12)
    if (formal && nicks.length) out.set(formal, nicks)
  }
  return out
}

const hueOf = (name: string) => parseInt(shortHash(name, 6).replace(/[^0-9a-f]/gi, '').slice(0, 4) || '7', 16) % 360

export class People {
  byId = new Map<string, Person>()
  private alias = new Map<string, string | null>() // first name / nickname → person id (null when ambiguous)
  private crew: string[]
  private nicknames: Map<string, string[]>
  // a nickname → the name it is short for
  private formal: Map<string, string>

  constructor(crew: string[], nicknames: ReadonlyMap<string, string[]> = new Map()) {
    this.crew = crew
    this.nicknames = new Map(NICKNAMES)
    for (const [name, nicks] of nicknames) this.nicknames.set(name, [...new Set([...(this.nicknames.get(name) ?? []), ...nicks])])
    this.formal = new Map([...this.nicknames].flatMap(([name, nicks]) => nicks.map((n) => [n, name] as const)))
  }

  // Who a person is once a nickname is undone: "Bill Byron" in one meeting and "William Byron" in another are one person.
  private identity = (p: Person) => {
    const [first, ...rest] = p.id.split('-')
    return [this.formal.get(first) ?? first, ...rest].join('-')
  }

  add(fullName: string, meetingId: string): string {
    const id = slug(fullName)
    let p = this.byId.get(id)
    if (!p) {
      const first = fullName.split(/\s+/)[0]
      const firstKey = first.toLowerCase()
      const crew = this.crew.some((c) => slug(c) === id || c.toLowerCase() === firstKey)
      p = { id, name: fullName, short: SHORT.get(firstKey) ?? first, crew, hue: hueOf(fullName), meetings: [], aliases: [] }
      this.byId.set(id, p)
      for (const a of [firstKey, ...(this.nicknames.get(firstKey) ?? [])]) {
        p.aliases.push(a)
        const seen = this.alias.get(a)
        this.alias.set(a, seen === undefined || seen === id ? id : null)
      }
    }
    if (!p.meetings.includes(meetingId)) p.meetings.push(meetingId)
    return id
  }

  // "Ada/Grace and Linus" → [ada-byron, grace-hopper, linus-pauling]
  mentioned(text: string): string[] {
    const ids: string[] = []
    for (const w of text.toLowerCase().match(/\p{L}+/gu) ?? []) {
      const id = this.alias.get(w)
      if (id && !ids.includes(id)) ids.push(id)
    }
    return ids
  }

  // Who a person: filter means. The full name written as one word ("ada-byron") is that person; otherwise each
  // name in it ("ada", "ada/grace") is a first name or nickname, or failing that a last name. Each person found
  // comes back with every way the notes write them. A name that fits several people is ambiguous, with one id
  // for each of them: it names nobody until it is written so that it names one.
  named(text: string): { ids: string[][]; ambiguous: { name: string; ids: string[] }[] } {
    const everyone = [...this.byId.values()]
    const people = (fits: Person[]) => [...new Set(fits.map(this.identity))].map((who) => everyone.filter((p) => this.identity(p) === who).map((p) => p.id))
    const whole = this.byId.get(slug(text))
    if (whole) return { ids: people([whole]), ambiguous: [] }
    const ids: string[][] = []
    const ambiguous: { name: string; ids: string[] }[] = []
    for (const w of new Set(text.toLowerCase().match(/\p{L}+/gu) ?? [])) {
      const first = everyone.filter((p) => p.aliases.includes(w))
      const found = people(first.length ? first : everyone.filter((p) => p.id.split('-').at(-1) === slug(w)))
      if (found.length > 1) ambiguous.push({ name: w, ids: found.map(([id]) => id) })
      else if (found.length && !ids.some(([id]) => id === found[0][0])) ids.push(found[0])
    }
    return { ids, ambiguous }
  }

  isCrew = (id: string) => this.byId.get(id)?.crew ?? false

  // Whether a text names one of the archive's own people. Someone configured as crew counts even before they
  // have been in a meeting (a fresh install knows nobody from the notes yet), unless that name already
  // belongs to someone the meetings know.
  mentionsCrew(text: string): boolean {
    if (this.mentioned(text).some(this.isCrew)) return true
    const names = new Set(
      this.crew.flatMap((c) => {
        const first = c.split(/\s+/)[0].toLowerCase()
        return [first, ...(this.nicknames.get(first) ?? []), SHORT.get(first)?.toLowerCase() ?? first]
      }),
    )
    return (text.toLowerCase().match(/\p{L}+/gu) ?? []).some((w) => !this.alias.has(w) && names.has(w))
  }

  // the people this archive belongs to, by the short names they go by, in the order they were configured
  crewNames(): string[] {
    return this.crew.map((c) => {
      const first = c.split(/\s+/)[0]
      const known = [...this.byId.values()].find((p) => p.crew && (p.id === slug(c) || p.name.split(/\s+/)[0].toLowerCase() === c.toLowerCase()))
      return known?.short ?? SHORT.get(first.toLowerCase()) ?? first
    })
  }

  list(): Person[] {
    return [...this.byId.values()].sort((a, b) => Number(b.crew) - Number(a.crew) || b.meetings.length - a.meetings.length || a.name.localeCompare(b.name))
  }
}
