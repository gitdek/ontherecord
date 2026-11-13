import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { markdown } from '../web/js/markdown.js'
import { fixtureDir } from './fixtures.test-helper.ts'
import { buildLibrary, scanFiles } from './library.ts'
import { findSecrets, Notebook, NOTE_LIMITS, NoteError, type Note } from './notebook.ts'
import { chunksOf, Semantic } from './semantic.ts'

const look = { meeting: (id: string) => (id === 'm1' ? 'm1' : undefined), task: (id: string) => (id === 't1' ? 't1' : undefined) }

test('notebook: save, append, retag, relink, versions, delete and restore', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nb-'))
  try {
    const nb = new Notebook(join(dir, 'notebook.json'))
    const n = await nb.create({ title: ' Pricing research ', body: 'First pass.', tags: ['Pricing', 'Acme '], meetingIds: ['m1'] }, "Grace's agent", look)
    assert.equal(n.title, 'Pricing research')
    assert.deepEqual(n.tags, ['pricing', 'acme'])
    assert.equal(n.author, "Grace's agent")
    await nb.update(n.id, { append: 'Second pass.' }, 'Ada', look)
    assert.equal(nb.get(n.id)!.body, 'First pass.\n\nSecond pass.')
    assert.equal(nb.get(n.id)!.revisions.length, 1)
    assert.equal(nb.get(n.id)!.updatedBy, 'Ada')
    await assert.rejects(nb.update(n.id, { body: 'x', append: 'y' }, 'Ada', look), NoteError)
    await assert.rejects(nb.update(n.id, { meetingIds: ['nope'] }, 'Ada', look), /unknown meeting/)
    await assert.rejects(nb.update(n.id, {}, 'Ada', look), /nothing to change/)
    await nb.remove(n.id, 'Ada')
    assert.equal(nb.get(n.id), undefined)
    assert.equal(nb.list({ deleted: true }).length, 1)
    await nb.restore(n.id, 'Ada')
    assert.ok(nb.get(n.id))
    // survives a reload, and the file is owner-only
    const again = new Notebook(join(dir, 'notebook.json'))
    await again.load()
    assert.equal(again.get(n.id)?.body, 'First pass.\n\nSecond pass.')
  } finally {
    await rm(dir, { recursive: true })
  }
})

test('notebook: deleting makes room, each name holds only its share, and the newest 500 deleted notes stay', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nb-'))
  try {
    const path = join(dir, 'notebook.json')
    const nb = new Notebook(path)
    let made = 0
    // a note as the file holds it, filled in the cheap way; deleted ones a second apart, oldest first
    const put = (author: string, deleted = false) => {
      const at = new Date(Date.UTC(2026, 9, 1) + made * 1000).toISOString()
      const n: Note = { id: `n-${(made++).toString(16).padStart(10, '0')}`, title: `Note ${made}`, body: 'b', tags: [], meetingIds: [], taskIds: [], author, createdAt: at, updatedAt: at, updatedBy: author, revisions: [], version: 1, ...(deleted ? { deleted: { by: author, at } } : {}) }
      nb.notes.push(n)
      return n
    }
    // a loop filled the notebook, and all of it was deleted: there is room again
    for (let i = 0; i < NOTE_LIMITS.notes; i++) put("Grace's agent", true)
    const fresh = await nb.create({ title: 'Fresh', body: 'A new note' }, 'Grace', look)
    assert.deepEqual([nb.list().length, nb.list({ deleted: true }).length], [1, NOTE_LIMITS.deleted])
    // the deleted notes kept are the newest, and the file says the same
    const kept = nb.list({ deleted: true }).map((n) => n.id).sort()
    assert.deepEqual([kept[0], kept.at(-1)], [`n-${(NOTE_LIMITS.notes - NOTE_LIMITS.deleted).toString(16).padStart(10, '0')}`, `n-${(NOTE_LIMITS.notes - 1).toString(16).padStart(10, '0')}`])
    const again = new Notebook(path)
    await again.load()
    assert.deepEqual([again.list().length, again.list({ deleted: true }).length], [1, NOTE_LIMITS.deleted])

    // the 501st deleted note pushes out the oldest deleted one, never a note in view, however old
    const oldest = nb.list({ deleted: true }).at(-1)!
    const kept1 = put('Grace')
    kept1.createdAt = kept1.updatedAt = '2020-01-01T00:00:00.000Z'
    await nb.remove(fresh.id, 'Grace')
    assert.equal(nb.list({ deleted: true }).length, NOTE_LIMITS.deleted)
    assert.ok(!nb.notes.includes(oldest) && nb.notes.includes(fresh) && nb.notes.includes(kept1))

    // one name at its share is refused, and everyone else can still save
    for (let i = 0; i < NOTE_LIMITS.notesEach; i++) put("Grace's agent")
    await assert.rejects(nb.create({ title: 'One more', body: 'again' }, "Grace's agent", look), (err: Error) => err instanceof NoteError && /Grace's agent already has 800 notes in the notebook, the most one name may hold; delete some first/.test(err.message))
    await nb.create({ title: 'Mine', body: 'still room' }, 'Ada', look)
    // the notebook as a whole: full is full, and a deleted note can't be brought back over the cap
    while (nb.list().length < NOTE_LIMITS.notes) put('Ada')
    await assert.rejects(nb.create({ title: 'Over', body: 'too many' }, 'Grace', look), /holds at most 2000 notes; delete some first/)
    await assert.rejects(nb.restore(fresh.id, 'Grace'), /holds at most 2000 notes/)
    assert.equal(nb.list().length, NOTE_LIMITS.notes)
  } finally {
    await rm(dir, { recursive: true })
  }
})

test('notebook: a change past the most text it keeps is refused and changes nothing, and deleting makes room', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nb-'))
  const most = NOTE_LIMITS.chars
  // a small cap for the test; the real one is 64 MB
  NOTE_LIMITS.chars = 1000
  try {
    const path = join(dir, 'notebook.json')
    const nb = new Notebook(path)
    const alpha = await nb.create({ title: 'Alpha', body: 'a'.repeat(400) }, 'Ada', look)
    const beta = await nb.create({ title: 'Beta', body: 'b'.repeat(400) }, 'Ada', look)
    const [held, saved] = [JSON.stringify(nb.notes), await readFile(path, 'utf8')]
    const full = (err: Error) => err instanceof NoteError && /^the notebook is full: its notes and their earlier versions hold .* of text, the most it keeps\. Delete notes nobody needs any more to make room/.test(err.message)
    await assert.rejects(nb.create({ title: 'Gamma', body: 'c'.repeat(200) }, 'Ada', look), full)
    // an edit keeps the body it replaces among the earlier versions, so even a short append counts it again
    await assert.rejects(nb.update(alpha.id, { append: 'more' }, 'Ada', look), full)
    assert.equal(JSON.stringify(nb.notes), held)
    assert.equal(await readFile(path, 'utf8'), saved)
    // a deleted note makes room, and gives up its own when a new note needs it
    await nb.remove(beta.id, 'Ada')
    const gamma = await nb.create({ title: 'Gamma', body: 'c'.repeat(200) }, 'Ada', look)
    assert.deepEqual([nb.list().map((n) => n.title).sort(), nb.list({ deleted: true })], [['Alpha', 'Gamma'], []])
    const reread = new Notebook(path)
    await reread.load()
    assert.deepEqual(reread.notes.map((n) => n.title).sort(), ['Alpha', 'Gamma'])
    // a deleted note that would no longer fit is not brought back
    await nb.remove(alpha.id, 'Ada')
    NOTE_LIMITS.chars = 500
    await assert.rejects(nb.restore(alpha.id, 'Ada'), full)
    assert.deepEqual([nb.list().map((n) => n.id), nb.list({ deleted: true }).map((n) => n.id)], [[gamma.id], [alpha.id]])
  } finally {
    NOTE_LIMITS.chars = most
    await rm(dir, { recursive: true })
  }
})

test('notebook: an earlier version keeps the links it had, and a file from before that still loads', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nb-'))
  const at = '2026-10-01T09:00:00.000Z'
  try {
    const path = join(dir, 'notebook.json')
    const nb = new Notebook(path)
    const n = await nb.create({ title: 'Carrier comparison', body: 'First pass.', meetingIds: ['m1'], taskIds: ['t1'], source: 'Claude Code: carrier research' }, "Grace's agent", look)
    // relinked to nothing: the version before says what it was linked to and where it came from
    await nb.update(n.id, { meetingIds: [], taskIds: [], source: '' }, 'Ada', look)
    const [before] = nb.get(n.id)!.revisions
    assert.deepEqual([before.meetingIds, before.taskIds, before.source, nb.get(n.id)!.meetingIds, nb.get(n.id)!.taskIds, nb.get(n.id)!.source], [['m1'], ['t1'], 'Claude Code: carrier research', [], [], undefined])
    const reread = new Notebook(path)
    await reread.load()
    assert.deepEqual(reread.get(n.id)!.revisions[0], before)

    // a file written before versions kept their links loads as it was, and the next edit keeps them
    const old = { id: 'n-0000000001', title: 'Old', body: 'Kept', tags: [], meetingIds: ['m1'], taskIds: [], author: 'Ada', createdAt: at, updatedAt: at, updatedBy: 'Ada', revisions: [{ title: 'Older', body: 'Earlier', tags: [], by: 'Ada', at }], version: 2 }
    await writeFile(path, JSON.stringify({ notes: [old] }))
    const loaded = new Notebook(path)
    await loaded.load()
    assert.deepEqual(loaded.get(old.id)!.revisions, old.revisions)
    await loaded.update(old.id, { append: 'And more.', ifVersion: 2 }, 'Ada', look)
    assert.deepEqual(loaded.get(old.id)!.revisions, [{ title: 'Old', body: 'Kept', tags: [], meetingIds: ['m1'], taskIds: [], by: 'Ada', at }, ...old.revisions])
    // a version whose links are not lists of ids is a record in a shape the code doesn't expect
    await writeFile(path, JSON.stringify({ notes: [{ ...old, revisions: [{ ...old.revisions[0], meetingIds: 'm1' }] }] }))
    await assert.rejects(new Notebook(path).load(), /failed validation/)
  } finally {
    await rm(dir, { recursive: true })
  }
})

test('notebook: credentials are refused, ordinary text is not', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nb-'))
  try {
    const nb = new Notebook(join(dir, 'notebook.json'))
    const secrets = [
      'key: sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345',
      'AWS AKIAABCDEFGHIJKLMNOP', // gitleaks:allow (made up, to test the guard)
      'token ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'Bearer abcdefghijklmnopqrstuvwxyz0123456789',
      'GEMINI_API_KEY=AIzaSyA1234567890abcdefghijklmnopqrstuv', // gitleaks:allow (made up, to test the guard)
      'export GEMINI_API_KEY="AQ.Ab8RN6Jabcdefghijklmnopqrstuvwxyz"',
      'password: hunter2hunter2hunter2',
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXNpZ25hdHVyZQ', // gitleaks:allow (made up, to test the guard)
    ]
    for (const s of secrets) {
      assert.ok(findSecrets(s).length, s)
      await assert.rejects(nb.create({ title: 'x', body: s }, 'Ada', look), /credential/, s)
    }
    for (const ok of ['We discussed the API keys policy with Linus.', 'Pricing: $0.15 per call', 'See https://example.com/docs?page=2']) assert.deepEqual(findSecrets(ok), [], ok)
    await assert.rejects(nb.update('n-0000000000', { append: 'x' }, 'Ada', look), /no note/)
  } finally {
    await rm(dir, { recursive: true })
  }
})

test('notebook: a lowercase bearer header and a password inside a connection address are refused too', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nb-'))
  try {
    const nb = new Notebook(join(dir, 'notebook.json'))
    const secrets = [
      'authorization: bearer abcdefghijklmnopqrstuvwxyz0123456789',
      'Connect with postgres://admin:hunter2@db.example.test:5432/app', // gitleaks:allow (made up, to test the guard)
      'REDIS_URL=redis://:s3cr3tvalue@cache.example.test:6379', // gitleaks:allow (made up, to test the guard)
      'jdbc:postgresql://app:pa55word@db.example.test/app', // gitleaks:allow (made up, to test the guard)
    ]
    for (const s of secrets) {
      assert.ok(findSecrets(s).length, s)
      await assert.rejects(nb.create({ title: 'x', body: s }, 'Ada', look), /credential/, s)
    }
    // an address with no password, or a placeholder where it goes, and a plain bearer are ordinary text
    for (const ok of ['postgres://admin@db.example.test/app', 'postgres://admin:<password>@db.example.test/app', 'redis://:${REDIS_PASSWORD}@cache.example.test', 'https://example.test:8443/path?at=a:b@c', 'git@github.com:org/repo.git', 'The bearer of this letter is welcome.']) {
      assert.deepEqual(findSecrets(ok), [], ok)
    }
    assert.equal(nb.list().length, 0)
  } finally {
    await rm(dir, { recursive: true })
  }
})

test('notebook: a damaged file is kept aside, not overwritten', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nb-'))
  try {
    await writeFile(join(dir, 'notebook.json'), '{"notes": [ truncated')
    const nb = new Notebook(join(dir, 'notebook.json'))
    await nb.load()
    assert.equal(nb.list().length, 0)
    const files = await readdir(dir)
    assert.ok(files.some((f) => f.startsWith('notebook.json.corrupt-')))
    assert.ok(!files.includes('notebook.json'))
  } finally {
    await rm(dir, { recursive: true })
  }
})

test('markdown: formatting works and nothing executable gets through', () => {
  assert.equal(markdown('# Hi\n\n**bold** and `code`'), '<h2>Hi</h2>\n<p><strong>bold</strong> and <code>code</code></p>')
  const attacks = [
    '<img src=x onerror=alert(1)>',
    '<script>alert(1)</script>',
    '[click](javascript:alert(1))',
    '[x](//evil.example/path)',
    '[x](data:text/html,<script>alert(1)</script>)',
    '**<svg onload=alert(1)>**',
    '[a](https://ok.example/"onmouseover="alert(1))',
    '```\n</code><script>alert(1)</script>\n```',
  ]
  for (const a of attacks) {
    const out = markdown(a)
    // only real tags matter: escaped text like "&lt;img onerror=…" is inert
    const tags = out.match(/<[a-z][^>]*>/gi) ?? []
    assert.ok(tags.every((t) => /^<(?:p|h[2-5]|strong|em|code|pre|ul|ol|li|blockquote|hr|a)\b/i.test(t)), `${a} → ${out}`)
    assert.ok(tags.every((t) => !/\son\w+=/i.test(t)), `${a} → ${out}`)
    assert.ok(!/href="(?:javascript|data):|href="\/\//i.test(out), `${a} → ${out}`)
  }
  assert.match(markdown('[docs](https://example.com/a)'), /<a href="https:\/\/example\.com\/a" target="_blank" rel="noopener noreferrer">docs<\/a>/)
  assert.match(markdown('[meeting](/m/abc?t=5)'), /<a href="\/m\/abc\?t=5">meeting<\/a>/)
})

test('semantic: passages embed once, survive a restart, and rank by meaning', async () => {
  const dir = await fixtureDir({ index: true })
  const data = await mkdtemp(join(tmpdir(), 'sem-'))
  // a fake llama-server: vectors light up one dimension per keyword, so ranking is predictable
  const vocab = ['sandbox', 'soc', 'pilot', 'pricing', 'requirements']
  let calls = 0
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== 'Bearer k') return res.writeHead(401).end()
    let body = ''
    for await (const c of req) body += c
    const input = JSON.parse(body).input as string[]
    calls += input.length
    const data = input.map((t, index) => ({ index, embedding: vocab.map((w): number => (t.toLowerCase().includes(w) ? 1 : 0)).concat([0.01]) }))
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data }))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  try {
    const lib = await buildLibrary(await scanFiles(dir), () => ({}), [], new Map())
    const chunks = chunksOf(lib, [], 'test-model')
    assert.ok(chunks.some((c) => c.kind === 'transcript') && chunks.some((c) => c.kind === 'action'))
    assert.ok(chunks.find((c) => c.kind === 'action')?.actionId, 'action passages carry their item id')

    const sem = new Semantic(data, { url, key: 'k', model: 'test-model' })
    await sem.sync(chunks)
    assert.equal(sem.status().embedded, chunks.length)
    const before = calls
    const top = await sem.query('sandbox', { k: 3 })
    assert.ok(top[0].chunk.text.toLowerCase().includes('sandbox'))

    // a restart loads the vectors from disk instead of asking the model again
    const again = new Semantic(data, { url, key: 'k', model: 'test-model' })
    await again.load()
    await again.sync(chunks)
    assert.equal(calls, before + 1, 'only the query above was embedded')
    const files = await readdir(join(data, 'vectors'))
    assert.deepEqual(files, ['test-model.vec'])

    // a wrong key or a dead server degrades to "no results", never an exception
    const wrong = new Semantic(data, { url, key: 'nope', model: 'other' })
    await wrong.sync(chunks)
    assert.match(wrong.status().error ?? '', /401/)
    assert.deepEqual(await wrong.query('sandbox'), [])
  } finally {
    server.close()
    await rm(dir, { recursive: true })
    await rm(data, { recursive: true })
  }
})

