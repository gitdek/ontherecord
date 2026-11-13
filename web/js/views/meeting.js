// One meeting: the deck and topic river on the left; notes, transcript, files (and any excerpt) on the right.
// Everything is wired to one clock: clicking a timestamp, a topic, a flag or a transcript line seeks the
// video, and playback lights up the matching topic, line and notes card.
import { get, post } from '../api.js'
import { avatar, cassette, gauge, icon, stamp, tick } from '../art.js'
import { SKIP, createDeck } from '../deck.js'
import { createRiver } from '../river.js'
import { $, $$, clamp, coalesce, debounce, esc, fmtBytes, fmtClockOfDay, fmtDur, fmtLong, fmtNum, fmtT, html, kindLabel, linkTimes, local, rangeText, raw, relDay, segmentAt, topicColor } from '../util.js'
import { faces, progressOf } from './home.js'

// whose Mac the archive is on, when the server says: "Ada’s Mac"
const macOf = (app) => (app.lib?.mac ? `${app.lib.mac}’s Mac` : 'the archive’s Mac')

const sameTimeline = (x, y) => x && y && Math.abs((x.probe?.duration ?? 0) - (y.probe?.duration ?? 0)) <= 2

const pickTranscript = (m, v) => m.transcripts.find((t) => v && t.videoIds.includes(v.fileId)) ?? m.transcripts.find((t) => t.id === m.primaryTranscript) ?? m.transcripts[0] ?? null
// who's talking in a transcript: { state, voices: [{ key, name, seconds, confirmed, by?, seen?, match? }], names: suggestions }
const voicesOf = (t) => (t ? { ...t.speakers, names: t.names ?? [] } : null)
// a transcript's lines on the meeting's clock: one made from a copy trimmed at the start begins partway in
const onClock = (segments, meta) => (meta?.offset ? segments.map((s) => ({ ...s, s: s.s + meta.offset, e: s.e + meta.offset })) : segments)
const VOICE_HUES = [196, 28, 152, 280, 88, 336, 54, 232]

// Everything the page needs, fetched before it swaps in.
export async function load({ params, query }) {
  const m = await get(`/api/meetings/${encodeURIComponent(params[0])}`)
  const selectedVideo = m.videos.find((v) => v.playable && v.fileId === query?.get('video'))
  const selected = m.transcripts.find((t) => t.id === query?.get('transcript'))
  const preferred = m.videos.find((v) => v.isDefault) ?? m.videos.find((v) => v.playable) ?? null
  const variant = selectedVideo ?? (selected && !(preferred?.playable && selected.videoIds.includes(preferred.fileId))
    ? m.videos.find((v) => v.playable && selected.videoIds.includes(v.fileId)) ?? preferred
    : preferred)
  const at = query?.get('vt')
  const startVideoAt = selectedVideo && at?.trim() && Number.isFinite(Number(at)) && Number(at) >= 0 ? Number(at) : null
  const tMeta = selected ?? pickTranscript(m, variant)
  const [transcript, nb] = await Promise.all([tMeta ? get(tMeta.url) : null, get('/api/notebook').catch(() => ({ notes: [] }))])
  return { m, variant, startVideoAt, tMeta, segs: onClock(transcript?.segments ?? [], tMeta), voices: voicesOf(transcript), linkedNotes: nb.notes.filter((n) => n.meetingIds.includes(m.id)) }
}

// The top of a meeting's page: its date (and what sort of recording it is, when not a meeting), title and stats.
export const pageHead = (app, m, variant) => html`
    <header class="m-head">
      <a class="back" href="/">${raw(icon.arrow)} The shelf</a>
      <div class="m-title-row">
        <div class="m-tape" aria-hidden="true">${raw(cassette(m, { progress: progressOf(m) }))}</div>
        <div class="m-heading">
          <p class="eyebrow">${fmtLong(m.date)} · ${relDay(m.date)}${m.time != null ? ` · rolling at ${fmtClockOfDay(m.time)}` : ''}${kindLabel(m.kind)}</p>
          <h1>${m.title}</h1>
          <p class="m-blurb">${m.blurb}</p>
          <div class="m-meta">
            <span class="faces">${faces(app, m.participants, 9)}</span>
            <span class="m-stats"><b>${fmtDur(m.duration)}</b> of tape · <b>${fmtNum(m.words)}</b> words · <b>${m.topics.length}</b> topics · <b class="n-actions">${m.actions.length}</b> action items</span>
            <span class="here-too" hidden></span>
          </div>
        </div>
        <div class="m-actions">
          ${variant ? html`<a class="btn primary dl" href="${variant.download}" download>${raw(icon.download)}<span>Download video</span><small>${fmtBytes(variant.size)}</small><i class="eject" aria-hidden="true"></i></a>` : ''}
          <button class="btn ghost share" type="button">${raw(icon.link)} Copy link to this moment</button>
        </div>
      </div>
    </header>`

export async function mount(root, { app, params, query, data }) {
  const { m } = data
  let { variant, tMeta, segs, voices } = data
  if (m.id !== params[0]) history.replaceState(history.state, '', `/m/${m.id}${location.search}`)
  document.title = `${m.title} · On the Record`
  const base = m.timeBase
  let sync = m.sync?.offset ?? null

  const canSeek = () => Boolean(variant?.playable) && (base === 'offset' || sync != null)
  const toAxis = (vt) => (base === 'offset' ? vt + (variant?.offset ?? 0) : vt + sync)
  const toVideo = (at) => (base === 'offset' ? at - (variant?.offset ?? 0) : at - sync)
  const thumbsOf = () => {
    const withThumbs = m.videos.find((v) => v.thumbs)
    return withThumbs && (withThumbs === variant || sameTimeline(withThumbs, variant)) ? withThumbs.thumbs : null
  }
  const topicAt = (at) => {
    let best = null
    for (const t of m.topics) for (const [s, e] of t.ranges) if (at >= s && at <= e && (!best || s > best.s)) best = { t, s }
    return best?.t ?? null
  }
  const captionAt = (at) => {
    const i = segmentAt(segs, at)
    const s = segs[i]
    return s && !s.q && at <= s.e + 1.2 ? s : null
  }
  const linesAt = (at) => {
    let i = segmentAt(segs, at)
    if (i < 0) return null
    while (i > 0 && segs[i].q) i--
    const near = (from, step) => {
      for (let k = from; k >= 0 && k < segs.length; k += step) if (!segs[k].q) return segs[k]
      return null
    }
    return { index: i, prev: near(i - 1, -1), now: segs[i].q ? null : segs[i], next: near(i + 1, 1) }
  }
  const thumbStyle = (vt, width) => {
    const th = thumbsOf()
    if (!th) return ''
    const i = clamp(Math.floor(vt / th.interval), 0, th.count - 1)
    const k = width / th.tileW
    return `background-image:url(${th.sprite});background-size:${th.cols * th.tileW * k}px auto;background-position:-${(i % th.cols) * th.tileW * k}px -${Math.floor(i / th.cols) * th.tileH * k}px;width:${width}px;height:${Math.round(th.tileH * k)}px`
  }
  const bands = () => (canSeek() ? m.topics.flatMap((t) => t.ranges.map(([s, e]) => ({ s: toVideo(s), e: toVideo(e), color: topicColor(t.color), title: t.title }))) : [])

  const tabs = [
    m.notes && ['notes', 'Notes'],
    m.transcripts.length && ['transcript', 'Transcript'],
    m.docs.length && ['excerpt', 'Excerpt'],
    ['files', 'Files'],
  ].filter(Boolean)
  let tab = query.get('tab') ?? (query.get('q') ? 'transcript' : local.get('tab', 'notes'))
  if (!tabs.some(([k]) => k === tab)) tab = tabs[0][0]

  root.innerHTML = String(html`
  <article class="meeting" style="--hue:${m.hue}">
    ${pageHead(app, m, variant)}
    ${base === 'clock' ? html`<div class="sync-banner"></div>` : ''}
    <section class="stage">
      <div class="stage-main">
        <div class="deck-host"></div>
        <section class="river-wrap">
          <header class="river-head"><h2>Topic river</h2><p>${m.topics.some((t) => t.auto) ? 'Chapters guessed from the transcript until notes arrive.' : 'Each lane is a topic from the notes, placed where it was discussed. Click anything to jump there.'}</p></header>
          <div class="river-host"></div>
        </section>
      </div>
      <aside class="side">
        <nav class="tabs" role="tablist">${tabs.map(([k, label]) => html`<button role="tab" type="button" data-tab="${k}" aria-selected="${k === tab}">${label}${k === 'transcript' ? html`<i class="tab-n">${fmtNum(m.words)}w</i>` : ''}${k === 'notes' && m.actions.length ? html`<i class="tab-n">${m.actions.length}✓</i>` : ''}</button>`)}</nav>
        <div class="panes">
          ${m.notes ? html`<section class="pane" data-pane="notes" ${tab !== 'notes' ? 'hidden' : ''}>${linkedNotesView(data.linkedNotes)}${notesView(app, m)}</section>` : ''}
          ${m.transcripts.length ? html`<section class="pane transcript" data-pane="transcript" ${tab !== 'transcript' ? 'hidden' : ''}></section>` : ''}
          ${m.docs.length ? html`<section class="pane" data-pane="excerpt" ${tab !== 'excerpt' ? 'hidden' : ''}>
            ${m.docs.length > 1 ? html`<label class="doc-picker">Document <select name="excerpt-file"><option value="">All documents</option>${m.docs.map((d) => html`<option value="${d.id}" ${d.id === query.get('file') ? 'selected' : ''}>${d.name}</option>`)}</select></label>` : ''}
            <div class="doc-content" aria-live="polite"></div>
          </section>` : ''}
          <section class="pane" data-pane="files" ${tab !== 'files' ? 'hidden' : ''}>${filesView(m, variant, macOf(app))}</section>
        </div>
      </aside>
    </section>
  </article>`)

  // ?t= is a moment in seconds; anything else (?t=abc, an empty t) is ignored rather than becoming NaN
  const at = query.get('t')
  const startAt = data.startVideoAt != null
    ? canSeek() ? toAxis(data.startVideoAt) : null
    : at?.trim() && Number.isFinite(Number(at)) ? Number(at) : null
  let lastNow = ''

  // ---------- transcript ----------
  // a voice keeps the colour of the person it's named after, wherever they show up
  const hueOf = (v) => app.personByName(v.name)?.hue ?? VOICE_HUES[Number(v.key) % VOICE_HUES.length]
  const tp = $('.pane.transcript', root)
    ? transcriptPane($('.pane.transcript', root), {
        m,
        base,
        mac: macOf(app),
        getSegs: () => segs,
        getVoices: () => voices,
        hueOf,
        hueOfName: (name) => app.personByName(name)?.hue ?? (name.length * 47) % 360,
        canSeek,
        topics: m.topics,
        onPick: (at) => goTo(at, { play: deck.playing }),
        onHear: (at) => goTo(at, { play: true }),
        rename: renameVoice,
        toast: app.toast,
        tMeta: () => tMeta,
        onHits: (times) => paintHits(times),
      })
    : null

  async function reloadTranscript(keepDraft = false) {
    const selected = tMeta
    if (!selected || (keepDraft && tp?.editing)) return
    const t = await get(selected.url)
    if (!root.isConnected || tMeta !== selected || (keepDraft && tp?.editing)) return
    segs = onClock(t.segments, selected)
    voices = voicesOf(t)
    tp?.relabel()
  }
  async function renameVoice(key, name) {
    await post(`/api/transcripts/${encodeURIComponent(tMeta.id)}/speakers`, { speaker: key, name })
    await reloadTranscript()
  }

  // ---------- river ----------
  const river = createRiver($('.river-host', root), {
    base,
    axis: m.axis,
    topics: m.topics,
    phases: m.phases,
    actions: m.actions,
    segments: segs,
    strip: thumbsOf(),
    stripAt: canSeek() && thumbsOf() ? (i) => toAxis(i * thumbsOf().interval) : null,
    thumb: (at) => (canSeek() ? `<div class="tip-thumb" style="${thumbStyle(toVideo(at), 176)}"></div>` : ''),
    onSeek: (at, why) => {
      goTo(at, { play: deck.playing || Boolean(why.topic) })
      if (why.topic) flashTopic(why.topic)
      if (why.action) flashAction(why.action)
    },
  })

  // ---------- deck ----------
  const deck = createDeck($('.deck-host', root), {
    meeting: m,
    variant,
    poster: thumbsOf()?.poster ?? variant?.thumbs?.poster,
    startAt: data.startVideoAt ?? (startAt != null && canSeek() ? toVideo(startAt) : null),
    canSeek,
    toAxis,
    topicAt,
    captionAt,
    linesAt,
    thumbStyle,
    bands: bands(),
    onTime: (vt) => {
      if (!canSeek()) return
      const at = toAxis(vt)
      river.setTime(at)
      tp?.setTime(at)
      paintNotesNow(at)
    },
  })

  function paintHits(times) {
    river.setHits(times)
    deck.setMarks(canSeek() ? times.map(toVideo) : [])
  }

  const refreshActions = boardOnPage(root, { app, m, river })

  // Jump to a moment on the meeting's own clock: seek the video when we can, always show the line.
  function goTo(at, { play = false } = {}) {
    if (canSeek()) deck.seek(toVideo(at), play)
    else river.setTime(at)
    tp?.reveal(at)
    paintNotesNow(at)
  }

  function paintNotesNow(at) {
    const keys = m.topics.filter((t) => t.ranges.some(([s, e]) => at >= s && at <= e)).map((t) => t.key)
    const sig = keys.join(' ')
    if (sig === lastNow) return
    lastNow = sig
    for (const c of $$('.topic-card', root)) c.classList.toggle('now', keys.includes(c.dataset.topic))
  }

  function showTab(k, focus = false) {
    tab = k
    local.set('tab', k)
    for (const b of $$('.tabs [data-tab]', root)) b.setAttribute('aria-selected', String(b.dataset.tab === k))
    for (const p of $$('.pane', root)) p.hidden = p.dataset.pane !== k
    if (k === 'excerpt') void loadExcerpt()
    if (k === 'transcript') tp?.refresh()
    if (focus) $(`.pane[data-pane="${k}"]`, root)?.focus?.()
  }

  function flashTopic(key) {
    if (!m.notes) return
    showTab('notes')
    const card = $(`.topic-card[data-topic="${CSS.escape(key)}"]`, root)
    if (!card) return
    scrollWithin($('.panes', root), card)
    card.classList.remove('flash')
    void card.offsetWidth
    card.classList.add('flash')
  }
  function flashAction(id) {
    if (!m.notes) return
    showTab('notes')
    const li = $(`[data-action="${CSS.escape(id)}"]`, root)
    if (!li) return
    scrollWithin($('.panes', root), li)
    li.classList.remove('flash')
    void li.offsetWidth
    li.classList.add('flash')
  }

  let excerptRequest
  const docPicker = $('.doc-picker select', root)
  async function loadExcerpt() {
    if (excerptRequest || !m.docs.length) return
    const request = excerptRequest = new AbortController()
    const target = m.docs.find((d) => d.id === docPicker?.value)
    const content = $('.doc-content', root)
    content.innerHTML = '<p class="muted">Loading…</p>'
    const docs = await Promise.all((target ? [target] : m.docs).map(async (meta) => {
      try {
        return docView(await get(meta.url, request.signal), meta)
      } catch (err) {
        return html`<p class="muted">Couldn’t load ${meta.name}. ${err.message}</p>`
      }
    }))
    if (!request.signal.aborted) content.innerHTML = String(html`${docs}`)
  }
  docPicker?.addEventListener('change', () => {
    excerptRequest?.abort()
    excerptRequest = undefined
    const url = new URL(location.href)
    url.searchParams.set('tab', 'excerpt')
    if (docPicker.value) url.searchParams.set('file', docPicker.value)
    else url.searchParams.delete('file')
    history.replaceState(history.state, '', url)
    void loadExcerpt()
  })

  // ---------- clock sync for wall-clock transcripts (Oct 7) ----------
  function paintSync() {
    const box = $('.sync-banner', root)
    if (!box) return
    const s = m.syncSuggestion
    const range = segs.length ? `${fmtT(segs[0].s, 'clock')}–${fmtT(segs[segs.length - 1].e, 'clock')}` : ''
    if (sync == null) {
      box.innerHTML = String(html`<span class="sb-icon">⏱</span><div><b>This transcript runs on a wall clock</b> (${range})${variant?.probe && !variant.probe.hasAudio ? ' and the video has no audio' : ''}, so they don't line up on their own.
        ${s ? html` The recording's filename says it started at <b>${fmtT(s.offset + s.hours * 3600, 'clock')}</b>, which is <b>${fmtT(s.offset, 'clock')}</b> on the transcript's clock, ${s.hours ? `${s.hours} hour${s.hours > 1 ? 's' : ''} apart (time zones)` : 'the same clock'}.` : ''}</div>
        ${s && variant ? html`<button class="btn small primary" data-sync="${s.offset}" type="button">Line them up</button>` : ''}`)
    } else {
      box.innerHTML = String(html`<span class="sb-icon ok">✓</span><div><b>Lined up:</b> video 0:00 = <b>${fmtT(sync, 'clock')}</b> on the transcript clock${m.sync?.by ? html` · set by ${m.sync.by}` : ''}. Nudge if the screen and words drift:</div>
        <span class="nudges">${[-10, -1, 1, 10].map((d) => html`<button class="btn small ghost" data-nudge="${d}" type="button">${d > 0 ? '+' : '−'}${Math.abs(d)}s</button>`)}<button class="btn small ghost" data-sync="null" type="button">Unlink</button></span>`)
    }
    box.classList.toggle('synced', sync != null)
  }
  async function setSync(offset) {
    const res = await post(`/api/meetings/${encodeURIComponent(m.id)}/sync`, { offset })
    m.sync = res.sync
    sync = res.sync?.offset ?? null
    applySync()
  }
  function applySync() {
    paintSync()
    deck.setBands(bands())
    river.update({ stripAt: canSeek() && thumbsOf() ? (i) => toAxis(i * thumbsOf().interval) : null })
    tp?.refresh()
    deck.refresh()
  }
  paintSync()

  // ---------- events ----------
  root.addEventListener('click', async (e) => {
    const t = e.target.closest('.ts')
    if (t) {
      e.preventDefault()
      return goTo(Number(t.dataset.t), { play: deck.playing })
    }
    const tabBtn = e.target.closest('.tabs [data-tab]')
    if (tabBtn) return showTab(tabBtn.dataset.tab)
    const head = e.target.closest('.topic-card > header')
    if (head && !e.target.closest('button')) {
      const topic = m.topics.find((x) => x.key === head.parentElement.dataset.topic)
      if (topic) goTo(topic.ranges[0][0], { play: true })
      return
    }
    const sw = e.target.closest('[data-variant]')
    if (sw) {
      const next = m.videos.find((v) => v.fileId === sw.dataset.variant)
      if (!next) return
      // the moment carries over between copies of one recording, and to a trimmed copy whose offset is known
      const sameClock =
        sameTimeline(next, variant) ||
        (base === 'offset' && (Boolean(next.offset || variant?.offset) || Math.abs((next.probe?.duration ?? 0) - (variant?.probe?.duration ?? 0)) < 300))
      const at = sameClock && canSeek() ? toAxis(deck.time) : null
      variant = next
      const nt = pickTranscript(m, variant)
      if (nt && nt.id !== tMeta?.id) {
        tMeta = nt
        const t = await get(nt.url)
        segs = onClock(t.segments, nt)
        voices = voicesOf(t)
        tp?.reload()
      }
      // the thumbnail strip belongs to one copy (and any other on its timeline)
      river.update({ segments: segs, strip: thumbsOf(), stripAt: canSeek() && thumbsOf() ? (i) => toAxis(i * thumbsOf().interval) : null })
      deck.setVariant(variant, at != null && canSeek() ? toVideo(at) : null)
      deck.setBands(bands())
      $('.dl', root)?.setAttribute('href', variant.download)
      if ($('.dl small', root)) $('.dl small', root).textContent = fmtBytes(variant.size)
      $('.pane[data-pane="files"]', root).innerHTML = String(filesView(m, variant, macOf(app)))
      app.toast({ icon: '🎞️', title: `Playing the ${variant.label} copy`, body: `${fmtBytes(variant.size)}${variant.probe ? ` · ${variant.probe.width}×${variant.probe.height}` : ''}`, timeout: 3000 })
      return
    }
    const sy = e.target.closest('[data-sync]')
    if (sy) return setSync(sy.dataset.sync === 'null' ? null : Number(sy.dataset.sync))
    const nu = e.target.closest('[data-nudge]')
    if (nu && sync != null) return setSync(sync + Number(nu.dataset.nudge))
    if (e.target.closest('.share')) {
      const at = canSeek() ? toAxis(deck.time) : tp?.currentTime()
      const url = `${location.origin}/m/${m.id}${at != null ? `?t=${Math.floor(at)}` : ''}`
      await navigator.clipboard?.writeText(url).catch(() => {})
      return app.toast({ icon: '🔗', title: 'Link copied', body: at != null ? `Opens at ${fmtT(at, base)}` : url, timeout: 3000 })
    }
    const dl = e.target.closest('.dl')
    if (dl) {
      dl.classList.remove('ejecting')
      void dl.offsetWidth
      dl.classList.add('ejecting')
      app.toast({ icon: '⏏️', title: 'Download started', body: `${variant.label} copy · ${fmtBytes(variant.size)}`, timeout: 3500 })
    }
  })

  root.addEventListener('change', async (e) => {
    const box = e.target.closest('.checklist input[type=checkbox]')
    if (!box) return
    const li = box.closest('[data-action]')
    li.classList.toggle('done', box.checked)
    if (box.checked) li.classList.add('stamping')
    const a = m.actions.find((x) => x.id === li.dataset.action)
    try {
      const res = await post(`/api/actions/${encodeURIComponent(li.dataset.action)}`, { status: box.checked ? 'done' : 'open', rev: a?.rev })
      paintStamp(li, res.action)
      if (a) Object.assign(a, res.action)
      river.update({ actions: m.actions })
    } catch (err) {
      // someone changed it first: show the row as it stands now instead of ticking over their change
      if (a && err.status === 409 && err.body?.action) {
        Object.assign(a, err.body.action)
        li.outerHTML = String(actionRow(app, a, m.notes.timeBase))
        river.update({ actions: m.actions })
        return app.toast({ icon: '✋', title: 'Not saved: this item just changed', body: 'The row shows it as it stands now. Tick it again if that still applies.' })
      }
      box.checked = !box.checked
      li.classList.toggle('done', box.checked)
      li.classList.remove('stamping')
      app.toast({ icon: '⚠️', title: "Couldn't save that", body: err.message })
    }
  })

  const onKey = (e) => {
    if (e.target.closest?.('input, textarea, select, [contenteditable="true"]') || e.metaKey || e.ctrlKey || e.altKey) return
    const k = e.key
    if (k === ' ' || k === 'k') {
      if (e.target.closest?.('button, a') && k === ' ') return
      e.preventDefault()
      deck.toggle()
    } else if (k === 'j') deck.nudge(-SKIP)
    else if (k === 'l') deck.nudge(SKIP)
    else if (k === 'ArrowLeft' && !e.target.closest?.('.scrub')) deck.nudge(-5)
    else if (k === 'ArrowRight' && !e.target.closest?.('.scrub')) deck.nudge(5)
    else if (k === '[') deck.speed(-1)
    else if (k === ']') deck.speed(1)
    else if (k === 'f') deck.fullscreen()
    else if (k === 'c') deck.setCaptions()
    else if (k === 'm') deck.mute()
  }
  addEventListener('keydown', onKey)

  // ---------- arrival: deep links ----------
  if (query.get('q') && tp) tp.find(query.get('q'))
  if (startAt != null) {
    tp?.reveal(startAt)
    river.setTime(startAt)
    paintNotesNow(startAt)
  }
  if (query.get('topic')) setTimeout(() => flashTopic(query.get('topic')), 250)
  if (tab === 'excerpt') void loadExcerpt()

  return {
    async onResume() {
      await reloadTranscript(true)
      if (root.isConnected) deck.refresh()
      await refreshActions()
    },
    cleanup() {
      excerptRequest?.abort()
      removeEventListener('keydown', onKey)
      deck.destroy()
      river.destroy()
      tp?.destroy()
    },
    onSlash() {
      if (!tp) return false
      showTab('transcript')
      tp.focusFind()
      return true
    },
    async onLibrary(d) {
      if (!(d.changed ?? []).includes(m.id) && !(d.removed ?? []).includes(m.id)) return
      if (deck.playing) app.toast({ icon: '📝', title: 'This meeting changed on disk', body: 'Reload when you finish watching.', href: location.pathname, actionLabel: 'Reload' })
      else app.navigate(location.pathname + location.search, { replace: true })
    },
    async onSpeakers(d) {
      if (tMeta && (d.transcripts ?? []).includes(tMeta.id)) await reloadTranscript()
    },
    async onThumbs(d) {
      if (!m.videos.some((v) => v.fileId === d.fileId)) return
      const fresh = await get(`/api/meetings/${encodeURIComponent(m.id)}`)
      for (const v of m.videos) v.thumbs = fresh.videos.find((x) => x.fileId === v.fileId)?.thumbs ?? v.thumbs
      river.update({ strip: thumbsOf(), stripAt: canSeek() && thumbsOf() ? (i) => toAxis(i * thumbsOf().interval) : null })
      if (!deck.video.getAttribute('poster') && thumbsOf()?.poster) deck.video.setAttribute('poster', thumbsOf().poster)
    },
    async onState(d) {
      if (d.kind === 'action') {
        const a = m.actions.find((x) => x.id === d.id)
        const li = $(`[data-action="${CSS.escape(d.id)}"]`, root)
        if (a) {
          Object.assign(a, { status: d.status, done: d.done, canceled: d.canceled, note: d.note, hold: d.hold ?? null, rev: d.rev ?? a.rev })
          // new wording, a new owner or a change taken back isn't spelled out in the event: fetch the item as it stands
          if (d.did?.some((w) => ['reworded', 'undone', 'redone'].includes(w))) Object.assign(a, (await get('/api/actions')).actions.find((x) => x.id === d.id))
          river.update({ actions: m.actions })
        }
        if (a && li) {
          // redraw the whole row: a canceled item swaps its checkbox for a ✕ and shows why
          const focused = li.contains(document.activeElement)
          li.outerHTML = String(actionRow(app, a, m.notes.timeBase))
          if (focused) $(`[data-action="${CSS.escape(d.id)}"] input`, root)?.focus()
        }
      }
      // a task added or deleted, here or anywhere, or a change whose save had failed now on disk (recovered): this
      // page's action rows and flags, not the whole page again
      if (d.kind === 'task-added' || d.kind === 'task-deleted' || d.kind === 'recovered') await refreshActions()
      if (d.kind === 'sync' && d.meetingId === m.id) {
        const fresh = await get(`/api/meetings/${encodeURIComponent(m.id)}`)
        m.sync = fresh.sync
        sync = fresh.sync?.offset ?? null
        applySync()
      }
    },
    onPresence(list) {
      const here = [...new Set(list.filter((p) => p.id !== app.clientId && p.name !== app.me.name && p.page === location.pathname).map((p) => p.name))]
      const chip = $('.here-too', root)
      chip.hidden = !here.length
      if (here.length) chip.innerHTML = String(html`${here.map((n) => (app.personByName(n) ? raw(avatar(app.personByName(n), { size: 22 })) : ''))}<span>${here.join(' & ')} ${here.length > 1 ? 'are' : 'is'} here too 👀</span>`)
    },
  }
}

function linkedNotesView(notes = []) {
  if (!notes.length) return ''
  return html`<section class="sec from-notebook"><h3>From the notebook</h3>${notes.map(
    (n) => html`<a class="nb-mini" href="/notebook/${encodeURIComponent(n.id)}"><b>${n.title}</b><span>${n.updatedBy} · ${n.updatedAt.slice(0, 10)}${n.tags.length ? ` · ${n.tags.map((t) => `#${t}`).join(' ')}` : ''}</span></a>`,
  )}</section>`
}

function scrollWithin(container, node) {
  const top = node.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop - container.clientHeight * 0.25
  container.scrollTo({ top, behavior: 'smooth' })
}

function paintStamp(li, a) {
  li.querySelector('.stamp')?.remove()
  li.classList.remove('stamping')
  li.insertAdjacentHTML('beforeend', stamp(a))
}

// ---------- notes ----------

function actionRow(app, a, base) {
  const people = a.people.map((id) => app.people.get(id)).filter(Boolean)
  return html`<li data-action="${a.id}" class="${a.lane} ${a.status === 'open' ? '' : a.status}">
    ${raw(tick(a))}
    <div class="ai"><span class="owner">${people.map((p) => raw(avatar(p, { size: 22, title: false })))}<b>${a.owner || 'Unassigned'}</b><i class="lane-tag">${a.lane === 'us' ? 'on us' : 'on them'}${a.source === 'added' ? ` · added by ${a.createdBy}` : ''}</i></span>
    <p>${linkTimes(a.text, base)}</p>${a.ranges.map((r) => html`<button type="button" class="ts chip-t" data-t="${r[0]}" data-end="${r[1]}">${rangeText(r, base)}</button>`)}
    ${a.original ? html`<p class="was">${a.source === 'added' ? 'The task said' : 'The notes say'}: <q>${[a.original.owner, a.original.text].filter(Boolean).join(': ')}</q></p>` : ''}
    ${a.canceled?.reason ? html`<p class="reason">✕ ${a.canceled.reason}</p>` : ''}
    ${a.hold ? html`<p class="hold">${a.hold.ready ? '▶ Ready to start' : '⏸ On hold'}${a.hold.on && !a.hold.ready ? `: ${a.hold.on}` : ''}${a.hold.after.length ? ` · after ${a.hold.after.map((r) => [r.owner, r.text].filter(Boolean).join(': ')).join('; ')}` : ''}</p>` : ''}
    <p class="note" ${a.note ? '' : 'hidden'}>✎ <span>${a.note?.text ?? ''}</span> <small>${a.note ? `${a.note.by}` : ''}</small></p></div>
    ${raw(stamp(a))}
  </li>`
}

// The notes' action items, each on its row as the board has it now, then the tasks added on the board for this
// meeting. Drawn on its own again when the board changes.
function actionsView(app, m, s) {
  const base = m.notes.timeBase
  // each action line names its item (b.action); lineActions says which board id that is now, so an item reworded
  // in the notes or on the board keeps its line, and two lines worded alike are two items
  const actionFor = (b) => {
    const id = b.action && (m.lineActions?.[b.action] ?? b.action)
    return m.actions.find((a) => a.source === 'notes' && (id ? a.id === id : b.text.endsWith(a.original?.text ?? a.text)))
  }
  const added = m.actions.filter((a) => a.source === 'added')
  return html`<section class="sec actions"><h3>${s.title}</h3><ul class="checklist">${s.blocks.map((b) => {
    if (b.kind !== 'bullet') return html`<li class="plain">${linkTimes(b.text ?? b.title, base)}</li>`
    const a = actionFor(b)
    return a ? actionRow(app, a, base) : html`<li class="plain">${linkTimes(b.text, base)}</li>`
  })}</ul>${added.length ? html`<h4 class="added-h">Added on the board</h4><ul class="checklist">${added.map((a) => actionRow(app, a, base))}</ul>` : ''}</section>`
}

// What a meeting's page shows of the board: the notes' action rows, their flags on the river and how many there are.
// After a change on the board it fetches the meeting's items and draws only these again, so the transcript search,
// the player and where the page is scrolled stay as they are; when nothing here changed, nothing is drawn. A burst
// of changes (an agent working through a list) costs one fetch.
export function boardOnPage(root, { app, m, river }) {
  return coalesce(async () => {
    const fresh = await get(`/api/meetings/${encodeURIComponent(m.id)}`)
    if (!root.isConnected || JSON.stringify([fresh.actions, fresh.lineActions]) === JSON.stringify([m.actions, m.lineActions])) return
    m.actions = fresh.actions
    m.lineActions = fresh.lineActions
    river.update({ actions: m.actions })
    const focused = $('.sec.actions li:focus-within', root)?.dataset.action
    const sections = m.notes?.sections.filter((s) => s.role === 'actions') ?? []
    $$('.sec.actions', root).forEach((node, i) => (node.outerHTML = String(actionsView(app, m, sections[i]))))
    if (focused) $(`.sec.actions [data-action="${CSS.escape(focused)}"] input`, root)?.focus()
    const count = $('.n-actions', root)
    if (count) count.textContent = m.actions.length
    const tab = $('.tabs [data-tab="notes"]', root)
    tab?.querySelector('.tab-n')?.remove()
    if (tab && m.actions.length) tab.insertAdjacentHTML('beforeend', String(html`<i class="tab-n">${m.actions.length}✓</i>`))
  })
}

function notesView(app, m) {
  const n = m.notes
  const base = n.timeBase
  const topicByN = new Map(m.topics.filter((t) => t.n != null).map((t) => [t.n, t]))
  const ranges = (rs) => rs.map((r) => html`<button type="button" class="ts chip-t" data-t="${r[0]}" data-end="${r[1]}">${rangeText(r, base)}</button>`)

  const section = (s, si) => {
    if (s.role === 'source') return ''
    if (s.role === 'summary')
      return html`<section class="sec summary"><span class="tldr">TL;DR</span><h3>${s.title}</h3>${s.blocks.map((b) => html`<p class="lead">${linkTimes(b.text ?? b.title, base)}</p>`)}</section>`
    if (s.role === 'actions') return actionsView(app, m, s)
    if (s.role === 'next') return html`<section class="sec next"><h3>${s.title}</h3><ul class="arrows">${s.blocks.map((b) => html`<li>${linkTimes(b.text ?? b.title, base)}</li>`)}</ul></section>`
    if (s.role === 'caveats') return html`<section class="sec caveats"><h3><span>${s.title}</span></h3><ul>${s.blocks.map((b) => html`<li>${linkTimes(b.text ?? b.title, base)}</li>`)}</ul></section>`
    return html`<section class="sec disc" data-sec="${si}"><h3>${s.title}</h3>${s.blocks.map((b) => {
      if (b.kind === 'item') {
        const t = topicByN.get(b.n)
        return html`<article class="topic-card" data-topic="${t?.key ?? ''}" style="--c:${topicColor(t?.color ?? b.n)}">
          <header><span class="num">${b.n}</span><h4>${b.title}</h4></header>
          <div class="chips">${ranges(b.ranges)}</div>
          <ul>${b.bullets.map((l) => html`<li>${linkTimes(l.text, base)}${l.ranges.length ? html` ${ranges(l.ranges)}` : ''}</li>`)}</ul>
        </article>`
      }
      if (b.kind === 'bullet') return html`<p class="bullet">${linkTimes(b.text, base)}${b.ranges.length ? html` ${ranges(b.ranges)}` : ''}</p>`
      return html`<p>${linkTimes(b.text, base)}</p>`
    })}</section>`
  }

  const source = n.sections.filter((s) => s.role === 'source')
  return html`<div class="notes">
    <div class="meta-chips">${n.meta.map((x) => html`<span class="mchip">${linkTimes(x, base)}</span>`)}</div>
    ${n.sections.map(section)}
    <details class="fineprint"><summary>How these notes were made</summary>
      ${n.intro.map((l) => html`<p>${linkTimes(l.text, base)}</p>`)}
      ${source.map((s) => html`<h4>${s.title}</h4>${s.blocks.map((b) => html`<p>${linkTimes(b.text ?? b.title, base)}</p>`)}`)}
      ${m.timing ? html`<p><b>Timing:</b> ${m.timing}</p>` : ''}
      ${m.notesFile ? html`<p><a href="${m.notesFile.url}" download>Download the notes file</a></p>` : ''}
    </details>
  </div>`
}

// ---------- transcript ----------

function transcriptPane(pane, o) {
  const { m, base, mac } = o
  let query = ''
  let matches = []
  let cur = -1
  let follow = true
  let nowIdx = -1
  // the voice being named (its key), so live updates don't close the box mid-typing
  let editing = null
  let heard = 0
  const opened = new Set()
  const focus = base === 'clock' ? m.axis : null

  pane.innerHTML = String(html`
    <div class="t-tools">
      <label class="find"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg><input type="search" placeholder="Find in transcript  (/)" aria-label="Find in transcript"/><span class="find-n"></span></label>
      <button class="icon-btn f-prev" type="button" title="Previous match">${raw(icon.up)}</button>
      <button class="icon-btn f-next" type="button" title="Next match">${raw(icon.down)}</button>
      <button class="icon-btn follow on" type="button" title="Follow along with playback">${raw(icon.target)}</button>
      ${m.transcripts.length > 1 ? html`<span class="t-which"></span>` : ''}
    </div>
    <div class="t-voices" hidden></div>
    <div class="t-note"></div>
    <div class="t-rows" tabindex="-1"></div>
    <button class="back-to-now" type="button" hidden>↓ Back to now</button>`)
  const rows = $('.t-rows', pane)
  const input = $('.find input', pane)

  const hl = (text) => {
    if (!query) return esc(text)
    const words = query.toLowerCase().split(/\s+/).filter(Boolean).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    if (!words.length) return esc(text)
    const re = new RegExp(`(${words.join('|')})`, 'gi')
    return text
      .split(re)
      .map((part, i) => (i % 2 ? `<mark>${esc(part)}</mark>` : esc(part)))
      .join('')
  }

  const voiceTitle = (v) =>
    v.confirmed
      ? `Named by ${v.by || 'someone'}. Click to rename.`
      : v.seen
        ? `Read off ${v.seen.as}'s highlighted Meet tile while this voice talked (${v.seen.votes} of ${v.seen.of} moments). Click to correct.`
        : v.match != null
          ? `Sounds like ${v.name} from another meeting (${Math.round(v.match * 100)}% alike). Click to confirm or correct.`
          : 'Nobody has named this voice yet. Click to name it.'
  const aboutVoices = (vs) => {
    // a caption export's own labels ("Speaker 3"), named from the video
    if (vs?.source === 'labels')
      return vs.state === 'done'
        ? 'the meeting platform’s speaker labels, named from the Meet tile highlighted while each one talks; words can be misheard. Click a name to fix it.'
        : `the meeting platform’s speaker labels; reading their names off the video on ${mac}…`
    return (
      {
        queued: `machine transcript. Telling the voices apart on ${mac} (a few minutes)…`,
        running: `machine transcript. Telling the voices apart on ${mac} (a few minutes)…`,
        failed: `machine transcript; telling the voices apart didn’t work (${vs?.error ?? 'unknown error'}).`,
        done: 'speakers told apart by voice and named from the highlighted Meet tile; words can be misheard. Click a name to fix it; a ? is a guess from another meeting.',
      }[vs?.state] ?? 'machine transcript, not attributed to speakers; words can be misheard.'
    )
  }

  // The voices in this recording, each with its share of the talking; click one to name it.
  function paintVoices() {
    const vs = o.getVoices()
    const box = $('.t-voices', pane)
    let list = vs?.state === 'done' ? vs.voices : []
    // a wall-clock transcript shared by two meetings: only this meeting's part of it counts
    if (focus) {
      const talk = new Map()
      for (const s of o.getSegs()) if (s.spk != null && !s.q && s.e >= focus[0] && s.s <= focus[1]) talk.set(String(s.spk), (talk.get(String(s.spk)) ?? 0) + s.e - s.s)
      list = list.map((v) => ({ ...v, seconds: talk.get(v.key) ?? 0 }))
    }
    list = list.filter((v) => v.seconds >= 1)
    if (editing != null && list.some((v) => v.key === editing)) return
    editing = null
    box.hidden = !list.length
    const total = list.reduce((n, v) => n + v.seconds, 0) || 1
    box.innerHTML = String(
      html`${list.map(
        (v) =>
          html`<button class="voice${v.match != null ? ' guess' : ''}" type="button" data-spk="${v.key}" style="--h:${o.hueOf(v)}" title="${voiceTitle(v)}"><i class="dot"></i><b>${v.name}</b>${v.match != null ? html`<i class="q">?</i>` : ''}<small>${Math.max(1, Math.round((v.seconds / total) * 100))}%</small></button>`,
      )}`,
    )
  }

  function openEditor(key) {
    const vs = o.getVoices()
    const v = vs?.voices?.find((x) => x.key === key)
    if (!v) return
    editing = key
    heard = 0
    const box = $('.t-voices', pane)
    box.hidden = false
    box.innerHTML = String(html`<form class="voice-edit" style="--h:${o.hueOf(v)}">
      <label><i class="dot"></i><span>${v.confirmed || v.seen ? `Rename ${v.name}` : v.match != null ? `Is this ${v.name}?` : `Who is ${v.name}?`}</span>
        <input name="name" value="${v.confirmed || v.seen || v.match != null ? v.name : ''}" maxlength="60" autocomplete="off" spellcheck="false" placeholder="Their name" list="voice-names" /></label>
      <datalist id="voice-names">${(vs.names ?? []).map((n) => html`<option value="${n}"></option>`)}</datalist>
      <span class="ve-btns">
        <button class="btn small primary" type="submit">${v.match != null ? 'Yes, save' : 'Save'}</button>
        ${o.canSeek() ? html`<button class="btn small ghost" type="button" data-act="hear" title="Play one of their lines">${raw(icon.play)} Hear them</button>` : ''}
        ${v.confirmed ? html`<button class="btn small ghost" type="button" data-act="forget" title="Go back to the automatic name">Forget name</button>` : ''}
        <button class="btn small ghost" type="button" data-act="cancel">Cancel</button>
      </span>
    </form>`)
    const input = $('input', box)
    input.focus()
    input.select()
  }

  async function saveName(name) {
    const key = editing
    $$('.voice-edit button', pane).forEach((b) => (b.disabled = true))
    try {
      await o.rename(key, name)
      editing = null
      paintVoices()
    } catch (err) {
      $$('.voice-edit button', pane).forEach((b) => (b.disabled = false))
      o.toast({ icon: '⚠️', title: 'Couldn’t save that name', body: err.message, timeout: 5000 })
    }
  }

  // Play a few of the voice's longest lines in turn, to tell who it is.
  function hear(key) {
    const lines = o
      .getSegs()
      .filter((s) => String(s.spk) === key && !s.q)
      .sort((a, b) => b.e - b.s - (a.e - a.s))
      .slice(0, 5)
    if (!lines.length) return
    o.onHear(lines[heard++ % lines.length].s)
  }

  function render() {
    const segs = o.getSegs()
    const tm = o.tMeta()
    const vs = o.getVoices()
    const voices = new Map((vs?.state === 'done' ? vs.voices : []).map((v) => [v.key, v]))
    paintVoices()
    $('.t-note', pane).innerHTML = String(
      html`${tm ? html`<b>${tm.label}</b> · ${aboutVoices(vs)}` : ''}${base === 'clock' ? html` Showing this meeting's window (${fmtT(m.axis[0], 'clock')}–${fmtT(m.axis[1], 'clock')}) of a longer recording.` : ''}${o.canSeek() ? ' Click a line to jump there.' : ''}`,
    )
    if (m.transcripts.length > 1 && $('.t-which', pane)) $('.t-which', pane).textContent = ''
    const markers = new Map()
    for (const t of m.topics)
      for (const [s] of t.ranges) {
        const i = segs.findIndex((x) => x.s >= s - 1)
        if (i >= 0) markers.set(i, [...(markers.get(i) ?? []), t].filter((x, k, arr) => arr.indexOf(x) === k))
      }
    let out = ''
    let i = 0
    // a speaker's name shows where their turn starts; the coloured edge carries it down the lines that follow
    let prev = null
    const n = segs.length
    while (i < n) {
      const s = segs[i]
      const outside = focus && (s.e < focus[0] || s.s > focus[1])
      if (outside) {
        let j = i
        while (j < n && (segs[j].e < focus[0] || segs[j].s > focus[1])) j++
        const key = `${i}`
        if (!opened.has(key)) {
          out += `<button class="t-fold" type="button" data-open="${key}">▸ ${j - i} lines ${segs[i].s < focus[0] ? 'before' : 'after'} this meeting (${fmtT(segs[i].s, base)}–${fmtT(segs[j - 1].e, base)}) · other conversation</button>`
          i = j
          prev = null
          continue
        }
      }
      if (s.q) {
        let j = i
        while (j < n && segs[j].q) j++
        out += `<div class="t-quiet">· · · ${fmtT(segs[i].s, base)}–${fmtT(segs[j - 1].e, base)} probably silence (the model hears “${esc(segs[i].t)}”) · · ·</div>`
        i = j
        prev = null
        continue
      }
      for (const t of markers.get(i) ?? []) out += `<div class="t-topic" style="--c:${topicColor(t.color)}"><span>${t.n ?? '✦'}</span>${esc(t.title)}</div>`
      const v = s.spk != null ? voices.get(String(s.spk)) : null
      const who = v ? `v${v.key}` : s.sp ? `n${s.sp}` : null
      const hue = v ? o.hueOf(v) : s.sp ? o.hueOfName(s.sp) : null
      let name = ''
      if (who && who !== prev)
        name = v
          ? `<button class="sp${v.match != null ? ' guess' : ''}" type="button" data-spk="${esc(v.key)}" title="${esc(voiceTitle(v))}">${esc(v.name)}${v.match != null ? '<i>?</i>' : ''}</button> `
          : `<b class="sp">${esc(s.sp)}</b> `
      prev = who
      out += `<div class="seg${o.canSeek() ? ' seekable' : ''}${who ? ' voiced' : ''}" data-i="${i}" data-t="${s.s}"${hue != null ? ` style="--h:${hue}"` : ''}><button class="seg-t" type="button" tabindex="-1">${fmtT(s.s, base)}</button><p>${name}${hl(s.t)}</p><button class="seg-link" type="button" title="Copy a link to this line">${icon.link}</button></div>`
      i++
    }
    rows.innerHTML = out || '<p class="muted">No transcript lines.</p>'
    nowIdx = -1
  }

  function find(q) {
    query = q.trim()
    input.value = query
    const segs = o.getSegs()
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    matches = words.length ? segs.map((s, i) => (!s.q && words.every((w) => s.t.toLowerCase().includes(w)) ? i : -1)).filter((i) => i >= 0) : []
    cur = -1
    render()
    $('.find-n', pane).textContent = query ? `${matches.length ? `${matches.length}` : 'no'} match${matches.length === 1 ? '' : 'es'}` : ''
    o.onHits(matches.map((i) => segs[i].s))
    if (matches.length) step(1)
  }

  function step(d) {
    if (!matches.length) return
    cur = (cur + d + matches.length) % matches.length
    const node = rows.querySelector(`.seg[data-i="${matches[cur]}"]`)
    $$('.seg.cur', rows).forEach((x) => x.classList.remove('cur'))
    if (node) {
      node.classList.add('cur')
      follow = false
      paintFollow()
      scrollWithin(rows, node)
    }
    $('.find-n', pane).textContent = `${cur + 1} / ${matches.length}`
  }

  function paintFollow() {
    $('.follow', pane).classList.toggle('on', follow)
    $('.back-to-now', pane).hidden = follow || nowIdx < 0
  }

  function setTime(at) {
    const segs = o.getSegs()
    const i = segmentAt(segs, at)
    if (i === nowIdx) return
    rows.querySelector('.seg.now')?.classList.remove('now')
    nowIdx = i
    const node = rows.querySelector(`.seg[data-i="${i}"]`)
    if (!node) return
    node.classList.add('now')
    if (follow && !pane.hidden) {
      const r = node.getBoundingClientRect()
      const c = rows.getBoundingClientRect()
      if (r.top < c.top + 40 || r.bottom > c.bottom - 60) scrollWithin(rows, node)
    }
    paintFollow()
  }

  function reveal(at) {
    const segs = o.getSegs()
    let i = segmentAt(segs, at)
    if (i < 0) i = 0
    if (focus && segs[i] && (segs[i].e < focus[0] || segs[i].s > focus[1])) {
      // open the fold that hides this line
      for (const b of rows.querySelectorAll('.t-fold')) {
        const k = Number(b.dataset.open)
        if (k <= i) opened.add(String(k))
      }
      render()
    }
    const node = rows.querySelector(`.seg[data-i="${i}"]`) ?? rows.querySelector(`.seg[data-i="${i + 1}"]`)
    if (!node) return
    rows.querySelector('.seg.now')?.classList.remove('now')
    node.classList.add('now')
    nowIdx = i
    if (!pane.hidden) scrollWithin(rows, node)
  }

  rows.addEventListener('click', async (e) => {
    const fold = e.target.closest('.t-fold')
    if (fold) {
      opened.add(fold.dataset.open)
      return render()
    }
    const chip = e.target.closest('.sp[data-spk]')
    if (chip) return openEditor(chip.dataset.spk)
    const row = e.target.closest('.seg')
    if (!row) return
    const t = Number(row.dataset.t)
    if (e.target.closest('.seg-link')) {
      const params = new URLSearchParams({ t: String(t), tab: 'transcript' })
      const meta = o.tMeta()
      if (meta) params.set('transcript', meta.id)
      await navigator.clipboard?.writeText(`${location.origin}/m/${encodeURIComponent(m.id)}?${params}`).catch(() => {})
      row.classList.add('copied')
      setTimeout(() => row.classList.remove('copied'), 1200)
      return
    }
    if (window.getSelection()?.toString()) return
    follow = true
    paintFollow()
    o.onPick(t)
  })
  const stopFollow = () => {
    follow = false
    paintFollow()
  }
  rows.addEventListener('wheel', stopFollow, { passive: true })
  rows.addEventListener('touchmove', stopFollow, { passive: true })
  $('.follow', pane).onclick = () => {
    follow = !follow
    paintFollow()
    if (follow && nowIdx >= 0) scrollWithin(rows, rows.querySelector(`.seg[data-i="${nowIdx}"]`) ?? rows)
  }
  $('.back-to-now', pane).onclick = () => {
    follow = true
    paintFollow()
    const node = rows.querySelector('.seg.now')
    if (node) scrollWithin(rows, node)
  }
  const runFind = debounce(() => find(input.value), 140)
  input.addEventListener('input', runFind)
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      step(e.shiftKey ? -1 : 1)
    }
    if (e.key === 'Escape') {
      input.value = ''
      find('')
      input.blur()
    }
  })
  $('.f-prev', pane).onclick = () => step(-1)
  $('.f-next', pane).onclick = () => step(1)

  const voiceBox = $('.t-voices', pane)
  voiceBox.addEventListener('click', (e) => {
    const chip = e.target.closest('.voice[data-spk]')
    if (chip) return openEditor(chip.dataset.spk)
    const act = e.target.closest('[data-act]')?.dataset.act
    if (act === 'hear') hear(editing)
    else if (act === 'forget') void saveName(null)
    else if (act === 'cancel') {
      editing = null
      paintVoices()
    }
  })
  voiceBox.addEventListener('submit', (e) => {
    e.preventDefault()
    void saveName($('input', voiceBox).value.trim() || null)
  })
  voiceBox.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || editing == null) return
    e.stopPropagation()
    editing = null
    paintVoices()
  })
  render()

  return {
    setTime,
    get editing() { return editing != null },
    reveal,
    find,
    focusFind: () => {
      input.focus()
      input.select()
    },
    refresh: render,
    reload: () => find(query),
    // same lines, new speaker names: keep the place, the playing line and the current match
    relabel() {
      const top = rows.scrollTop
      const keep = nowIdx
      render()
      rows.scrollTop = top
      if (keep >= 0) {
        rows.querySelector(`.seg[data-i="${keep}"]`)?.classList.add('now')
        nowIdx = keep
      }
      if (cur >= 0 && matches.length) rows.querySelector(`.seg[data-i="${matches[cur]}"]`)?.classList.add('cur')
    },
    currentTime: () => (nowIdx >= 0 ? o.getSegs()[nowIdx]?.s : null),
    destroy() {},
  }
}

// ---------- files ----------

function filesView(m, current, mac) {
  const videos = m.videos
  return html`<div class="files">
    <h3>Video</h3>
    ${videos.length ? '' : html`<p class="muted">No video file for this meeting.</p>`}
    ${videos.map((v) => {
      const p = v.probe
      const warn = [
        p && !p.hasAudio && 'no audio track',
        p?.rotation && `rotation flag ${p.rotation}° (may play sideways)`,
        v.faststart === false && 'index at the end (slower to start streaming)',
        v.growing && 'still being written',
      ].filter(Boolean)
      return html`<article class="vcard ${v.fileId === current?.fileId ? 'current' : ''}">
        <div class="vcard-gauge">${raw(gauge(p?.bitrate))}</div>
        <div class="vcard-body">
          <h4>${v.label}${v.isDefault ? html` <i class="chip on">browsing copy</i>` : ''}${v.fileId === current?.fileId ? html` <i class="chip hot">playing</i>` : ''}</h4>
          <p class="vname" title="${v.name}">${v.name}</p>
          <p class="vspecs">${fmtBytes(v.size)}${p ? html` · ${fmtT(p.duration)} · ${p.width}×${p.height} @ ${Math.round(p.fps ?? 0)}fps · ${(p.vcodec ?? '?').toUpperCase()}${p.hasAudio ? ` + ${(p.acodec ?? '?').toUpperCase()}` : ''}` : ' · probing…'}</p>
          ${warn.length ? html`<p class="vwarn">⚠ ${warn.join(' · ')}</p>` : ''}
          <div class="vbtns">
            ${v.fileId !== current?.fileId && v.playable ? html`<button class="btn small" type="button" data-variant="${v.fileId}">${raw(icon.play)} Play this copy</button>` : ''}
            <a class="btn small ${v.isDefault ? 'primary' : 'ghost'}" href="${v.download}" download>${raw(icon.download)} Download · ${fmtBytes(v.size)}</a>
          </div>
        </div>
      </article>`
    })}
    <h3>Transcripts</h3>
    ${m.transcripts.length ? '' : html`<p class="muted">No transcript yet.</p>`}
    ${m.transcripts.map(
      (t) => html`<div class="frow"><b>${t.label}</b><span>${fmtNum(t.words)} words${t.synced ? ' · synced to video' : ''}</span>
        <span class="frow-links">${t.files.map((f) => html`<a href="${f.url}" download>.${f.name.split('.').pop()} <small>${fmtBytes(f.size)}</small></a>`)}<a href="/captions/${t.id}.vtt" download="${m.date} ${m.title.replace(/[/\\:*?"<>|]+/g, '-')}.vtt">.vtt captions</a></span></div>`,
    )}
    <h3>Notes &amp; documents</h3>
    ${m.notesFile ? html`<div class="frow"><b>Reviewed notes</b><span>${m.notesFile.name}</span><span class="frow-links"><a href="${m.notesFile.url}" download>.txt</a></span></div>` : html`<p class="muted">No reviewed notes yet. When a notes file lands in the folder it shows up here on its own.</p>`}
    ${m.docs.map((d) => html`<div class="frow"><b>Excerpt</b><span>${d.name}</span><span class="frow-links"><a href="${d.download}" download>.txt</a></span></div>`)}
    <p class="muted small">Downloads come straight from the folder on ${mac}, through the tunnel. Big originals can take a while; the browsing copy is usually all you need.</p>
  </div>`
}

// ---------- excerpt documents ----------

function docView(doc, meta) {
  const lines = doc.text.replace(/\r\n?/g, '\n').split('\n')
  const out = []
  let list = []
  const flush = () => {
    if (list.length) out.push(`<ul>${list.join('')}</ul>`)
    list = []
  }
  lines.forEach((line, i) => {
    const t = line.trim()
    if (!t) return flush()
    const next = (lines[i + 1] ?? '').trim()
    if (/^[-•*]\s+/.test(t)) return list.push(`<li>${linkTimes(t.replace(/^[-•*]\s+/, ''), 'clock')}</li>`)
    flush()
    if (i === 0) return out.push(`<h3>${esc(t)}</h3>`)
    if (t.length < 70 && !/[.:;,]$/.test(t) && !next.startsWith('-') && /^[A-Z0-9]/.test(t)) return out.push(`<h4>${esc(t)}</h4>`)
    out.push(`<p>${linkTimes(t, 'clock')}</p>`)
  })
  flush()
  return html`<article class="doc">${raw(out.join(''))}<p class="muted small"><a href="${meta.download}" download>Download ${meta.name}</a></p></article>`
}
