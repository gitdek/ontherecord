// App shell: routing, live updates from the server, the header (presence, live light), toasts and shortcuts.
import { connect, get, post } from './api.js'
import { avatar, trackEyes } from './art.js'
import { said } from './board-words.js'
import { SKIP } from './deck.js'
import { openPalette } from './palette.js'
import { $, $$, coalesce, decode, el, html, local, raw, reducedMotion } from './util.js'
import * as board from './views/board.js'
import * as cast from './views/cast.js'
import * as connectPage from './views/connect.js'
import * as follow from './views/follow.js'
import * as home from './views/home.js'
import * as lab from './views/lab.js'
import * as meeting from './views/meeting.js'
import * as notebook from './views/notebook.js'
import * as search from './views/search.js'

export const app = {
  lib: null,
  me: null,
  people: new Map(),
  byId: new Map(),
  clientId: null,
  presence: [],
  view: null,
  navigate,
  toast,
  refreshLibrary,
  personByName,
}

// the last column is what the browser tab says; a meeting or a note puts its own title there once it loads
const routes = [
  [/^\/$/, 'home', home, ''],
  [/^\/m\/([^/]+)\/?$/, 'meeting', meeting, 'Meeting'],
  [/^\/actions\/?$/, 'actions', board, 'Board'],
  [/^\/people\/?$/, 'people', cast, 'Cast'],
  [/^\/search\/?$/, 'search', search, 'Search'],
  [/^\/follow\/?$/, 'follow', follow, 'Follow'],
  [/^\/connect\/?$/, 'connect', connectPage, 'Connect an assistant'],
  [/^\/notebook(?:\/(n-[a-f0-9]{10}))?\/?$/, 'notebook', notebook, 'Notebook'],
  [/^\/lab\/?$/, 'lab', lab, 'Lab'],
]

// Dark is the house look; each person's choice is saved with their name, so it follows them between devices.
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme
  local.set('theme', theme)
  const btn = $('#theme')
  btn.setAttribute('aria-label', theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode')
  window.dispatchEvent(new CustomEvent('themechange', { detail: theme }))
}

$('#theme').addEventListener('click', (e) => {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'
  const r = e.currentTarget.getBoundingClientRect()
  const root = document.documentElement
  root.style.setProperty('--flip-x', `${Math.round(r.left + r.width / 2)}px`)
  root.style.setProperty('--flip-y', `${Math.round(r.top + r.height / 2)}px`)
  if (document.startViewTransition && !reducedMotion()) {
    root.classList.add('theme-flip')
    const vt = document.startViewTransition(() => applyTheme(next))
    vt.ready.catch(() => {})
    vt.finished.catch(() => {}).finally(() => root.classList.remove('theme-flip'))
  } else applyTheme(next)
  if (app.me) app.me.theme = next
  post('/api/prefs', { theme: next }).catch(() => {})
})

async function refreshLibrary(signal) {
  const lib = await get('/api/library', signal)
  signal?.throwIfAborted()
  // what this browser remembers (where each tape was left, speed, recent searches…) is kept per person
  if (!app.lib) local.viewer(lib.me?.name)
  if (!app.lib && lib.me?.theme) applyTheme(lib.me.theme)
  app.lib = lib
  app.me = lib.me
  app.people = new Map(lib.people.map((p) => [p.id, p]))
  app.byId = new Map(lib.meetings.map((m) => [m.id, m]))
  const badge = $('#open-count')
  badge.hidden = !lib.stats.open
  badge.textContent = lib.stats.open
  return lib
}

// "Grace" (a viewer name from Cloudflare Access) → Grace Hopper's creature
function personByName(name) {
  const n = String(name ?? '').toLowerCase()
  return [...app.people.values()].find((p) => p.short.toLowerCase() === n || p.aliases.includes(n) || p.name.toLowerCase() === n)
}

// ---------- routing ----------

let rendering = 0
// moved: the person went to another page (a link, back or forward), not a first load or a redraw in place
async function render({ moved = false } = {}) {
  const token = ++rendering
  app.view?.onLeave?.()
  const path = location.pathname
  const [re, name, mod, title] = routes.find(([r]) => r.test(path)) ?? [/^/, 'missing', { mount: missing }, 'Not found']
  // an optional route segment that didn't match stays undefined (decodeURIComponent would make it "undefined")
  const params = (path.match(re) ?? []).slice(1).map((v) => (v === undefined ? undefined : decode(v)))
  const ctx = { app, params, query: new URLSearchParams(location.search) }
  let data
  if (mod.load) {
    document.body.classList.add('loading')
    try {
      data = await mod.load(ctx)
    } catch (err) {
      data = { error: err }
    } finally {
      document.body.classList.remove('loading')
    }
    if (token !== rendering) return
  }
  const swap = async () => {
    // a transition waits for a frame, so a newer navigation can get here first: leave its page alone
    if (token !== rendering) return
    app.view?.cleanup?.()
    app.view = null
    document.title = title ? `${title} · On the Record` : 'On the Record'
    // Views hang their listeners on this element. Each one gets a fresh copy of it, so the last view's
    // listeners leave with the old element and anything it still renders late lands nowhere.
    const old = $('#app')
    const root = old.cloneNode(false)
    old.replaceWith(root)
    root.dataset.view = name
    const api = await Promise.resolve()
      .then(() => {
        if (data?.error) throw data.error
        return mod.mount(root, { ...ctx, data })
      })
      .catch((err) => {
        root.innerHTML = String(html`<section class="oops"><h1>Tape jammed.</h1><p>${err.message}</p><a class="btn" href="/">Back to the shelf</a></section>`)
        return {}
      })
    if (token !== rendering) return api?.cleanup?.()
    app.view = { name, ...api }
    // only while a view that can hold unsaved work is open: the listener keeps Firefox from caching the page for Back
    if (api?.unsaved) addEventListener('beforeunload', warnUnload)
    else removeEventListener('beforeunload', warnUnload)
  }
  for (const a of $$('.nav a')) {
    a.classList.toggle('on', a.dataset.nav === name)
    if (a.dataset.nav === name) a.setAttribute('aria-current', 'page')
    else a.removeAttribute('aria-current')
  }
  if (document.startViewTransition && !reducedMotion() && document.visibilityState === 'visible' && app.view) {
    const vt = document.startViewTransition(swap)
    // a transition can be skipped (tab hidden, another navigation); the swap itself still runs
    vt.ready.catch(() => {})
    vt.finished.catch(() => {})
    await vt.updateCallbackDone.catch(() => {})
  } else await swap()
  if (token !== rendering) return
  // a screen reader hears the new page and Tab carries on from its top, unless the view put the cursor somewhere
  if (moved && !$('#app').contains(document.activeElement)) $('#app').focus({ preventScroll: true })
  reportPresence()
}

function missing(root) {
  root.innerHTML = String(html`<section class="oops"><h1>Nothing on this tape.</h1><p>That page doesn't exist.</p><a class="btn" href="/">Back to the shelf</a></section>`)
  return {}
}

// A view holding work that isn't saved (a note being written) says so, and leaving it asks first: a link or a key
// here, Back or Forward, and (the browser's own question) a reload or another site.
const stay = () => Boolean(app.view?.unsaved?.()) && !confirm('Leave this page? What you typed hasn’t been saved.')
function warnUnload(e) {
  if (!app.view?.unsaved?.()) return
  e.preventDefault()
  e.returnValue = ''
}
// Each entry this page puts in the tab's history carries its place (n), so a Back or Forward that is called off can
// be undone. An entry from before has none (null here) and is simply followed.
let place = Number.isInteger(history.state?.n) ? history.state.n : 0
history.replaceState({ ...(history.state ?? {}), n: place }, '')

function navigate(url, { replace = false } = {}) {
  if (stay()) return Promise.resolve()
  if (!replace) history.replaceState({ ...(history.state ?? {}), y: scrollY }, '')
  if (!replace) place = (place ?? 0) + 1
  history[replace ? 'replaceState' : 'pushState']({ y: 0, n: place }, '', url)
  return render({ moved: !replace }).then(() => !replace && scrollTo({ top: 0, behavior: 'instant' }))
}

addEventListener('popstate', (e) => {
  const to = Number.isInteger(e.state?.n) ? e.state.n : null
  // back on the entry that was kept: the move below was called off
  if (to !== null && to === place) return
  if (to !== null && place !== null && stay()) return history.go(place - to)
  place = to
  render({ moved: true }).then(() => scrollTo({ top: e.state?.y ?? 0, behavior: 'instant' }))
})

// the skip link moves the cursor past the header; it leaves the address alone, where a #fragment would re-route
$('.skip').addEventListener('click', (e) => {
  e.preventDefault()
  $('#app').focus()
})

document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href]')
  if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
  const href = a.getAttribute('href')
  if (!href.startsWith('/') || href.startsWith('//') || a.hasAttribute('download') || a.target || /^\/(media|thumbs|captions|api)\//.test(href)) return
  e.preventDefault()
  navigate(href)
})

// ---------- toasts ----------

// A toast can carry one action: a link to follow (href) or something to do on the spot (onAction).
export function toast({ icon = '📼', title, body = '', href, onAction, timeout = 6500, sticky = false, actionLabel = 'Open' }) {
  const t = el(
    html`<div class="toast" role="status">
      <span class="toast-icon" aria-hidden="true">${icon}</span>
      <div class="toast-text"><b>${title}</b>${body ? html`<p>${body}</p>` : ''}</div>
      ${href ? html`<a class="toast-go" href="${href}">${actionLabel}</a>` : onAction ? html`<button class="toast-go" type="button">${actionLabel}</button>` : ''}
      <button class="toast-x" type="button" aria-label="Dismiss">×</button>
    </div>`,
  )
  const close = () => {
    t.classList.add('out')
    setTimeout(() => t.remove(), 300)
  }
  t.querySelector('.toast-x').onclick = close
  t.querySelector('.toast-go')?.addEventListener('click', () => {
    if (!href) onAction?.()
    close()
  })
  $('#toasts').append(t)
  while ($('#toasts').children.length > 4) $('#toasts').firstElementChild.remove()
  if (!sticky) setTimeout(close, timeout)
  return close
}

// ---------- live updates ----------

function setLive(status) {
  const live = $('#live')
  live.dataset.state = status
  live.title = status === 'live' ? `Live: watching ${app.lib?.folder ?? 'the meetings folder'} for new tapes` : status === 'expired' ? 'Session expired: reload to sign in' : 'Reconnecting…'
  live.querySelector('b').textContent = status === 'live' ? 'LIVE' : status === 'expired' ? 'SIGN IN' : 'OFFLINE'
}

let expiredShown = false
addEventListener('connection', (e) => {
  if (e.detail !== 'expired' || expiredShown) return
  expiredShown = true
  stopUpdates()
  setLive('expired')
  // the full address: a path that starts with two slashes would read as another site
  toast({ icon: '🔒', title: 'Your sign-in expired', body: 'Cloudflare Access wants you to log in again.', href: location.href, actionLabel: 'Reload', sticky: true })
  $('.toast:last-child .toast-go')?.addEventListener('click', () => location.reload())
})
$('#live').addEventListener('click', () => $('#live').dataset.state === 'expired' && location.reload())

function renderPresence() {
  const others = new Map()
  for (const p of app.presence) if (p.id !== app.clientId && p.name !== app.me?.name) others.set(p.name, p)
  const box = $('#presence')
  box.innerHTML = [...others.values()]
    .map((p) => {
      const person = personByName(p.name)
      const where = pageLabel(p.page)
      return String(
        html`<span class="peer" title="${p.name} is here${where ? ` · ${where}` : ''}">${person ? raw(avatar(person, { size: 26 })) : html`<i class="peer-dot">${p.name[0]}</i>`}<span class="peer-name">${p.name}</span></span>`,
      )
    })
    .join('')
}
function pageLabel(page = '') {
  const m = /^\/m\/([^/?]+)/.exec(page)
  if (m) return `on “${app.byId.get(decode(m[1]))?.title ?? 'a meeting'}”`
  if (page.startsWith('/notebook')) return 'in the notebook'
  return { '/': 'on the shelf', '/actions': 'on the board', '/people': 'with the cast', '/lab': 'in the lab', '/search': 'searching' }[page] ?? ''
}

let presenceTimer
function reportPresence() {
  clearTimeout(presenceTimer)
  const id = app.clientId
  const signal = liveRequest?.signal
  if (!id) return
  presenceTimer = setTimeout(() => {
    if (app.clientId === id) post('/api/presence', { id, page: location.pathname }, signal).catch(() => {})
  }, 400)
}

// stopped once the sign-in expires, so an expired page stops receiving board updates
let stopLive
let liveRequest

function stopUpdates() {
  stopLive?.()
  stopLive = undefined
  liveRequest?.abort()
  clearTimeout(presenceTimer)
  app.clientId = null
  app.presence = []
  renderPresence()
  app.view?.onPresence?.([])
}

function startLive() {
  if (stopLive) return liveRequest
  const request = liveRequest = new AbortController()
  const refresh = () => refreshLibrary(request.signal).catch(() => null)
  // a burst of board changes (an agent working through a list) costs one refresh, not one each
  const refreshSoon = coalesce(refresh)
  stopLive = connect(
    {
      hello: (d) => {
        app.clientId = d.id
        reportPresence()
      },
      library: async (d) => {
        const before = app.byId
        if (!(await refresh()) || request.signal.aborted) return
        for (const id of d.added ?? []) {
          const m = app.byId.get(id)
          if (m) toast({ icon: '📼', title: 'New tape on the shelf', body: m.title, href: `/m/${m.id}` })
        }
        for (const id of d.changed ?? []) {
          const a = before.get(id)
          const b = app.byId.get(id)
          if (!a || !b) continue
          if (!a.has.notes && b.has.notes) toast({ icon: '📝', title: 'Notes just landed', body: b.title, href: `/m/${b.id}` })
          else if (!a.has.transcript && b.has.transcript) toast({ icon: '🗒️', title: 'Transcript just landed', body: b.title, href: `/m/${b.id}` })
          else if (a.processing && !b.processing) toast({ icon: '🎞️', title: 'Video finished writing', body: b.title, href: `/m/${b.id}` })
        }
        app.view?.onLibrary?.(d)
      },
      thumbs: async (d) => {
        if (!(await refreshSoon()) || request.signal.aborted) return
        app.view?.onThumbs?.(d)
      },
      state: async (d) => {
        if (!(await refreshSoon()) || request.signal.aborted) return
        if (d.by && d.by !== app.me?.name) {
          const what = d.text ? (d.text.length > 90 ? `${d.text.slice(0, 88)}…` : d.text) : ''
          if (d.kind === 'action') {
            // the server says what the change did; guessing it from where the item ended up called a new note on
            // a canceled item "canceled" and an edited reason "reopened"
            const { icon, words } = said(d.did)
            toast({ icon, title: `${d.by} ${words}`, body: what, href: `/actions?show=all&focus=${encodeURIComponent(d.id)}`, actionLabel: 'Board' })
          }
          if (d.kind === 'task-added') toast({ icon: '📌', title: `${d.by} added a task`, body: what, href: `/actions?show=all&focus=${encodeURIComponent(d.id)}`, actionLabel: 'Board' })
          if (d.kind === 'task-deleted') toast({ icon: '🗑️', title: `${d.by} removed a task`, body: what })
          if (d.kind === 'sync') toast({ icon: '⏱️', title: `${d.by} lined up a recording`, body: app.byId.get(d.meetingId)?.title ?? '' })
        }
        app.view?.onState?.(d)
      },
      speakers: (d) => {
        if (d.by && d.by !== app.me?.name) toast({ icon: '🎙️', title: d.name ? `${d.by} named a voice “${d.name}”` : `${d.by} took the name off a voice`, body: 'Other meetings with the same voice pick it up too.', timeout: 5000 })
        app.view?.onSpeakers?.(d)
      },
      // a transcript the Mac is writing started, stopped or failed (the transcript itself arrives as a library change)
      writing: (d) => app.view?.onWriting?.(d),
      notebook: (d) => {
        if (d.by && d.by !== app.me?.name) {
          const verb = { saved: 'saved a note', updated: 'updated a note', deleted: 'deleted a note', restored: 'restored a note' }[d.kind] ?? 'changed the notebook'
          toast({ icon: '📓', title: `${d.by} ${verb}`, body: d.title, href: d.kind === 'deleted' ? '/notebook' : `/notebook/${d.id}`, actionLabel: 'Open' })
        }
        app.view?.onNotebook?.(d)
      },
      presence: (list) => {
        const hadOthers = new Set(app.presence.filter((p) => p.id !== app.clientId).map((p) => p.name))
        app.presence = list
        for (const p of list) if (p.id !== app.clientId && p.name !== app.me?.name && !hadOthers.has(p.name) && app.clientId) toast({ icon: '👋', title: `${p.name} just walked in`, timeout: 3500 })
        renderPresence()
        app.view?.onPresence?.(list)
      },
    },
    setLive,
    () => void reconnected(request),
  )
  return request
}

// The live stream open again after it ended (the server ends each one within ten minutes, and on every restart):
// what changed in between went only to the pages connected then. The library comes again and the view catches up
// as it does after Back (onResume), leaving an open form as it is. A view that can't catch up in place is left as
// it is: drawing it again every few minutes would replay its opening and reset what it holds.
async function reconnected(request) {
  const token = rendering
  try {
    await refreshLibrary(request.signal)
    if (!request.signal.aborted && token === rendering) await app.view?.onResume?.()
  } catch {
    // offline again, or on another page by now: the next reconnect catches up
  }
}

// A page the browser keeps for its back button would hold its stream open, and over HTTP/1.1 a few of those
// use up the connections the next page needs. Close it on the way out; back on the page, open it again and
// catch up on whatever changed in the meantime.
addEventListener('pagehide', stopUpdates)
addEventListener('pageshow', async (e) => {
  if (!e.persisted || expiredShown) return
  const request = startLive()
  const view = app.view
  const token = rendering
  const y = scrollY
  try {
    await refreshLibrary(request.signal)
    if (request.signal.aborted || token !== rendering) return
    const redraw = view?.onResume ? view.onResume() : render()
    const resume = rendering
    await redraw
    if (!request.signal.aborted && resume === rendering) scrollTo({ top: y, behavior: 'instant' })
  } catch {
    return
  }
})

// ---------- keyboard ----------

const typing = (e) => e.target.closest?.('input, textarea, select, [contenteditable="true"]')
let seq = ''
let gPending = 0
addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault()
    openPalette(app)
    return
  }
  if (typing(e) || e.metaKey || e.ctrlKey || e.altKey) return
  if (e.key === '/') {
    // on a meeting page "/" searches the transcript; everywhere else it searches everything
    if (app.view?.onSlash?.()) return e.preventDefault()
    e.preventDefault()
    openPalette(app)
    return
  }
  if (e.key === '?') return showHelp()
  if (Date.now() - gPending < 900) {
    const to = { s: '/', h: '/', a: '/actions', b: '/actions', n: '/notebook', p: '/people', c: '/people', l: '/lab' }[e.key]
    gPending = 0
    if (to) return navigate(to)
  }
  if (e.key === 'g') gPending = Date.now()
  seq = (seq + e.key.toLowerCase()).slice(-6)
  if (seq === 'rewind') rewind()
})

function showHelp() {
  if ($('.help')) return $('.help').remove()
  const rows = [
    ['⌘K or /', 'Search everything'],
    ['g then s · a · n · p · l', 'Shelf · Board · Notebook · Cast · Lab'],
    ['space or k', 'Play / pause'],
    ['j / l', `Back / forward ${SKIP} seconds`],
    ['← / →', 'Back / forward 5 seconds'],
    ['[ / ]', 'Slower / faster'],
    ['c', 'Captions'],
    ['f', 'Fullscreen'],
    ['/ (on a meeting)', 'Find in transcript'],
    ['?', 'This card'],
  ]
  const card = el(
    html`<div class="help" role="dialog" aria-label="Keyboard shortcuts"><div class="help-card"><h2>Keys</h2><dl>${rows.map(([k, v]) => html`<dt><kbd>${k}</kbd></dt><dd>${v}</dd>`)}</dl><p class="muted">Type <b>rewind</b> anywhere for a surprise.</p></div></div>`,
  )
  card.addEventListener('click', () => card.remove())
  document.body.append(card)
}

function rewind() {
  if (reducedMotion()) return scrollTo({ top: 0 })
  document.body.classList.add('rewinding')
  const tag = el('<div class="rewind-tag" aria-hidden="true">◀◀ REWIND</div>')
  document.body.append(tag)
  scrollTo({ top: 0, behavior: 'smooth' })
  setTimeout(() => {
    document.body.classList.remove('rewinding')
    tag.remove()
  }, 1500)
}

// ---------- boot ----------

$('#open-palette').addEventListener('click', () => openPalette(app))
trackEyes()
try {
  await refreshLibrary()
} catch (err) {
  $('#app').innerHTML = String(html`<section class="oops"><h1>Can't reach the archive.</h1><p>${err.message}</p></section>`)
  throw err
}
startLive()
await render()
