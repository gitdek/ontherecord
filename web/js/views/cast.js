// The cast: everyone named in the notes, as creatures. The crew wear headphones.
import { avatar } from '../art.js'
import { fmtDate, html, raw } from '../util.js'

export async function mount(root, { app }) {
  const meetings = new Map(app.lib.meetings.map((m) => [m.id, m]))
  const people = app.lib.people
  root.innerHTML = String(html`<section class="cast page">
    <header class="page-head">
      <p class="eyebrow">The cast</p>
      <h1>Everyone who turned up</h1>
      <p>Names come from each meeting's notes. Crew wear headphones. Their eyes follow you; that's normal.</p>
    </header>
    <div class="cast-grid">
      ${people.map((p, i) => {
        const ms = p.meetings.map((id) => meetings.get(id)).filter(Boolean).sort((a, b) => a.date.localeCompare(b.date))
        const first = ms[0]
        const last = ms[ms.length - 1]
        return html`<article class="person ${p.crew ? 'crew' : ''}" style="--hue:${p.hue};--i:${i}">
          <div class="person-blob">${raw(avatar(p, { size: 132 }))}</div>
          <h3>${p.name}</h3>
          <p class="role">${p.crew ? 'Crew' : 'Guest'} · ${ms.length} meeting${ms.length === 1 ? '' : 's'}</p>
          ${first ? html`<p class="span">${ms.length > 1 ? html`First ${fmtDate(first.date)} · last ${fmtDate(last.date)}` : html`On ${fmtDate(first.date)}`}</p>` : ''}
          <div class="person-tapes">${ms.map((m) => html`<a href="/m/${m.id}" style="--hue:${m.hue}" title="${m.title}"><i></i>${m.title}</a>`)}</div>
          <a class="person-search" href="/search?q=${encodeURIComponent(`person:${p.short}`)}">Their meetings in search →</a>
        </article>`
      })}
    </div>
  </section>`)
  return {}
}
