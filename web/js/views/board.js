// The board: every action item from every set of notes, plus tasks added here or by an agent, as sticky
// notes. Checking one off, canceling one that stopped mattering, parking one that has to wait, leaving a
// note or adding a task is shared: the other person's board (and their agents, through MCP) see it live.
import { get, post } from '../api.js'
import { avatar, pin, stamp, tick } from '../art.js'
import { trailWord } from '../board-words.js'
import { $, coalesce, fmtDate, fmtT, html, raw, rangeText, reducedMotion } from '../util.js'

const when = (iso) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
const SHOWS = ['open', 'hold', 'done', 'canceled', 'all']
const SHOW_LABEL = { open: 'Open', hold: 'On hold', done: 'Done', canceled: 'Canceled', all: 'Everything' }
const STANDS = { open: 'still open', done: 'done', canceled: 'canceled' }
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const label = (r) => cut(`${r.owner ? `${r.owner}: ` : ''}${r.text}`, 70)
// on hold with nothing to say it can start: still open, but not something to pick up today
const parked = (a) => a.status === 'open' && !!a.hold && !a.hold.ready
const rank = (a) => (a.status === 'open' ? (parked(a) ? 1 : 0) : a.status === 'done' ? 2 : 3)

export async function load() {
  // the notebook's notes, to cite as a source in the evidence form
  const [board, nb] = await Promise.all([get('/api/actions'), get('/api/notebook').catch(() => ({ notes: [] }))])
  return { ...board, notebook: nb.notes }
}

export async function mount(root, { app, query, data }) {
  let actions = data.actions
  // titles of the notebook notes that items cite as sources
  let notes = data.notes ?? {}
  // tasks deleted lately, newest first: each can be brought back. The list stays open or folded across redraws.
  let deleted = data.deleted ?? []
  let openDeleted = false
  const notebook = data.notebook ?? []
  let show = SHOWS.includes(query.get('show')) ? query.get('show') : 'open'
  let who = query.get('who') ?? ''
  // one form open at a time: a note on an item, why it no longer matters, what it waits on, or what backs it up
  let form = null
  // the item whose history is unfolded
  let trail = ''
  let saving = false
  let adding = false
  // a card that was just checked off stays put until its stamp has landed
  let settle = 0
  // the board as last drawn
  let drawn = ''
  // every listener hangs off this, so leaving the board takes them all down with it
  const ctl = new AbortController()
  const on = (type, fn) => root.addEventListener(type, fn, { signal: ctl.signal })
  const crew = app.lib.crew ?? []

  const byId = (id) => actions.find((a) => a.id === id)
  const cardOf = (id) => $(`.sticky[data-action="${CSS.escape(id)}"]`, root)
  const inShow = (a) => show === 'all' || (show === 'hold' ? parked(a) : a.status === show)
  const inWho = (a) => !who || a.people.includes(who)
  // would waiting on x go in a circle? (x already waits, directly or down the line, on this item)
  const waitsOn = (x, id, seen = new Set()) => {
    if (!x || seen.has(x.id)) return false
    seen.add(x.id)
    return (x.hold?.after ?? []).some((r) => r.id === id || waitsOn(byId(r.id), id, seen))
  }

  const ref = (r) => html`<a class="ref ${r.status}" href="/actions?show=all&focus=${encodeURIComponent(r.id)}" data-focus="${r.id}">${label(r)}</a>`
  const source = (s) => {
    if (s.note) return html`<a href="/notebook/${s.note}">${notes[s.note] || 'a notebook note'}</a>`
    if (!s.meeting) return html`<span>${s.ref}</span>`
    const m = app.byId.get(s.meeting)
    if (!m) return html`<span>a meeting no longer in the archive</span>`
    return html`<a href="/m/${m.id}${s.at != null ? `?t=${Math.floor(s.at)}` : ''}">${m.title}${s.at != null ? ` · ${fmtT(s.at, m.timeBase)}` : ''}</a>`
  }
  // a source as words, for a checkbox in the evidence form
  const sourceText = (s) => {
    if (s.note) return notes[s.note] || 'a notebook note'
    if (!s.meeting) return s.ref
    const m = app.byId.get(s.meeting)
    return m ? `${m.title}${s.at != null ? ` · ${fmtT(s.at, m.timeBase)}` : ''}` : 'a meeting no longer in the archive'
  }
  // with a label the sources take a line of their own, so they don't run on from the sentence before them
  const sources = (list, label = '') => (list?.length ? html`<span class="sources ${label ? 'own' : ''}">${label ? html`<i>${label}</i> ` : ''}${list.map((s, i) => html`${i ? ' · ' : ''}${source(s)}`)}</span>` : '')
  const proof = (p) => {
    if (!p?.evidence && !p?.sources?.length) return ''
    const from = p.sources?.length > 1 ? 'Sources' : 'Source'
    return p.evidence ? html`<p class="proof"><b>Evidence</b> ${p.evidence} ${sources(p.sources, from)}</p>` : html`<p class="proof"><b>${from}</b> ${sources(p.sources)}</p>`
  }

  const holdLine = (a) => {
    const h = a.hold
    return html`<div class="hold ${h.ready ? 'ready' : ''}">
      <b>${h.ready ? '▶ Ready to start' : '⏸ On hold'}</b>${h.on ? html` <span class="on">${h.on}</span>` : ''}
      ${h.after.length ? html`<ul>${h.after.map((r) => html`<li>after ${ref(r)} <i class="${r.status}">${STANDS[r.status]}</i></li>`)}</ul>` : ''}
      <small>${h.by} · ${when(h.at)}</small>
    </div>`
  }

  const entry = (e) => {
    if (e.did === 'linked') {
      const other = byId(e.text)
      return html`${trailWord(e.did)}${other ? html`: ${ref(other)}` : ''}`
    }
    return html`${trailWord(e.did)}${e.text ? html`: <q>${e.text}</q>` : ''}${e.evidence ? html` <span class="ev">Evidence: ${e.evidence}</span>` : ''} ${sources(e.sources, e.sources?.length > 1 ? 'Sources' : 'Source')}`
  }
  const trailOf = (a) => html`<div class="trail">
      ${a.original ? html`<p>${a.source === 'added' ? 'The task said' : 'The notes say'}: <q>${[a.original.owner, a.original.text].filter(Boolean).join(': ')}</q></p>` : ''}
      <ol>${a.history.map((e) => html`<li><time datetime="${e.at}" title="${new Date(e.at).toLocaleString()}">${when(e.at)}</time> <b>${e.by}</b> ${entry(e)}</li>`)}</ol>
      ${a.undoable ? html`<button type="button" class="link-btn" data-undo>${a.history.at(-1)?.did === 'undone' ? 'Put that change back' : 'Undo last change'}</button>` : ''}
    </div>`

  const noteForm = (a, d) =>
    html`<form class="note-form"><textarea name="note" rows="3" maxlength="1000" placeholder="What happened? (Enter saves, Esc cancels)">${d ? d.note : (a.note?.text ?? '')}</textarea><div><button class="btn small primary" type="submit">Save note</button>${a.note ? html`<button class="btn small ghost" type="button" data-clear>Clear</button>` : ''}<button class="btn small ghost" type="button" data-cancel>Cancel</button></div></form>`
  const whyForm = (a, d) =>
    html`<form class="why-form"><input name="reason" type="text" maxlength="300" placeholder="Why? (optional)" value="${d ? d.reason : (a.canceled?.reason ?? '')}" aria-label="Why it no longer matters" /><div><button class="btn small primary" type="submit">${a.canceled ? 'Save reason' : 'Cancel this item'}</button><button class="btn small ghost" type="button" data-cancel>${a.canceled ? 'Never mind' : 'Keep it'}</button></div></form>`
  const holdForm = (a, d) => {
    const kept = a.hold?.after ?? []
    const taken = new Set([a.id, ...kept.map((r) => r.id)])
    const others = actions.filter((x) => x.status === 'open' && !taken.has(x.id) && !waitsOn(x, a.id))
    // a blocker stays ticked unless this form showed it and it was unticked
    const ticked = (id) => !d || !d.seen.includes(id) || d.keep.includes(id)
    return html`<form class="hold-form">
      <input name="hold" type="text" maxlength="300" placeholder="What is it waiting on?" value="${d ? d.hold : (a.hold?.on ?? '')}" aria-label="What it waits on" />
      ${kept.map((r) => html`<label class="keep"><input type="checkbox" name="keep" value="${r.id}" ${ticked(r.id) ? 'checked' : ''} /><span>after ${label(r)}</span></label>`)}
      ${others.length
        ? html`<select name="after" aria-label="Wait for another item"><option value="">${kept.length ? 'And after another item…' : 'After another item… (optional)'}</option>${others.map((x) => html`<option value="${x.id}" ${d?.after === x.id ? 'selected' : ''}>${label(x)}</option>`)}</select>`
        : ''}
      <div><button class="btn small primary" type="submit">${a.hold ? 'Save' : 'Put on hold'}</button>${a.hold ? html`<button class="btn small ghost" type="button" data-release>Take off hold</button>` : ''}<button class="btn small ghost" type="button" data-cancel>Cancel</button></div>
    </form>`
  }
  // What backs an item up. Done or canceled: the evidence, where it comes from and (canceled) the item that
  // replaces it. Open: a look for confirmation that found nothing, and where it looked.
  const proofForm = (a, d) => {
    const open = a.status === 'open'
    const was = open ? a.checked : (a.done ?? a.canceled)
    // a source stays ticked unless this form showed it and it was unticked
    const ticked = (key) => !d || !d.seen.includes(key) || d.keep.includes(key)
    const stands = actions.filter((x) => x.id !== a.id && x.status !== 'canceled')
    const replaced = d ? d.replacedBy : (a.replacedBy?.id ?? '')
    return html`<form class="proof-form">
      ${open
        ? html`<input name="notFound" type="text" maxlength="500" placeholder="What did you check?" value="${d ? d.notFound : (was?.text ?? '')}" aria-label="What was checked" />`
        : html`<textarea name="evidence" rows="2" maxlength="500" placeholder="What shows it? (optional)" aria-label="Evidence">${d ? d.evidence : (was?.evidence ?? '')}</textarea>`}
      ${(was?.sources ?? []).map((s) => {
        const key = JSON.stringify(s)
        return html`<label class="keep"><input type="checkbox" name="keep" value="${key}" ${ticked(key) ? 'checked' : ''} /><span>${sourceText(s)}</span></label>`
      })}
      <div class="source-add">
        <select name="from" aria-label="${open ? 'Where you looked' : 'Add a source'}"><option value="">${open ? 'Where you looked… (optional)' : 'Add a source… (optional)'}</option>
          <optgroup label="Meetings">${app.lib.meetings.map((m) => html`<option value="m:${m.id}" ${d?.from === `m:${m.id}` ? 'selected' : ''}>${fmtDate(m.date)} · ${m.title}</option>`)}</optgroup>
          ${notebook.length ? html`<optgroup label="Notebook">${notebook.map((n) => html`<option value="n:${n.id}" ${d?.from === `n:${n.id}` ? 'selected' : ''}>${n.title}</option>`)}</optgroup>` : ''}
        </select>
        <input name="at" type="text" maxlength="12" placeholder="at 12:34" value="${d?.at ?? ''}" aria-label="When in that meeting (optional)" />
      </div>
      <input name="ref" type="text" maxlength="200" placeholder="${open ? 'Or somewhere else you looked' : 'Or a source outside the archive'}: an email, a ticket…" value="${d?.ref ?? ''}" aria-label="A source outside the archive" />
      ${a.canceled
        ? html`<select name="replacedBy" aria-label="Replaced by"><option value="">Not replaced by another item</option>${stands.map((x) => html`<option value="${x.id}" ${replaced === x.id ? 'selected' : ''}>Replaced by ${label(x)}</option>`)}</select>`
        : ''}
      <div><button class="btn small primary" type="submit">${open ? 'Save what you checked' : 'Save evidence'}</button><button class="btn small ghost" type="button" data-cancel>Cancel</button></div>
    </form>`
  }
  const FORMS = { note: noteForm, why: whyForm, hold: holdForm, proof: proofForm }

  const card = (a, i) => {
    const people = a.people.map((id) => app.people.get(id)).filter(Boolean)
    const t = a.ranges[0]?.[0]
    const hue = a.meeting?.hue ?? 48
    const open = form?.id === a.id ? form : null
    // a note being edited sits in the form; once the draft says something else (or the note changed under it)
    // the saved one shows above the form again
    const editingNote = open?.kind === 'note' && (!open.draft || open.draft.note === (a.note?.text ?? ''))
    // the evidence form shows what it edits, so the lines it replaces step aside while it is open
    const editingProof = open?.kind === 'proof'
    const mark = a.done ?? a.canceled
    const unfolded = trail === a.id
    const tool = (attr, text, more = '') => html`<button type="button" class="link-btn ${more}" ${raw(attr)}>${text}</button>`
    const tools = [
      tool('data-form="note"', a.note ? 'Edit note' : 'Add note'),
      a.status === 'open' ? [tool('data-form="hold"', a.hold ? 'Edit hold' : 'Put on hold'), tool('data-form="why"', 'No longer relevant'), tool('data-form="proof"', a.checked ? 'Edit check' : 'Looked, found nothing')] : '',
      a.canceled ? [tool('data-form="why"', a.canceled.reason ? 'Edit reason' : 'Add reason'), tool('data-reopen', 'Reopen')] : '',
      mark ? tool('data-form="proof"', mark.evidence || mark.sources?.length ? 'Edit evidence' : 'Add evidence') : '',
      a.history.length || a.original ? tool(`data-trail aria-expanded="${unfolded ? 'true' : 'false'}"`, unfolded ? 'Hide history' : 'History') : '',
      a.source === 'added' ? tool('data-delete', 'Delete', 'danger') : '',
    ]
    return html`<article class="sticky ${a.status === 'open' ? '' : a.status} ${parked(a) ? 'parked' : ''} ${a.lane} ${a.source} ${open || unfolded ? 'editing' : ''}" data-action="${a.id}" data-rev="${a.rev}" style="--hue:${hue};--tilt:${((i * 37) % 5) - 2}deg">
      ${raw(pin(hue))}
      ${raw(tick(a))}
      <div class="who">${people.map((p) => raw(avatar(p, { size: 26, title: false })))}<b>${a.owner || 'Unassigned'}</b></div>
      <p>${a.text}</p>
      ${a.hold && open?.kind !== 'hold' ? holdLine(a) : ''}
      ${a.canceled?.reason && open?.kind !== 'why' ? html`<p class="reason">✕ ${a.canceled.reason}</p>` : ''}
      ${a.replacedBy && !editingProof ? html`<p class="links">Replaced by ${ref(a.replacedBy)}</p>` : ''}
      ${a.replaces.length ? html`<p class="links">Replaces ${a.replaces.map((r, n) => html`${n ? ', ' : ''}${ref(r)}`)}</p>` : ''}
      ${mark && editingProof ? '' : proof(mark)}
      ${a.checked && !(editingProof && a.status === 'open') ? html`<p class="looked"><b>🔎 Looked, found nothing</b> ${a.checked.text} ${sources(a.checked.sources, 'Looked in')} <small>${a.checked.by} · ${when(a.checked.at)}</small></p>` : ''}
      ${a.note && !editingNote ? html`<p class="note">✎ ${a.note.text} <small>${a.note.by} · ${when(a.note.at)}</small></p>` : ''}
      ${open ? FORMS[open.kind](a, open.draft) : ''}
      ${open || unfolded ? '' : raw(stamp(a))}
      ${unfolded ? trailOf(a) : ''}
      <footer>
        ${a.meeting ? html`<a href="/m/${a.meeting.id}?tab=notes${t != null ? `&t=${Math.floor(t)}` : ''}">${a.meeting.title}</a>` : html`<span class="free">Not tied to a meeting</span>`}
        <span>${a.source === 'added' ? `added by ${a.createdBy} · ${when(a.createdAt)}` : `${a.meeting ? fmtDate(a.meeting.date) : ''}${t != null ? ` · ${rangeText(a.ranges[0], a.meeting.timeBase)}` : ''}`}</span>
        <span class="card-tools">${tools}</span>
      </footer>
    </article>`
  }

  // quiet: a refresh from outside, which leaves the board as it is when it finds nothing new (every card would come in
  // again, and the page catches up every few minutes)
  function render(quiet = false) {
    if (ctl.signal.aborted) return
    // a hold is for open items only, and the evidence form asks different things of an open item and a closed one
    if (form && (!byId(form.id) || (form.kind === 'hold' && byId(form.id).status !== 'open') || (form.kind === 'proof' && byId(form.id).status !== form.status))) form = null
    if (trail && !byId(trail)) trail = ''
    // what is typed into the open form, and where the cursor is, survive the redraw
    const typed = form && cardOf(form.id)?.querySelector(`form.${form.kind}-form`)
    if (typed) {
      const fd = new FormData(typed)
      form.draft = { ...Object.fromEntries(fd), keep: fd.getAll('keep'), seen: [...typed.querySelectorAll('[name=keep]')].map((box) => box.value) }
    }
    const active = root.contains(document.activeElement) ? document.activeElement : null
    const held = active?.name && active.form ? { card: active.closest('.sticky')?.dataset.action, name: active.name, at: [active.selectionStart, active.selectionEnd] } : null
    const draft = Object.fromEntries(new FormData($('.add-task', root) ?? document.createElement('form')))

    const list = actions.filter((a) => inShow(a) && inWho(a)).sort((x, y) => rank(x) - rank(y) || (y.createdAt ?? y.meeting?.date ?? '').localeCompare(x.createdAt ?? x.meeting?.date ?? ''))
    const us = list.filter((a) => a.lane === 'us')
    const them = list.filter((a) => a.lane === 'them')
    const live = actions.filter((a) => a.status === 'open' && !parked(a))
    const waiting = actions.filter(parked).length
    const owners = [...new Set(actions.flatMap((a) => a.people))].map((id) => app.people.get(id)).filter(Boolean)
    const page = String(html`<section class="board page">
      <header class="page-head">
        <p class="eyebrow">The board</p>
        <h1>Who said they'd do what</h1>
        <p>Every action item from every set of notes, plus anything added here or by an agent. Tick one off, cancel one that no longer matters, put one on hold while it waits on something, leave a note or add a task and the other person's board (and their agents) see it straight away. The notes record what was agreed at the time; this board tracks what actually happened.</p>
        <div class="counters">
          <span><b>${live.filter((a) => a.lane === 'us').length}</b> open on us</span>
          <span><b>${live.filter((a) => a.lane === 'them').length}</b> waiting on them</span>
          ${waiting ? html`<span><b>${waiting}</b> on hold</span>` : ''}
          <span><b>${actions.filter((a) => a.status === 'done').length}</b> done</span>
          <span><b>${actions.filter((a) => a.status === 'canceled').length}</b> canceled</span>
        </div>
        <form class="add-task" autocomplete="off">
          <input name="text" type="text" maxlength="600" placeholder="Add a task… e.g. Send the vendor the endpoint spec" value="${draft.text ?? ''}" aria-label="Task" />
          <input name="owner" type="text" maxlength="80" list="owners" placeholder="Who" value="${draft.owner ?? crew.join('/')}" aria-label="Owner" />
          <datalist id="owners">${crew.length > 1 ? html`<option value="${crew.join('/')}"></option>` : ''}${app.lib.people.map((p) => html`<option value="${p.short}"></option>`)}</datalist>
          <select name="meetingId" aria-label="Meeting"><option value="">No meeting</option>${app.lib.meetings.map((m) => html`<option value="${m.id}" ${draft.meetingId === m.id ? 'selected' : ''}>${fmtDate(m.date)} · ${m.title}</option>`)}</select>
          <button class="btn primary" type="submit" ${adding ? 'disabled' : ''}>Add</button>
        </form>
        <div class="filters">
          ${SHOWS.map((k) => html`<button type="button" class="fchip ${show === k ? 'on' : ''}" data-show="${k}">${SHOW_LABEL[k]}</button>`)}
          <span class="fsep"></span>
          <button type="button" class="fchip ${!who ? 'on' : ''}" data-who="">Anyone</button>
          ${owners.map((p) => html`<button type="button" class="fchip person ${who === p.id ? 'on' : ''}" data-who="${p.id}">${raw(avatar(p, { size: 20, title: false }))}${p.short}</button>`)}
        </div>
      </header>
      <div class="lanes">
        <section class="lane-col us"><h2>On us <small>${crew.length ? `${crew.join(' & ')} · ` : ''}${us.length}</small></h2><div class="stickies">${us.length ? us.map(card) : html`<p class="empty">Nothing here. ${show === 'open' ? 'Clean plate.' : ''}</p>`}</div></section>
        <section class="lane-col them"><h2>Waiting on them <small>${them.length}</small></h2><div class="stickies">${them.length ? them.map(card) : html`<p class="empty">Nothing here.</p>`}</div></section>
      </div>
      ${deleted.length
        ? html`<details class="deleted" ${openDeleted ? 'open' : ''}><summary>Recently deleted <small>${deleted.length}</small></summary><ul>${deleted.map(
            (d) => html`<li><span>${d.owner ? html`<b>${d.owner}:</b> ` : ''}${d.text}</span><small>deleted by ${d.by} · ${when(d.at)}</small><button type="button" class="btn" data-restore="${d.id}">Bring back</button></li>`,
          )}</ul></details>`
        : ''}
    </section>`)
    if (quiet && page === drawn) return
    root.innerHTML = drawn = page

    let field
    if (form?.fresh) {
      // a form that just opened takes the cursor, at the end of what is already there
      form.fresh = false
      field = cardOf(form.id)?.querySelector('form :is(textarea, input[type=text])')
      field?.focus()
      field?.setSelectionRange(field.value.length, field.value.length)
    } else if (held) {
      field = (held.card ? cardOf(held.card) : $('.add-task', root))?.querySelector(`[name="${held.name}"]`)
      field?.focus()
      try {
        if (held.at[0] != null) field?.setSelectionRange(...held.at)
      } catch {
        // a checkbox or a select has no selection to put back
      }
    }
  }

  const flash = (id) => {
    const node = cardOf(id)
    if (!node) return
    node.classList.remove('flash')
    void node.offsetWidth
    node.classList.add('flash')
  }
  const sync = () => history.replaceState(history.state, '', `/actions?show=${show}${who ? `&who=${who}` : ''}`)
  // bring a card into view, widening the filters only as far as it takes to show it
  const reveal = (id) => {
    const a = byId(id)
    if (!a) return void app.toast({ icon: '🫥', title: 'That item is no longer on the board', timeout: 4000 })
    if (!inShow(a) || !inWho(a)) {
      if (!inShow(a)) show = 'all'
      if (!inWho(a)) who = ''
      sync()
      render()
    }
    cardOf(id)?.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' })
    flash(id)
  }

  const pull = async () => {
    const r = await get('/api/actions')
    actions = r.actions
    notes = r.notes ?? {}
    deleted = r.deleted ?? []
  }
  const refresh = async () => {
    await pull()
    render()
  }
  const settled = async () => {
    while (Date.now() < settle) await pause(settle - Date.now())
  }
  // someone else's change: wait for a stamp that is landing, and never redraw under an open form
  const refreshSoon = coalesce(async () => {
    await pull()
    await settled()
    if (!form) render(true)
  })
  const swap = (a) => (actions = actions.map((x) => (x.id === a.id ? a : x)))
  // Every change says which revision of the item it was made against (the one on the card the person was
  // looking at), so a change that crossed with someone else's is refused instead of quietly winning.
  const send = (id, patch) => {
    const rev = cardOf(id)?.dataset.rev
    return post(`/api/actions/${encodeURIComponent(id)}`, { ...patch, ...(rev != null ? { rev: Number(rev) } : {}) })
  }
  const crossed = (err) => {
    if (err.status !== 409 || !err.body?.action) return false
    const last = err.body.action.history.at(-1)
    swap(err.body.action)
    render()
    app.toast({ icon: '✋', title: 'Not saved: this item just changed', body: `${last ? `${last.by} changed it` : 'It changed'} while this page still showed the older version. The card is up to date now; make your change again if it still applies.`, timeout: 9000 })
    return true
  }
  const save = async (id, patch, { close = false } = {}) => {
    if (saving) return
    saving = true
    try {
      const res = await send(id, patch)
      swap(res.action)
      if (close && form?.id === id) form = null
      // one change can move other cards too: an item this one was holding up, the one it replaces
      await refresh()
    } catch (err) {
      if (!crossed(err)) app.toast({ icon: '⚠️', title: "Couldn't save that", body: err.message })
    } finally {
      saving = false
    }
  }
  const changedUnder = (a) => {
    const last = a.history.at(-1)
    const now = { open: 'open again', done: 'done', canceled: 'canceled' }[a.status]
    app.toast({ icon: '✋', title: 'Not saved: this item just changed', body: `${last ? `${last.by} changed it` : 'It changed'} while you were writing, and it is ${now} now. What you wrote is still in the form; Cancel shows the card as it stands.`, timeout: 12000 })
  }
  const closeForm = () => {
    if (!form) return
    const { id, kind } = form
    form = null
    render()
    cardOf(id)?.querySelector(`[data-form="${kind}"]`)?.focus()
  }

  const add = async (f) => {
    if (adding) return
    const fd = Object.fromEntries(new FormData(f))
    if (!fd.text.trim()) return f.elements.text.focus()
    adding = true
    const button = $('button[type=submit]', f)
    if (button) button.disabled = true
    try {
      const res = await post('/api/tasks', fd)
      if (ctl.signal.aborted) return
      const current = $('.add-task', root)
      if (current && ['text', 'owner', 'meetingId'].every((name) => current.elements[name].value === fd[name])) current.elements.text.value = ''
      show = 'open'
      sync()
      await refresh()
      if (!ctl.signal.aborted) reveal(res.action.id)
    } catch (err) {
      app.toast({ icon: '⚠️', title: "Couldn't add the task", body: err.message })
    } finally {
      adding = false
      const currentButton = $('.add-task button[type=submit]', root)
      if (currentButton) currentButton.disabled = false
    }
  }
  // no "are you sure?": the task goes, and the toast that says so can bring it back
  const remove = async (a) => {
    try {
      await post(`/api/tasks/${encodeURIComponent(a.id)}/delete`, {})
    } catch (err) {
      return void app.toast({ icon: '⚠️', title: "Couldn't delete it", body: err.message })
    }
    await refresh()
    app.toast({
      icon: '🗑️',
      title: 'Task deleted',
      body: cut(a.text, 90),
      timeout: 14000,
      actionLabel: 'Undo',
      onAction: async () => {
        try {
          await post(`/api/actions/${encodeURIComponent(a.id)}`, { undo: true })
          if (ctl.signal.aborted) return
          await refresh()
          reveal(a.id)
        } catch (err) {
          app.toast({ icon: '⚠️', title: "Couldn't bring it back", body: err.message })
        }
      },
    })
  }

  // toggle doesn't bubble, so it is caught on the way down
  root.addEventListener('toggle', (e) => e.target.matches?.('details.deleted') && (openDeleted = e.target.open), { capture: true, signal: ctl.signal })
  on('click', async (e) => {
    const back = e.target.closest('[data-restore]')
    if (back) {
      back.disabled = true
      try {
        await post(`/api/actions/${encodeURIComponent(back.dataset.restore)}`, { undo: true })
        if (ctl.signal.aborted) return
        await refresh()
        reveal(back.dataset.restore)
      } catch (err) {
        back.disabled = false
        app.toast({ icon: '⚠️', title: "Couldn't bring it back", body: err.message })
      }
      return
    }
    const chip = e.target.closest('[data-show], [data-who]')
    if (chip) {
      if (chip.dataset.show != null) show = chip.dataset.show
      else who = chip.dataset.who
      sync()
      return render()
    }
    const link = e.target.closest('a[data-focus]')
    if (link) {
      // a plain click jumps to the card; with a modifier key the link opens the usual way
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
      e.preventDefault()
      return reveal(link.dataset.focus)
    }
    const btn = e.target.closest('.sticky button')
    const id = btn?.closest('.sticky').dataset.action
    const a = id && byId(id)
    if (!a) return
    const d = btn.dataset
    if (d.form) {
      form = form?.id === id && form.kind === d.form ? null : { id, kind: d.form, status: a.status, fresh: true }
      return render()
    }
    if ('cancel' in d) return closeForm()
    if ('trail' in d) {
      trail = trail === id ? '' : id
      return render()
    }
    if ('clear' in d) return save(id, { note: '' }, { close: true })
    if ('release' in d) return save(id, { hold: '' }, { close: true })
    if ('reopen' in d) return save(id, { status: 'open' }, { close: true })
    if ('undo' in d) return save(id, { undo: true })
    if ('delete' in d) return remove(a)
  })

  on('submit', (e) => {
    e.preventDefault()
    const f = e.target
    if (f.matches('.add-task')) return add(f)
    const id = f.closest('.sticky')?.dataset.action
    const a = id && byId(id)
    if (!a) return
    const fd = new FormData(f)
    if (f.matches('.note-form')) return save(id, { note: fd.get('note') }, { close: true })
    if (f.matches('.why-form')) return save(id, { status: 'canceled', reason: fd.get('reason') }, { close: true })
    if (f.matches('.hold-form')) {
      const hold = fd.get('hold').trim()
      const blockedBy = [...new Set([...fd.getAll('keep'), fd.get('after')].filter(Boolean))]
      // nothing to wait on and nothing to take off: ask again rather than save an empty hold
      if (!hold && !blockedBy.length && !a.hold) return f.elements.hold.focus()
      return save(id, { hold, blockedBy }, { close: true })
    }
    if (f.matches('.proof-form')) {
      // done, canceled or reopened since this form opened (a live update doesn't redraw under an open form): it asks
      // about the item as it stood, so nothing is sent, and what was typed stays in the form
      if (form?.id === id && form.status !== a.status) return changedUnder(a)
      const from = fd.get('from')
      const at = fd.get('at').trim()
      const elsewhere = fd.get('ref').trim()
      // a time goes with a meeting: ask for the meeting rather than drop the time
      if (at && !from.startsWith('m:')) return f.elements.from.focus()
      // the sources still ticked, then any added here; the server checks each one and the limit of eight
      const sources = [
        ...fd.getAll('keep').map((key) => JSON.parse(key)),
        ...(from.startsWith('m:') ? [{ meeting: from.slice(2), ...(at ? { at } : {}) }] : from.startsWith('n:') ? [{ note: from.slice(2) }] : []),
        ...(elsewhere ? [{ ref: elsewhere }] : []),
      ]
      // which save it is comes from the form on screen: evidence for a closed item, what was checked for an open one
      if (fd.has('evidence')) return save(id, { evidence: fd.get('evidence'), sources, ...(fd.has('replacedBy') ? { replacedBy: fd.get('replacedBy') } : {}) }, { close: true })
      // a look that found nothing says what was looked at
      const looked = (fd.get('notFound') ?? '').trim()
      if (!looked) return f.elements.notFound?.focus()
      return save(id, { notFound: looked, sources }, { close: true })
    }
  })

  on('keydown', (e) => {
    const f = e.target.closest?.('.sticky form')
    if (!f) return
    if (e.key === 'Escape') return closeForm()
    // Enter saves a note and Shift+Enter starts a new line; the one-line fields submit on Enter by themselves.
    // An Enter that only picks a suggestion while composing (Japanese, Chinese, Korean input) is left alone.
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.target.matches('textarea')) {
      e.preventDefault()
      f.requestSubmit()
    }
  })

  on('change', async (e) => {
    const box = e.target.closest('.tick input[type=checkbox]')
    if (!box) return
    const node = box.closest('.sticky')
    const id = node.dataset.action
    const done = box.checked
    node.classList.toggle('done', done)
    if (done) settle = Date.now() + 900
    else node.querySelector('.stamp')?.remove()
    try {
      const res = await send(id, { status: done ? 'done' : 'open' })
      swap(res.action)
      node.dataset.rev = res.action.rev
      // the stamp comes down on the card as it is; the board is put back in order once it has landed
      if (done && !node.classList.contains('editing')) node.querySelector('footer')?.insertAdjacentHTML('beforebegin', stamp(res.action))
      await settled()
      await refresh()
    } catch (err) {
      box.checked = !done
      node.classList.toggle('done', !done)
      // a stamp still coming down on another card lands before the board is redrawn
      await settled()
      if (!crossed(err)) {
        render()
        app.toast({ icon: '⚠️', title: "Couldn't save that", body: err.message })
      }
    }
  })

  // arriving from a toast, a search result or an agent's link: show that card, whatever the filters say
  const wanted = query.get('focus')
  const target = wanted && byId(wanted)
  if (target && !inShow(target)) show = 'all'
  if (target && !inWho(target)) who = ''
  render()
  if (wanted) setTimeout(() => !ctl.signal.aborted && reveal(wanted), 150)

  const leave = () => ctl.abort()
  return {
    async onState(d) {
      // recovered: a change whose save had failed is on disk now; it names no item, so nothing is pointed at
      if (!['action', 'task-added', 'task-deleted', 'recovered'].includes(d.kind)) return
      // our own change coming back around: the board already shows it
      if (d.kind === 'action' && d.rev != null && byId(d.id)?.rev === d.rev) return
      await refreshSoon()
      if (!form && d.kind !== 'task-deleted' && d.kind !== 'recovered') flash(d.id)
    },
    onLibrary: refreshSoon,
    onResume: refreshSoon,
    onLeave: leave,
    cleanup: leave,
  }
}
