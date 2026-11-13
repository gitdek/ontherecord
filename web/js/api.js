// Talking to the server. Cloudflare Access answers an expired session with a redirect to its login page;
// with redirect: 'manual' that shows up as an opaque redirect, and we ask for a reload instead of failing oddly.

export class SessionExpired extends Error {}

async function reach(path, init) {
  init?.signal?.throwIfAborted()
  let res
  try {
    res = await fetch(path, { redirect: 'manual', credentials: 'same-origin', ...init })
  } catch (err) {
    if (!init?.signal?.aborted && err.name !== 'AbortError') window.dispatchEvent(new CustomEvent('connection', { detail: 'down' }))
    throw err
  }
  init?.signal?.throwIfAborted()
  if (res.type === 'opaqueredirect' || res.status === 401) {
    window.dispatchEvent(new CustomEvent('connection', { detail: 'expired' }))
    throw new SessionExpired('Your Cloudflare Access session expired')
  }
  return res
}

async function call(path, init = {}) {
  const res = await reach(path, init)
  const body = await res.json().catch(() => ({}))
  init.signal?.throwIfAborted()
  // the status and the body ride along: a refused change (409) carries the item as it now stands
  if (!res.ok) throw Object.assign(new Error(body.error || `${res.status} ${res.statusText}`), { status: res.status, body })
  return body
}

export const get = (path, signal) => call(path, { signal, headers: { accept: 'application/json' } })

export const post = (path, data, signal) =>
  call(path, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', accept: 'application/json', 'x-requested-with': 'meetings' },
    body: JSON.stringify(data),
  })

const GROUNDING = new Set(['cited', 'uncited', 'invalid', 'no-sources'])
const ANSWER_EVENTS = ['sources', 'text', 'done', 'error']
const validSource = (s) =>
  Number.isInteger(s?.n) && s.n > 0 && typeof s.title === 'string' && typeof s.link === 'string' &&
  /^\/(?!\/)[^\\\s]*$/.test(s.link) && (s.when == null || typeof s.when === 'string')

// Ask sends a sources record, then text fragments, then exactly one done or error record.
// A failed request or an EOF before a terminal record interrupts the answer.
export async function stream(path, data, onLine, signal) {
  const res = await reach(path, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', accept: 'application/x-ndjson', 'x-requested-with': 'meetings' },
    body: JSON.stringify(data),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw Object.assign(new Error(body.error || `${res.status} ${res.statusText}`), { status: res.status, body })
  }
  if (!res.body) throw new Error('The answer stream did not open')
  const reader = res.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let buf = ''
  let sources
  const cancel = () => void reader.cancel().catch(() => {})
  const receive = (line) => {
    signal?.throwIfAborted()
    if (!line.trim()) return
    let event
    try {
      event = JSON.parse(line)
    } catch {
      throw new Error('The answer stream contained malformed JSON')
    }
    const kinds = event && typeof event === 'object' ? ANSWER_EVENTS.filter((key) => Object.hasOwn(event, key)) : []
    const kind = kinds.length === 1 && kinds[0]
    if (kind === 'error' && typeof event.error === 'string' && event.error) throw new Error(event.error)
    if (kind === 'done' && sources && event.done === true && Array.isArray(event.cited) &&
      event.cited.every((n) => sources.has(n)) && GROUNDING.has(event.grounding)) return event
    if (kind === 'sources' && !sources && Array.isArray(event.sources) && event.sources.every(validSource)) {
      sources = new Set(event.sources.map((source) => source.n))
      if (sources.size !== event.sources.length) throw new Error('The answer stream repeated a source')
    } else if (kind !== 'text' || !sources || typeof event.text !== 'string') {
      throw new Error('The answer stream sent an invalid event')
    }
    onLine(event)
  }
  signal?.addEventListener('abort', cancel, { once: true })
  try {
    for (;;) {
      signal?.throwIfAborted()
      const { value, done } = await reader.read()
      signal?.throwIfAborted()
      buf += done ? decoder.decode() : decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = done ? '' : lines.pop()
      for (const line of lines) {
        const terminal = receive(line)
        if (terminal) return terminal
      }
      if (done) throw new Error('The answer stream ended before completion')
    }
  } finally {
    signal?.removeEventListener('abort', cancel)
    cancel()
    reader.releaseLock()
  }
}

// onReconnect: the stream is open again after it ended. The server sends a change only to the pages connected at
// that moment, so whatever happened in between has to be fetched.
export function connect(handlers, onStatus, onReconnect) {
  let es
  let retry = 1000
  let timer
  let stopped = false
  let opened = false
  const request = new AbortController()
  const open = () => {
    if (stopped) return
    const source = es = new EventSource(`/api/events?page=${encodeURIComponent(location.pathname)}`)
    const current = () => !stopped && es === source
    source.onopen = () => {
      if (!current()) return
      retry = 1000
      onStatus('live')
      if (opened) onReconnect?.()
      opened = true
    }
    // The server ends each stream when the sign-in that opened it runs out (ten minutes at most) and the
    // browser reconnects through Access. If that reconnect is refused, ask once whether the session expired.
    source.onerror = () => {
      if (!current()) return
      onStatus('down')
      if (source.readyState === EventSource.CLOSED) {
        get('/api/me', request.signal).catch(() => {})
        clearTimeout(timer)
        timer = setTimeout(open, retry)
        retry = Math.min(retry * 2, 30_000)
      }
    }
    for (const [name, fn] of Object.entries(handlers)) source.addEventListener(name, (e) => {
      if (current()) fn(JSON.parse(e.data))
    })
  }
  open()
  return () => {
    stopped = true
    request.abort()
    clearTimeout(timer)
    es?.close()
  }
}
