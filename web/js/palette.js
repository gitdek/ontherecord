// ⌘K: one box that searches every note, action item and transcript line as you type.
import { get } from './api.js'
import { unmark } from './markdown.js'
import { $, debounce, el, esc, fmtDate, fmtT, html, local, raw } from './util.js'

const KIND = { meeting: 'Meeting', summary: 'Summary', topic: 'Topic', note: 'Note', action: 'Action', next: 'Next step', caveat: 'Caveat', transcript: 'Said', doc: 'Document', kb: 'Notebook', update: 'Board', screen: 'On screen' }
export const kindLabel = (k) => KIND[k] ?? k
// Something written on an action item after the meeting says which part of the item it is.
const PART = { reason: 'Canceled', evidence: 'Evidence', note: 'Board note', hold: 'On hold', checked: 'Checked' }
export const hitLabel = (h) => (h.kind === 'update' && PART[h.part]) || kindLabel(h.kind)
export const hitTime = (h, base) => fmtT(h.t, h.kind === 'screen' ? 'offset' : base)
// What a hit belongs to when its own words don't say: a notebook entry, or the action item an update is on.
export function hitLead(h) {
  const about = h.noteTitle ?? (h.kind === 'update' ? h.section : '')
  return about ? html`<b>${about.length > 70 ? `${about.slice(0, 67)}…` : about}</b> · ` : ''
}
// Board lines no meeting holds: tasks added without one, and what was written on them since.
export const offTape = (hits) => hits.filter((h) => h.board && !h.meetingId)

// Text with <mark>s, trimmed to a window around the first match.
export function snippet(text, marks = [], width = 190) {
  let start = 0
  if (text.length > width && marks.length) start = Math.max(0, marks[0][0] - 60)
  if (start > 0) start = text.lastIndexOf(' ', start) + 1 || start
  const end = Math.min(text.length, start + width)
  let out = start > 0 ? '…' : ''
  let pos = start
  for (const [a, b] of marks) {
    if (b <= pos || a >= end) continue
    out += esc(text.slice(pos, Math.max(a, pos))) + `<mark>${esc(text.slice(Math.max(a, pos), Math.min(b, end)))}</mark>`
    pos = Math.min(b, end)
  }
  out += esc(text.slice(pos, end)) + (end < text.length ? '…' : '')
  return raw(out)
}

// A hit's words, trimmed and marked. A notebook passage is Markdown: it shows as plain words.
export function excerpt(hit, width) {
  const { text, marks } = hit.noteId ? unmark(hit.text, hit.marks) : hit
  return snippet(text, marks, width)
}

// Where a hit lands: the meeting, at its moment, with the words pre-filled in the transcript finder.
// What the board holds (an added task, new wording, a reason or a note) lands on its card there.
export function hitHref(hit, query) {
  const words = query.replace(/(?:^|\s)(person|who|with|in|after|before|since|until|meeting|on):\S+/gi, ' ').replace(/(?:^|\s)[@-]\S+/g, ' ').replace(/"/g, '').trim()
  if (hit.link) {
    if (hit.kind !== 'transcript' || !words) return hit.link
    const [path, qs] = hit.link.split('?')
    const p = new URLSearchParams(qs)
    p.set('q', words)
    return `${path}?${p}`
  }
  if (hit.noteId) return `/notebook/${encodeURIComponent(hit.noteId)}`
  if ((hit.board || hit.kind === 'update') && hit.actionId) return `/actions?show=all&focus=${encodeURIComponent(hit.actionId)}`
  const p = new URLSearchParams()
  const meeting = `/m/${encodeURIComponent(hit.meetingId)}`
  if (hit.kind === 'doc') {
    p.set('tab', 'excerpt')
    if (hit.fileId) p.set('file', hit.fileId)
    return `${meeting}?${p}`
  }
  if (hit.t != null) p.set('t', String(Math.round(hit.t * 10) / 10))
  if (words) p.set('q', words)
  p.set('tab', hit.kind === 'transcript' ? 'transcript' : 'notes')
  if (hit.kind === 'transcript' && hit.transcriptId) p.set('transcript', hit.transcriptId)
  if (hit.topicKey) p.set('topic', hit.topicKey)
  return `${meeting}?${p}`
}

export function openPalette(app, initial = '') {
  if ($('.palette-wrap:not(.out)')) return $('.palette-wrap:not(.out) input').focus()
  $('.palette-wrap.out')?.remove()
  const recent = local.get('recent-searches', [])
  // the examples come from the archive itself, so each one finds something
  const terms = (app.lib?.threads ?? []).map((t) => t.term)
  const guest = (app.lib?.people ?? []).find((p) => !p.crew)?.short.toLowerCase()
  const phrase = terms.slice(4).find((t) => t.includes(' '))
  const examples = [...terms.slice(0, 4), ...(guest ? [`person:${guest}`, `in:actions ${guest}`] : ['in:actions']), ...(phrase ? [`"${phrase}"`] : [])]
  // A combobox: the cursor stays in the box while the arrows move through the options, and the box tells a
  // screen reader which option that is (aria-activedescendant). Messages go in a status line beside the list.
  const wrap = el(
    html`<div class="palette-wrap" role="dialog" aria-modal="true" aria-label="Search the archive">
      <div class="palette">
        <label class="pal-input">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>
          <input type="search" role="combobox" aria-expanded="false" aria-controls="pal-list" aria-autocomplete="list" placeholder="Search notes, action items, everything anyone said…" autocomplete="off" spellcheck="false" aria-label="Search" />
          <kbd aria-hidden="true">esc</kbd>
        </label>
        <div class="pal-results"><div class="pal-msg" role="status"></div><div id="pal-list" role="listbox" aria-label="Results"></div></div>
        <div class="pal-foot"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>↵</kbd> open</span><span><kbd>⌘↵</kbd> all results</span><span class="pal-syntax">person:name · in:actions · "exact" · -not · after:2026-10-15</span></div>
      </div>
    </div>`,
  )
  // whatever had the cursor before gets it back when the palette closes
  const back = document.activeElement
  document.body.append(wrap)
  const input = $('input', wrap)
  const list = $('#pal-list', wrap)
  const msg = $('.pal-msg', wrap)
  input.value = initial
  input.focus()
  let items = []
  let sel = 0
  let gid = 0
  let searching
  // options under a heading, as a group that a screen reader names by that heading
  const group = (head, options) => {
    const id = `pal-g${gid++}`
    return html`<div role="group" aria-labelledby="${id}"><div class="pal-group" id="${id}">${head}</div>${options}</div>`
  }

  const paint = () => {
    items.forEach((it, i) => {
      it.el.classList.toggle('sel', i === sel)
      it.el.setAttribute('aria-selected', String(i === sel))
    })
    input.setAttribute('aria-expanded', String(items.length > 0))
    list.hidden = !items.length
    if (items[sel]) input.setAttribute('aria-activedescendant', items[sel].el.id)
    else input.removeAttribute('aria-activedescendant')
    items[sel]?.el.scrollIntoView({ block: 'nearest' })
  }
  const close = (restoreFocus = true) => {
    if (wrap.inert) return
    search.cancel()
    searching?.abort()
    wrap.inert = true
    wrap.classList.add('out')
    setTimeout(() => wrap.remove(), 160)
    // opening a result moves the cursor on to the new page instead (see render in main.js)
    if (restoreFocus && back?.isConnected && back !== document.body) back.focus({ preventScroll: true })
  }
  const go = (href) => {
    const q = input.value.trim()
    if (q) local.set('recent-searches', [q, ...recent.filter((r) => r !== q)].slice(0, 6))
    close(false)
    app.navigate(href)
  }

  const empty = () => {
    const nav = [
      { href: '/', label: 'The shelf', meta: 'every meeting' },
      { href: '/actions', label: 'The board', meta: 'action items' },
      { href: '/people', label: 'The cast', meta: 'who was there' },
      { href: '/lab', label: 'Tape lab', meta: 'file sizes & encodes' },
    ]
    msg.textContent = ''
    list.innerHTML = String(html`
      ${recent.length ? group('Recent', recent.map((r) => html`<div class="pal-item" role="option" data-q="${r}"><span class="pal-kind" aria-hidden="true">↺</span><span class="pal-text">${r}</span></div>`)) : ''}
      ${group('Try', examples.map((r) => html`<div class="pal-item" role="option" data-q="${r}"><span class="pal-kind" aria-hidden="true">✦</span><span class="pal-text">${r}</span></div>`))}
      ${group('Jump to', nav.map((n) => html`<div class="pal-item" role="option" data-href="${n.href}"><span class="pal-kind" aria-hidden="true">→</span><span class="pal-text">${n.label}</span><span class="pal-meta">${n.meta}</span></div>`))}
    `)
    bind()
  }

  const bind = () => {
    items = [...list.querySelectorAll('.pal-item')].map((node, i) => {
      node.id = `pal-o${i}`
      return { el: node }
    })
    sel = 0
    items.forEach((it, i) => {
      it.el.addEventListener('mousemove', () => {
        if (sel !== i) {
          sel = i
          paint()
        }
      })
      it.el.addEventListener('click', () => activate(it.el))
    })
    paint()
  }
  const activate = (node) => {
    if (node.dataset.q) {
      input.value = node.dataset.q
      run()
    } else if (node.dataset.href) go(node.dataset.href)
  }

  const search = debounce(async (q, request) => {
    const r = await get(`/api/search?q=${encodeURIComponent(q)}&limit=40`, request.signal).catch(() => null)
    if (request.signal.aborted || q !== input.value.trim()) return
    if (!r) {
      msg.textContent = 'Search is unavailable.'
      return
    }
    if (!r.hits.length) {
      list.innerHTML = ''
      msg.innerHTML = String(html`<div class="pal-none">Nothing on tape for <b>${q}</b>.${Object.keys(r.fuzzy).length ? '' : ' Try fewer words, or a name.'}</div>`)
      items = []
      return paint()
    }
    // group by meeting, best meetings first, three hits each; notebook entries and board items no meeting holds get their own groups
    const found = r.meetings.slice(0, 6).map((g) => ({ m: app.byId.get(g.id), count: g.count, hits: r.hits.filter((h) => h.meetingId === g.id).slice(0, 3) }))
    const board = offTape(r.hits)
    if (board.length) found.unshift({ m: { title: 'The board', hue: 160, date: '' }, count: board.length, hits: board.slice(0, 3) })
    const kb = r.hits.filter((h) => h.noteId)
    if (kb.length) found.unshift({ m: { title: 'Notebook', hue: 48, date: '' }, count: kb.length, hits: kb.slice(0, 3) })
    msg.innerHTML = r.loose ? String(html`<div class="pal-note">No line has every word, so these have some of them.</div>`) : ''
    list.innerHTML = String(html`
      ${found.map((g) =>
        group(
          html`<i class="dot" style="--hue:${g.m?.hue ?? 0}"></i>${g.m?.title ?? g.hits[0]?.meetingId} <span>${g.m?.date ? `${fmtDate(g.m.date)} · ` : ''}${g.count} hit${g.count === 1 ? '' : 's'}</span>`,
          g.hits.map(
            (h) => html`<div class="pal-item" role="option" data-href="${hitHref(h, q)}"><span class="pal-kind k-${h.kind}">${hitLabel(h)}</span><span class="pal-text">${hitLead(h)}${excerpt(h, 150)}</span>${h.t != null ? html`<span class="pal-meta">${hitTime(h, g.m?.timeBase)}</span>` : ''}</div>`,
          ),
        ),
      )}
      <div class="pal-item pal-all" role="option" data-href="/search?q=${encodeURIComponent(q)}"><span class="pal-kind" aria-hidden="true">⌘↵</span><span class="pal-text">All ${r.total} results for “${q}”</span></div>
    `)
    bind()
  }, 90)
  const run = () => {
    if (wrap.inert) return
    search.cancel()
    searching?.abort()
    const q = input.value.trim()
    if (!q) return empty()
    list.replaceChildren()
    msg.textContent = ''
    items = []
    paint()
    searching = new AbortController()
    search(q, searching)
  }

  input.addEventListener('input', run)
  // picking an option with the mouse leaves the cursor in the box
  list.addEventListener('mousedown', (e) => e.preventDefault())
  input.addEventListener('keydown', (e) => {
    if (e.isComposing) return
    if (e.key === 'Escape') {
      e.preventDefault()
      return close()
    }
    // the box is the dialog's only stop: Tab stays in it, and the arrows move through the options
    if (e.key === 'Tab') return e.preventDefault()
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!items.length) return
      sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
      paint()
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      const q = input.value.trim()
      if ((e.metaKey || e.ctrlKey) && q) return go(`/search?q=${encodeURIComponent(q)}`)
      if (items[sel]) activate(items[sel].el)
      else if (q) go(`/search?q=${encodeURIComponent(q)}`)
    }
  })
  wrap.addEventListener('mousedown', (e) => e.target === wrap && close())
  if (initial) run()
  else empty()
}
