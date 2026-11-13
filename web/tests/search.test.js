import assert from 'node:assert/strict'
import test from 'node:test'
import { hitHref } from '../js/palette.js'
globalThis.innerWidth = 1024
globalThis.innerHeight = 768
const { mount } = await import('../js/views/search.js')

const app = { lib: { threads: [{ term: 'Launch', total: 2 }], people: [], ask: true }, byId: new Map() }
const tick = () => new Promise(setImmediate)

function harness(t, value) {
  const requests = []
  t.mock.method(globalThis, 'fetch', (path, { signal }) => new Promise((resolve) => requests.push({ path, signal, resolve })))
  const paths = []
  globalThis.history = { state: null, replaceState: (_state, _title, path) => paths.push(path) }
  t.after(() => { delete globalThis.history })
  const input = Object.assign(new EventTarget(), { value, focus() {}, setSelectionRange() {} })
  const out = { innerHTML: '', querySelector: () => null }
  const answer = { innerHTML: '', hidden: true, replaceChildren() { this.innerHTML = '' } }
  const nodes = { input, '.results': out, '.answer': answer, form: new EventTarget() }
  const root = Object.assign(new EventTarget(), { dataset: { view: 'search' }, querySelector: (sel) => nodes[sel], querySelectorAll: () => [] })
  const click = (selector, dataset = {}) => {
    const event = new Event('click')
    Object.defineProperty(event, 'target', { value: { closest: (sel) => sel === selector ? { dataset } : sel === '[data-view]' ? root : null } })
    root.dispatchEvent(event)
  }
  return { root, input, out, answer, requests, paths, click }
}

test('clearing a query immediately invalidates an already running search', async (t) => {
  const { root, input, out, requests, paths } = harness(t, 'old')
  const view = await mount(root, { app, query: new URLSearchParams('q=old') })
  assert.match(requests[0].path, /q=old.*typing=0/)
  input.value = ''
  input.dispatchEvent(new Event('input'))
  assert.equal(requests[0].signal.aborted, true)
  assert.equal(paths.at(-1), '/search')
  assert.match(out.innerHTML, /search-empty/)
  requests[0].resolve(Response.json({ error: 'stale result' }))
  await tick()
  assert.match(out.innerHTML, /search-empty/)
  assert.doesNotMatch(out.innerHTML, /stale result/)
  view.cleanup()
})

test('leaving Search cancels a scheduled search while the destination can still be loading', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { root, input, requests, paths } = harness(t, '')
  const view = await mount(root, { app, query: new URLSearchParams() })
  input.value = 'new page in flight'
  input.dispatchEvent(new Event('input'))
  view.onLeave()
  t.mock.timers.tick(1000)
  assert.deepEqual(paths, ['/search'])
  assert.equal(requests.length, 0)
  view.cleanup()
})

test('Ask ignores older error and completion records and displays an interrupted answer at EOF', async (t) => {
  const { root, input, answer, requests, click } = harness(t, '')
  const view = await mount(root, { app, query: new URLSearchParams() })
  input.value = 'First question'
  click('[data-ask]')
  input.value = 'Second question'
  input.dispatchEvent(new Event('input'))
  click('[data-ask]')
  assert.equal(requests[0].signal.aborted, true)
  requests[0].resolve(new Response('{"error":"old error"}\n'))
  requests[1].resolve(new Response('{"sources":[]}\n{"text":"Partial second answer"}\n'))
  await tick()
  assert.match(answer.innerHTML, /interrupted .*ended before completion/)
  assert.match(answer.innerHTML, /Partial second answer/)
  assert.doesNotMatch(answer.innerHTML, /old error/)

  click('[data-ask]')
  input.value = ''
  input.dispatchEvent(new Event('input'))
  requests[2].resolve(new Response('{"sources":[]}\n{"done":true,"cited":[],"grounding":"no-sources"}\n'))
  await tick()
  assert.equal(answer.hidden, true)
  assert.equal(answer.innerHTML, '')
  view.cleanup()
})

test('Ask labels an uncited completion and shows source links separately', async (t) => {
  const { root, input, answer, requests, click } = harness(t, '')
  const view = await mount(root, { app, query: new URLSearchParams() })
  input.value = 'Which document?'
  click('[data-ask]')
  requests[0].resolve(new Response([
    { sources: [{ n: 1, title: 'Launch notes', link: '/m/demo?tab=excerpt&file=launch' }] },
    { text: 'An uncited answer.' },
    { done: true, cited: [], grounding: 'uncited' },
  ].map(JSON.stringify).join('\n')))
  await tick()
  assert.match(answer.innerHTML, /completed without citations/)
  assert.match(answer.innerHTML, /href="\/m\/demo\?tab=excerpt&amp;file=launch"/)
  view.cleanup()
})

test('settled search renders semantic-only rows and their counts in both views', async (t) => {
  const { root, out, requests, click } = harness(t, 'launch')
  const saved = new Map()
  globalThis.localStorage = { getItem: (k) => saved.get(k), setItem: (k, v) => saved.set(k, v) }
  t.after(() => { delete globalThis.localStorage })
  const view = await mount(root, { app, query: new URLSearchParams('q=launch') })
  const h = { kind: 'doc', meetingId: 'demo', fileId: 'launch', text: 'Found by meaning', marks: [], meaning: true, link: '/m/demo?tab=excerpt&file=launch' }
  const hits = [h, ...Array.from({ length: 12 }, (_, i) => ({ ...h, fileId: `extra-${i}`, text: `Extra hit ${i}` }))]
  const result = { total: 15, fuzzy: {}, hits, fused: hits, meetings: [{ id: 'demo', count: 15 }], related: [h] }
  requests[0].resolve(Response.json(result))
  await tick()
  assert.match(out.innerHTML, /href="\/m\/demo\?tab=excerpt&amp;file=launch"/)
  assert.match(out.innerHTML, /\+2 more, by meeting/)
  click('button[data-view]', { view: 'meetings' })
  requests[1].resolve(Response.json(result))
  await tick()
  assert.match(out.innerHTML, /<details class="more-hits"><summary class="more">\+1 more in this meeting<\/summary><ol>.*?<\/ol><\/details>/s)
  assert.match(out.innerHTML, /\+2 more in this meeting beyond this result window/)
  assert.match(out.innerHTML, /15 hits/)
  assert.equal(out.innerHTML.match(/Found by meaning/g).length, 1)
  view.cleanup()
})

test('the On screen filter submits a settled screen query', async (t) => {
  const { root, input, requests, click } = harness(t, 'launch')
  const view = await mount(root, { app: { ...app, lib: { ...app.lib, screenSearch: true } }, query: new URLSearchParams('q=launch') })
  t.after(() => view.cleanup())
  assert.match(root.innerHTML, /data-area="in:screen"/)
  click('[data-area]', { area: 'in:screen' })
  assert.equal(input.value, 'launch in:screen')
  const search = new URL(requests.at(-1).path, 'http://fixture.invalid').searchParams
  assert.equal(search.get('q'), 'launch in:screen')
  assert.equal(search.get('typing'), '0')
})

test('search links keep precise document, notebook, action and transcript targets', () => {
  assert.equal(hitHref({ kind: 'doc', meetingId: 'demo', fileId: 'a & b' }, 'a'), '/m/demo?tab=excerpt&file=a+%26+b')
  assert.equal(hitHref({ kind: 'kb', link: '/notebook/n-123' }, 'a'), '/notebook/n-123')
  assert.equal(hitHref({ kind: 'update', link: '/actions?show=all&focus=task' }, 'a'), '/actions?show=all&focus=task')
  assert.equal(hitHref({ kind: 'transcript', link: '/m/demo?t=2.5&tab=transcript' }, 'in:transcript "a phrase"'), '/m/demo?t=2.5&tab=transcript&q=a+phrase')
})

test('a person chip names one person, and a name two people share says who each of them is', async (t) => {
  const people = [
    { id: 'ada-byron', name: 'Ada Byron', short: 'Ada', crew: true, hue: 10, meetings: ['a', 'b'] },
    { id: 'ada-lovelace', name: 'Ada Lovelace', short: 'Ada', crew: false, hue: 20, meetings: ['c', 'd'] },
  ]
  const { root, input, out, requests, click } = harness(t, 'pricing person:ada')
  const view = await mount(root, { app: { ...app, lib: { ...app.lib, people } }, query: new URLSearchParams('q=pricing+person:ada') })
  t.after(() => view.cleanup())
  // both chips read "Ada"; each sends the form that names only its own Ada
  assert.match(root.innerHTML, /data-person="ada-byron"[^>]*>.*Ada<\/button>/s)
  assert.match(root.innerHTML, /data-person="ada-lovelace"/)
  requests[0].resolve(Response.json({ total: 0, hits: [], fused: [], meetings: [], fuzzy: {}, badFilters: [], unknownPeople: [], ambiguousPeople: [{ name: 'ada', ids: ['ada-byron', 'ada-lovelace'] }] }))
  await tick()
  assert.match(out.innerHTML, /More than one person is called <b>ada<\/b>: Ada Byron \(<code>person:ada-byron<\/code>\) or Ada Lovelace \(<code>person:ada-lovelace<\/code>\)\./)
  input.value = 'pricing'
  click('[data-person]', { person: 'ada-lovelace' })
  assert.equal(input.value, 'pricing person:ada-lovelace')
  assert.equal(new URL(requests.at(-1).path, 'http://fixture.invalid').searchParams.get('q'), 'pricing person:ada-lovelace')
})

test('a result from a demo carries a label beside its title, a meeting none, and kind: says what it takes', async (t) => {
  const { root, out, requests, click } = harness(t, 'widget')
  const saved = new Map()
  globalThis.localStorage = { getItem: (k) => saved.get(k), setItem: (k, v) => saved.set(k, v) }
  t.after(() => { delete globalThis.localStorage })
  const shelf = [{ id: 'show', kind: 'demo', title: 'Widget show', date: '2026-11-10', hue: 200 }, { id: 'plan', kind: 'meeting', title: 'Widget plan', date: '2026-11-09', hue: 20 }]
  const byId = new Map(shelf.map((m) => [m.id, m]))
  const view = await mount(root, { app: { ...app, byId, lib: { ...app.lib, meetings: shelf } }, query: new URLSearchParams('q=widget') })
  t.after(() => view.cleanup())
  const hit = (meetingId) => ({ kind: 'summary', meetingId, text: 'The widget', marks: [], link: `/m/${meetingId}` })
  const result = { total: 2, fuzzy: {}, hits: [hit('show'), hit('plan')], fused: [hit('show'), hit('plan')], meetings: [{ id: 'show', count: 1 }, { id: 'plan', count: 1 }], related: [] }
  requests[0].resolve(Response.json(result))
  await tick()
  assert.match(out.innerHTML, /<b>Widget show<\/b><i class="chip kind"[^>]*>Demo<\/i>/)
  assert.match(out.innerHTML, /<b>Widget plan<\/b> ·/)
  assert.equal(out.innerHTML.match(/chip kind/g).length, 1)
  click('button[data-view]', { view: 'meetings' })
  requests[1].resolve(Response.json(result))
  await tick()
  assert.match(out.innerHTML, /<a href="\/m\/show">Widget show<\/a><i class="chip kind"[^>]*>Demo<\/i>/)
  assert.match(out.innerHTML, /<a href="\/m\/plan">Widget plan<\/a><span>/)
  // a kind nobody has: the answer says which kinds there are
  const empty = { total: 0, hits: [], fused: [], meetings: [], fuzzy: {}, unknownPeople: [] }
  click('button[data-view]', { view: 'meetings' })
  requests[2].resolve(Response.json({ ...empty, badFilters: ['-kind:webinar'] }))
  await tick()
  assert.match(out.innerHTML, /<b>-kind:webinar<\/b> isn't a filter this search can use: kind: takes meeting or demo\./)
})
