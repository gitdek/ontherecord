// A tiny synthetic meetings folder for tests: invented names, no real meeting content.
import { EventEmitter } from 'node:events'
import { mkdtemp, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { App } from './app.ts'

export const NOTES = `MEETING NOTES: Launch planning
October 2, 2026 | Recording: 20:00 | Substantive discussion approximately 01:00–18:30
Participants visible in recording: Ada Byron, Grace Hopper, Linus Pauling (Acme); Mary Shelley joins late.
Written up from a transcript made on this Mac. Times count from the start of the recording, not from a clock.

SUMMARY
The team agreed to pilot the Widget API with Acme before the holidays.

AGREED DIRECTION / REQUIREMENTS
1. Pilot scope (01:10–04:00)
- Start with one clinic and the Widget API sandbox.
- Keep billing out of the pilot.
2. Security review with ACME (04:00–06:30; 12:00–13:00)
- Acme asked for a SOC 2 report.

SEPARATE ADA/GRACE DEBRIEF
- Ada and Grace discussed pricing. (15:00–16:10)

ACTION ITEMS
- Ada/Grace: Write the Widget API requirements and send them to Linus. (02:00–02:30)
- Linus: Share sandbox credentials process. (05:00–05:20)
- Team: Book the follow-up call. (17:00–17:10)

UNCERTAINTIES
- Nobody confirmed the pilot start date.
`

export const WHISPER = JSON.stringify({
  text: 'x',
  language: 'en',
  segments: [
    { id: 0, start: 0, end: 29.9, text: ' Thank you.', no_speech_prob: 0.01, avg_logprob: -0.5 },
    { id: 1, start: 60, end: 64.2, text: ' Hi Linus, thanks for joining.' },
    { id: 2, start: 70, end: 75, text: ' The Widget API sandbox is ready next week.' },
    { id: 3, start: 130, end: 140, text: ' Ada will write the requirements for the sandbox access.' },
    { id: 4, start: 250, end: 262, text: ' Acme wants a SOC 2 report before the pilot.' },
  ],
})

export const TRANSCRIPT_TXT = `MACHINE TRANSCRIPT: Launch planning - 2026-10-02
Source video: Screen Recording 2026-10-02 at 9.15.00 AM.mp4
Duration: 1200.0 seconds

[00:00:00 - 00:00:29] Thank you.
[00:01:00 - 00:01:04] Hi Linus, thanks for joining.
`

export const CLOCK_TXT = `13:00:01 --> 13:00:02
Speaker 1: Okay,

13:00:02 --> 13:00:04
Speaker 1: let's start the demo.

13:00:10 --> 13:00:12
Speaker 2: Sounds good.
`

export async function fixtureDir(opts: { index?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'meetings-test-'))
  const w = (name: string, data: string | Buffer) => writeFile(join(dir, name), data)
  await w('Ada Grace - Launch planning - 2026-10-02 - notes.txt', NOTES)
  await w('Ada Grace - Launch planning - 2026-10-02 - transcript.json', WHISPER)
  await w('Ada Grace - Launch planning - 2026-10-02 - transcript.txt', TRANSCRIPT_TXT)
  // a fake "video": only its bytes matter to the library and the range server
  await w('Screen Recording 2026-10-02 at 9.15.00 AM.mp4', Buffer.alloc(4000, 1))
  await w('Screen Recording 2026-10-02 at 9.15.00 AM compressed.mp4', Buffer.alloc(1000, 2))
  await w('Demo day - 2026-10-05 - source.txt', CLOCK_TXT)
  if (opts.index)
    await w(
      'meetings-index.json',
      JSON.stringify({
        sessions: [
          {
            id: '2026-10-02-launch',
            date: '2026-10-02',
            title: 'Launch planning',
            topic: 'Widget API pilot with Acme.',
            notes: 'Ada Grace - Launch planning - 2026-10-02 - notes.txt',
            videos: ['Screen Recording 2026-10-02 at 9.15.00 AM compressed.mp4', 'Screen Recording 2026-10-02 at 9.15.00 AM.mp4'],
            transcript: 'Ada Grace - Launch planning - 2026-10-02 - transcript.txt',
            transcript_json: 'Ada Grace - Launch planning - 2026-10-02 - transcript.json',
            video_transcripts: [
              {
                video: 'Screen Recording 2026-10-02 at 9.15.00 AM compressed.mp4',
                transcript: 'Ada Grace - Launch planning - 2026-10-02 - transcript.txt',
                transcript_json: 'Ada Grace - Launch planning - 2026-10-02 - transcript.json',
                synchronization: 'recording offsets',
              },
            ],
          },
        ],
        cautions: ['Synthetic test data.'],
      }),
    )
  return dir
}

export class RouteResponse extends EventEmitter {
  statusCode = 0
  headersSent = false
  writableEnded = false
  destroyed = false
  payload = ''
  setHeader() {}
  writeHead(code: number) {
    this.statusCode = code
    this.headersSent = true
  }
  write(chunk: string) {
    this.payload += chunk
    this.emit('chunk', chunk)
    return true
  }
  end(chunk?: string) {
    if (chunk) this.write(chunk)
    this.writableEnded = true
  }
  destroy() {
    this.destroyed = true
    this.emit('close')
  }
  json() {
    return JSON.parse(this.payload)
  }
  events() {
    return this.payload.trim().split('\n').map((line) => JSON.parse(line))
  }
}

export async function requestApp(app: App, url: string, body?: unknown, res = new RouteResponse(), headers: Record<string, string> = {}) {
  const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), {
    url,
    method: body === undefined ? 'GET' : 'POST',
    headers: { host: '127.0.0.1:8798', 'content-type': 'application/json', 'x-requested-with': 'meetings', ...headers },
    socket: { remoteAddress: '127.0.0.1' },
  })
  await app.handler(req as unknown as IncomingMessage, res as unknown as ServerResponse)
  return res
}
