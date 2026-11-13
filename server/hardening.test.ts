import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { link, mkdir, mkdtemp, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { configFrom } from './config.ts'
import { buildLibrary, openScanned, pinFolder, readScanned, scanFiles, StaleFile } from './library.ts'
import { People } from './people.ts'
import { Store } from './state.ts'

const scratch = () => mkdtemp(join(tmpdir(), 'meetings-hardening-'))

test('a scanned file swapped for a symlink or a pipe is refused, not followed', async () => {
  const dir = await scratch()
  try {
    await writeFile(join(dir, 'secret.txt'), 'not for the web')
    const folder = join(dir, 'meetings')
    await mkdir(folder)
    await writeFile(join(folder, 'decoy - notes.txt'), 'hello')
    const [f] = await scanFiles(folder)
    assert.equal(await readScanned(f), 'hello')
    // the scan knows a file by its device and inode: a second name keeps the original's inode taken, so no file
    // made below can be handed the same number (Linux reuses a freed one at once)
    await link(f.path, join(dir, 'original'))

    await symlink(join(dir, 'secret.txt'), join(folder, '.swap'))
    await rename(join(folder, '.swap'), f.path)
    await assert.rejects(readScanned(f), StaleFile)
    await assert.rejects(openScanned(f), StaleFile)

    await rm(f.path)
    execFileSync('mkfifo', [f.path])
    await assert.rejects(openScanned(f), StaleFile, 'a pipe must not block or be read')

    await rm(f.path)
    await writeFile(f.path, 'hello')
    await assert.rejects(openScanned(f), StaleFile, 'a different file under the same name waits for the next scan')
  } finally {
    await rm(dir, { recursive: true })
  }
})

test('malformed index, manifest and transcript files are skipped or reported, never fatal', async () => {
  const dir = await scratch()
  try {
    await writeFile(
      join(dir, 'meetings-index.json'),
      JSON.stringify({ sessions: [null, 5, { title: 'dateless, no files' }, { id: '../../api/tasks', title: 'odd id', video_transcripts: 7 }, { id: 42, videos: 'x' }], cautions: [1, 'real caution'] }),
    )
    await writeFile(join(dir, 'clip - manifest.json'), JSON.stringify({ files: { path: 3 } }))
    await writeFile(join(dir, 'x - transcript.txt'), '[00:00:10 - 00:00:15] welcome everyone to the call\n[00:00:01 - 00:00:02] pricing remark\n')
    await writeFile(join(dir, 'y - transcript.json'), JSON.stringify({ segments: [{ text: 'no start' }, { start: 3, end: 4, text: 'fine' }] }))
    const lib = await buildLibrary(await scanFiles(dir), () => ({}), [], new Map())
    assert.ok(lib.cautions.includes('real caution'))
    assert.ok(lib.cautions.every((c) => typeof c === 'string'))
    assert.ok(!lib.meetings.some((m) => m.id.includes('/')), 'ids that could change a URL path are replaced')
    for (const t of lib.transcripts.values()) {
      const starts = t.parsed.segments.map((s) => s.s)
      assert.ok(starts.every((s, i) => Number.isFinite(s) && (i === 0 || s >= starts[i - 1])), 'segments are timed and in order')
    }
  } finally {
    await rm(dir, { recursive: true })
  }
})

test('the board store: no-op writes change nothing, the first check-off stands, a damaged file is kept', async () => {
  const dir = await scratch()
  try {
    const path = join(dir, 'state.json')
    const store = new Store(path)
    assert.equal(await store.setAction('a1', { status: 'done' }, 'Ada'), true)
    const first = store.state.actions.a1.done
    assert.equal(await store.setAction('a1', { status: 'done' }, "Grace's agent"), false)
    assert.deepEqual(store.state.actions.a1.done, first)
    assert.equal(await store.setAction('a1', { note: 'sent' }, 'Grace'), true)
    assert.equal(await store.setAction('a1', { note: 'sent' }, 'Ada'), false)
    assert.equal(store.state.actions.a1.note?.by, 'Grace')

    await writeFile(path, '{"actions": {"a1": tru')
    const again = new Store(path)
    await again.load()
    assert.deepEqual(again.state.actions, {})
    assert.ok((await readdir(dir)).some((f) => f.startsWith('state.json.corrupt-')))
  } finally {
    await rm(dir, { recursive: true })
  }
})

test('the board store: a cancel replaces a check-off, keeps who made it, and its reason can be reworded or cleared', async () => {
  const dir = await scratch()
  try {
    const path = join(dir, 'state.json')
    const store = new Store(path)
    await store.setAction('a1', { status: 'done', note: 'sent' }, 'Ada')
    assert.equal(await store.setAction('a1', { status: 'canceled', reason: '  the pilot was dropped ' }, "Ada's agent"), true)
    assert.equal(store.state.actions.a1.done, undefined)
    assert.equal(store.state.actions.a1.canceled?.reason, 'the pilot was dropped')
    assert.equal(store.state.actions.a1.note?.text, 'sent', 'the note outlives a change of status')
    const first = { ...store.state.actions.a1.canceled! }
    assert.equal(await store.setAction('a1', { status: 'canceled' }, 'Grace'), false)
    assert.equal(await store.setAction('a1', { reason: 'superseded' }, 'Grace'), true)
    assert.deepEqual(store.state.actions.a1.canceled, { by: "Ada's agent", at: first.at, reason: 'superseded' })

    // what was saved comes back, next to marks written before there was a canceled status
    const again = new Store(path)
    await again.load()
    assert.deepEqual(again.state.actions.a1.canceled, store.state.actions.a1.canceled)

    assert.equal(await store.setAction('a1', { reason: '' }, 'Grace'), true)
    assert.deepEqual(store.state.actions.a1.canceled, { by: "Ada's agent", at: first.at })
    // a reason means nothing on an item nobody canceled
    assert.equal(await store.setAction('a2', { reason: 'never mind' }, 'Grace'), false)
    assert.equal(store.state.actions.a2, undefined)
    // marking it done lifts the cancel; reopening leaves no mark, only the trail of what happened
    assert.equal(await store.setAction('a1', { status: 'done', note: null }, 'Grace'), true)
    // read afresh: the assertions above narrow store.state.actions.a1 for the type checker
    const a1 = () => store.state.actions.a1
    assert.deepEqual([a1().canceled, a1().note, a1().done?.by], [undefined, undefined, 'Grace'])
    assert.equal(await store.setAction('a1', { status: 'open' }, 'Grace'), true)
    assert.deepEqual([store.state.actions.a1.done, store.state.actions.a1.canceled, store.state.actions.a1.note], [undefined, undefined, undefined])
    assert.deepEqual(store.state.actions.a1.history?.map((e) => e.did), ['done', 'note', 'canceled', 'reason', 'reason', 'done', 'note-cleared', 'reopened'])
    assert.equal(store.state.actions.a1.rev, 6)
  } finally {
    await rm(dir, { recursive: true })
  }
})

test('config: service tokens are read-only unless marked :write; local hosts and origins come from the port', () => {
  const c = configFrom({
    PORT: '8800',
    PUBLIC_URL: 'https://meetings.example.test/',
    ACCESS_AUD: 'site-aud, mcp-aud',
    ACCESS_SERVICE_TOKENS: "a1.access=Grace's Hermes:write, b2.access=Ada's Codex, c3.access",
  })
  assert.deepEqual(c.accessAuds, ['site-aud', 'mcp-aud'])
  assert.deepEqual(c.agents.get('a1.access'), { name: "Grace's Hermes", scope: 'write' })
  assert.deepEqual(c.agents.get('b2.access'), { name: "Ada's Codex", scope: 'read' })
  assert.deepEqual(c.agents.get('c3.access'), { name: 'agent', scope: 'read' })
  assert.deepEqual(c.localHosts, ['127.0.0.1:8800', 'localhost:8800', '[::1]:8800'])
  assert.deepEqual(c.origins, ['https://meetings.example.test', 'http://127.0.0.1:8800', 'http://localhost:8800', 'http://[::1]:8800'])
  // the MCP endpoint also answers hosted assistants: Claude's unless MCP_ORIGINS says otherwise
  assert.deepEqual(c.mcpOrigins, ['https://claude.ai', 'https://claude.com'])
  assert.deepEqual(configFrom({ MCP_ORIGINS: 'https://chat.example/, ' }).mcpOrigins, ['https://chat.example'])
  assert.deepEqual(configFrom({ MCP_ORIGINS: '' }).mcpOrigins, [])
  assert.equal(configFrom({}).users.size, 0)
})

test('a meetings folder swapped for a symlink after startup is not followed', async () => {
  const dir = await realpath(await scratch())
  try {
    const folder = join(dir, 'meetings')
    await mkdir(folder)
    await writeFile(join(folder, 'agenda - notes.txt'), 'hello')
    await mkdir(join(dir, 'elsewhere'))
    await writeFile(join(dir, 'elsewhere', 'id_ed25519'), 'not for the web')
    const pinned = await pinFolder(folder)
    assert.equal((await scanFiles(pinned)).length, 1)
    await rename(folder, join(dir, 'meetings-old'))
    await symlink(join(dir, 'elsewhere'), folder)
    await assert.rejects(scanFiles(pinned), StaleFile)
    // after a restart, the link itself is refused unless the owner allows it
    await assert.rejects(pinFolder(folder), StaleFile)
    assert.equal((await pinFolder(folder, true)).path, join(dir, 'elsewhere'))
  } finally {
    await rm(dir, { recursive: true })
  }
})

test('a transcript with absurd timestamps is trimmed instead of exhausting memory', async () => {
  const dir = await scratch()
  try {
    await writeFile(join(dir, 'x - transcript.json'), JSON.stringify({ segments: [{ start: 0, end: 5, text: 'welcome everyone to the planning call' }, { start: 1e12, end: 1e12 + 5, text: 'pricing and contract terms' }, { start: 1e7, end: 1e7 + 5, text: 'renewal timeline for the clinic' }] }))
    const t0 = performance.now()
    const lib = await buildLibrary(await scanFiles(dir), () => ({}), [], new Map())
    assert.ok(performance.now() - t0 < 2000, 'built quickly')
    for (const t of lib.transcripts.values()) assert.ok(t.parsed.segments.every((s) => s.s <= 2 * 86_400))
  } finally {
    await rm(dir, { recursive: true })
  }
})

test('a participant named like a built-in property (Constructor, Proto) is just a name', () => {
  const people = new People([])
  for (const name of ['Constructor Smith', '__proto__ Jones', 'ToString Lee', 'HasOwnProperty Diaz']) assert.ok(people.add(name, 'm1'))
  assert.equal(people.list().length, 4)
})
