// Tape lab: how heavy every recording is to stream, what the browsing copy is, and the exact ffmpeg line
// that matches the lightest encode in the folder.
import { get, post } from '../api.js'
import { gauge, icon } from '../art.js'
import { fmtBytes, fmtDate, fmtT, html, plural, raw } from '../util.js'

// Quote filenames as literal POSIX shell arguments, including apostrophes and metacharacters.
const sh = (s) => `'${s.replaceAll("'", "'\\''")}'`
const stem = (name) => name.replace(/\.[^.]+$/, '').replace(/\s+(compressed( CRF\s?\d+)?|original)$/i, '')

// One line on the copy of the meetings folder kept in each BACKUP_DIR folder.
const mirrorLine = (m) => {
  if (!m.enabled) return html`No second copy of the meetings folder. Set <code>BACKUP_DIR</code> to keep one.`
  const when = m.running ? 'copying now' : m.lastRun ? `last run ${new Date(m.lastRun).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : 'not run yet'
  return html`Copy of the meetings folder in ${plural(m.folders, 'backup folder')}, ${when}: ${plural(m.files, 'file')}, ${m.copied} copied, ${m.waiting} still being written${m.failed ? html`, <span class="warn">${m.failed} not copied (the server log names them)</span>` : ', none failed'}.`
}

// What to paste into an agent's chat so that it connects itself: the README's block, with this archive's own
// addresses filled in.
const connectBlock = (url) => `Connect yourself to On the Record, a private meeting archive, as a remote MCP server.

  Name:       meetings
  Address:    ${url}/mcp
  Transport:  Streamable HTTP
  Sign-in:    OAuth 2.1 with discovery, dynamic client registration and PKCE.
              There is no client id, secret or token to set up.

1. Add the server to your MCP settings with OAuth sign-in turned on.
2. Start the sign-in. If no browser opens, give me the link, and tell me where
   to paste the address the browser ends up on.
3. I sign in on ${globalThis.location?.host || 'the archive’s site'} and press Approve.
4. Reload your MCP servers if you need to, call list_meetings, and tell me how
   many meetings came back.

If you can't sign in with OAuth, or the server refuses to register you, stop and tell me.`

export async function mount(root, { app }) {
  // the library as it is now, for its cautions (a file that can't be read, say)
  const [lab, connector, lib] = await Promise.all([get('/api/lab'), get('/api/connector').catch(() => ({ enabled: false })), Promise.resolve(app.refreshLibrary?.() ?? app.lib).catch(() => app.lib)])
  const cautions = lib?.cautions ?? []
  const videos = lab.meetings.flatMap((m) => m.videos.map((v) => ({ ...v, meeting: m })))
  const total = videos.reduce((n, v) => n + v.size, 0)
  const browse = videos.filter((v) => v.isDefault)
  const browseBytes = browse.reduce((n, v) => n + v.size, 0)
  const twins = videos.filter((v) => !v.isDefault && v.meeting.videos.some((o) => o.isDefault && o !== v && Math.abs((o.probe?.duration ?? 0) - (v.probe?.duration ?? 0)) < 3))
  const twinBytes = twins.reduce((n, v) => n + v.size, 0)
  // the lightest encode per minute is the house style worth copying
  const best = [...videos].filter((v) => v.probe?.bitrate && v.probe.hasAudio).sort((a, b) => a.probe.bitrate - b.probe.bitrate)[0]
  const target = best?.probe ? best.probe : { width: 1920, height: 1242, fps: 24, bitrate: 720_000 }
  const fps = Math.round(target.fps ?? 24)
  const crf = 28
  const recipe = (v) =>
    `ffmpeg -i ${sh(v.name)} -vf "scale='min(${target.width ?? 1920},iw)':-2,fps=${fps}" -c:v libx264 -preset slow -crf ${crf} -c:a aac -b:a 96k -movflags +faststart ${sh(`${stem(v.name)} - compressed.mp4`)}`
  const remux = (v) => `ffmpeg -i ${sh(v.name)} -c copy -movflags +faststart ${sh(`${stem(v.name)} - faststart.mp4`)}`
  const estimate = (v) => ((v.probe?.duration ?? 0) * (best?.probe?.bitrate ?? 720_000)) / 8

  root.innerHTML = String(html`<section class="lab page">
    <header class="page-head">
      <p class="eyebrow">Tape lab</p>
      <h1>How heavy is each tape?</h1>
      <p>Streaming goes from this Mac through the Cloudflare tunnel, so lighter files start faster and seek smoother. The browsing copy is the one the player picks; the rest are kept for downloads.</p>
      <div class="counters">
        <span><b>${fmtBytes(total)}</b> of video in the folder</span>
        <span><b>${fmtBytes(browseBytes)}</b> in browsing copies</span>
        <span><b>${fmtBytes(twinBytes)}</b> in originals that have a lighter twin</span>
      </div>
      ${lab.mirror ? html`<p class="muted small mirror-line">${mirrorLine(lab.mirror)}</p>` : ''}
    </header>
    ${best
      ? html`<section class="recipe">
      <h2>The house blend</h2>
      <p>The lightest file here is <b>${best.meeting.title}</b> (${best.label}): ${best.probe.width}×${best.probe.height} at ${Math.round(best.probe.fps)} fps, <b>${(best.probe.bitrate / 1e6).toFixed(2)} Mb/s</b>, and it still looks fine. To make any recording match it, run this in the meetings folder (it writes a new file next to the original):</p>
      <pre class="cmd"><code>${recipe({ name: 'INPUT.mp4' })}</code><button class="copy" type="button" data-copy="${recipe({ name: 'INPUT.mp4' })}">${raw(icon.copy)} Copy</button></pre>
      <p class="muted small">Files whose index sits at the end of the file start streaming slowly. Remuxing fixes that in seconds without re-encoding: <code>${remux({ name: 'INPUT.mp4' })}</code></p>
    </section>`
      : ''}
    ${lab.semantic
      ? html`<section class="recipe sem-box"><h2>Meaning search</h2>${lab.semantic.enabled
          ? html`<p>Local model <code>${lab.semantic.model}</code> has embedded <b>${lab.semantic.embedded}</b> of <b>${lab.semantic.total}</b> passages (notes, transcripts, notebook). Nothing leaves this Mac.${lab.semantic.error ? html` <span class="warn">Paused: ${lab.semantic.error}</span>` : ''}${lab.semantic.refused ? html` <span class="warn">Left out until edited: ${plural(lab.semantic.refused, 'passage')} the model refused (the server log says where).</span>` : ''}</p>`
          : html`<p class="muted">Off. Set <code>EMBED_URL</code>, <code>EMBED_KEY</code> and <code>EMBED_MODEL</code> and run the local embedding server (<code>ops/install.sh embed</code>) to search by meaning as well as keywords.</p>`}</section>`
      : ''}
    ${connector.enabled
      ? html`<section class="recipe assistants"><h2>Connected assistants</h2>${connector.connections.length
          ? html`<p>Assistants that connect from their provider's servers, such as Claude on the web, the phone or the desktop app. Each one was approved by the person it works for.</p><ul class="assistant-list">${connector.connections.map(
              (c) => html`<li><span><b>${c.assistant}</b> for ${c.person} · ${c.scope === 'write' ? 'read and write' : 'read only'}</span><small>connected ${fmtDate(c.createdAt.slice(0, 10))}${c.lastUsedAt ? ` · last used ${fmtDate(c.lastUsedAt.slice(0, 10))}` : ''}</small><button class="btn small" type="button" data-end="${c.id}">End</button></li>`,
            )}</ul>`
          : html`<p class="muted">None yet. In Claude, add <code>${connector.url}/mcp</code> (read and write) or <code>${connector.url}/mcp/readonly</code> (read only) as a custom connector and press Connect.</p>`}
        <p>To connect another agent, paste this into its chat. It sets itself up, and a page opens here for you to approve it.</p>
        <pre class="cmd connect"><code>${connectBlock(connector.url)}</code><button class="copy" type="button" data-copy="${connectBlock(connector.url)}">${raw(icon.copy)} Copy</button></pre>
        <p class="muted small">For an agent that should only read, change the address to <code>${connector.url}/mcp/readonly</code> before pasting.</p></section>`
      : ''}
    ${!lab.ffmpeg ? html`<p class="warnbox">ffprobe isn't installed on the server, so durations and thumbnails are missing. <code>brew install ffmpeg</code> fixes it.</p>` : ''}
    <div class="lab-list">
      ${lab.meetings.map(
        (m) => html`<section class="lab-meeting" style="--hue:${m.hue}">
          <header><i class="dot"></i><a href="/m/${m.id}?tab=files">${m.title}</a><span>${fmtDate(m.date)}</span></header>
          ${m.videos.length ? '' : html`<p class="muted">No video.</p>`}
          ${m.videos.map((v) => {
            const p = v.probe
            const heavy = p?.bitrate > 2_000_000
            return html`<div class="lab-row ${v.isDefault ? 'default' : ''}">
              <div class="lab-gauge">${raw(gauge(p?.bitrate))}</div>
              <div class="lab-info">
                <b>${v.label}</b>${v.isDefault ? html` <i class="chip on">browsing copy</i>` : ''}${v.growing ? html` <i class="chip warn">writing…</i>` : ''}
                <p class="vname">${v.name}</p>
                <p class="vspecs">${fmtBytes(v.size)}${p ? html` · ${fmtT(p.duration)} · ${p.width}×${p.height} @ ${Math.round(p.fps ?? 0)}fps · ${(p.vcodec ?? '?').toUpperCase()}${p.hasAudio ? '' : ' · no audio'}` : v.failed ? html` · <span class="warn">ffprobe can't read it, so the player leaves it out</span>` : ' · probing…'}${v.faststart === false ? html` · <span class="warn">index at end</span>` : ''}${p?.rotation ? html` · <span class="warn">rotation ${p.rotation}°</span>` : ''}</p>
              </div>
              <div class="lab-act">
                ${heavy && best && v !== best ? html`<button class="btn small ghost copy" type="button" data-copy="${recipe(v)}">${raw(icon.copy)} House blend → ~${fmtBytes(estimate(v))}</button>` : ''}
                ${v.faststart === false ? html`<button class="btn small ghost copy" type="button" data-copy="${remux(v)}">${raw(icon.copy)} Fix streaming start</button>` : ''}
              </div>
            </div>`
          })}
        </section>`,
      )}
    </div>
    ${cautions.length ? html`<section class="loose cautions"><h2>Cautions</h2><ul>${cautions.map((c) => html`<li>${c}</li>`)}</ul></section>` : ''}
    ${lab.loose.length ? html`<section class="loose"><h2>Loose files</h2><p class="muted">In the folder but not part of any meeting.</p><ul>${lab.loose.map((f) => html`<li><code>${f.name}</code> <span class="muted">${fmtBytes(f.size)}</span></li>`)}</ul></section>` : ''}
  </section>`)

  root.addEventListener('click', async (e) => {
    const end = e.target.closest('[data-end]')
    if (end) {
      end.disabled = true
      try {
        await post(`/api/connector/connections/${encodeURIComponent(end.dataset.end)}/end`, {})
        end.closest('li').remove()
        // the last one gone: the page says again how to connect one
        if (!root.querySelector('.assistant-list li')) app.navigate('/lab', { replace: true })
        app.toast({ icon: '🔌', title: 'Connection ended', body: 'That assistant has to be approved again to reconnect.', timeout: 4000 })
      } catch (err) {
        end.disabled = false
        app.toast({ icon: '⚠️', title: 'Couldn’t end it', body: err.message })
      }
      return
    }
    const b = e.target.closest('[data-copy]')
    if (!b) return
    await navigator.clipboard?.writeText(b.dataset.copy).catch(() => {})
    app.toast({ icon: '📋', title: 'Command copied', body: 'Run it in Terminal from the meetings folder.', timeout: 3000 })
  })
  return {
    async onLibrary() {
      app.navigate('/lab', { replace: true })
    },
  }
}
