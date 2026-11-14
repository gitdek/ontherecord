import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

Object.assign(globalThis, { innerWidth: 1024, innerHeight: 768 })
const { mount: lab } = await import('../js/views/lab.js')
const { mount: notebook } = await import('../js/views/notebook.js')
const { load: meeting, boardOnPage } = await import('../js/views/meeting.js')

test('a timed transcript link opens its matching playable cut and reads on the meeting clock', async (t) => {
  const main = { id: 'main', url: '/api/transcript/main', videoIds: ['main-video'] }
  const alt = { id: 'alt', url: '/api/transcript/alt', videoIds: ['alt-video'], offset: 120 }
  const videos = [{ fileId: 'main-video', isDefault: true, playable: true }, { fileId: 'alt-video', playable: true }]
  const replies = new Map([
    ['/api/meetings/sample', { id: 'sample', videos, transcripts: [main, alt], primaryTranscript: 'main' }],
    ['/api/transcript/main', { segments: [{ s: 4, e: 6, t: 'main' }] }],
    ['/api/transcript/alt', { segments: [{ s: 4, e: 6, t: 'alternate' }] }],
    ['/api/notebook', { notes: [] }],
  ])
  t.mock.method(globalThis, 'fetch', async (path) => Response.json(replies.get(path)))
  const load = (query) => meeting({ params: ['sample'], query: new URLSearchParams(query) })
  const selected = await load('t=124&tab=transcript&transcript=alt')
  assert.equal(selected.variant.fileId, 'alt-video')
  assert.equal(selected.tMeta.id, 'alt')
  assert.deepEqual(selected.segs, [{ s: 124, e: 126, t: 'alternate' }])
  for (const query of ['t=4&tab=transcript', 't=4&tab=transcript&transcript=missing']) {
    const fallback = await load(query)
    assert.equal(fallback.variant.fileId, 'main-video')
    assert.equal(fallback.tMeta.id, 'main')
  }
})

test('a screen citation selects its recording and preserves the exact playback offset', async (t) => {
  const videos = [{ fileId: 'primary', isDefault: true, playable: true }, { fileId: 'indexed', playable: true }]
  t.mock.method(globalThis, 'fetch', async (path) => Response.json(path === '/api/meetings/sample'
    ? { id: 'sample', videos, transcripts: [], timeBase: 'clock', sync: null }
    : { notes: [] }))
  const load = (query) => meeting({ params: ['sample'], query: new URLSearchParams(query) })
  const hit = await load('video=indexed&vt=4.125')
  assert.equal(hit.variant.fileId, 'indexed')
  assert.equal(hit.startVideoAt, 4.125)
  assert.equal((await load('video=indexed&vt=0')).startVideoAt, 0)
  assert.equal((await load('video=missing&vt=4.125')).startVideoAt, null)
  assert.equal((await load('video=indexed&vt=-1')).startVideoAt, null)
})

test('the Lab copy command passes unusual filenames as literal shell arguments', async (t) => {
  const filename = "Director's cut $VERSION & !.mp4"
  const video = { name: filename, label: 'Original', size: 5000, faststart: false }
  t.mock.method(globalThis, 'fetch', async (path) => Response.json(path === '/api/lab'
    ? { meetings: [{ id: 'sample', title: 'Sample', date: '2026-11-10', hue: 220, videos: [video] }], ffmpeg: true, loose: [] }
    : { enabled: false }))
  const root = new EventTarget()
  await lab(root, { app: {} })
  const encoded = root.innerHTML.match(/data-copy="([^"]+)"/)[1]
  const command = encoded.replaceAll('&#39;', "'").replaceAll('&amp;', '&')
  const result = spawnSync('/bin/sh', ['-c', `ffmpeg() { printf '%s\\n' "$@"; }; ${command}`], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(result.stdout.trimEnd().split('\n'), ['-i', filename, '-c', 'copy', '-movflags', '+faststart', filename.replace('.mp4', ' - faststart.mp4')])
})

test('the Lab counts the passages the embedding model refused', async (t) => {
  const semantic = { enabled: true, model: 'fixture', total: 61, embedded: 60, pending: 0, refused: 1 }
  t.mock.method(globalThis, 'fetch', async (path) => Response.json(path === '/api/lab' ? { meetings: [], ffmpeg: true, loose: [], semantic } : { enabled: false }))
  const root = new EventTarget()
  await lab(root, { app: {} })
  assert.match(root.innerHTML, /has embedded <b>60<\/b> of <b>61<\/b> passages/)
  assert.match(root.innerHTML, /Left out until edited: 1 passage the model refused/)
})

test('the Lab says when ffprobe could not read a copy, instead of probing forever', async (t) => {
  const videos = [
    { name: 'Demo - compressed.mp4', label: 'compressed', size: 1000, failed: true, playable: false },
    { name: 'Demo.mov', label: 'original', size: 5000, playable: true, isDefault: true },
  ]
  t.mock.method(globalThis, 'fetch', async (path) => Response.json(path === '/api/lab'
    ? { meetings: [{ id: 'sample', title: 'Sample', date: '2026-11-10', hue: 220, videos }], ffmpeg: true, loose: [] }
    : { enabled: false }))
  const root = new EventTarget()
  await lab(root, { app: {} })
  const [failed, waiting] = root.innerHTML.split('class="lab-row').slice(1)
  assert.match(failed, /ffprobe can.t read it/)
  assert.doesNotMatch(failed, /probing/)
  assert.match(waiting, /probing…/)
})

test('the Lab says in one line how the copy of the meetings folder went', async (t) => {
  let mirror = { enabled: true, folders: 1, files: 45, copied: 2, waiting: 1, failed: 0, lastRun: '2026-11-12T14:02:00.000Z', running: false }
  t.mock.method(globalThis, 'fetch', async (path) => Response.json(path === '/api/lab' ? { meetings: [], ffmpeg: true, loose: [], mirror } : { enabled: false }))
  const show = async () => {
    const root = new EventTarget()
    await lab(root, { app: {} })
    return root.innerHTML.match(/<p class="muted small mirror-line">(.*?)<\/p>/s)?.[1]
  }
  assert.match(await show(), /^Copy of the meetings folder in 1 backup folder, last run .+: 45 files, 2 copied, 1 still being written, none failed\.$/)
  mirror = { ...mirror, failed: 3, running: true }
  assert.match(await show(), /copying now: 45 files.*<span class="warn">3 not copied \(the server log names them\)<\/span>/)
  mirror = { enabled: false, folders: 0, files: 0, copied: 0, waiting: 0, failed: 0, lastRun: null, running: false }
  assert.equal(await show(), 'No second copy of the meetings folder. Set <code>BACKUP_DIR</code> to keep one.')
})

test('the Lab says in one line whether this Mac writes transcripts, with what, and how many wait or failed', async (t) => {
  let transcripts = { enabled: true, model: 'whisper-large-v3-turbo', waiting: 3, writing: true, failed: 1 }
  t.mock.method(globalThis, 'fetch', async (path) => Response.json(path === '/api/lab' ? { meetings: [], ffmpeg: true, loose: [], transcripts } : { enabled: false }))
  const show = async () => {
    const root = new EventTarget()
    await lab(root, { app: {} })
    return root.innerHTML.match(/<p class="muted small transcripts-line">(.*?)<\/p>/s)?.[1]
  }
  const on = 'Transcripts for recordings that have none: on, written on this Mac with <code>whisper-large-v3-turbo</code>.'
  assert.equal(await show(), `${on} Writing one now, 2 recordings waiting, <span class="warn">1 recording failed (the meeting's Files tab says why)</span>.`)
  transcripts = { ...transcripts, waiting: 0, writing: false, failed: 0 }
  assert.equal(await show(), `${on} None waiting, none failed.`)
  transcripts = { ...transcripts, waiting: 1, writing: true }
  assert.equal(await show(), `${on} Writing one now, none failed.`)
  transcripts = { enabled: false, waiting: 0, writing: false, failed: 0 }
  assert.equal(await show(), 'Transcripts for recordings that have none: off. Set <code>TRANSCRIBE_PYTHON</code> to a Python that has MLX Whisper to have this Mac write them.')
  transcripts = { enabled: false, model: 'whisper-large-v3-turbo', problem: "the model mlx-community/whisper-large-v3-turbo isn't on this Mac (it is never downloaded by the server)", waiting: 0, writing: false, failed: 0 }
  assert.equal(await show(), 'Transcripts for recordings that have none: off, because the model mlx-community/whisper-large-v3-turbo isn&#39;t on this Mac (it is never downloaded by the server).')
})

test('a meeting with no transcript says on its Files tab whether one is waiting, being written on the Mac, or failed and why', async () => {
  const { filesView } = await import('../js/views/meeting.js')
  const m = { videos: [], transcripts: [], docs: [], notesFile: null, date: '2026-11-03', title: 'Roast review' }
  const line = (transcribing) => String(filesView({ ...m, transcribing }, null, 'Ada’s Mac')).match(/<p class="muted no-transcript">(.*?)<\/p>/s)?.[1]
  assert.equal(line(null), 'No transcript yet.')
  assert.equal(line({ state: 'queued' }), 'No transcript yet. One will be written on Ada’s Mac, after the recordings ahead of it.')
  assert.equal(line({ state: 'running' }), 'No transcript yet. One is being written on Ada’s Mac now, and it shows up here on its own.')
  assert.equal(line({ state: 'failed', error: 'the speech model stopped: <b>no</b> weights' }), 'No transcript yet. Writing one on Ada’s Mac failed (the speech model stopped: &lt;b&gt;no&lt;/b&gt; weights). It is tried again when the server restarts.')
  // a meeting that has its transcript says nothing of the kind
  assert.doesNotMatch(String(filesView({ ...m, transcripts: [{ id: 't', label: 'Transcript', words: 17, synced: true, files: [] }], transcribing: null }, null, 'Ada’s Mac')), /No transcript yet/)
})

test('the Files tab says who saved notes an agent wrote, and how a meeting with a transcript gets its notes', async () => {
  const { filesView } = await import('../js/views/meeting.js')
  const m = { videos: [], docs: [], date: '2026-11-03', title: 'Roast review', transcribing: null }
  const transcript = [{ id: 't', label: 'Transcript', words: 17, synced: true, files: [] }]
  const page = (o) => String(filesView({ ...m, ...o }, null, 'Ada’s Mac'))
  assert.match(page({ transcripts: transcript, notesFile: null }), /<p class="muted">No notes yet\. Ask an agent connected to the archive to write them\.<\/p>/)
  assert.match(page({ transcripts: [], notesFile: null }), /<p class="muted">No notes yet\. When a notes file lands in the folder it shows up here on its own\.<\/p>/)
  const saved = page({ transcripts: transcript, notesFile: { name: 'Roast review - notes.txt', url: '/media/n?download=1' }, notesSaved: { by: "Ada's agent", at: '2026-11-14T15:00:00.000Z', reason: 'from the transcript' } })
  assert.match(saved, /<b>Notes<\/b><span>Roast review - notes\.txt<small class="saved-by">Saved by Ada&#39;s agent on 2026-11-1\d · from the transcript<\/small><\/span>/)
  // notes nobody saved through the tool say only what they are
  assert.match(page({ transcripts: transcript, notesFile: { name: 'Roast review - notes.txt', url: '/media/n?download=1' }, notesSaved: null }), /<b>Notes<\/b><span>Roast review - notes\.txt<\/span>/)
  assert.doesNotMatch(saved, /[Rr]eviewed/)
})

test('the Lab lists the cautions of the library as it is now', async (t) => {
  t.mock.method(globalThis, 'fetch', async (path) => Response.json(path === '/api/lab' ? { meetings: [], ffmpeg: true, loose: [] } : { enabled: false }))
  const caution = "x - transcript.json can't be read, so what it holds is left out"
  const root = new EventTarget()
  await lab(root, { app: { lib: { cautions: [] }, refreshLibrary: async () => ({ cautions: [caution] }) } })
  assert.match(root.innerHTML, /<h2>Cautions<\/h2>/)
  assert.ok(root.innerHTML.includes("x - transcript.json can&#39;t be read, so what it holds is left out"))
  const quiet = new EventTarget()
  await lab(quiet, { app: { lib: { cautions: [] } } })
  assert.doesNotMatch(quiet.innerHTML, /Cautions/)
})

test('a Notebook resume refresh preserves an editor opened while it was fetching', async (t) => {
  globalThis.document = { title: '' }
  t.after(() => { delete globalThis.document })
  const responses = []
  t.mock.method(globalThis, 'fetch', () => new Promise((resolve) => responses.push(resolve)))
  const root = Object.assign(new EventTarget(), { querySelector: () => null })
  let renders = 0
  let rendered = ''
  Object.defineProperty(root, 'innerHTML', { get: () => rendered, set: (html) => { renders++; rendered = html } })
  const ctx = { app: { lib: { meetings: [] } }, query: new URLSearchParams(), data: { list: { notes: [] }, trash: { notes: [] }, note: null } }
  const view = await notebook(root, ctx)
  const resume = view.onResume()
  assert.equal(responses.length, 2)
  const open = new Event('click')
  Object.defineProperty(open, 'target', { value: { closest: (sel) => sel === '[data-new]' ? {} : null } })
  root.dispatchEvent(open)
  assert.equal(renders, 2)
  assert.match(root.innerHTML, /nb-editor/)
  responses.forEach((resolve) => resolve(Response.json({ notes: [] })))
  await resume
  assert.equal(renders, 2)
  await view.onResume()
  assert.equal(responses.length, 2)
})

test('a Notebook refresh cannot set the document title after leaving its view', async (t) => {
  globalThis.document = { title: '' }
  t.after(() => { delete globalThis.document })
  const replies = []
  t.mock.method(globalThis, 'fetch', (_path, { signal }) => new Promise((resolve) => replies.push({ signal, resolve })))
  const root = Object.assign(new EventTarget(), { querySelector: () => null })
  const ctx = { app: { lib: { meetings: [] } }, query: new URLSearchParams(), data: { list: { notes: [] }, trash: { notes: [] }, note: null } }
  const view = await notebook(root, ctx)
  const resume = view.onResume()
  view.cleanup()
  document.title = 'Different page'
  for (const { signal, resolve } of replies) {
    assert.equal(signal.aborted, true)
    resolve(Response.json({ notes: [] }))
  }
  await resume
  assert.equal(document.title, 'Different page')
})

test('resuming with an in-flight Notebook create cannot submit the draft a second time', async (t) => {
  globalThis.document = { title: '' }
  t.after(() => { delete globalThis.document })
  const requests = []
  t.mock.method(globalThis, 'fetch', (path, init) => new Promise((resolve) => requests.push({ path, init, resolve })))
  const submitButton = { disabled: false }
  const form = { title: { value: 'Draft' }, body: { value: 'Details' }, tags: { value: '' }, meetingIds: { selectedOptions: [] }, querySelector: () => submitButton }
  const root = Object.assign(new EventTarget(), { querySelector: () => null, contains: (node) => node === form })
  const opened = []
  const ctx = { app: { lib: { meetings: [] }, navigate: (path) => opened.push(path) }, query: new URLSearchParams('new=1'), data: { list: { notes: [] }, trash: { notes: [] }, note: null } }
  const view = await notebook(root, ctx)
  const submit = () => {
    const event = new Event('submit')
    Object.defineProperty(event, 'target', { value: form })
    root.dispatchEvent(event)
  }
  submit()
  assert.equal(submitButton.disabled, true)
  await view.onResume()
  submit()
  assert.deepEqual(requests.map(({ path, init }) => [path, init.method]), [['/api/notebook', 'POST']])
  requests[0].resolve(Response.json({ note: { id: 'n-1234567890' } }))
  await new Promise(setImmediate)
  assert.deepEqual(opened, ['/notebook/n-1234567890'])
  assert.equal(submitButton.disabled, false)
  view.cleanup()
})

// A stand-in for the notebook's page: what it is given to draw, and an editor whose fields hold what that drawing
// says, as a browser's would. Typing is a change to those fields.
function notebookPage() {
  const unescape = (s) => s.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&amp;', '&')
  const fieldsOf = (page) => ({
    title: { value: unescape(page.match(/name="title"[^>]*value="([^"]*)"/)?.[1] ?? '') },
    body: { value: unescape(page.match(/<textarea name="body"[^>]*>([\s\S]*?)<\/textarea>/)?.[1] ?? '') },
    tags: { value: unescape(page.match(/name="tags"[^>]*value="([^"]*)"/)?.[1] ?? '') },
    meetingIds: { selectedOptions: [...page.matchAll(/<option value="([^"]*)" selected>/g)].map((m) => ({ value: m[1] })) },
  })
  let drawn = ''
  let form = null
  let renders = 0
  const root = Object.assign(new EventTarget(), { querySelector: (sel) => (sel === '.nb-editor' ? form : null) })
  Object.defineProperty(root, 'innerHTML', { get: () => drawn, set: (page) => { renders++; drawn = page; form = page.includes('class="nb-editor"') ? fieldsOf(page) : null } })
  const click = (selector, dataset = {}) => {
    const event = new Event('click')
    Object.defineProperty(event, 'target', { value: { closest: (sel) => (sel === selector ? { dataset } : null) } })
    root.dispatchEvent(event)
  }
  return { root, click, get form() { return form }, get renders() { return renders } }
}

test('what is typed into the Notebook editor survives the page redrawing itself', async (t) => {
  globalThis.document = { title: '' }
  globalThis.history = { state: null, replaceState() {} }
  t.after(() => { delete globalThis.document; delete globalThis.history })
  const notes = [{ id: 'n-0123456789', title: 'Pricing research', excerpt: 'Tiers', tags: ['pricing'], meetingIds: [], updatedBy: 'Ada', updatedAt: '2026-11-10T10:00:00.000Z', revisions: 1 }]
  const restored = []
  t.mock.method(globalThis, 'fetch', async (path, init) => {
    if (init?.method === 'POST') restored.push(path)
    return Response.json(init?.method === 'POST' ? { ok: true } : { notes: path.includes('deleted=1') ? [] : notes })
  })
  const app = { lib: { meetings: [{ id: 'launch', date: '2026-10-02', title: 'Launch planning' }] }, byId: new Map(), personByName: () => null }
  const page = notebookPage()
  const view = await notebook(page.root, { app, query: new URLSearchParams(), data: { list: { notes }, trash: { notes: [] }, note: null } })

  // a new note, written in full, then a tag chip filters the list under it
  page.click('[data-new]')
  assert.equal(view.unsaved(), false, 'an editor nobody typed in holds nothing to lose')
  Object.assign(page.form, { title: { value: 'Vendor call prep' }, body: { value: 'Questions for Thursday: <SLA> & "data export".' }, tags: { value: 'vendor, q4' }, meetingIds: { selectedOptions: [{ value: 'launch' }] } })
  assert.equal(view.unsaved(), true)
  page.click('[data-tag]', { tag: 'pricing' })
  const kept = { title: 'Vendor call prep', body: 'Questions for Thursday: <SLA> & "data export".', tags: 'vendor, q4', meetingIds: ['launch'] }
  const shown = () => ({ title: page.form.title.value, body: page.form.body.value, tags: page.form.tags.value, meetingIds: page.form.meetingIds.selectedOptions.map((o) => o.value) })
  assert.deepEqual(shown(), kept)
  assert.match(page.root.innerHTML, /fchip on" data-tag="pricing"/)

  // a note brought back from the recently deleted redraws the list too
  page.click('[data-restore]', { restore: 'n-9876543210' })
  for (let i = 0; i < 5; i++) await new Promise(setImmediate)
  assert.deepEqual(restored, ['/api/notebook/n-9876543210/restore'])
  assert.deepEqual(shown(), kept)
  assert.equal(view.unsaved(), true)

  page.click('[data-cancel]')
  assert.equal(page.form, null)
  assert.equal(view.unsaved(), false)
  view.cleanup()
})

test('a Notebook edit keeps its text when the earlier versions are shown or hidden', async (t) => {
  globalThis.document = { title: '' }
  t.after(() => { delete globalThis.document })
  const at = '2026-11-10T10:00:00.000Z'
  const saved = { id: 'n-0123456789', title: 'Pricing research', body: 'Second draft.', tags: ['pricing'], meetingIds: [], taskIds: [], author: 'Ada', createdAt: at, updatedBy: 'Ada', updatedAt: at, version: 2 }
  const note = { note: saved, revisions: [{ title: 'Pricing research', by: 'Ada', at, body: 'First draft.' }] }
  const app = { lib: { meetings: [] }, byId: new Map(), personByName: () => null }
  const page = notebookPage()
  const view = await notebook(page.root, { app, query: new URLSearchParams(), data: { list: { notes: [] }, trash: { notes: [] }, note } })
  page.click('[data-edit]')
  assert.equal(page.form.body.value, 'Second draft.')
  assert.equal(view.unsaved(), false)
  page.form.body.value += ' Plus three paragraphs written just now.'
  page.click('[data-versions]')
  assert.match(page.root.innerHTML, /class="nb-versions"/)
  assert.equal(page.form.body.value, 'Second draft. Plus three paragraphs written just now.')
  page.click('[data-versions]')
  assert.equal(page.form.body.value, 'Second draft. Plus three paragraphs written just now.')
  assert.equal(page.form.title.value, 'Pricing research')
  assert.equal(view.unsaved(), true)
  view.cleanup()
})

// a board item as /api/actions gives it
const boardItem = (id, more = {}) => ({ id, text: `Task ${id}`, owner: 'Ada', people: [], lane: 'us', status: 'open', source: 'added', createdBy: 'Ada', createdAt: '2026-11-10T10:00:00.000Z', ranges: [], meeting: null, history: [], replaces: [], hold: null, note: null, rev: 1, ...more })

function boardHarness(t) {
  const originalFormData = globalThis.FormData
  globalThis.FormData = class {
    constructor(form) { this.form = form }
    *[Symbol.iterator]() {
      for (const [name, field] of Object.entries(this.form?.elements ?? {})) yield [name, field.value]
    }
    get(name) { return this.form?.elements?.[name]?.value ?? null }
    has(name) { return Object.hasOwn(this.form?.elements ?? {}, name) }
    getAll() { return [] }
  }
  globalThis.history = { state: null, replaceState() {} }
  globalThis.document = { activeElement: null, createElement: () => ({}) }
  globalThis.CSS = { escape: (s) => s }
  t.after(() => { globalThis.FormData = originalFormData; delete globalThis.history; delete globalThis.document; delete globalThis.CSS })
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const app = { lib: { people: [], meetings: [], crew: [] }, people: new Map(), byId: new Map(), toasts: [], toast(m) { this.toasts.push(m) } }
  return { app, settle: async (pending) => { t.mock.timers.tick(300); await pending } }
}

test('a catch-up that finds nothing new leaves the Board and the Notebook as they are drawn', async (t) => {
  const { mount: board } = await import('../js/views/board.js')
  const { app, settle } = boardHarness(t)
  let served = { actions: [boardItem('t-1'), boardItem('t-2')], notes: {}, deleted: [] }
  const notes = { notes: [{ id: 'n-0123456789', title: 'Pricing research', excerpt: 'Tiers', tags: [], meetingIds: [], updatedBy: 'Ada', updatedAt: '2026-11-10T10:00:00.000Z', revisions: 0 }] }
  t.mock.method(globalThis, 'fetch', async (path) => Response.json(path.startsWith('/api/notebook') ? (path.includes('deleted=1') ? { notes: [] } : notes) : served))
  let renders = 0
  const root = Object.assign(new EventTarget(), { querySelector: () => null, contains: () => false })
  Object.defineProperty(root, 'innerHTML', { get: () => '', set: () => renders++ })
  const view = await board(root, { app, query: new URLSearchParams(), data: served })
  assert.equal(renders, 1)
  await settle(view.onResume())
  assert.equal(renders, 1, 'the same board: its cards stay where they are')
  served = { ...served, actions: [boardItem('t-1', { status: 'done', done: { by: 'Grace', at: '2026-11-11T09:00:00.000Z' }, rev: 2 }), boardItem('t-2')] }
  await settle(view.onResume())
  assert.equal(renders, 2, 'an item changed while the page was away: drawn again')
  view.cleanup()

  const page = notebookPage()
  const nb = await notebook(page.root, { app: { lib: { meetings: [] }, byId: new Map(), personByName: () => null }, query: new URLSearchParams(), data: { list: notes, trash: { notes: [] }, note: null } })
  assert.equal(page.renders, 1)
  await nb.onResume()
  assert.equal(page.renders, 1)
  notes.notes = [{ ...notes.notes[0], title: 'Pricing research, revised', revisions: 1 }]
  await nb.onResume()
  assert.equal(page.renders, 2)
  assert.match(page.root.innerHTML, /Pricing research, revised/)
  nb.cleanup()
})

test('evidence typed for a done item that is reopened meanwhile is kept, and the Board says why it was not saved', async (t) => {
  const { mount: board } = await import('../js/views/board.js')
  const { app, settle } = boardHarness(t)
  const at = '2026-11-11T09:00:00.000Z'
  const done = (id, more = {}) => boardItem(id, { status: 'done', done: { by: 'Ada', at }, rev: 2, ...more })
  let served = { actions: [done('t-1'), done('t-2')], notes: {}, deleted: [] }
  const posted = []
  t.mock.method(globalThis, 'fetch', async (path, init) => {
    if (init?.method !== 'POST') return Response.json(served)
    posted.push([path, JSON.parse(init.body)])
    return Response.json({ action: done('t-2', { rev: 3 }) })
  })
  let renders = 0
  const root = Object.assign(new EventTarget(), { querySelector: () => null, contains: () => false })
  Object.defineProperty(root, 'innerHTML', { get: () => '', set: () => renders++ })
  const view = await board(root, { app, query: new URLSearchParams('show=all'), data: served })
  const card = (id) => ({ dataset: { action: id } })
  const openEvidence = (id) => {
    const event = new Event('click')
    const button = { dataset: { form: 'proof' }, closest: (sel) => (sel === '.sticky' ? card(id) : null) }
    Object.defineProperty(event, 'target', { value: { closest: (sel) => (sel === '.sticky button' ? button : null) } })
    root.dispatchEvent(event)
  }
  const evidenceForm = (id, evidence) => ({ matches: (sel) => sel === '.proof-form', closest: (sel) => (sel === '.sticky' ? card(id) : null), elements: { evidence: { value: evidence }, from: { value: '' }, at: { value: '' }, ref: { value: '' } } })
  const submit = (form) => {
    const event = new Event('submit')
    Object.defineProperty(event, 'target', { value: form })
    root.dispatchEvent(event)
  }

  openEvidence('t-1')
  const shown = renders
  const typed = evidenceForm('t-1', 'Linus confirmed by email on Nov 3 that the requirements arrived.')
  // Grace reopens it; the board doesn't redraw under the open form
  served = { ...served, actions: [boardItem('t-1', { rev: 3, history: [{ at, by: 'Grace', did: 'reopened' }] }), done('t-2')] }
  await settle(view.onState({ kind: 'action', id: 't-1', rev: 3 }))
  submit(typed)
  await new Promise(setImmediate)
  assert.deepEqual(posted, [], 'nothing is sent for an item that is open again')
  assert.equal(renders, shown, 'the form, and what was typed in it, stay on the page')
  assert.equal(typed.elements.evidence.value, 'Linus confirmed by email on Nov 3 that the requirements arrived.')
  assert.equal(app.toasts.at(-1).title, 'Not saved: this item just changed')
  assert.match(app.toasts.at(-1).body, /Grace changed it while you were writing, and it is open again now\. What you wrote is still in the form/)

  // an item whose state held still saves the evidence its form asks for, and nothing else
  openEvidence('t-2')
  submit(evidenceForm('t-2', 'Signed off in the Nov 4 call.'))
  await settle(new Promise(setImmediate))
  assert.deepEqual(posted, [['/api/actions/t-2', { evidence: 'Signed off in the Nov 4 call.', sources: [] }]])
  view.cleanup()
})

test('the Board catches up, quietly, when a change whose save had failed reaches disk ("recovered")', async (t) => {
  const { mount: board } = await import('../js/views/board.js')
  const { app, settle } = boardHarness(t)
  let served = { actions: [boardItem('t-1')], notes: {}, deleted: [] }
  const asked = []
  t.mock.method(globalThis, 'fetch', async (path) => {
    asked.push(path)
    return Response.json(served)
  })
  const looked = []
  let renders = 0
  const root = Object.assign(new EventTarget(), { querySelector: (sel) => (looked.push(sel), null), contains: () => false })
  Object.defineProperty(root, 'innerHTML', { get: () => '', set: () => renders++ })
  const view = await board(root, { app, query: new URLSearchParams('show=all'), data: served })
  // the change was made but its save failed, so no page heard of it; a later retry has just written it
  served = { ...served, actions: [boardItem('t-1', { status: 'done', done: { by: 'Grace', at: '2026-11-11T09:00:00.000Z' }, rev: 2 })] }
  looked.length = 0
  await settle(view.onState({ kind: 'recovered' }))
  assert.deepEqual(asked, ['/api/actions'])
  assert.equal(renders, 2)
  assert.deepEqual(looked.filter((sel) => sel.startsWith('.sticky[')), [], 'no card is flashed: the event names none')
  assert.deepEqual(app.toasts, [])
  view.cleanup()
})

test('a task added or deleted anywhere redraws only what the meeting page shows of the board', async (t) => {
  globalThis.CSS = { escape: (s) => s }
  t.after(() => { delete globalThis.CSS })
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const spec = boardItem('a-1', { source: 'notes', text: 'Write the Widget API requirements', meeting: { id: 'launch' } })
  const venue = boardItem('t-1', { text: 'Book the venue', meeting: { id: 'launch' } })
  const lineActions = { 'a-1': 'a-1' }
  const m = { id: 'launch', notes: { timeBase: 'offset', sections: [{ role: 'actions', title: 'Action items', blocks: [{ kind: 'bullet', text: 'Ada: Write the Widget API requirements', action: 'a-1' }] }] }, actions: [spec], lineActions }
  let served = { actions: [spec, venue], lineActions }
  const asked = []
  t.mock.method(globalThis, 'fetch', async (path) => {
    asked.push(path)
    return Response.json(served)
  })
  // the page: its action section, the count in the heading and the Notes tab; nothing else is reachable from here
  const drawn = []
  const section = { set outerHTML(page) { drawn.push(page) } }
  const count = { textContent: 1 }
  const tab = { added: [], querySelector: () => ({ remove() {} }), insertAdjacentHTML(_where, page) { this.added.push(page) } }
  const root = { isConnected: true, querySelector: (sel) => ({ '.n-actions': count, '.tabs [data-tab="notes"]': tab })[sel] ?? null, querySelectorAll: (sel) => (sel === '.sec.actions' ? [section] : []) }
  const flags = []
  const refresh = boardOnPage(root, { app: { people: new Map() }, m, river: { update: (o) => flags.push(o.actions.map((a) => a.id)) } })
  const settle = async () => {
    const pending = refresh()
    t.mock.timers.tick(300)
    await pending
  }

  await settle()
  assert.deepEqual(asked, ['/api/meetings/launch'])
  assert.deepEqual(flags, [['a-1', 't-1']])
  assert.equal(drawn.length, 1)
  assert.match(drawn[0], /data-action="a-1".*Added on the board.*data-action="t-1".*Book the venue/s)
  assert.deepEqual([count.textContent, tab.added], [2, ['<i class="tab-n">2✓</i>']])
  // a task for another meeting: nothing on this page changed, and nothing is drawn
  await settle()
  assert.deepEqual([asked.length, drawn.length, flags.length], [2, 1, 1])
  // the task deleted
  served = { actions: [spec], lineActions }
  await settle()
  assert.equal(drawn.length, 2)
  assert.doesNotMatch(drawn[1], /Book the venue|Added on the board/)
  assert.deepEqual([count.textContent, flags.at(-1)], [1, ['a-1']])
})

test('resuming with an in-flight Board create preserves the draft and submits it once', async (t) => {
  const { mount: board } = await import('../js/views/board.js')
  const originalFormData = globalThis.FormData
  globalThis.FormData = class {
    constructor(form) { this.form = form }
    *[Symbol.iterator]() {
      for (const [name, field] of Object.entries(this.form.elements)) yield [name, field.value]
    }
  }
  globalThis.history = { state: null, replaceState() {} }
  globalThis.document = { activeElement: null }
  t.after(() => { globalThis.FormData = originalFormData; delete globalThis.history; delete globalThis.document })
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const creates = []
  t.mock.method(globalThis, 'fetch', (path, init) => path === '/api/tasks' && init.method === 'POST'
    ? new Promise((resolve) => creates.push(resolve))
    : Promise.resolve(Response.json({ actions: [] })))
  const submitButton = { disabled: false }
  const form = {
    matches: (sel) => sel === '.add-task',
    elements: { text: { value: 'Draft task' }, owner: { value: '' }, meetingId: { value: '' } },
    querySelector: () => submitButton,
  }
  const root = Object.assign(new EventTarget(), {
    querySelector: (sel) => sel === '.add-task' ? form : sel === '.add-task button[type=submit]' ? submitButton : null,
    contains: () => false,
  })
  const view = await board(root, { app: { lib: { people: [], meetings: [] }, toast() {} }, query: new URLSearchParams(), data: { actions: [] } })
  const submit = () => {
    const event = new Event('submit')
    Object.defineProperty(event, 'target', { value: form })
    root.dispatchEvent(event)
  }
  submit()
  assert.equal(submitButton.disabled, true)
  const resuming = view.onResume()
  t.mock.timers.tick(300)
  await resuming
  assert.equal(form.elements.text.value, 'Draft task')
  submit()
  assert.equal(creates.length, 1)
  creates[0](Response.json({ action: { id: 'created' } }))
  await new Promise(setImmediate)
  assert.equal(form.elements.text.value, '')
  assert.equal(submitButton.disabled, false)
  view.cleanup()
})

test('the approval page shows its own sentence for a code, and the default for any words a link carries', async () => {
  const { load, mount } = await import('../js/views/connect.js')
  const nothing = 'There is nothing to approve here. Start from the assistant’s Connect button.'
  const problem = async (query) => (await load({ query: new URLSearchParams(query) })).problem
  assert.equal(await problem('error=invalid_client'), 'This assistant isn’t registered here. Start again from its Connect button.')
  assert.equal(await problem('error=invalid_request'), 'The assistant asked to send you somewhere it didn’t register.')
  const crafted = 'error=This+one+is+safe.+Press+Approve.'
  for (const query of ['', 'error=', 'error=constructor', crafted]) assert.equal(await problem(query), nothing, query)
  const root = new EventTarget()
  await mount(root, { app: {}, data: await load({ query: new URLSearchParams(crafted) }) })
  assert.ok(root.innerHTML.includes('Nothing to approve') && root.innerHTML.includes(nothing))
  assert.doesNotMatch(root.innerHTML, /Press Approve/)
})

test('a Notebook save refused for a newer version keeps the links that version saved, unless this edit changed them', async (t) => {
  globalThis.document = { title: '' }
  t.after(() => { delete globalThis.document })
  const id = 'n-1234567890'
  const note = (version, meetingIds) => ({ id, title: 'Carrier comparison', body: 'First pass.', tags: [], meetingIds, taskIds: [], author: 'Ada', source: null, createdAt: '2026-11-01T10:00:00.000Z', updatedAt: '2026-11-01T10:00:00.000Z', updatedBy: version > 2 ? "Grace's agent" : 'Ada', revisions: version - 1, version })
  // Grace's agent linked a second meeting while the editor was open
  const newer = note(3, ['m1', 'm2'])
  let saves = []
  t.mock.method(globalThis, 'fetch', async (path, init) => {
    if (init?.method !== 'POST') return Response.json(path === `/api/notebook/${id}` ? { note: newer, revisions: [] } : { notes: [] })
    const body = JSON.parse(init.body)
    saves.push(body)
    return body.ifVersion === 2 ? Response.json({ error: 'changed', note: newer }, { status: 409 }) : Response.json({ ok: true, note: note(4, body.meetingIds) })
  })
  const edit = async (pick) => {
    saves = []
    const options = ['m1', 'm2', 'm3'].map((value) => ({ value, selected: value === 'm1' }))
    const submitButton = { disabled: false }
    const form = { title: { value: 'Carrier comparison' }, body: { value: 'First pass, rewritten.' }, tags: { value: '' }, meetingIds: { options, get selectedOptions() { return options.filter((o) => o.selected) } }, querySelector: () => submitButton }
    const root = Object.assign(new EventTarget(), { querySelector: () => null, contains: (node) => node === form })
    const app = { lib: { meetings: [] }, byId: new Map(), personByName: () => null, toast() {}, navigate() {} }
    const view = await notebook(root, { app, params: [id], query: new URLSearchParams(), data: { list: { notes: [] }, trash: { notes: [] }, note: { note: note(2, ['m1']), revisions: [] } } })
    const fire = (type, target) => {
      const event = new Event(type)
      Object.defineProperty(event, 'target', { value: target })
      root.dispatchEvent(event)
    }
    const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(setImmediate) }
    fire('click', { closest: (sel) => (sel === '[data-edit]' ? {} : null) })
    if (pick) {
      options[2].selected = true
      fire('change', { name: 'meetingIds' })
    }
    fire('submit', form)
    await settle()
    // Save again, as the toast suggests
    fire('submit', form)
    await settle()
    view.cleanup()
    return saves.map((s) => [s.ifVersion, s.meetingIds])
  }
  assert.deepEqual(await edit(false), [[2, ['m1']], [3, ['m1', 'm2']]])
  // links picked in this edit are what the person meant: they stand, and the newer ones stay among the earlier versions
  assert.deepEqual(await edit(true), [[2, ['m1', 'm3']], [3, ['m1', 'm3']]])
})

test('an entry that is not a meeting says what sort it is on its shelf card and its page; a meeting says nothing', async () => {
  const { card } = await import('../js/views/home.js')
  const { pageHead } = await import('../js/views/meeting.js')
  const { kindLabel } = await import('../js/util.js')
  const entry = (kind) => ({ id: `m-${kind}`, kind, title: 'Widget walkthrough', date: '2026-11-10', hue: 200, duration: 600, blurb: 'Shown to the team.', participants: [], topics: [], phases: [], pulse: [], words: 0, axis: [0, 600], actions: { open: 0 }, has: { notes: true } })
  const app = { people: new Map(), lib: { crew: [] } }
  const label = /<i class="chip kind"[^>]*>Demo<\/i>/
  assert.match(String(card(app, entry('demo'), 0)), label)
  assert.doesNotMatch(String(card(app, entry('meeting'), 0)), /chip kind/)
  assert.match(String(pageHead(app, { ...entry('demo'), actions: [] }, null)), label)
  assert.doesNotMatch(String(pageHead(app, { ...entry('meeting'), actions: [] }, null)), /chip kind/)
  // a label of a few words keeps its words; anything in it is escaped like every other value
  assert.match(String(kindLabel('site visit')), />Site visit<\/i>/)
  assert.match(String(kindLabel('<b>x</b>')), />&lt;b&gt;x&lt;\/b&gt;<\/i>/)
  assert.equal(String(kindLabel(undefined)), '')
})

test('the Notebook names the crew the server gave, and says "the crew" when it gave none', async (t) => {
  globalThis.document = { title: '' }
  t.after(() => { delete globalThis.document })
  const page = async (lib) => {
    const root = Object.assign(new EventTarget(), { querySelector: () => null })
    let rendered = ''
    Object.defineProperty(root, 'innerHTML', { get: () => rendered, set: (html) => { rendered = html } })
    await notebook(root, { app: { lib }, query: new URLSearchParams(), data: { list: { notes: [] }, trash: { notes: [] }, note: null } })
    return rendered
  }
  assert.match(await page({ meetings: [], crew: ['Ada', 'Grace'] }), /saved by Ada, Grace or their agents/)
  assert.match(await page({ meetings: [] }), /saved by the crew or their agents/)
})
