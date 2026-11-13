import { randomUUID } from 'node:crypto'
import { lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { rrf } from './fuse.ts'
import type { FileEntry, Library, Meeting } from './library.ts'
import { isRecord, parseJson, readRegularFile } from './persistence.ts'
import { stem, tokenize, type PreparedQuery } from './search.ts'
import { normalize, type Chunk } from './semantic.ts'
import { shortHash } from './text.ts'
import { STOPWORDS } from './topics.ts'

export const SCREEN_MODEL = 'gemini-embedding-2'
export const SCREEN_DIMENSIONS = 768
// The most frames one recording gives in hosted mode, where every frame is sent to Gemini. With gaps of at least
// 30 seconds while the picture holds still, an hour is about one frame every 37 seconds.
export const SCREEN_FRAME_LIMIT = 96
// Searches about nothing in particular. A frame's mean similarity to them is its baseline: a frame without text (a
// camera view) resembles every search a little, so a frame matches only when it stands out from its own baseline.
export const SCREEN_REFERENCE = ['a photo', 'a page of text', 'a screenshot of an app', 'a chart or a table', 'people in a video call', 'an empty slide', 'a diagram', 'a website']
// How far above its baseline a frame has to score. On made-up slides and camera frames, direct matches came out 0.10
// to 0.21 above, reworded ones 0.04 to 0.09, and unrelated or nonsense searches at most 0.06. Recheck it against
// real recordings once there are questions with answers on screen.
export const SCREEN_MIN_LIFT = 0.06
// The picture model on this Mac (SCREEN_SEARCH=local): Qwen3-VL-Embedding under llama-server. It was trained on
// chat-formatted inputs and llama-server adds no template to an embedding request, so each input is wrapped here:
// a stored frame with the model's default instruction, a search with a task instruction. Its vector is cut to its
// first 1024 numbers, which the model is trained to support. On 28 made-up frames and 72 searches, direct matches
// came out 0.21 to 0.53 above baseline and reworded ones 0.08 to 0.24; searches on a related topic that no frame
// answers reached 0.17, unrelated or nonsense ones 0.10. 0.18 keeps every search without an answer out, and a
// reworded search clears it about a third of the time (docs/screen-search.md). Recheck it against real recordings
// once there are questions with answers on screen.
export const LOCAL_SCREEN = {
  frame: "Represent the user's input.",
  search: 'Given a search, find the frame of a recorded business meeting (a slide, chart, document, app or camera view) that shows what it describes.',
  dimensions: 1024,
  minLift: 0.18,
  // Nothing is sent anywhere, so a recording is looked at every two seconds and each look is read. A look is kept
  // when it reads differently from the last kept one, when the picture cuts, and every ten seconds while neither
  // happens. On the first real recording (a 52-minute app demo) a frame every ten seconds held 318 frames and
  // missed 141 of the 1,145 words that were on screen for two looks in a row, most of them steps of a form that
  // were up for a few seconds; this way held 628 frames and missed 3. With a full page of text kept for a frame it
  // holds 617 and misses 3 of 1,182 (docs/screen-search.md).
  frames: 960,
  every: 10,
  look: 2,
  changed: 0.1,
}
// The most text kept for a frame. A page of an app in a browser reads to over 3,000 characters, and at the earlier
// 1,600 the lower half of such a page was lost.
const MAX_OCR = 6000
export const SCREEN_TEXT_LIMIT = MAX_OCR
// The stopword list holds words as written and the match compares stems ("this" is "thi", "does" is "doe").
const STOP_STEMS = new Set([...STOPWORDS].map(stem))
const SNAPSHOT_VERSION = 1
const ENDPOINT = 'https://openrouter.ai/api/v1/embeddings'
// what llama-server called the place for a picture before it picked a random marker at each start
const DEFAULT_MARKER = '<__media__>'

// off; Gemini Embedding 2 through OpenRouter (SCREEN_SEARCH=1 or gemini); or the picture model on this Mac
// (SCREEN_SEARCH=local), whose url is empty unless it is a loopback address (config.ts)
export type ScreenConfig =
  | { mode: 'off' }
  | { mode: 'gemini'; key: string }
  | { mode: 'local'; url: string; key: string; model: string }
export type ScreenFrame = { t: number; ocr: string; vector: Float32Array }
// Stored numbers are comparable only within one model and one input recipe, so each mode keeps its own snapshots
// (dir, under DATA_DIR) under its own model identity, and has its own threshold.
// frames: the most frames a recording's index holds; every: the longest wait, in seconds, between two of them.
// look and changed are local mode's: how often, in seconds, a recording is looked at for frames to keep, and the
// share of the words on two screens that only one of them has before the second counts as another screen.
export type ScreenProfile = { model: string; dimensions: number; dir: string; minLift: number; frames: number; every: number; look?: number; changed?: number }
export type ScreenEmbeddings = { image(jpeg: Buffer): Promise<Float32Array>; query(text: string, signal?: AbortSignal): Promise<Float32Array> }
type Match = { chunk: Chunk; score: number }
type EmbeddingInput = string | { content: { type: 'image_url'; image_url: { url: string } }[] }[]

export const GEMINI_PROFILE: ScreenProfile = { model: SCREEN_MODEL, dimensions: SCREEN_DIMENSIONS, dir: 'screens', minLift: SCREEN_MIN_LIFT, frames: SCREEN_FRAME_LIMIT, every: 30 }

// Fewer words than this apart is one screen read twice: a letter misread on a camera view is not a new screen.
const CHANGED_WORDS = 3

const wrap = (instruction: string, input: string) => `<|im_start|>system\n${instruction}<|im_end|>\n<|im_start|>user\n${input}<|im_end|>\n<|im_start|>assistant\n`

// The model file's name and a hash of the recipe: a new model file, wrapper, instruction or vector size is a new
// identity, and so is another way of picking frames. The snapshots made before it are ignored until the recording
// is indexed again.
export function localProfile(model: string): ScreenProfile {
  const { frames, every, look, changed } = LOCAL_SCREEN
  const recipe = shortHash(JSON.stringify([wrap('{instruction}', '{input}'), LOCAL_SCREEN.frame, LOCAL_SCREEN.search, LOCAL_SCREEN.dimensions, frames, every, look, changed, CHANGED_WORDS, MAX_OCR]))
  return { model: `${model} ${recipe}`, dimensions: LOCAL_SCREEN.dimensions, dir: join('screens', 'local'), minLift: LOCAL_SCREEN.minLift, frames, every, look, changed }
}

export type SeenScreen = { t: number; text: string; cut?: boolean }
const wordsOf = (text: string) => new Set(tokenize(text).map((w) => w.stem))
// Two screens read differently when more than `share` of the words on them are on only one, and at least three are.
const differs = (a: Set<string>, b: Set<string>, share: number) => {
  let both = 0
  for (const w of a) if (b.has(w)) both++
  const apart = a.size + b.size - 2 * both
  return apart >= CHANGED_WORDS && apart / (a.size + b.size - both) > share
}

// Which looks at a recording an index keeps, as positions in `seen` (in time order): the first; every look after
// a cut of the picture; every look that reads differently from the last kept one (more than `changed` of the
// words on the two screens are on only one of them); and one after `every` seconds without any of those. Each
// look is compared with the last one kept, not the one before it, so a page that changes a word at a time is
// kept again once enough of it has changed. When that is more than `limit` looks, the bar is raised a step at a
// time, and past that the kept ones are thinned evenly.
export function distinctScreens(seen: SeenScreen[], limit: number, every: number, changed: number): number[] {
  const words = seen.map((s) => wordsOf(s.text))
  const pick = (every: number, changed: number) => {
    const kept: number[] = []
    for (let i = 0; i < seen.length; i++) {
      const last = kept.at(-1)
      if (last === undefined || seen[i].cut || seen[i].t - seen[last].t >= every || differs(words[last], words[i], changed)) kept.push(i)
    }
    return kept
  }
  let kept = pick(every, changed)
  for (let step = 1; kept.length > limit && step <= 6; step++) kept = pick(every * (1 + step / 2), Math.min(0.9, changed + step * 0.15))
  if (kept.length > limit) kept = Array.from({ length: limit }, (_, i) => kept[Math.floor((i * kept.length) / limit)])
  return kept
}

export const screenProfile = (config: ScreenConfig) => (config.mode === 'local' ? localProfile(config.model) : GEMINI_PROFILE)

// The picture model a mode uses, if it is configured. Local mode never builds the hosted client, whatever else is
// set, and there is no fallback between the two: without its model a mode matches on frame text only.
export function screenEmbeddings(config: ScreenConfig): ScreenEmbeddings | undefined {
  if (config.mode === 'gemini') return config.key ? new GeminiScreenEmbeddings(config.key) : undefined
  if (config.mode === 'local') return config.url && config.model ? new LocalScreenEmbeddings(config) : undefined
}

function dot(a: Float32Array, b: Float32Array) {
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i]
  return sum
}

function vectorOf(values: unknown, dimensions = SCREEN_DIMENSIONS) {
  if (!Array.isArray(values) || values.length !== dimensions || !values.every(Number.isFinite)) {
    throw new Error('invalid Gemini embedding dimensions or values')
  }
  return normalize(Float32Array.from(values))
}

// The model's first numbers stand on their own: keep the first `dimensions` and scale them back to length 1.
export function shorten(values: unknown, dimensions: number) {
  if (!Array.isArray(values) || values.length < dimensions || !values.every(Number.isFinite)) {
    throw new Error('invalid local embedding dimensions or values')
  }
  return normalize(Float32Array.from(values.slice(0, dimensions)))
}

// A search goes into the wrapper as text, and llama-server reads control tokens (<|im_start|>, <|endoftext|>…) and
// the media marker in text. Taking them out means a search can neither break the request nor rewrite the
// instruction. Spaces stand in for what is removed, so the pieces left can't join into a new one.
export function cleanSearch(text: string, marker: string) {
  let clean = text
  for (const m of new Set([marker, DEFAULT_MARKER])) while (clean.includes(m)) clean = clean.replaceAll(m, ' ')
  return clean.replace(/<\||\|>/g, ' ').replace(/\s+/g, ' ').trim()
}

export class GeminiScreenEmbeddings {
  private readonly key: string

  constructor(key: string) {
    this.key = key
  }

  async image(jpeg: Buffer) {
    return this.embed([{
      content: [{ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${jpeg.toString('base64')}` } }],
    }])
  }

  async query(text: string, signal?: AbortSignal) {
    return this.embed(`task: search result | query: ${text.slice(0, 2000)}`, signal)
  }

  private async embed(input: EmbeddingInput, signal?: AbortSignal) {
    const timeout = AbortSignal.timeout(30_000)
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.key}` },
      body: JSON.stringify({ model: `google/${SCREEN_MODEL}`, input, dimensions: SCREEN_DIMENSIONS, encoding_format: 'float' }),
      redirect: 'error',
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    })
    if (!response.ok) throw new Error(`OpenRouter embedding request failed (HTTP ${response.status})`)
    const payload = await response.json().catch(() => null)
    if (!Array.isArray(payload?.data) || payload.data.length !== 1 || payload.data[0]?.index !== 0) {
      throw new Error('invalid OpenRouter embedding response')
    }
    return vectorOf(payload.data[0].embedding)
  }
}

// The picture model on this Mac: llama-server with the model's vision file. A picture goes in as base64 beside a
// prompt that holds the server's media marker where the picture belongs.
export class LocalScreenEmbeddings {
  private readonly cfg: { url: string; key: string; model: string }
  private marker?: Promise<string>

  constructor(cfg: { url: string; key: string; model: string }) {
    this.cfg = cfg
  }

  async image(jpeg: Buffer, signal?: AbortSignal) {
    return this.embed((marker) => ({ prompt_string: wrap(LOCAL_SCREEN.frame, marker), multimodal_data: [jpeg.toString('base64')] }), signal)
  }

  async query(text: string, signal?: AbortSignal) {
    return this.embed((marker) => wrap(LOCAL_SCREEN.search, cleanSearch(text, marker).slice(0, 2000)), signal)
  }

  private headers(): Record<string, string> {
    return this.cfg.key ? { Authorization: `Bearer ${this.cfg.key}` } : {}
  }

  // The server picks a random marker each time it starts. It is read when first needed and kept; a request the
  // server can't tokenize reads it again once, since a restarted server has a new one. The same answer names the
  // model file the server runs, which has to be SCREENS_MODEL: the snapshots are kept under that name.
  private mediaMarker() {
    if (!this.marker) {
      const marker = (async () => {
        const response = await fetch(`${this.cfg.url}/props`, { headers: this.headers(), redirect: 'error', signal: AbortSignal.timeout(15_000) })
        if (!response.ok) throw new Error(`local picture model properties failed (HTTP ${response.status})`)
        const props = await response.json().catch(() => null)
        const served = typeof props?.model_path === 'string' ? basename(props.model_path).replace(/\.gguf$/i, '') : this.cfg.model
        if (served !== this.cfg.model) throw new Error(`the local picture model server runs ${served}, not SCREENS_MODEL (${this.cfg.model})`)
        const value = props?.media_marker
        return typeof value === 'string' && value.trim() ? value : DEFAULT_MARKER
      })()
      // a failed read is tried again by the next request
      marker.catch(() => {
        if (this.marker === marker) this.marker = undefined
      })
      this.marker = marker
    }
    return this.marker
  }

  private async embed(input: (marker: string) => unknown, signal?: AbortSignal) {
    for (let attempt = 0; ; attempt++) {
      const used = this.mediaMarker()
      const marker = await used
      // the first request after a quiet spell also loads the model
      const timeout = AbortSignal.timeout(90_000)
      const response = await fetch(`${this.cfg.url}/v1/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.headers() },
        body: JSON.stringify({ input: input(marker), model: this.cfg.model }),
        redirect: 'error',
        signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
      })
      if (!response.ok) {
        const message = await response.text().catch(() => '')
        if (attempt === 0 && response.status === 500 && /tokenize/i.test(message)) {
          if (this.marker === used) this.marker = undefined
          continue
        }
        throw new Error(`local picture model request failed (HTTP ${response.status})`)
      }
      const payload = await response.json().catch(() => null)
      if (!Array.isArray(payload?.data) || payload.data.length !== 1 || payload.data[0]?.index !== 0) {
        throw new Error('invalid local embedding response')
      }
      return shorten(payload.data[0].embedding, LOCAL_SCREEN.dimensions)
    }
  }
}

export const screenDir = (dataDir: string, profile = GEMINI_PROFILE) => join(dataDir, profile.dir)
// The most an index file may weigh: a frame is its numbers written out (about 21 KB for 1,024 of them) and up to
// 1,600 characters read off it. One number for the reader and for the search that decides whether to read.
const snapshotLimit = (profile: ScreenProfile) => profile.frames * 42_000
const snapshotPath = (dataDir: string, video: FileEntry, profile = GEMINI_PROFILE) => join(screenDir(dataDir, profile), `${video.id}.json`)
const sourceStamp = (file: FileEntry) => `${file.dev}:${file.ino}:${file.size}:${file.mtimeMs}`
export const tidyScreenText = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, MAX_OCR)

export async function readScreenSnapshot(dataDir: string, video: FileEntry, profile = GEMINI_PROFILE): Promise<ScreenFrame[] | undefined> {
  try {
    const bytes = await readRegularFile(snapshotPath(dataDir, video, profile))
    if (!bytes || bytes.length > snapshotLimit(profile)) return
    const saved = parseJson(bytes)
    if (!isRecord(saved) || saved.version !== SNAPSHOT_VERSION || saved.model !== profile.model || saved.stamp !== sourceStamp(video)) return
    if (!Array.isArray(saved.frames) || !saved.frames.length || saved.frames.length > profile.frames) return
    const frames: ScreenFrame[] = []
    for (const frame of saved.frames) {
      if (!isRecord(frame) || typeof frame.t !== 'number' || !Number.isFinite(frame.t) || frame.t < 0 || frame.t <= (frames.at(-1)?.t ?? -1)) return
      if (typeof frame.ocr !== 'string' || frame.ocr.length > MAX_OCR) return
      frames.push({ t: frame.t, ocr: frame.ocr, vector: vectorOf(frame.values, profile.dimensions) })
    }
    return frames
  } catch {
    // This index can be rebuilt. A bad snapshot must not break search.
    return
  }
}

export async function writeScreenSnapshot(dataDir: string, video: FileEntry, frames: ScreenFrame[], profile = GEMINI_PROFILE) {
  const path = snapshotPath(dataDir, video, profile)
  const tmp = `${path}.${randomUUID()}.tmp`
  await mkdir(screenDir(dataDir, profile), { recursive: true, mode: 0o700 })
  try {
    const data = {
      version: SNAPSHOT_VERSION,
      model: profile.model,
      stamp: sourceStamp(video),
      frames: frames.map(({ t, ocr, vector }) => ({ t, ocr: tidyScreenText(ocr), values: Array.from(vector) })),
    }
    await writeFile(tmp, JSON.stringify(data), { flag: 'wx', mode: 0o600 })
    await rename(tmp, path)
  } finally {
    await rm(tmp, { force: true })
  }
}

// seq: the frame's place among all the frames a search looks at, recording after recording in time order, so two
// frames of one recording that follow each other have places one apart
// at: when the screen came up, in seconds into the recording; until: when the next one replaced it
export type ShownScreen = { at: number; until: number; text: string }

// The words that tell one screen from another when an index is read back: whole words, not a clock in a status
// bar, a count, or the stray letter an icon is read as.
const solidWords = (text: string) => new Set(tokenize(text).map((w) => w.stem).filter((w) => /^[a-z]{3,}$/.test(w)))
// how many new words make another screen, and how much of a screen has to remain for it to be the same one
const NEW_WORDS = 3
const SAME_SCREEN = 0.9
const GONE = 0.5

// An index read back in order, for following a recording screen by screen. The index keeps a frame every time a
// screen reads differently, which while someone types an answer is every two seconds; read back, those are one
// screen. A frame joins the screen before it when it holds nearly all of that screen's words, with or without
// more (an answer being typed, a list opened over a form), and when it brings fewer than three words the screen's
// reading does not have (the same page read slightly differently, a frame the clock kept). The screen is given in
// its fullest reading. A frame that brings three new words and has lost some of the old starts the next screen: a
// page scrolled on, another step, a box that opened and pushed the page down as it was typed into. So does one
// that has lost most of the words without bringing any (a camera view). New words are counted against the
// reading the screen is given in, so words typed one at a time add up until they show. Each screen lasts until
// the next.
export function screensInOrder(frames: { t: number; ocr: string }[]): ShownScreen[] {
  const out: ShownScreen[] = []
  // the words of the reading the current screen is given in
  let shown = new Set<string>()
  for (const frame of frames) {
    const words = solidWords(frame.ocr)
    const last = out.at(-1)
    let fresh = 0
    for (const w of words) if (!shown.has(w)) fresh++
    const kept = words.size - fresh
    const remains = shown.size ? kept / shown.size : words.size ? 0 : 1
    const another = !last || (fresh >= NEW_WORDS ? remains < SAME_SCREEN : remains < GONE && shown.size >= NEW_WORDS)
    if (another) {
      out.push({ at: frame.t, until: frame.t, text: frame.ocr })
      shown = words
      continue
    }
    last.until = frame.t
    // the fuller reading: one that holds what the screen showed and more words, not the same words with one misread
    if (remains >= SAME_SCREEN && words.size > shown.size) [last.text, shown] = [frame.ocr, words]
  }
  for (const [i, screen] of out.entries()) screen.until = out[i + 1]?.at ?? screen.until
  return out
}

// Whether two words are within `most` letters of each other (changed, dropped or added).
function near(a: string, b: string, most: number) {
  if (Math.abs(a.length - b.length) > most) return false
  let row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const next = [i]
    let least = i
    for (let j = 1; j <= b.length; j++) {
      next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
      if (next[j] < least) least = next[j]
    }
    if (least > most) return false
    row = next
  }
  return row[b.length] <= most
}

// What a screen reads that an earlier screen did not, and how much of the two is the same. The two readings are
// lined up word by word: the longest run of words they have in common, in the same order, is what did not change,
// and what lies between is what the later screen added or changed. Lining up by position keeps a new block whole:
// a question that repeats the options of the one above it ("Rarely, Often, Never") is new all the same, where a
// list of new words would leave those options out. A word read a letter off is taken as the same word (the small
// print of a full page is read a little differently at every look); a stretch is given only if it holds a whole
// word, so a clock that moved on is not news; and up to two unchanged words inside a stretch stay in it.
// same: the share of the longer reading's words that both hold in order. furniture: words that are on most
// screens whatever they show (the tabs of a browser, read in another order at every look); a stretch made of
// those alone is not news either.
export function addedSince(before: string, now: string, furniture: (word: string) => boolean = () => false): { text: string; same: number } {
  const was = tokenize(before).map((t) => t.stem)
  const tokens = tokenize(now)
  if (!was.length || !tokens.length || was.length * tokens.length > 4_000_000) return { text: now, same: 0 }
  const known = new Set(was)
  const long = [...known].filter((w) => w.length >= 6)
  const stems = tokens.map((t) => t.stem)
  // A word the earlier reading does not have may be one of its words read a letter off. A long word is taken as
  // that word wherever it stands. A short one only where the earlier word stands beside the same neighbour:
  // "Nates" after "Roast" is "Notes", and "Blond" in a new line is not "Blend".
  const is = stems.map((stem, j) => {
    if (known.has(stem) || stem.length < 4) return stem
    if (stem.length >= 7) return long.find((w) => near(stem, w, stem.length >= 11 ? 2 : 1)) ?? stem
    for (let i = 0; i < was.length; i++) {
      if ((i > 0 && j > 0 && was[i - 1] === stems[j - 1]) || (i + 1 < was.length && j + 1 < stems.length && was[i + 1] === stems[j + 1])) {
        if (was[i].length >= 4 && near(stem, was[i], 1)) return was[i]
      }
    }
    return stem
  })
  // the longest common run, by the usual table: rows are the earlier words, columns the later
  const width = is.length + 1
  const table = new Uint16Array((was.length + 1) * width)
  for (let i = 1; i <= was.length; i++) {
    for (let j = 1; j <= is.length; j++) {
      table[i * width + j] = was[i - 1] === is[j - 1] ? table[(i - 1) * width + j - 1] + 1 : Math.max(table[(i - 1) * width + j], table[i * width + j - 1])
    }
  }
  const kept = new Array<boolean>(is.length).fill(false)
  for (let i = was.length, j = is.length; i > 0 && j > 0; ) {
    if (was[i - 1] === is[j - 1]) {
      kept[j - 1] = true
      i--
      j--
    } else if (table[(i - 1) * width + j] >= table[i * width + j - 1]) i--
    else j--
  }
  const runs: { from: number; to: number; solid: boolean }[] = []
  let gap = Infinity
  for (const [j, token] of tokens.entries()) {
    if (kept[j]) {
      gap++
      continue
    }
    const solid = /^[a-z]{3,}$/.test(token.stem) && !furniture(token.stem)
    const last = runs.at(-1)
    if (last && gap <= 2) [last.to, last.solid] = [token.end, last.solid || solid]
    else runs.push({ from: token.start, to: token.end, solid })
    gap = 0
  }
  return { text: runs.filter((run) => run.solid).map((run) => now.slice(run.from, run.to)).join(' … '), same: table[was.length * width + is.length] / Math.max(was.length, is.length) }
}

// how alike two readings are before they are lined up at all: the share of the larger one's whole words they share
export function alike(a: Set<string>, b: Set<string>) {
  let both = 0
  for (const w of a) if (b.has(w)) both++
  return a.size && b.size ? both / Math.max(a.size, b.size) : 0
}
export { near, solidWords }

const MONTH = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\\.?'
// A date as a machine reads it off a screen: "Apr 9, 1988" also comes out as "Apr 09.1988" or "Apr.9 1988".
const dated = (year: string) => `(?:\\d{1,2}[/.-]\\d{1,2}[/.-]${year}|${year}-\\d{2}-\\d{2}|${MONTH}[ .]{0,2}\\d{1,2}(?:st|nd|rd|th)?[,. ]{1,3}${year}|\\d{1,2}(?:st|nd|rd|th)?[ .]{1,2}${MONTH}[,. ]{1,3}${year})`
const DATE = dated('\\d{2,4}')
// a year too far back for an order or an appointment: on a product's screen a date in it is a birth date
const BORN = dated('(?:19\\d\\d|200\\d)')
const UNIT = "(?:Apt|Unit|Suite|Ste|#)\\.? ?[A-Za-z0-9-]+"
const TOWN = '[A-Z][A-Za-z.]+(?: [A-Z][A-Za-z.]+){0,2}'
const STREET = '(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Ln|Lane|Way|Ct|Court|Pl|Place|Pkwy|Parkway|Ter|Terrace|Cir|Circle|Hwy|Highway|Sq|Square|Trl|Trail)'
// What a presenter typed into a form while their screen was recorded, told by its shape and replaced by what it
// was: an email address, a card number or its last four digits, a phone number, a date beside a birth label or in
// a year nobody books a visit for, a street address. Order matters: a card number holds a phone number's digits.
const TYPED: [RegExp, string][] = [
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, '[email]'],
  // one that is half typed: it has its @ and not yet its ending
  [/[A-Za-z0-9._%+-]{2,}@[A-Za-z0-9.-]*/g, '[email]'],
  // a card or account number: 13 to 19 digits in a row, or in a card's groups (a calendar's days are not one)
  [/(?<![\dA-Za-z$=-])(?:\d{13,19}|\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{1,7}|\d{4}[ -]\d{6}[ -]\d{5})(?![\dA-Za-z-])/g, '[number]'],
  [/(?:[•●∙·*]{2,} ?)+\d{4}(?!\d)/g, '[card]'],
  // a phone number shown with all but its last digits hidden
  [/\(?(?:[•●∙·*]{2,}[ )-]*)+\d{2,3}(?!\d)/g, '[number]'],
  // the same as a text reader can write it: the dots in the brackets gone, the last digits left
  [/\(\W{1,4}\) ?\S{0,8}?\d{2,4}(?!\d)/g, '[number]'],
  [/\(\W{1,4}\)(?: ?[^\w\s]{1,6}){1,3}\d{2,4}(?!\d)/g, '[number]'],
  [/(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)/g, '[number]'],
  [/(?<![\d$.,/-])(?:\+?1[ .-]?)?(?:\(\d{3}\) ?|\d{3}[ .-]?)\d{3}[ .-]?\d{4}(?![\d/-])/g, '[phone]'],
  [new RegExp(`\\b((?:date of birth|birth ?date|birthday|d\\.?o\\.?b\\.?|born)\\b[^A-Za-z0-9]{0,6}(?:on )?)${DATE}`, 'gi'), '$1[date]'],
  [new RegExp(`(?<![\\d/.-])${BORN}(?![\\d/-])`, 'g'), '[date]'],
  // a month and a year in a date picker scrolled back to a birth date
  [new RegExp(`\\b${MONTH} (?:19\\d\\d|200\\d)\\b`, 'g'), '[date]'],
  // a street address, told by its ending (a town and a state, as an address box suggests it: "12 Harbour Point,
  // Newport, RI, USA") or by its street word ("4500 N. Lake Shore Dr")
  [new RegExp(`\\b\\d{1,6} (?:[A-Z0-9][A-Za-z0-9.'-]* ?){1,6}(?:, ${UNIT})?(?:, ${TOWN}){1,2}, [A-Z]{2}\\b(?:,? (?:USA|United States))?(?:,? \\d{5}(?:-\\d{4})?)?`, 'g'), '[address]'],
  [new RegExp(`\\b\\d{1,6} (?:[NSEW]\\.? )?(?:[A-Z0-9][A-Za-z0-9.'-]* ){1,4}${STREET}\\b\\.?(?:,? ${UNIT})?(?:,? ${TOWN},? [A-Z]{2}\\b)?(?:,? \\d{5}(?:-\\d{4})?)?`, 'g'), '[address]'],
  // Last, what is half typed beside its label: the first digits of a phone number or of a birth date. The label
  // is the word on the form, never the word inside a mask already put there.
  [/(?<!\[)\b((?:phone|mobile|cell)(?: number)?\b[^A-Za-z0-9[(]{0,4})[()\d][()\d .-]{0,18}/gi, '$1[phone] '],
  [/(?<!\[)\b((?:date of birth|birth ?date|birthday|d\.?o\.?b\.?)\b[^A-Za-z0-9[]{0,4})\d[\d/.-]{0,10}/gi, '$1[date]'],
]
// A recording asks for this with "mask_screens" in the meetings index: true, or a list of words to mask as well,
// for what no shape tells (a street, the name of a shop). A listed word is masked wherever it starts a word,
// to the end of that word, so the start of a name covers every way it was typed or read, and a number in front of
// it goes with it, as the number of a street does. It is done to what a
// search or an assistant is given, not to the index, so it can be set for a recording without indexing it again.
export function maskTyped(text: string, words: string[] = []) {
  let out = fieldAddresses(TYPED.reduce((masked, [shape, label]) => masked.replace(shape, label), text))
  for (const word of words) {
    const shape = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])(?:\\d{1,6} )?${shape}[\\p{L}\\p{N}._+'-]*`, 'giu'), '[masked]')
  }
  return out
}

// What the shapes above leave: an address as its own field shows it, cut short or half typed, so it has neither
// a town nor a street word. It is told by the address label before it, with at most a name or an icon read in between the two: a number, then
// words that start with a capital.
const ADDRESS_LABEL = /(?<!\[)\b(?:home|street|mailing|billing|shipping) address\b/gi
const IN_FIELD = /^([^\d[]{0,60}?)\b\d{1,6}(?: \p{Lu}[\p{L}'.-]*){1,6}(?:\.{2,}|…)?/u
function fieldAddresses(text: string) {
  let out = ''
  let from = 0
  for (const label of text.matchAll(ADDRESS_LABEL)) {
    const end = label.index + label[0].length
    if (end < from) continue
    const typed = IN_FIELD.exec(text.slice(end))
    if (!typed) continue
    out += `${text.slice(from, end)}${typed[1]}[address]`
    from = end + typed[0].length
  }
  return out + text.slice(from)
}

type Masking = Pick<Meeting, 'maskScreens' | 'maskWords'>
type Candidate = { chunk: Chunk; frame: ScreenFrame; stamp: string; seq: number; mask: Masking }

export class ScreenSearch {
  readonly enabled: boolean
  private readonly dataDir: string
  private readonly library: () => Library
  private readonly profile: ScreenProfile
  private readonly model?: ScreenEmbeddings
  private readonly cache = new Map<string, { key: string; frames?: ScreenFrame[] }>()
  // what a frame reads, as given and as words, plain and with typed details masked: worked out once for a frame,
  // since every search reads every frame
  private readonly readings = new WeakMap<ScreenFrame, { words?: Set<string>; masked?: { for: string; text: string; words?: Set<string> } }>()
  private references?: Promise<Float32Array[]>

  constructor(config: ScreenConfig, dataDir: string, library: () => Library) {
    this.enabled = config.mode !== 'off'
    this.dataDir = dataDir
    this.library = library
    this.profile = screenProfile(config)
    this.model = screenEmbeddings(config)
  }

  private async frames(file: FileEntry) {
    const stat = await lstat(snapshotPath(this.dataDir, file, this.profile)).catch(() => undefined)
    if (!stat?.isFile() || stat.size > snapshotLimit(this.profile)) {
      this.cache.delete(file.id)
      return
    }
    const key = `${sourceStamp(file)}:${stat.ino}:${stat.size}:${stat.mtimeMs}`
    const cached = this.cache.get(file.id)
    if (cached?.key === key) return cached.frames
    const frames = await readScreenSnapshot(this.dataDir, file, this.profile)
    this.cache.set(file.id, { key, frames })
    return frames
  }

  private reading(frame: ScreenFrame) {
    let reading = this.readings.get(frame)
    if (!reading) this.readings.set(frame, (reading = {}))
    return reading
  }

  // a frame's masked reading, worked out again only when its recording's masking changes
  private masked(frame: ScreenFrame, mask: Masking) {
    const reading = this.reading(frame)
    const key = mask.maskWords.join('\n')
    if (reading.masked?.for !== key) reading.masked = { for: key, text: maskTyped(frame.ocr, mask.maskWords) }
    return reading.masked
  }

  // the text a frame is given with: as read, or with what someone typed masked when its recording asks for that
  private shown(frame: ScreenFrame, mask: Masking) {
    return mask.maskScreens ? this.masked(frame, mask).text : frame.ocr
  }

  private wordsOn(frame: ScreenFrame, mask: Masking) {
    if (!mask.maskScreens) return (this.reading(frame).words ??= wordsOf(frame.ocr))
    const masked = this.masked(frame, mask)
    return (masked.words ??= wordsOf(masked.text))
  }

  // The index of a meeting's recording: that of its default playable copy, or of the first copy that has one.
  private async indexOf(meeting: Meeting) {
    if (!this.enabled) return
    const lib = this.library()
    for (const video of [...meeting.videos].sort((a, b) => Number(b.isDefault) - Number(a.isDefault))) {
      const file = lib.files.get(video.fileId)
      if (!file || !video.playable) continue
      const frames = await this.frames(file)
      if (frames?.length) return { video, frames }
    }
  }

  // whether a meeting's recording has its screens indexed
  async indexed(meeting: Meeting) {
    return (await this.indexOf(meeting)) !== undefined
  }

  // What was on screen in a meeting's recording, in order, read back from its index.
  // offset: where the indexed copy's 0:00 falls on the meeting's clock.
  async shownIn(meeting: Meeting): Promise<{ videoId: string; offset: number; screens: ShownScreen[] } | undefined> {
    const index = await this.indexOf(meeting)
    if (!index) return
    const read = index.frames.map((frame) => ({ t: frame.t, ocr: this.shown(frame, meeting) }))
    const screens = screensInOrder(read)
    // the last screen stays up until the recording ends
    const last = screens.at(-1)
    const length = index.video.probe?.duration
    if (last && length && length > last.until) last.until = length
    return { videoId: index.video.fileId, offset: index.video.offset, screens }
  }

  // The reference searches are embedded once per server; a failed attempt is tried again by the next search.
  private referenceVectors() {
    if (!this.model) return Promise.resolve(undefined)
    const model = this.model
    this.references ??= Promise.all(SCREEN_REFERENCE.map((r) => model.query(r)))
    return this.references.catch(() => {
      this.references = undefined
      return undefined
    })
  }

  async find(current: () => PreparedQuery, limit: number, signal?: AbortSignal): Promise<Match[]> {
    signal?.throwIfAborted()
    const query = current()
    if (!this.enabled || !query.valid || query.items) return []
    const lib = this.library()
    for (const id of this.cache.keys()) if (!lib.files.has(id)) this.cache.delete(id)
    const candidates: Candidate[] = []
    for (const meeting of lib.meetings) {
      if (!query.metadataOk({ kind: 'screen', meetingId: meeting.id, text: '' })) continue
      for (const video of meeting.videos) {
        signal?.throwIfAborted()
        const file = lib.files.get(video.fileId)
        if (!file || !video.playable) continue
        const frames = await this.frames(file) ?? []
        for (const frame of frames) {
          const text = this.shown(frame, meeting)
          candidates.push({
            frame,
            mask: meeting,
            seq: candidates.length,
            stamp: sourceStamp(file),
            chunk: {
              key: shortHash(`${meeting.id}:${file.id}:${frame.t}`),
              kind: 'screen',
              meetingId: meeting.id,
              videoId: file.id,
              t: frame.t,
              title: `${meeting.title} · On screen`,
              text: text || 'Open the recording to inspect this frame.',
              evidence: text,
            },
          })
        }
      }
    }
    signal?.throwIfAborted()

    const eligible = () => {
      const latest = current()
      const lib = this.library()
      return candidates.filter(({ chunk, frame, stamp }) => {
        const m = lib.byId.get(chunk.meetingId!)
        const file = lib.files.get(chunk.videoId!)
        return file && stamp === sourceStamp(file) && m?.videos.some((v) => v.fileId === file.id && v.playable) &&
          (frame.ocr || (!latest.phrases.length && !latest.q.exclude.length)) && latest.chunk(chunk)
      })
    }
    let pool = eligible()
    if (!pool.length) return []
    const text = query.embeddingText
    // Small words ("the", "for") say nothing about a screen, and a frame has to show at least half of the rest:
    // one shared word out of five is how unrelated slides used to match.
    const stems = tokenize(text).map((term) => term.stem)
    const content = stems.filter((s) => !STOP_STEMS.has(s))
    const terms = new Set(content.length ? content : stems)
    if (!terms.size) return pool.slice(0, limit).map(({ chunk }) => ({ chunk, score: 0 }))
    const needed = Math.ceil(terms.size / 2)
    const vector = text.length > 2 ? await this.model?.query(text, signal).catch(() => undefined) : undefined
    // without the baseline a lift can't be judged, so only the on-screen text matches
    const references = vector && (await this.referenceVectors())
    signal?.throwIfAborted()
    pool = eligible()
    const ocr: { candidate: Candidate; score: number }[] = []
    const visual: typeof ocr = []
    for (const candidate of pool) {
      const words = this.wordsOn(candidate.frame, candidate.mask)
      const overlap = [...terms].filter((term) => words.has(term)).length
      if (overlap >= needed) ocr.push({ candidate, score: overlap / terms.size })
      if (vector && references) {
        const frame = candidate.frame.vector
        const lift = dot(vector, frame) - references.reduce((sum, r) => sum + dot(r, frame), 0) / references.length
        if (lift >= this.profile.minLift) visual.push({ candidate, score: lift })
      }
    }
    const ranked = new Map<Candidate, { score: number; rank: number }>()
    for (const list of [visual, ocr]) {
      list.sort((a, b) => b.score - a.score).forEach(({ candidate, score }, i) => {
        const previous = ranked.get(candidate)
        ranked.set(candidate, { score: previous?.score ?? score, rank: (previous?.rank ?? 0) + rrf(i) })
      })
    }
    // One hit for each stretch of a recording. A page that stays up, or is scrolled through, matches in frame after
    // frame, and without this it fills the list and pushes every other moment out. Frames of one recording that
    // follow each other in its index and all match are one stretch, and the best ranked of them stands for it.
    const taken = new Set<number>()
    const hits: Match[] = []
    for (const [candidate, { score }] of [...ranked].sort((a, b) => b[1].rank - a[1].rank)) {
      if (taken.has(candidate.seq)) continue
      hits.push({ chunk: candidate.chunk, score })
      if (hits.length >= limit) break
      taken.add(candidate.seq)
      for (const step of [-1, 1]) {
        for (let seq = candidate.seq + step; ; seq += step) {
          const next = candidates[seq]
          if (!next || next.chunk.videoId !== candidate.chunk.videoId || !ranked.has(next)) break
          taken.add(seq)
        }
      }
    }
    return hits
  }
}
