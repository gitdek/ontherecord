import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CLOCK_TXT, NOTES, TRANSCRIPT_TXT, WHISPER } from './fixtures.test-helper.ts'
import { actionsOf, parseNotes, topicsOf } from './notes.ts'
import { findRanges, normName, parseTime, prettyHeading, recordingStamp } from './text.ts'
import { parseTranscriptText, parseWhisperJson } from './transcripts.ts'

test('timestamps: offsets read m:ss, wall clocks read h:mm', () => {
  assert.deepEqual(findRanges('(02:18–04:28; 12:47-12:56)'), [
    [138, 268],
    [767, 776],
  ])
  assert.deepEqual(findRanges('approximately 12:59-13:39 in transcript', true), [[46740, 49140]])
  assert.deepEqual(findRanges('12:44:29-12:53:00'), [[45869, 46380]])
  assert.deepEqual(findRanges('Recording began approximately 11:00 AM'), [])
  assert.equal(parseTime('00:00:29.980'), 29.98)
  assert.equal(parseTime('1:02:03'), 3723)
})

test('recording names: narrow no-break spaces and AM/PM', () => {
  assert.equal(normName('Screen Recording 2026-09-18 at 4.07.09 PM.mp4'), 'screen recording 2026-09-18 at 4.07.09 pm.mp4')
  assert.deepEqual(recordingStamp('Screen Recording 2026-09-18 at 4.07.09 PM.mp4'), { date: '2026-09-18', seconds: 16 * 3600 + 7 * 60 + 9 })
  assert.equal(recordingStamp('Screen Recording 2026-09-19 at 12.05.00 AM.mp4')?.seconds, 300)
})

test('headings borrow the body casing for names and acronyms', () => {
  assert.equal(prettyHeading('SEPARATE ACME PLATFORM WITH WIDGET FLOWS', 'Acme and Widget Flows were discussed; the widget shipped.'), 'Separate Acme platform with Widget Flows')
  assert.equal(prettyHeading('RECOMMENDED NEXT STEPS, NOT MEETING COMMITMENTS', 'MEETING NOTES are not the meeting; NOT elapsed.'), 'Recommended next steps, not meeting commitments')
})

test('notes: sections, topics, actions, phases, participants', () => {
  const n = parseNotes(NOTES)
  assert.equal(n.title, 'Launch planning')
  assert.equal(n.date, '2026-10-02')
  assert.equal(n.timeBase, 'offset')
  assert.equal(n.duration, 1200)
  assert.deepEqual(n.phases, [{ label: 'Substantive discussion', start: 60, end: 1110 }])
  assert.deepEqual(n.participants, ['Ada Byron', 'Grace Hopper', 'Linus Pauling', 'Mary Shelley'])
  assert.deepEqual(
    n.sections.map((s) => s.role),
    ['summary', 'discussion', 'discussion', 'actions', 'caveats'],
  )
  const topics = topicsOf(n)
  assert.deepEqual(
    topics.map((t) => [t.title, t.ranges]),
    [
      ['Pilot scope', [[70, 240]]],
      ['Security review with ACME', [[240, 390], [720, 780]]],
      ['Separate Ada/Grace debrief', [[900, 970]]],
    ],
  )
  const acts = actionsOf(n)
  assert.deepEqual(
    acts.map((a) => a.owner),
    ['Ada/Grace', 'Linus', 'Team'],
  )
  assert.equal(acts[0].text, 'Write the Widget API requirements and send them to Linus.')
  assert.deepEqual(acts[0].ranges, [[120, 150]])
})

test('notes on a wall clock say so, even while mentioning recording offsets', () => {
  const n = parseNotes(`MEETING NOTES: Demo\nOctober 5, 2026 | Main call approximately 13:00:00-13:40:00 in the source transcript\nThese notes use the transcript's original clock timestamps. They are NOT elapsed recording offsets.\n\nSUMMARY\nA demo.\n`)
  assert.equal(n.timeBase, 'clock')
  assert.deepEqual(n.phases, [{ label: 'Main call', start: 46800, end: 49200 }])
})

test('whisper JSON: segments, with long "Thank you." silences flagged', () => {
  const t = parseWhisperJson(WHISPER)
  assert.equal(t.segments.length, 5)
  assert.equal(t.segments[0].q, 'silence')
  assert.equal(t.segments[1].t, 'Hi Linus, thanks for joining.')
  assert.equal(t.segments[1].q, undefined)
})

test('bracketed transcript: header facts and offsets', () => {
  const t = parseTranscriptText(TRANSCRIPT_TXT)
  assert.equal(t.timeBase, 'offset')
  assert.equal(t.sourceVideo, 'Screen Recording 2026-10-02 at 9.15.00 AM.mp4')
  assert.equal(t.duration, 1200)
  assert.deepEqual(
    t.segments.map((s) => [s.s, s.e]),
    [
      [0, 29],
      [60, 64],
    ],
  )
})

test('arrow transcript on a wall clock: speakers kept, fragments joined', () => {
  const t = parseTranscriptText(CLOCK_TXT)
  assert.equal(t.timeBase, 'clock')
  assert.deepEqual(t.segments, [
    { s: 46801, e: 46804, t: "Okay, let's start the demo.", sp: 'Speaker 1' },
    { s: 46810, e: 46812, t: 'Sounds good.', sp: 'Speaker 2' },
  ])
})
