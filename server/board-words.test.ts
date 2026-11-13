import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
// the board's vocabulary is plain JavaScript the browser loads; it has no DOM in it so it can be checked here
import { said, TRAIL_WORDS, trailWord } from '../web/js/board-words.js'

test('board words: every change the server can report has words in the history', async () => {
  const sources = await Promise.all(['state.ts', 'tasks.ts'].map((f) => readFile(new URL(f, import.meta.url), 'utf8')))
  const reported = new Set([...sources.join('\n').matchAll(/\bdid: '([a-z-]+)'/g)].map((m) => m[1]))
  // the two the store names without a `did:` in front
  for (const word of ['undone', 'redone']) reported.add(word)
  assert.ok(reported.size >= 19, `only ${reported.size} words found: has the trail's shape changed?`)
  assert.deepEqual([...reported].filter((w) => !TRAIL_WORDS.includes(w)), [])
  assert.deepEqual(TRAIL_WORDS.filter((w) => !reported.has(w)), [])
  assert.equal(trailWord('note-cleared'), 'Note cleared')
  // a word from a newer server still shows, as itself
  assert.equal(trailWord('archived'), 'archived')
})

test('board words: a toast names what the change did, not where the item ended up', () => {
  assert.equal(said(['canceled', 'linked']).words, 'canceled an action item')
  assert.equal(said(['done', 'evidence']).words, 'checked off an action item')
  assert.equal(said(['reopened']).words, 'reopened an action item')
  // a new reason or note on a canceled item is not a cancellation, and never a reopening
  assert.equal(said(['reason']).words, 'updated an action item')
  assert.equal(said(['note']).words, 'left a note on an action item')
  assert.equal(said(['hold']).words, 'put an action item on hold')
  assert.equal(said(['released']).words, 'took an action item off hold')
  assert.equal(said(['checked']).words, 'looked into an action item')
  assert.equal(said(['undone']).words, 'took back a change to an action item')
  assert.equal(said(['restored']).words, 'brought back a deleted task')
  // an older server sends no list at all
  assert.deepEqual(said(undefined), { icon: '✎', words: 'updated an action item' })
  assert.deepEqual(said([]), { icon: '✎', words: 'updated an action item' })
})
