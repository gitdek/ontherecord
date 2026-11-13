// Connect an assistant: where a hosted assistant (Claude on the web, the phone or the desktop app) sends someone who
// pressed its Connect button. Access has already said who they are; here they see what is asking, for which door,
// and approve or decline. The answer goes back to the assistant's own address (server/connector.ts).
import { get, post } from '../api.js'
import { html } from '../util.js'

// What the server can send in ?error= when it has nowhere else to send the person. Only these sentences show: a
// link can put any words in the address, and this is the page where people decide what to approve.
const PROBLEMS = new Map([
  ['invalid_client', 'This assistant isn’t registered here. Start again from its Connect button.'],
  ['invalid_request', 'The assistant asked to send you somewhere it didn’t register.'],
])

export async function load({ query }) {
  const id = query.get('req')
  if (!id) return { problem: PROBLEMS.get(query.get('error')) ?? 'There is nothing to approve here. Start from the assistant’s Connect button.' }
  return get(`/api/connector/requests/${encodeURIComponent(id)}`).then(
    (request) => ({ request }),
    (err) => ({ problem: err.message }),
  )
}

export async function mount(root, { app, data }) {
  const r = data.request
  root.innerHTML = String(html`<section class="connect page">
    <header class="page-head">
      <p class="eyebrow">Connect an assistant</p>
      ${r
        ? html`<h1>${r.client} wants to use On the Record</h1>
          <p>It would work as <b>${r.person}'s agent</b>, ${r.scope === 'write' ? 'reading the archive and changing the board and the notebook' : 'reading the archive only'}. What it changes shows up under that name, and the connection can be ended on the Lab page at any time.</p>
          <p class="muted">Approve only if you just pressed Connect in ${r.client} yourself. The answer goes back to <b>${r.redirectHost}</b>.</p>
          <div class="connect-actions">
            <button class="btn primary" type="button" data-approve>Approve</button>
            <button class="btn" type="button" data-decline>Decline</button>
          </div>`
        : html`<h1>Nothing to approve</h1><p>${data.problem}</p>`}
    </header>
  </section>`)
  root.addEventListener('click', async (e) => {
    const approve = e.target.closest('[data-approve]')
    if (!approve && !e.target.closest('[data-decline]')) return
    const buttons = root.querySelectorAll('.connect-actions button')
    for (const b of buttons) b.disabled = true
    try {
      const { redirect } = await post(`/api/connector/requests/${encodeURIComponent(r.id)}`, { approve: Boolean(approve) })
      location.assign(redirect)
    } catch (err) {
      for (const b of buttons) b.disabled = false
      app.toast({ icon: '⚠️', title: 'That didn’t go through', body: err.message })
    }
  })
  return {}
}
