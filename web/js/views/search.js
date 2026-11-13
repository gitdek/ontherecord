// Full search: the same engine as ⌘K with filters you can click instead of type. While typing it lists keyword
// hits by meeting; a settled search ranks keyword hits and passages close in meaning in one list, and Ask has a
// local model answer from them, with links to the source passages.
import { get, stream } from '../api.js'
import { avatar } from '../art.js'
import { unmark } from '../markdown.js'
import { excerpt, hitHref, hitLabel, hitTime, offTape } from '../palette.js'
import { $, debounce, esc, fmtDate, html, kindLabel, local, raw } from '../util.js'

// Show the first dozen hits, with the rest of the returned rows expandable by group.
const PER_GROUP = 12
const firstOf = (hits, where, item, total = hits.length) => {
  const shown = hits.slice(0, PER_GROUP)
  const rest = hits.slice(PER_GROUP)
  return html`${shown.map(item)}
    ${rest.length ? html`<li><details class="more-hits"><summary class="more">+${rest.length} more ${where}</summary><ol>${rest.map(item)}</ol></details></li>` : ''}
    ${total > hits.length ? html`<li class="more">+${total - hits.length} more ${where} beyond this result window</li>` : ''}`
}

const AREAS = [
  ['', 'Everything'],
  ['in:notes', 'Notes'],
  ['in:actions', 'Action items'],
  ['in:transcript', 'What was said'],
  ['in:docs', 'Documents'],
  ['in:notebook', 'Notebook'],
]
// the ranked list shows this many rows
const RANKED = 40
const meaningTag = (h) => h.meaning && h.kind !== 'screen' ? html`<i class="tag meaning">${h.marks.length ? 'and by meaning' : 'by meaning'}</i>` : ''

// What a filter that means nothing should have been.
const BAD = { after: 'a day such as 2026-10-15', before: 'a day such as 2026-10-15', since: 'a day such as 2026-10-15', until: 'a day such as 2026-10-15', on: 'a day such as 2026-10-15', status: 'open, on_hold, done or canceled' }

// kind: takes the sorts of recording the shelf holds ("meeting or demo"), a space written as a hyphen
const kindsHere = (app) => {
  const kinds = [...new Set(['meeting', ...(app.lib.meetings ?? []).map((m) => m.kind ?? 'meeting')])].map((k) => k.replaceAll(' ', '-'))
  return kinds.length > 1 ? `${kinds.slice(0, -1).join(', ')} or ${kinds.at(-1)}` : kinds[0]
}

const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10)

export async function mount(root, { app, query }) {
  const initial = query.get('q') ?? ''
  // the examples around the box come from the archive itself, so they name things that are really in it
  const terms = app.lib.threads.map((t) => t.term)
  const phrase = terms.find((t) => t.includes(' ')) ?? 'exact words'
  const word = terms.find((t) => !t.includes(' '))?.toLowerCase() ?? 'word'
  const guest = app.lib.people.find((p) => !p.crew)?.short.toLowerCase() ?? 'name'
  root.innerHTML = String(html`<section class="search-page page">
    <header class="page-head">
      <p class="eyebrow">Search</p>
      <h1>What did we say about…</h1>
      <form class="big-search" role="search">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>
        <input name="q" type="search" value="${initial}" placeholder="${terms.length ? `${terms.slice(0, 4).join(', ')}…` : 'Notes, action items, everything anyone said…'}" autocomplete="off" spellcheck="false" aria-label="Search" />
        ${app.lib.ask ? html`<button type="button" class="ask-btn" data-ask title="A short answer from the archive with source links">Ask</button>` : ''}
      </form>
      <div class="filters">
        ${(app.lib.screenSearch ? [...AREAS, ['in:screen', 'On screen']] : AREAS).map(([tok, label]) => html`<button type="button" class="fchip" data-area="${tok}">${label}</button>`)}
        <span class="fsep"></span>
        ${app.lib.people
          .filter((p) => p.meetings.length > 1 || p.crew)
          .map((p) => html`<button type="button" class="fchip person" data-person="${p.id}">${raw(avatar(p, { size: 20, title: false }))}${p.short}</button>`)}
        <span class="fsep"></span>
        <button type="button" class="fchip" data-when="7">Last 7 days</button>
        <button type="button" class="fchip" data-when="30">Last 30 days</button>
      </div>
      <p class="syntax">Quote a phrase <code>"${phrase}"</code> · leave a word out <code>-${word}</code> · <code>person:${guest}</code> · <code>in:actions</code> · <code>status:on_hold</code> · <code>owner:${guest}</code> · <code>after:2026-10-15</code>. Typos are forgiven.</p>
    </header>
    <section class="answer" aria-live="polite" hidden></section>
    <div class="results" aria-live="polite"></div>
  </section>`)
  const input = $('input', root)
  const out = $('.results', root)
  const answer = $('.answer', root)

  const tokens = () => input.value.split(/\s+/).filter(Boolean)
  const has = (tok) => tokens().some((t) => t.toLowerCase() === tok.toLowerCase())
  const setTok = (re, tok) => {
    const rest = tokens().filter((t) => !re.test(t))
    input.value = [...rest, ...(tok ? [tok] : [])].join(' ')
  }
  const paintChips = () => {
    const press = (b, active) => {
      b.classList.toggle('on', active)
      b.setAttribute('aria-pressed', String(active))
    }
    for (const b of root.querySelectorAll('[data-area]')) press(b, b.dataset.area ? has(b.dataset.area) : !tokens().some((t) => /^in:/i.test(t)))
    for (const b of root.querySelectorAll('[data-person]')) press(b, has(`person:${b.dataset.person}`))
    for (const b of root.querySelectorAll('[data-when]')) press(b, has(`after:${daysAgo(Number(b.dataset.when))}`))
  }

  let currentQuery = input.value.trim()
  let shownQuery
  let searching
  let asking
  let left = false
  const invalidate = () => {
    searching?.abort()
    const next = input.value.trim()
    if (currentQuery === next) return
    currentQuery = next
    asking?.abort()
    answer.hidden = true
    answer.replaceChildren()
  }
  // While typing ('typing'), the last word may be unfinished: it matches as the start of a word and only
  // keywords count. A query that has settled (Enter, a filter, or a pause) is searched as written, by meaning
  // too, and goes into the recent searches.
  async function run(mode) {
    if (left) return
    invalidate()
    const q = currentQuery
    history.replaceState(history.state, '', q ? `/search?q=${encodeURIComponent(q)}` : '/search')
    paintChips()
    if (!q) {
      out.innerHTML = String(html`<div class="search-empty">${app.lib.threads.slice(0, 10).map((t) => html`<button type="button" class="thread small" data-try="${t.term.includes(' ') ? `"${t.term}"` : t.term}"><span class="thread-term">${t.term}</span><span class="thread-n">${t.total}</span></button>`)}</div>`)
      return
    }
    const request = searching = new AbortController()
    const r = await get(`/api/search?q=${encodeURIComponent(q)}&limit=200${mode === 'typing' ? '' : '&typing=0'}`, request.signal).catch((err) => ({ error: err.message }))
    if (request.signal.aborted || q !== input.value.trim()) return
    searching = undefined
    if (r.error) {
      out.innerHTML = String(html`<p class="muted">${r.error}</p>`)
      return
    }
    // a pause in the middle of a word: what it matched as typed stays up, and it isn't a search to remember
    if (mode === 'pause' && !r.hits.length && !r.fused?.length && shownQuery === q && $('.hit', out)) return
    shownQuery = q
    if (mode !== 'typing') local.set('recent-searches', [q, ...local.get('recent-searches', []).filter((x) => x !== q)].slice(0, 6))
    if (!r.hits.length && !r.fused?.length) {
      const bad = (r.badFilters ?? []).map((f) => {
        const key = f.split(':')[0].replace(/^-/, '')
        return html`<b>${f}</b> isn't a filter this search can use: ${key}: takes ${key === 'kind' ? kindsHere(app) : BAD[key] ?? 'something else'}. `
      })
      const ambiguous = (r.ambiguousPeople ?? []).map(({ name, ids }) => html`More than one person is called <b>${name}</b>: ${ids.map((id, i) => html`${i ? ' or ' : ''}${app.lib.people.find((p) => p.id === id)?.name ?? id} (<code>person:${id}</code>)`)}. `)
      out.innerHTML = String(html`<div class="nothing"><p class="big">Nothing on tape for <b>${q}</b>.</p><p class="muted">${bad.length ? bad : ambiguous.length ? ambiguous : r.unknownPeople?.length ? `Nobody called ${r.unknownPeople.join(' or ')} appears in the notes.` : 'Try fewer words, a name, or drop a filter.'}</p></div>`)
      return
    }
    // a settled search shows one ranked list, unless someone asked for the hits by meeting
    const view = r.fused?.length && local.get('search-view', 'ranked') === 'ranked' ? 'ranked' : 'meetings'
    const fuzzy = Object.entries(r.fuzzy)
    const kb = r.hits.filter((h) => h.noteId)
    const board = offTape(r.hits)
    const notebookCount = r.notebookCount ?? kb.length
    const boardCount = r.boardCount ?? board.length
    // "in 2 meetings, the notebook and on the board": a result can sit where no meeting does
    const places = [r.meetings.length ? html`in <b>${r.meetings.length}</b> meeting${r.meetings.length === 1 ? '' : 's'}` : '', notebookCount ? (r.meetings.length ? 'the notebook' : 'in the notebook') : '', boardCount ? 'on the board' : ''].filter(Boolean)
    const toggle = r.fused?.length
      ? html`<span class="view-toggle" role="group" aria-label="Show results"><button type="button" data-view="ranked" aria-pressed="${view === 'ranked'}">Ranked</button><button type="button" data-view="meetings" aria-pressed="${view === 'meetings'}">By meeting</button></span>`
      : ''
    const head = html`<p class="rcount"><b>${r.total}</b> result${r.total === 1 ? '' : 's'} ${places.map((x, i) => html`${i ? (i === places.length - 1 ? ' and ' : ', ') : ''}${x}`)}${r.loose ? ' · no single line has every word, so these match some' : ''}${fuzzy.length ? html` · also matched ${fuzzy.map(([w, alts]) => html`<i>${w}</i> → ${alts.slice(0, 3).join(', ')}`)}` : ''} · <a class="follow-link" href="/follow?q=${encodeURIComponent(q)}">Follow it across the meetings →</a>${toggle}</p>`
    if (view === 'ranked') {
      // "exact" only means something next to rows found by meaning
      const mixed = r.fused.some((h) => h.meaning)
      const shown = r.fused.slice(0, RANKED)
      out.innerHTML = String(html`${head}<ol class="ranked">${shown.map((h) => {
        const m = h.meetingId ? app.byId.get(h.meetingId) : undefined
        const where = h.noteId ? html`<b>Notebook</b>${h.noteTitle || h.title ? html` · ${h.noteTitle ?? h.title}` : ''}` : m ? html`<b>${m.title}</b>${kindLabel(m.kind)} · ${fmtDate(m.date)}` : html`<b>The board</b>`
        const about = h.kind === 'update' || h.kind === 'doc' ? h.section : ''
        const worded = h.marks.length > 0
        const text = worded ? excerpt(h, 260) : h.kind === 'kb' ? unmark(h.text).text : h.text
        return html`<li><a class="hit" href="${hitHref(h, h.marks.length ? q : '')}">
          <span class="pal-kind k-${h.kind}">${hitLabel(h)}</span>
          <span class="hit-body"><small>${where}${about ? html` · ${about}` : ''}</small>${h.before ? html`<span class="ctx">${h.before.slice(-90)}</span> ` : ''}<span class="hit-text">${text}</span>${h.after ? html` <span class="ctx">${h.after.slice(0, 90)}</span>` : ''}
            <span class="why">${worded && h.exact && mixed ? html`<i class="tag exact">exact</i>` : ''}${meaningTag(h)}</span></span>
          ${h.t != null && m ? html`<span class="hit-t">${hitTime(h, m.timeBase)}</span>` : ''}
        </a></li>`
      })}${r.total > shown.length ? html`<li><button type="button" class="more btn ghost" data-view="meetings">+${r.total - shown.length} more, by meeting</button></li>` : ''}</ol>${r.reranked ? html`<p class="muted small">Ranked by keywords, meaning and the reranker together.</p>` : ''}`)
      return
    }
    out.innerHTML = String(html`
      ${head}
      ${notebookCount
        ? html`<section class="rgroup" style="--hue:48"><header><i class="dot"></i><a href="/notebook">Notebook</a><span>${notebookCount} hit${notebookCount === 1 ? '' : 's'}</span></header><ol>${firstOf(
            kb,
            'in the notebook',
            (h) => html`<li><a class="hit" href="${hitHref(h, q)}"><span class="pal-kind k-kb">Notebook</span><span class="hit-body"><small>${h.noteTitle ?? h.title ?? ''}</small><span class="hit-text">${excerpt(h, 260)}</span>${meaningTag(h)}</span><span></span></a></li>`,
            notebookCount,
          )}</ol></section>`
        : ''}
      ${boardCount
        ? html`<section class="rgroup" style="--hue:160"><header><i class="dot"></i><a href="/actions?show=all">The board</a><span>${boardCount} hit${boardCount === 1 ? '' : 's'} on items no meeting holds</span></header><ol>${firstOf(
            board,
            'on the board',
            (h) => html`<li><a class="hit" href="${hitHref(h, q)}"><span class="pal-kind k-${h.kind}">${hitLabel(h)}</span><span class="hit-body">${h.kind === 'update' ? html`<small>${h.section}</small>` : ''}<span class="hit-text">${excerpt(h, 260)}</span>${meaningTag(h)}</span><span></span></a></li>`,
            boardCount,
          )}</ol></section>`
        : ''}
      ${r.meetings.map((g) => {
        const m = app.byId.get(g.id)
        const hits = r.hits.filter((h) => h.meetingId === g.id)
        return html`<section class="rgroup" style="--hue:${m?.hue ?? 0}">
          <header><i class="dot"></i><a href="/m/${g.id}">${m?.title ?? g.id}</a>${kindLabel(m?.kind)}<span>${m ? fmtDate(m.date) : ''} · ${g.count} hit${g.count === 1 ? '' : 's'}</span></header>
          <ol>${firstOf(
            hits,
            'in this meeting',
            (h) => html`<li><a class="hit" href="${hitHref(h, h.marks.length ? q : '')}">
              <span class="pal-kind k-${h.kind}">${hitLabel(h)}</span>
              <span class="hit-body">${h.section && h.kind !== 'transcript' ? html`<small>${h.section}</small>` : ''}${h.before ? html`<span class="ctx">${h.before.slice(-90)}</span> ` : ''}<span class="hit-text">${excerpt(h, 260)}</span>${h.after ? html` <span class="ctx">${h.after.slice(0, 90)}</span>` : ''}${meaningTag(h)}</span>
              ${h.t != null ? html`<span class="hit-t">${hitTime(h, m?.timeBase)}</span>` : ''}
            </a></li>`,
            g.count,
          )}</ol>
        </section>`
      })}`)
  }
  const typed = debounce(() => run('typing'), 180)
  const paused = debounce(() => run('pause'), 600)
  input.addEventListener('input', () => {
    invalidate()
    if (!currentQuery) return void settle()
    typed()
    paused()
  })
  // Enter, a filter or an example settles the query now, and nothing still waiting runs after it
  const settle = () => {
    typed.cancel()
    paused.cancel()
    return run()
  }
  $('form', root).addEventListener('submit', (e) => {
    e.preventDefault()
    settle()
  })
  // Ask: the local model answers from the passages search finds, citing each one as [n]
  async function ask() {
    const question = input.value.trim()
    if (left || !question || !app.lib.ask) return
    asking?.abort()
    const request = asking = new AbortController()
    let text = ''
    let sources = []
    const paint = (state) => {
      if (request.signal.aborted || question !== input.value.trim()) return
      const cited = (s) => esc(s).replace(/\[(\d{1,2})\]/g, (all, n) => {
        const src = sources.find((x) => x.n === Number(n))
        return src ? `<a class="cite" href="${esc(src.link)}" title="${esc([src.title, src.when].filter(Boolean).join(' · '))}">${n}</a>` : all
      })
      answer.hidden = false
      answer.innerHTML = String(html`<header><b>Answer</b><span class="muted">${state}</span></header>
        <p class="answer-text">${raw(cited(text) || '…')}</p>
        ${sources.length ? html`<ol class="sources">${sources.map((s) => html`<li><a href="${s.link}"><b>${s.n}</b> ${s.title}${s.when ? html` · ${s.when}` : ''}</a></li>`)}</ol>` : ''}`)
    }
    paint('reading the archive…')
    try {
      const terminal = await stream('/api/ask', { question }, (line) => {
        if (line.sources) sources = line.sources
        if (line.text) text += line.text
        paint('writing…')
      }, request.signal)
      paint({ cited: 'written on this Mac with citations', uncited: 'completed without citations', invalid: 'completed with invalid citation references', 'no-sources': 'no sources found' }[terminal.grounding])
    } catch (err) {
      paint(`interrupted — ${err.message}`)
    } finally {
      if (asking === request) asking = undefined
    }
  }
  root.addEventListener('click', (e) => {
    if (e.target.closest('[data-ask]')) return void ask()
    const v = e.target.closest('button[data-view]')
    if (v) {
      local.set('search-view', v.dataset.view)
      return settle()
    }
    const a = e.target.closest('[data-area]')
    if (a) {
      setTok(/^in:/i, a.dataset.area)
      return settle()
    }
    const p = e.target.closest('[data-person]')
    if (p) {
      const tok = `person:${p.dataset.person}`
      setTok(new RegExp(`^${tok}$`, 'i'), has(tok) ? '' : tok)
      return settle()
    }
    const w = e.target.closest('[data-when]')
    if (w) {
      const tok = `after:${daysAgo(Number(w.dataset.when))}`
      setTok(/^after:/i, has(tok) ? '' : tok)
      return settle()
    }
    const t = e.target.closest('[data-try]')
    if (t) {
      input.value = t.dataset.try
      settle()
    }
  })
  run()
  input.focus()
  input.setSelectionRange(input.value.length, input.value.length)
  // Invalidate as soon as navigation starts, even when the next page is still loading.
  const leave = () => {
    left = true
    typed.cancel()
    paused.cancel()
    searching?.abort()
    asking?.abort()
  }
  return { onLeave: leave, onResume: paintChips, cleanup: leave }
}
