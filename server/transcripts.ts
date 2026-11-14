// Transcript parsers. Three shapes show up in the folder:
//   whisper JSON          {"segments":[{"start","end","text",...}]}            offsets from the recording
//   bracketed text        [00:01:32 - 00:02:01] text   (after a header)        offsets from the recording
//   arrow blocks          12:43:12 --> 12:43:13 \n Speaker 1: text             wall-clock (or SRT/VTT offsets)
import { parseTime, words } from './text.ts'

// sp: who is speaking (from the file, or a voice told apart by server/speakers.ts, whose number is spk)
export type Segment = { s: number; e: number; t: string; sp?: string; spk?: number; q?: 'silence' }
export type Transcript = {
  timeBase: 'offset' | 'clock'
  segments: Segment[]
  header: string[]
  title?: string
  sourceVideo?: string
  duration?: number
}

// Whisper fills long silences with "Thank you." and friends; dim those instead of trusting them.
function markSilence(segs: Segment[]): Segment[] {
  for (const seg of segs) {
    const len = seg.e - seg.s
    const n = words(seg.t)
    if ((len >= 15 && n <= 4) || (len >= 8 && /^(thank you|thanks|bye|you|okay|ok)[.!]?$/i.test(seg.t.trim()))) seg.q = 'silence'
  }
  return segs
}

type WhisperSegment = { start: number; end: number; text: string; no_speech_prob?: number; avg_logprob?: number }

export function parseWhisperJson(raw: string): Transcript {
  const data = JSON.parse(raw) as { segments?: WhisperSegment[] }
  const segments: Segment[] = (data.segments ?? [])
    .map((s): Segment => {
      const seg: Segment = { s: round(s.start), e: round(s.end), t: (s.text ?? '').trim() }
      if ((s.no_speech_prob ?? 0) > 0.6 && (s.avg_logprob ?? 0) < -1) seg.q = 'silence'
      return seg
    })
    .filter((s) => s.t)
  return { timeBase: 'offset', segments: markSilence(segments), header: [] }
}

const round = (n: number) => Math.round(n * 1000) / 1000

// The recording a transcript was made from: a "Source video:" line naming a video, as it always was, else a
// "Source recording:" (or "Source video:") line naming any recording, sound only included.
const SOURCE_VIDEO = /^Source video:\s*(.+?\.(?:mp4|m4v|mov|webm|mkv))/im
const SOURCE_ANY = /^Source (?:video|recording):\s*(.+?\.(?:mp4|m4v|mov|webm|mkv|m4a|mp3|wav|aac|ogg|opus|flac))/im

const TS = String.raw`\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?`
const BRACKET = new RegExp(String.raw`^\[(${TS})\s*[-–—]+\s*(${TS})\]\s?(.*)$`)
const ARROW = new RegExp(String.raw`^(${TS})\s*-->\s*(${TS})`)
const SPEAKER = /^([A-Z][\w .'’-]{0,30}?):\s+(.*)$/

export function parseTranscriptText(raw: string): Transcript {
  const lines = raw.replace(/\r\n?/g, '\n').split('\n')
  const header: string[] = []
  const segments: Segment[] = []
  let arrow = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    const b = BRACKET.exec(line)
    if (b) {
      segments.push({ s: parseTime(b[1])!, e: parseTime(b[2])!, t: b[3].trim() })
      continue
    }
    const a = ARROW.exec(line)
    if (a) {
      arrow = true
      const text: string[] = []
      while (i + 1 < lines.length && lines[i + 1].trim() && !ARROW.test(lines[i + 1].trim())) text.push(lines[++i].trim())
      const joined = text.join(' ')
      const sp = SPEAKER.exec(joined)
      segments.push({ s: parseTime(a[1], false)!, e: parseTime(a[2], false)!, t: sp ? sp[2] : joined, ...(sp ? { sp: sp[1] } : {}) })
      continue
    }
    if (!segments.length && line && !/^(WEBVTT|\d+)$/.test(line)) header.push(line)
  }

  // "12:43:12" style blocks with nothing near zero are a wall clock, not offsets
  const timeBase = segments.length && segments[0].s >= 3600 ? 'clock' : 'offset'
  const meta = header.join('\n')
  return {
    timeBase,
    segments: markSilence(arrow ? mergeFragments(segments.filter((s) => s.t)) : segments.filter((s) => s.t)),
    header,
    title: /^MACHINE TRANSCRIPT:\s*(.+)$/im.exec(meta)?.[1]?.trim(),
    sourceVideo: (SOURCE_VIDEO.exec(meta) ?? SOURCE_ANY.exec(meta))?.[1]?.trim(),
    duration: durationFrom(meta),
  }
}

function durationFrom(meta: string): number | undefined {
  const secs = /^Duration:\s*([\d.]+)\s*seconds/im.exec(meta)
  if (secs) return Number(secs[1])
  const clock = /^Duration:\s*([\d:.]+)/im.exec(meta)
  return clock ? parseTime(clock[1]) : undefined
}

// Live-caption exports arrive a few words at a time; join a speaker's run into readable lines.
function mergeFragments(segs: Segment[]): Segment[] {
  const out: Segment[] = []
  for (const seg of segs) {
    const last = out[out.length - 1]
    if (last && last.sp === seg.sp && seg.s - last.e <= 2 && last.t.length + seg.t.length < 240 && seg.e - last.s <= 30) {
      last.t = `${last.t} ${seg.t}`
      last.e = Math.max(last.e, seg.e)
    } else out.push({ ...seg })
  }
  return out
}

// Every timeline downstream assumes time only moves forward, within one recording. Segments without real
// times (a whisper JSON missing starts) or outside two days are dropped, the rest put in order (a
// hand-edited file can shuffle them), and an end before its start is pulled up to it.
const MAX_TIME = 2 * 86_400
export function parseTranscript(raw: string, name: string): Transcript {
  const t = /\.json$/i.test(name) ? parseWhisperJson(raw) : parseTranscriptText(raw)
  t.segments = t.segments
    .filter((s) => Number.isFinite(s.s) && Number.isFinite(s.e) && s.s >= 0 && s.s <= MAX_TIME)
    .map((s) => (s.e >= s.s ? s : { ...s, e: s.s }))
    .sort((a, b) => a.s - b.s)
  return t
}

export const transcriptWords = (t: Transcript) => t.segments.reduce((n, s) => n + (s.q ? 0 : words(s.t)), 0)
