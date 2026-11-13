// `npm run check`: what the server would make of the meetings folder right now, without starting it.
// Handy after dropping in new files: did they land in the right meeting?
import { configFrom } from './config.ts'
import { buildLibrary, scanFiles } from './library.ts'
import { Media } from './media.ts'

const config = configFrom(process.env)
// the server's probe cache says how long each video is, which decides the default copy
const media = new Media(config.dataDir, () => {})
await media.load()
const files = await scanFiles(config.meetingsDir)
const lib = await buildLibrary(files, (f) => media.facts(f), config.crew, new Map())
const mb = (n: number) => `${(n / 1e6).toFixed(0)} MB`

console.log(`${config.meetingsDir}: ${files.length} files, ${lib.meetings.length} meetings\n`)
for (const m of lib.meetings) {
  console.log(`${m.date}  ${m.title}   [${m.id}]${m.fromIndex ? '' : '   (not in meetings-index.json yet)'}`)
  console.log(`    notes: ${m.notesFile?.name ?? '—'}`)
  for (const t of m.transcripts) console.log(`    transcript: ${t.label} (${lib.transcripts.get(t.id)?.files.map((f) => f.name).join(' + ')})`)
  for (const v of m.videos) console.log(`    video${v.isDefault ? '*' : ' '}: ${v.name} (${mb(v.size)})`)
  for (const d of m.docs) console.log(`    doc: ${d.name}`)
  console.log(`    ${m.topics.length} topics, ${m.actions.length} action items, ${m.words} words${m.timeBase === 'clock' ? ', wall-clock times' : ''}\n`)
}
if (lib.loose.length) console.log(`Not part of any meeting:\n${lib.loose.map((f) => `    ${f.name}`).join('\n')}`)
console.log('\n* = the copy the player streams by default')
