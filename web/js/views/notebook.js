// The notebook: research, decisions and context saved by the crew or their agents, linked to meetings.
import { get, post } from '../api.js'
import { avatar, icon } from '../art.js'
import { markdown } from '../markdown.js'
import { $, fmtDate, html, raw, relDay } from '../util.js'

const when = (iso) => `${relDay(iso.slice(0, 10))} · ${new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`

export async function load({ params }) {
  const [list, trash] = await Promise.all([get('/api/notebook'), get('/api/notebook?deleted=1')])
  const note = params[0] ? await get(`/api/notebook/${encodeURIComponent(params[0])}`) : null
  return { list, trash, note }
}

const byline = (app, name) => {
  const p = app.personByName(name.replace(/['’]s agent$/i, ''))
  const agent = /agent/i.test(name)
  return html`<span class="byline">${p ? raw(avatar(p, { size: 22, title: false })) : ''}<b>${name}</b>${agent ? html`<i class="agent-tag">agent</i>` : ''}</span>`
}

function card(app, n) {
  return html`<a class="nb-card" href="/notebook/${encodeURIComponent(n.id)}">
    <h3>${n.title}</h3>
    <p class="nb-excerpt">${n.excerpt.replace(/[#*_`>[\]]/g, '').slice(0, 220)}${n.excerpt.length > 220 ? '…' : ''}</p>
    <div class="nb-meta">${byline(app, n.updatedBy)}<span>${when(n.updatedAt)}</span>${n.revisions ? html`<span>${n.revisions} earlier version${n.revisions === 1 ? '' : 's'}</span>` : ''}</div>
    <div class="nb-links">${n.tags.map((t) => html`<i class="tag">#${t}</i>`)}${n.meetingIds.map((id) => html`<i class="mlink" style="--hue:${app.byId.get(id)?.hue ?? 0}">${app.byId.get(id)?.title ?? id}</i>`)}</div>
  </a>`
}

// typed: what the editor held before a redraw; without it the editor opens on the note as saved
function editor(app, n, typed) {
  const v = typed ?? { title: n?.title ?? '', body: n?.body ?? '', tags: n?.tags.join(', ') ?? '', meetingIds: n?.meetingIds ?? [] }
  return html`<form class="nb-editor" autocomplete="off">
    <input name="title" maxlength="200" placeholder="Title" value="${v.title}" required />
    <textarea name="body" rows="14" maxlength="60000" placeholder="Markdown. Paste research, decisions, context… (credentials are refused)" required>${v.body}</textarea>
    <div class="nb-editor-row">
      <input name="tags" placeholder="tags, comma separated" value="${v.tags}" />
      <select name="meetingIds" multiple size="4" aria-label="Linked meetings">${app.lib.meetings.map((m) => html`<option value="${m.id}" ${v.meetingIds.includes(m.id) ? 'selected' : ''}>${fmtDate(m.date)} · ${m.title}</option>`)}</select>
    </div>
    <div class="nb-editor-row end"><button class="btn ghost" type="button" data-cancel>Cancel</button><button class="btn primary" type="submit">${n ? 'Save changes' : 'Save to notebook'}</button></div>
  </form>`
}

export async function mount(root, { app, params, query, data }) {
  let { list, trash, note } = data
  let tag = query.get('tag') ?? ''
  let editing = query.get('new') === '1' ? 'new' : ''
  let showVersions = false
  // whether this edit changed the meeting picker itself, as opposed to the links someone else saved meanwhile
  let linksPicked = false
  let saving = false
  let refresh
  let closed = false
  // What is typed into the open editor (title, body, tags, linked meetings) survives every redraw of this view.
  // opened: what the editor held when it opened, so leaving the page asks first only when something was typed.
  let draft = null
  let opened = null
  const typed = () => {
    const f = $('.nb-editor', root)
    return f && { title: f.title.value, body: f.body.value, tags: f.tags.value, meetingIds: [...f.meetingIds.selectedOptions].map((o) => o.value) }
  }
  const unsaved = () => Boolean(editing && opened && JSON.stringify(typed() ?? draft) !== JSON.stringify(opened))

  const listView = () => {
    const notes = list.notes.filter((n) => !tag || n.tags.includes(tag))
    const tags = [...new Set(list.notes.flatMap((n) => n.tags))].sort()
    const s = list.semantic
    return html`<section class="notebook page">
      <header class="page-head">
        <p class="eyebrow">The notebook</p>
        <h1>What we figured out</h1>
        <p>Research, decisions and context saved by ${app.lib.crew?.length ? app.lib.crew.join(', ') : 'the crew'} or their agents, linked to the meetings they relate to. Agents add to it through MCP (<code>find_connections</code> then <code>save_note</code>) and pull briefs out of it with <code>gather_context</code>.</p>
        <div class="counters"><span><b>${list.notes.length}</b> note${list.notes.length === 1 ? '' : 's'}</span><span class="sem ${s?.enabled && !s?.error ? 'on' : ''}">${s?.enabled ? (s.error ? `meaning search paused: ${s.error}` : html`meaning search on · ${s.embedded}/${s.total} passages · <code>${s.model}</code>`) : 'meaning search off (keyword only)'}</span></div>
        <div class="filters">
          <button type="button" class="btn primary small" data-new>${raw(icon.arrow)} New note</button>
          <span class="fsep"></span>
          <button type="button" class="fchip ${!tag ? 'on' : ''}" data-tag="">All</button>
          ${tags.map((t) => html`<button type="button" class="fchip ${tag === t ? 'on' : ''}" data-tag="${t}">#${t}</button>`)}
        </div>
      </header>
      ${editing === 'new' ? editor(app, null, draft) : ''}
      <div class="nb-grid">${notes.length ? notes.map((n) => card(app, n)) : html`<p class="empty">${tag ? `Nothing tagged #${tag}.` : 'Empty so far. Ask an agent to "save what we worked out here to the meetings notebook", or write one yourself.'}</p>`}</div>
      ${trash.notes.length ? html`<details class="nb-trash"><summary>Recently deleted (${trash.notes.length})</summary>${trash.notes.map((n) => html`<div class="nb-trash-row"><span>${n.title} <small>deleted by ${n.deleted.by} · ${when(n.deleted.at)}</small></span><button class="btn small ghost" type="button" data-restore="${n.id}">Restore</button></div>`)}</details>` : ''}
    </section>`
  }

  const noteView = () => {
    const n = note.note
    const tasks = n.taskIds
    return html`<article class="notebook page nb-note">
      <a class="back" href="/notebook">${raw(icon.arrow)} The notebook</a>
      <header class="page-head">
        <p class="eyebrow">Notebook${n.tags.length ? ` · ${n.tags.map((t) => `#${t}`).join(' ')}` : ''}</p>
        <h1>${n.title}</h1>
        <div class="nb-meta">${byline(app, n.author)}<span>started ${when(n.createdAt)}</span>${n.updatedBy !== n.author || n.updatedAt !== n.createdAt ? html`<span>· updated by ${n.updatedBy} ${when(n.updatedAt)}</span>` : ''}${n.source ? html`<span>· from ${n.source}</span>` : ''}</div>
        <div class="nb-links">${n.meetingIds.map((id) => html`<a class="mlink" style="--hue:${app.byId.get(id)?.hue ?? 0}" href="/m/${encodeURIComponent(id)}">${app.byId.get(id)?.title ?? id}</a>`)}${tasks.length ? html`<a class="mlink task" href="/actions">${tasks.length} linked action item${tasks.length === 1 ? '' : 's'}</a>` : ''}</div>
        <div class="filters">
          <button class="btn small" type="button" data-edit>Edit</button>
          ${note.revisions.length ? html`<button class="btn small ghost" type="button" data-versions>${showVersions ? 'Hide' : 'Show'} ${note.revisions.length} earlier version${note.revisions.length === 1 ? '' : 's'}</button>` : ''}
          <button class="btn small ghost danger" type="button" data-delete>Delete</button>
        </div>
      </header>
      ${editing === n.id ? editor(app, n, draft) : html`<div class="md">${raw(markdown(n.body))}</div>`}
      ${showVersions ? html`<section class="nb-versions">${note.revisions.map((r) => html`<details><summary>${r.title} · ${r.by} · ${when(r.at)}</summary><div class="md">${raw(markdown(r.body))}</div></details>`)}</section>` : ''}
    </article>`
  }

  // quiet: a refresh from outside, which leaves the page as it is when it finds nothing new (the cards would come in
  // again, and the page catches up every few minutes)
  let drawn = ''
  const render = (quiet = false) => {
    draft = editing ? (typed() ?? draft) : null
    const page = String(note ? noteView() : listView())
    if (quiet && page === drawn) return
    root.innerHTML = drawn = page
    if (editing && !draft) opened = typed()
    document.title = note ? `${note.note.title} · Notebook` : 'Notebook · On the Record'
    $('.nb-editor input[name=title]', root)?.focus()
  }
  render()

  const reload = async (keepDraft = false) => {
    if (closed) return
    refresh?.abort()
    const request = refresh = new AbortController()
    try {
      const [freshList, freshTrash, freshNote] = await Promise.all([
        get('/api/notebook', request.signal),
        get('/api/notebook?deleted=1', request.signal),
        note ? get(`/api/notebook/${encodeURIComponent(note.note.id)}`, request.signal).catch(() => null) : null,
      ])
      if (request.signal.aborted || (keepDraft && editing)) return
      list = freshList
      trash = freshTrash
      note = freshNote
      // a live update or a catch-up (keepDraft) draws the page again only if something changed
      render(keepDraft)
    } catch (err) {
      if (!request.signal.aborted) throw err
    }
  }

  root.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-tag]')
    if (t) {
      tag = t.dataset.tag
      history.replaceState(history.state, '', tag ? `/notebook?tag=${encodeURIComponent(tag)}` : '/notebook')
      return render()
    }
    if (e.target.closest('[data-new]')) {
      editing = 'new'
      linksPicked = false
      return render()
    }
    if (e.target.closest('[data-edit]')) {
      editing = note.note.id
      linksPicked = false
      return render()
    }
    if (e.target.closest('[data-cancel]')) {
      editing = ''
      return render()
    }
    if (e.target.closest('[data-versions]')) {
      showVersions = !showVersions
      return render()
    }
    // no "are you sure?": the note goes to the recently deleted, and the toast that says so can bring it back
    if (e.target.closest('[data-delete]')) {
      const { id, title } = note.note
      try {
        await post(`/api/notebook/${encodeURIComponent(id)}/delete`, {})
      } catch (err) {
        return void app.toast({ icon: '⚠️', title: "Couldn't delete it", body: err.message })
      }
      app.toast({
        icon: '🗑️',
        title: 'Note deleted',
        body: title,
        timeout: 14000,
        actionLabel: 'Undo',
        onAction: async () => {
          try {
            await post(`/api/notebook/${encodeURIComponent(id)}/restore`, {})
            // still on the notebook: open the note again; anywhere else it is simply back in the list
            if (location.pathname === '/notebook') app.navigate(`/notebook/${encodeURIComponent(id)}`)
          } catch (err) {
            app.toast({ icon: '⚠️', title: "Couldn't bring it back", body: err.message })
          }
        },
      })
      // what was being written into it went with the note: leaving for the list doesn't ask about it
      editing = ''
      return app.navigate('/notebook')
    }
    const r = e.target.closest('[data-restore]')
    if (r) {
      await post(`/api/notebook/${encodeURIComponent(r.dataset.restore)}/restore`, {})
      return reload()
    }
  })

  root.addEventListener('change', (e) => {
    if (e.target?.name === 'meetingIds') linksPicked = true
  })

  root.addEventListener('submit', async (e) => {
    e.preventDefault()
    if (closed || saving || !editing) return
    const f = e.target
    const payload = {
      title: f.title.value,
      body: f.body.value,
      tags: f.tags.value.split(',').map((s) => s.trim()).filter(Boolean),
      meetingIds: [...f.meetingIds.selectedOptions].map((o) => o.value),
    }
    saving = true
    const button = $('button[type=submit]', f)
    if (button) button.disabled = true
    try {
      if (editing === 'new') {
        const res = await post('/api/notebook', payload)
        if (closed || !root.contains(f)) return
        editing = ''
        return app.navigate(`/notebook/${res.note.id}`)
      }
      // the version this editor opened: a newer one saved meanwhile is never overwritten unawares
      await post(`/api/notebook/${encodeURIComponent(note.note.id)}`, { ...payload, ifVersion: note.note.version })
      if (closed || !root.contains(f)) return
      editing = ''
      await reload()
    } catch (err) {
      if (closed || !root.contains(f)) return
      if (note && err.status === 409 && err.body?.note) {
        // nothing was saved. The editor keeps this text; saving again replaces the newer version knowingly, and
        // that one stays among the earlier versions. The links come from the newer version, unless this edit
        // changed them, so saving again never drops a link someone else just added.
        note.note = err.body.note
        if (!linksPicked) for (const o of f.meetingIds.options) o.selected = note.note.meetingIds.includes(o.value)
        return void app.toast({ icon: '✋', title: 'Not saved: the note changed while you edited it', body: `${err.body.note.updatedBy} saved a newer version. Your text is still here. Save again to replace theirs; theirs stays among the earlier versions.`, timeout: 15000 })
      }
      app.toast({ icon: '⚠️', title: "Couldn't save", body: err.message, timeout: 8000 })
    } finally {
      saving = false
      if (button) button.disabled = false
    }
  })

  const leave = () => {
    closed = true
    refresh?.abort()
  }
  return {
    onLeave: leave,
    cleanup: leave,
    // the app asks before leaving the page while this is true
    unsaved,
    async onNotebook(d) {
      if (closed || editing) return
      if (note && d.id === note.note.id && d.kind === 'deleted') return app.navigate('/notebook')
      await reload(true)
    },
    onResume: () => editing ? undefined : reload(true),
  }
}

