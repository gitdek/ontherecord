// Follow: one topic, person or decision across the meetings, oldest first. What each meeting said about it
// (found by its words or by meaning), the board items it touched as they stand now, and the notebook entries
// about it. The same filters as search work, so "person:ada pricing" follows one person on one thing.
import { get } from '../api.js'
import { unmark } from '../markdown.js'
import { excerpt, hitHref, hitLabel, hitTime } from '../palette.js'
import { $, fmtDate, html, plural } from '../util.js'

export async function load({ query }) {
  const q = (query.get('q') ?? '').trim()
  return { q, r: q ? await get(`/api/follow?q=${encodeURIComponent(q)}`) : null }
}

const STATUS = { open: 'Open', done: 'Done', canceled: 'Canceled' }

export async function mount(root, { app, data }) {
  const { q, r } = data
  const nothing = r && !r.meetings.length && !r.items.length && !r.notebook.length
  const bad = r?.badFilters?.length ? `${r.badFilters.join(', ')} can't be followed: dates are written 2026-10-15, and status: takes open, on_hold, done or canceled.` : ''
  const unknown = r?.unknownPeople?.length ? `Nobody called ${r.unknownPeople.join(' or ')} appears in the notes.` : ''
  const ambiguous = (r?.ambiguousPeople ?? []).map(({ name, ids }) => `More than one person is called ${name}: ${ids.map((id) => `${app.lib.people.find((p) => p.id === id)?.name ?? id} (person:${id})`).join(' or ')}.`).join(' ')
  root.innerHTML = String(html`<section class="follow page">
    <header class="page-head">
      <p class="eyebrow">Follow</p>
      <h1>${q ? html`<q>${q}</q> across the meetings` : 'Follow something across the meetings'}</h1>
      <form class="big-search" role="search">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>
        <input name="q" type="search" value="${q}" placeholder="A topic, a decision, or person:name" aria-label="What to follow" autocomplete="off" spellcheck="false" />
      </form>
      <p class="muted">Oldest first: what each meeting said about it, and the board items it touched as they stand now.${q ? html` <a class="follow-link" href="/search?q=${encodeURIComponent(q)}">The same in search →</a>` : ''}</p>
    </header>
    ${!r
      ? html`<div class="search-empty">${app.lib.threads.slice(0, 12).map((t) => html`<a class="thread small" href="/follow?q=${encodeURIComponent(t.term.includes(' ') ? `"${t.term}"` : t.term)}"><span class="thread-term">${t.term}</span><span class="thread-n">${t.total}</span></a>`)}</div>`
      : nothing
        ? html`<div class="nothing"><p class="big">Nothing on tape for <b>${q}</b>.</p><p class="muted">${bad || ambiguous || unknown || 'Try fewer words, or a name.'}</p></div>`
        : html`
          <ol class="timeline">${r.meetings.map((g) => {
            const m = app.byId.get(g.id) ?? g
            return html`<li style="--hue:${g.hue}">
              <header><i class="dot"></i><a href="/m/${encodeURIComponent(g.id)}">${g.title}</a><span>${fmtDate(g.date)} · ${plural(g.count, 'moment')}</span></header>
              <ol>${g.moments.map(
                (h) => html`<li><a class="hit" href="${hitHref(h, h.marks.length ? q : '')}">
                  <span class="pal-kind k-${h.kind}">${hitLabel(h)}</span>
                  <span class="hit-body">${h.section && h.kind !== 'transcript' ? html`<small>${h.section}</small>` : ''}<span class="hit-text">${h.marks.length ? excerpt(h, 220) : h.kind === 'kb' ? unmark(h.text).text : h.text}</span>${h.meaning && !h.marks.length ? html` <i class="tag meaning">by meaning</i>` : ''}</span>
                  ${h.t != null ? html`<span class="hit-t">${hitTime(h, g.timeBase)}</span>` : ''}
                </a></li>`,
              )}</ol>
            </li>`
          })}</ol>
          ${r.items.length
            ? html`<section class="rgroup" style="--hue:160"><header><i class="dot"></i><a href="/actions?show=all">On the board</a><span>${plural(r.items.length, 'item')} it touched, as they stand now</span></header><ol>${r.items.map(
                (a) => html`<li><a class="hit" href="/actions?show=all&focus=${encodeURIComponent(a.id)}">
                  <span class="pal-kind k-action">${a.onHold ? 'On hold' : STATUS[a.status]}</span>
                  <span class="hit-body"><small>${a.owner || 'unassigned'}${a.meeting ? html` · ${a.meeting.title}` : ''}</small><span class="hit-text">${a.text}</span>${a.reason ? html` <span class="ctx">${a.reason}</span>` : ''}</span><span></span>
                </a></li>`,
              )}</ol></section>`
            : ''}
          ${r.notebook.length
            ? html`<section class="rgroup" style="--hue:48"><header><i class="dot"></i><a href="/notebook">Notebook</a><span>${plural(r.notebook.length, 'entry', 'entries')}</span></header><ol>${r.notebook.map(
                (n) => html`<li><a class="hit" href="/notebook/${encodeURIComponent(n.id)}"><span class="pal-kind k-kb">Notebook</span><span class="hit-body"><small>${n.updatedBy} · ${fmtDate(n.updatedAt.slice(0, 10))}</small><span class="hit-text">${n.title}</span></span><span></span></a></li>`,
              )}</ol></section>`
            : ''}`}
  </section>`)
  const input = $('input', root)
  $('form', root).addEventListener('submit', (e) => {
    e.preventDefault()
    const next = input.value.trim()
    if (next !== q) app.navigate(next ? `/follow?q=${encodeURIComponent(next)}` : '/follow')
  })
  if (!q) input.focus()
  return {}
}
