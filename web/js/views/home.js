// The shelf: a hero whose waveform is the shape of the latest conversation, then every meeting as a cassette.
import { get, post } from '../api.js'
import { avatar, cassette, icon, pin } from '../art.js'
import { openPalette } from '../palette.js'
import { $, $$, coalesce, esc, fmtDate, fmtDur, fmtHours, fmtNum, fmtT, greeting, html, kindLabel, local, raw, reducedMotion, relDay, topicColor } from '../util.js'

// the archive's owners as a page names them ("Ada & Grace"); with nobody configured the page says "we" or "us"
const crewOf = (app, nobody = 'us') => (app.lib.crew?.length ? app.lib.crew.join(' & ') : nobody)

const letters = (s) => raw([...s].map((ch, i) => `<span style="--i:${i}">${ch === ' ' ? '&nbsp;' : esc(ch)}</span>`).join(''))

export const progressOf = (m) => {
  const pos = local.get(`pos:${m.id}`, null)
  return pos && m.duration ? Math.min(1, pos.t / m.duration) : 0
}

// A meeting in one strip: talk density on top, topic colours along the bottom.
export function barcode(m, { width = 300, height = 30 } = {}) {
  const [a, b] = m.axis ?? [0, m.duration || 1]
  const span = Math.max(1, b - a)
  const X = (t) => ((t - a) / span) * width
  const pulse = m.pulse ?? []
  const n = pulse.length || 1
  const top = height - 10
  let d = `M0 ${top}`
  pulse.forEach((v, i) => (d += ` L${((i + 0.5) / n) * width} ${top - v * (top - 2)}`))
  d += ` L${width} ${top} Z`
  const bars = (m.topics ?? []).flatMap((t) =>
    t.ranges.map(([s, e]) => `<rect x="${X(s).toFixed(1)}" y="${height - 7}" width="${Math.max(2, X(e) - X(s)).toFixed(1)}" height="6" rx="2" fill="${topicColor(t.color)}"><title>${esc(t.title)}</title></rect>`),
  )
  return raw(
    `<svg class="barcode" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true"><path d="${d}" class="bc-pulse"/><rect x="0" y="${height - 7}" width="${width}" height="6" rx="2" class="bc-track"/>${bars.join('')}</svg>`,
  )
}

export const faces = (app, ids, max = 5) =>
  raw(
    ids
      .slice(0, max)
      .map((id) => app.people.get(id))
      .filter(Boolean)
      .map((p) => `<span class="face" title="${esc(p.name)}">${avatar(p, { size: 30, title: false })}</span>`)
      .join('') + (ids.length > max ? `<span class="face more">+${ids.length - max}</span>` : ''),
  )

export function card(app, m, i) {
  return html`<a class="card" href="/m/${m.id}" data-id="${m.id}" style="--hue:${m.hue};--i:${i}">
    <div class="card-tape" aria-hidden="true">${raw(cassette(m, { progress: progressOf(m) }))}</div>
    <div class="card-body">
      <div class="card-meta"><span>${fmtDate(m.date)}${m.time != null ? html` · ${clockOfDay(m.time)}` : ''}</span><span class="rel">${relDay(m.date)}</span></div>
      <h3>${m.title}</h3>
      <p>${m.blurb}</p>
      ${barcode(m)}
      <div class="card-foot">
        <span class="faces">${faces(app, m.participants)}</span>
        <span class="has">
          ${kindLabel(m.kind)}
          ${m.processing ? html`<i class="chip warn" title="A video here is still being written">writing…</i>` : ''}
          <i class="chip">${fmtDur(m.duration)}</i>
          ${m.has.notes ? html`<i class="chip on" title="Notes">notes</i>` : html`<i class="chip" title="No notes yet">no notes</i>`}
          ${m.actions.open ? html`<i class="chip hot" title="Open action items on ${crewOf(app)}">${m.actions.open} on us</i>` : ''}
        </span>
      </div>
    </div>
  </a>`
}

const clockOfDay = (sec) => {
  const h = Math.floor(sec / 3600)
  return `${((h + 11) % 12) + 1}:${String(Math.floor(sec / 60) % 60).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`
}

function shelf(app) {
  const byMonth = new Map()
  for (const m of app.lib.meetings) {
    const key = m.date.slice(0, 7)
    byMonth.set(key, [...(byMonth.get(key) ?? []), m])
  }
  let i = 0
  return html`${[...byMonth.entries()].map(
    ([month, ms]) => html`<div class="month">
      <h3 class="month-label"><span>${new Date(`${month}-15T12:00:00`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</span><i></i><b>${ms.length} tape${ms.length === 1 ? '' : 's'}</b></h3>
      <div class="cards">${ms.map((m) => card(app, m, i++))}</div>
    </div>`,
  )}`
}

function spotlight(app) {
  const m = app.lib.meetings[0]
  if (!m) return ''
  const pos = local.get(`pos:${m.id}`, null)
  return html`<section class="spotlight" style="--hue:${m.hue}">
    <a class="spot-screen" href="/m/${m.id}" aria-label="Play ${m.title}">
      ${m.poster ? html`<img src="${m.poster}" alt="" loading="lazy" />` : html`<div class="spot-static"></div>`}
      <span class="spot-rec"><i></i>REC · ${fmtDate(m.date, { month: 'short', day: '2-digit' }).toUpperCase()}</span>
      <span class="spot-tc">${fmtT(m.duration)}</span>
      <span class="spot-play">${raw(icon.play)}</span>
      <span class="scanlines"></span>
    </a>
    <div class="spot-body">
      <p class="eyebrow">Latest on tape · ${relDay(m.date)}${kindLabel(m.kind)}</p>
      <h2>${m.title}</h2>
      <p class="spot-blurb">${m.blurb}</p>
      ${barcode(m, { width: 400, height: 38 })}
      <div class="spot-topics">${m.topics.slice(0, 6).map((t) => html`<span class="tchip" style="--c:${topicColor(t.color)}">${t.title}</span>`)}</div>
      <div class="spot-foot">
        <span class="faces">${faces(app, m.participants, 7)}</span>
        <a class="btn primary" href="/m/${m.id}${pos?.t > 30 ? `?t=${Math.floor(pos.t)}` : ''}">${raw(icon.play)} ${pos?.t > 30 ? `Resume at ${fmtT(pos.t)}` : 'Play'}</a>
      </div>
    </div>
  </section>`
}

function threads(app) {
  const order = [...app.lib.meetings].reverse()
  const max = Math.max(1, ...app.lib.threads.flatMap((t) => t.meetings.map((x) => x.count)))
  return html`${app.lib.threads.map((t) => {
    const counts = order.map((m) => t.meetings.find((x) => x.id === m.id)?.count ?? 0)
    const bars = counts.map((c, i) => `<rect x="${i * 6}" y="${16 - Math.max(c ? 2 : 0.6, (c / max) * 16)}" width="4" height="${Math.max(c ? 2 : 0.6, (c / max) * 16)}" rx="1"/>`).join('')
    return html`<button class="thread" type="button" data-term="${t.term}" data-ids="${t.meetings.map((x) => x.id).join(' ')}">
      <span class="thread-term">${t.term}</span>
      <svg viewBox="0 0 ${order.length * 6} 16" class="spark" aria-hidden="true">${raw(bars)}</svg>
      <span class="thread-n">${t.total}</span>
    </button>`
  })}`
}

// The hero's oscilloscope: three glowing traces whose envelope is the latest meeting's talk density.
function startWave(canvas, pulse) {
  const ctx = canvas.getContext('2d')
  let w = 0
  let h = 0
  let raf = 0
  let t = 0
  let mx = 0.5
  let my = 0.5
  let visible = true
  const env = pulse?.length ? pulse : new Array(48).fill(0.5)
  const resize = () => {
    const dpr = Math.min(2, devicePixelRatio || 1)
    w = canvas.clientWidth
    h = canvas.clientHeight
    canvas.width = w * dpr
    canvas.height = h * dpr
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }
  const sample = (x) => {
    // envelope scrolls slowly so the waveform "plays" the meeting
    const f = ((x / w + t * 0.012) % 1) * (env.length - 1)
    const i = Math.floor(f)
    const v = env[i] + (env[Math.min(env.length - 1, i + 1)] - env[i]) * (f - i)
    return 0.18 + v * 0.82
  }
  const traces = [
    { c: '54,226,196', d: '11,150,128', a: 1, f: 0.011, s: 1.5, lw: 2.2 },
    { c: '255,107,61', d: '228,86,43', a: 0.7, f: 0.017, s: -2.1, lw: 1.6 },
    { c: '155,135,255', d: '102,80,224', a: 0.55, f: 0.007, s: 0.9, lw: 1.3 },
  ]
  const frame = () => {
    raf = requestAnimationFrame(frame)
    if (!visible) return
    t += 0.016
    ctx.clearRect(0, 0, w, h)
    // glowing light on dark; ink on paper in light mode
    const light = document.documentElement.dataset.theme === 'light'
    ctx.globalCompositeOperation = light ? 'source-over' : 'lighter'
    const mid = h * 0.55
    const amp = h * (0.16 + (1 - my) * 0.16)
    for (const tr of traces) {
      ctx.beginPath()
      for (let x = 0; x <= w; x += 3) {
        const taper = Math.sin((Math.PI * x) / w) ** 1.4
        const y = mid + Math.sin(x * tr.f * (0.6 + mx) + t * tr.s) * amp * tr.a * taper * sample(x) + Math.sin(x * 0.045 + t * 3.1) * 3 * taper
        x ? ctx.lineTo(x, y) : ctx.moveTo(x, y)
      }
      const rgb = light ? tr.d : tr.c
      ctx.strokeStyle = `rgba(${rgb},${0.85 * tr.a})`
      ctx.lineWidth = tr.lw
      ctx.shadowColor = `rgba(${rgb},${light ? 0.35 : 0.9})`
      ctx.shadowBlur = light ? 6 : 14
      ctx.stroke()
    }
  }
  const onMove = (e) => {
    mx = e.clientX / innerWidth
    my = e.clientY / innerHeight
  }
  const io = new IntersectionObserver(([e]) => (visible = e.isIntersecting))
  io.observe(canvas)
  resize()
  addEventListener('resize', resize)
  addEventListener('pointermove', onMove, { passive: true })
  if (reducedMotion()) {
    t = 3
    frame()
    cancelAnimationFrame(raf)
  } else frame()
  return () => {
    cancelAnimationFrame(raf)
    io.disconnect()
    removeEventListener('resize', resize)
    removeEventListener('pointermove', onMove)
  }
}

function countUp(root) {
  for (const node of $$('[data-count]', root)) {
    const target = Number(node.dataset.count)
    const dec = Number(node.dataset.dec ?? 0)
    if (reducedMotion()) {
      node.textContent = dec ? target.toFixed(dec) : fmtNum(target)
      continue
    }
    const start = performance.now()
    const dur = 1400 + Math.random() * 400
    const step = (now) => {
      const p = Math.min(1, (now - start) / dur)
      const v = target * (1 - (1 - p) ** 4)
      node.textContent = dec ? v.toFixed(dec) : fmtNum(v)
      if (p < 1) requestAnimationFrame(step)
    }
    requestAnimationFrame(step)
  }
}

function tilt(root) {
  const onMove = (e) => {
    const c = e.target.closest?.('.card')
    if (!c) return
    const r = c.getBoundingClientRect()
    c.style.setProperty('--rx', `${(((e.clientY - r.top) / r.height - 0.5) * -7).toFixed(2)}deg`)
    c.style.setProperty('--ry', `${(((e.clientX - r.left) / r.width - 0.5) * 9).toFixed(2)}deg`)
  }
  const onLeave = (e) => {
    const c = e.target.closest?.('.card')
    if (c && !c.contains(e.relatedTarget)) {
      c.style.removeProperty('--rx')
      c.style.removeProperty('--ry')
    }
  }
  root.addEventListener('pointermove', onMove)
  root.addEventListener('pointerout', onLeave)
}

async function plate(app, root) {
  const box = $('.plate-list', root)
  const { actions } = await get('/api/actions').catch(() => ({ actions: [] }))
  const onUs = actions.filter((a) => a.lane === 'us' && a.status === 'open')
  // an item waiting on something else isn't ours to pick up yet: it is counted here and listed on the board
  const open = onUs.filter((a) => !a.hold || a.hold.ready)
  const held = onUs.length - open.length
  const hueOf = (a) => a.meeting?.hue ?? 48
  if (!onUs.length) {
    box.innerHTML = '<li class="muted">Nothing open on us. Enjoy it.</li>'
    return
  }
  const parked = html`<a href="/actions?show=hold">${held} ${open.length ? 'more ' : ''}on hold</a>, waiting on something else first.`
  // the plate shows six; the rest are counted, so a short list never passes for the whole of it
  const more = open.length - 6
  box.innerHTML = String(
    html`${open.slice(0, 6).map(
      (a, i) => html`<li class="plate-item" data-action="${a.id}" data-rev="${a.rev}" style="--hue:${hueOf(a)};--tilt:${i % 2 ? 0.6 : -0.5}deg">
        ${raw(pin(hueOf(a)))}
        <label class="tick"><input type="checkbox" aria-label="Mark done" /><span class="box">${raw(icon.check)}</span></label>
        <div><b>${a.owner || 'Unassigned'}</b> ${a.text}${a.note ? html`<span class="from">✎ ${a.note.text}</span>` : ''}${a.meeting ? html`<a class="from" href="/m/${a.meeting.id}${a.ranges[0] ? `?t=${Math.floor(a.ranges[0][0])}` : ''}">${a.meeting.title} · ${fmtDate(a.meeting.date)}</a>` : html`<a class="from" href="/actions">added by ${a.createdBy}</a>`}</div>
      </li>`,
    )}${more > 0 ? html`<li class="muted"><a href="/actions">+${more} more</a> open on the board.</li>` : ''}${held ? html`<li class="muted">${open.length ? '' : 'Nothing to pick up right now. '}${parked}</li>` : ''}`,
  )
}

export async function mount(root, { app }) {
  const s = app.lib.stats
  const latest = app.lib.meetings[0]
  // the shelf as last drawn, so a catch-up that finds nothing new leaves its tapes where they are
  let shelved = String(shelf(app))
  root.innerHTML = String(html`
    <section class="hero">
      <canvas class="hero-wave" aria-hidden="true"></canvas>
      <div class="hero-inner">
        <p class="hello"><i class="rec"></i>${greeting(app.me.name)}<span class="caret">▌</span></p>
        <h1 class="title" aria-label="On the Record">${letters('On the')} <em>${letters('Record')}</em></h1>
        <p class="sub">Every meeting ${crewOf(app, 'we')} ${app.lib.crew?.length === 1 ? 'has' : 'have'} sat through: the tape, the transcript and the notes, in one place you can search in a heartbeat.</p>
        <button class="hero-search" type="button">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>
          <span class="ph">Try <b class="rot">“${[...app.lib.threads].find((t) => t.term.length > 3)?.term ?? 'pricing'}”</b></span><kbd>/</kbd>
        </button>
        <div class="stats">
          <div class="stat"><b data-count="${s.meetings}">0</b><span>meetings on tape</span></div>
          <div class="stat"><b data-count="${fmtHours(s.seconds)}" data-dec="1">0</b><span>hours recorded</span></div>
          <div class="stat"><b data-count="${s.words}">0</b><span>words transcribed</span></div>
          <a class="stat hot" href="/actions"><b data-count="${s.open}">0</b><span>open on us</span></a>
        </div>
      </div>
    </section>
    ${spotlight(app)}
    <section class="block">
      <header class="block-head"><h2>The shelf</h2><p>${s.meetings} tapes, newest first. Hover one to hear it spin.</p></header>
      <div class="shelf">${raw(shelved)}</div>
    </section>
    <section class="block two">
      <div>
        <header class="block-head"><h2>Threads</h2><p>Names and acronyms that keep coming back. Hover to see where; click to search.</p></header>
        <div class="threads">${threads(app)}</div>
      </div>
      <div>
        <header class="block-head"><h2>On our plate</h2><p>Open action items for ${crewOf(app)}. <a href="/actions">The whole board →</a></p></header>
        <ul class="plate-list"><li class="muted">Loading…</li></ul>
      </div>
    </section>
    <section class="block">
      <header class="block-head"><h2>The cast</h2><p>Everyone who turned up in the notes. <a href="/people">Meet them →</a></p></header>
      <div class="cast-row">${app.lib.people.map((p) => html`<a class="cast-chip" href="/search?q=${encodeURIComponent(`person:${p.short}`)}">${raw(avatar(p, { size: 46 }))}<span>${p.short}</span></a>`)}</div>
    </section>
    <footer class="foot">
      <span>Private archive · reading <code>${app.lib.folder}</code> live · ${app.lib.access ? 'Cloudflare Access verified' : 'local only'}</span>
      <span>Press <kbd>?</kbd> for keys</span>
    </footer>
  `)

  const stopWave = startWave($('.hero-wave', root), latest?.pulse)
  countUp(root)
  tilt(root)
  void plate(app, root)
  const plateSoon = coalesce(() => plate(app, root))
  $('.plate-list', root).addEventListener('change', async (e) => {
    const li = e.target.closest('.plate-item')
    if (!li) return
    const done = e.target.checked
    li.classList.toggle('stamped', done)
    try {
      // the revision is the version of the item this tick was made on, so it can't land on top of a change that hasn't shown here yet
      const res = await post(`/api/actions/${encodeURIComponent(li.dataset.action)}`, { status: done ? 'done' : 'open', rev: Number(li.dataset.rev) })
      li.dataset.rev = res.action.rev
    } catch (err) {
      li.classList.toggle('stamped', !done)
      e.target.checked = !done
      if (err.status !== 409) return app.toast({ icon: '⚠️', title: "Couldn't save that", body: err.message })
      app.toast({ icon: '✋', title: 'Not saved: this item just changed', body: 'The list shows it as it stands now. Tick it again if that still applies.' })
      void plate(app, root)
    }
  })

  // rotate the hero's example query
  const named = [...app.lib.threads].sort((a, b) => Number(b.term.length > 3) - Number(a.term.length > 3))
  const guest = app.lib.people.find((p) => !p.crew)?.short.toLowerCase()
  const examples = [...named.slice(0, 6).map((t) => `“${t.term}”`), ...(guest ? [`“person:${guest}”`, `“in:actions ${guest}”`] : ['“in:actions”'])]
  let k = 0
  const rot = setInterval(() => {
    const b = $('.rot', root)
    if (!b) return
    b.classList.remove('flip')
    void b.offsetWidth
    b.classList.add('flip')
    b.textContent = examples[++k % examples.length]
  }, 2800)
  $('.hero-search', root).addEventListener('click', () => openPalette(app))

  // threads light up the tapes they run through
  const lightUp = (ids) => {
    for (const c of $$('.card', root)) {
      c.classList.toggle('lit', Boolean(ids && ids.includes(c.dataset.id)))
      c.classList.toggle('dim', Boolean(ids && !ids.includes(c.dataset.id)))
    }
  }
  root.addEventListener('pointerover', (e) => {
    const t = e.target.closest('.thread')
    if (t) lightUp(t.dataset.ids.split(' '))
  })
  root.addEventListener('pointerout', (e) => {
    const t = e.target.closest('.thread')
    if (t && !t.contains(e.relatedTarget)) lightUp(null)
  })
  root.addEventListener('click', (e) => {
    const t = e.target.closest('.thread')
    if (t) app.navigate(`/search?q=${encodeURIComponent(t.dataset.term.includes(' ') ? `"${t.dataset.term}"` : t.dataset.term)}`)
    // the clicked cassette flies into the player (view transition)
    const c = e.target.closest('.card')
    if (c) $('.cassette', c).style.viewTransitionName = 'tape'
  })

  return {
    cleanup() {
      stopWave()
      clearInterval(rot)
    },
    onLibrary(d) {
      $('.shelf', root).innerHTML = shelved = String(shelf(app))
      for (const id of d.added ?? []) $(`.card[data-id="${CSS.escape(id)}"]`, root)?.classList.add('fresh')
    },
    // back after a gap (the live stream reconnected, or Back from another site): the plate as it stands now, and
    // the shelf if anything on it changed
    onResume() {
      const next = String(shelf(app))
      if (next !== shelved) $('.shelf', root).innerHTML = shelved = next
      return plateSoon()
    },
    onThumbs() {
      const spot = $('.spotlight', root)
      if (spot && !spot.querySelector('img') && app.lib.meetings[0]?.poster) spot.outerHTML = String(spotlight(app))
    },
    onState(d) {
      // recovered: a change whose save had failed is on disk now
      if (d.kind === 'action' || d.kind === 'task-added' || d.kind === 'task-deleted' || d.kind === 'recovered') void plateSoon()
    },
  }
}
