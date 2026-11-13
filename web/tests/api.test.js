import assert from 'node:assert/strict'
import test from 'node:test'
import { connect, stream } from '../js/api.js'

const encoder = new TextEncoder()
const sources = { sources: [{ n: 1, title: 'Launch notes', link: '/m/demo?tab=excerpt&file=demo' }] }
const terminal = { done: true, cited: [1], grounding: 'cited' }
const line = (record) => `${JSON.stringify(record)}\n`

function response(t) {
  let controller
  let canceled = 0
  const body = new ReadableStream({
    start(c) { controller = c },
    cancel() { canceled++ },
  })
  t.mock.method(globalThis, 'fetch', async () => new Response(body))
  return {
    send: (value) => controller.enqueue(typeof value === 'string' ? encoder.encode(value) : value),
    close: () => controller.close(),
    get canceled() { return canceled },
    body,
  }
}

test('Ask handles split UTF-8 and NDJSON, including a terminal record without a final newline', async (t) => {
  const remote = response(t)
  const fragment = { text: 'Café [1]' }
  const data = encoder.encode(line(sources) + line(fragment) + JSON.stringify(terminal))
  for (const byte of data) remote.send(Uint8Array.of(byte))
  remote.close()
  const events = []
  assert.deepEqual(await stream('/api/ask', {}, (e) => events.push(e)), terminal)
  assert.deepEqual(events, [sources, fragment])
  assert.equal(remote.body.locked, false)
})

test('Ask stops at the terminal record and releases the reader even if the stream stays open', async (t) => {
  const remote = response(t)
  remote.send(line(sources) + line(terminal) + line({ text: 'late event' }))
  const events = []
  assert.deepEqual(await stream('/api/ask', {}, (e) => events.push(e)), terminal)
  assert.deepEqual(events, [sources])
  assert.equal(remote.canceled, 1)
  assert.equal(remote.body.locked, false)
})

test('Ask reports malformed records, invalid completion, server errors and premature EOF', async (t) => {
  const cases = [
    ['{unfinished\n', /malformed JSON/],
    [line({ ...terminal, cited: [99] }), /invalid event/],
    [line({ ...terminal, grounding: 'unknown' }), /invalid event/],
    [line(sources), /invalid event/],
    [line({ text: 'partial answer' }), /ended before completion/],
    [line({ error: 'The model stopped early' }) + line(terminal), /stopped early/],
  ]
  for (const [tail, error] of cases) {
    await t.test(String(error), async (t) => {
      const remote = response(t)
      remote.send(line(sources) + tail)
      remote.close()
      await assert.rejects(stream('/api/ask', {}, () => {}), error)
      assert.equal(remote.body.locked, false)
    })
  }
})

test('an incomplete UTF-8 sequence fails at EOF', async (t) => {
  const remote = response(t)
  remote.send(line(sources))
  remote.send(Uint8Array.of(0xe2, 0x82))
  remote.close()
  await assert.rejects(stream('/api/ask', {}, () => {}), TypeError)
  assert.equal(remote.body.locked, false)
})

test('aborting Ask unblocks the pending reader and suppresses later events', async (t) => {
  const remote = response(t)
  const request = new AbortController()
  const events = []
  const reading = stream('/api/ask', {}, (e) => events.push(e), request.signal)
  remote.send(line(sources))
  await new Promise(setImmediate)
  assert.deepEqual(events, [sources])
  remote.send(line(terminal))
  request.abort()
  await assert.rejects(reading, { name: 'AbortError' })
  assert.deepEqual(events, [sources])
  assert.equal(remote.canceled, 1)
  assert.equal(remote.body.locked, false)
})

test('closing the live connection drops queued callbacks and cancels its retry', async (t) => {
  const sources = []
  class FakeEventSource extends EventTarget {
    static CLOSED = 2
    constructor(path) {
      super()
      this.path = path
      sources.push(this)
    }
    close() { this.readyState = FakeEventSource.CLOSED }
    hello(id) { this.dispatchEvent(new MessageEvent('hello', { data: JSON.stringify(id) })) }
  }
  Object.assign(globalThis, { EventSource: FakeEventSource, location: { pathname: '/actions' } })
  t.after(() => { delete globalThis.EventSource; delete globalThis.location })
  t.mock.method(globalThis, 'fetch', async () => Response.json({}))
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const seen = []
  const stop = connect({ hello: (id) => seen.push(id) }, (status) => seen.push(status))
  assert.equal(sources[0].path, '/api/events?page=%2Factions')
  sources[0].onopen()
  sources[0].hello('previous')
  sources[0].readyState = FakeEventSource.CLOSED
  sources[0].onerror()
  stop()
  sources[0].onopen()
  sources[0].onerror()
  sources[0].hello('queued')
  const stopResumed = connect({ hello: (id) => seen.push(id) }, (status) => seen.push(status))
  sources[1].hello('resumed')
  t.mock.timers.tick(30_000)
  assert.equal(sources.length, 2)
  assert.deepEqual(seen, ['live', 'previous', 'down', 'resumed'])
  stopResumed()
})

test('a live stream that opens again asks the page to catch up, and its first opening does not', async (t) => {
  const sources = []
  class FakeEventSource extends EventTarget {
    static CLOSED = 2
    constructor(path) {
      super()
      this.path = path
      sources.push(this)
    }
    close() { this.readyState = FakeEventSource.CLOSED }
    hello(id) { this.dispatchEvent(new MessageEvent('hello', { data: JSON.stringify(id) })) }
  }
  Object.assign(globalThis, { EventSource: FakeEventSource, location: { pathname: '/actions' } })
  t.after(() => { delete globalThis.EventSource; delete globalThis.location })
  t.mock.method(globalThis, 'fetch', async () => Response.json({}))
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const seen = []
  const stop = connect({ hello: (id) => seen.push(id) }, (status) => seen.push(status), () => seen.push('catch up'))
  sources[0].onopen()
  sources[0].hello('first')
  // the server ends the stream (within ten minutes, and on every restart) and the browser reconnects on its own;
  // what changed meanwhile was sent to the pages that were connected
  sources[0].readyState = 0
  sources[0].onerror()
  sources[0].onopen()
  sources[0].hello('second')
  // a stream the browser gave up on is opened again from here, and catches up the same way
  sources[0].readyState = FakeEventSource.CLOSED
  sources[0].onerror()
  t.mock.timers.tick(1000)
  sources[1].onopen()
  sources[1].hello('third')
  stop()
  sources[1].onopen()
  assert.deepEqual(seen, ['live', 'first', 'down', 'live', 'catch up', 'second', 'down', 'live', 'catch up', 'third'])
})
