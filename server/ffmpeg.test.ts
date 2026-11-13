// The two tests that pick frames from a real recording need FFmpeg. Without it they are skipped on a Mac, but CI
// installs it, so there a missing FFmpeg means a broken install step: the tests fail instead of being skipped.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const FRAME_TESTS = [
  ['screens.test.ts', 'screen indexing previews real scene frames and sends only selected JPEGs when explicitly enabled'],
  ['screens-local.test.ts', 'local indexing embeds the picked frames on this Mac and keeps them in its own folder'],
]

test('without FFmpeg the frame tests are skipped, except under CI, where they fail', async (t) => {
  // an empty folder as PATH, so neither ffmpeg nor ffprobe can be found
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'frame-tests-')))
  t.after(() => rm(dir, { recursive: true, force: true }))
  for (const [file, name] of FRAME_TESTS) {
    const only = `--test-name-pattern=^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`
    const run = (env: Record<string, string>) =>
      spawnSync(process.execPath, ['--test', '--test-reporter=tap', only, join(import.meta.dirname, file)], {
        env: { PATH: dir, HOME: dir, TMPDIR: dir, ...env },
        encoding: 'utf8',
      })
    const laptop = run({})
    assert.equal(laptop.status, 0, laptop.stdout)
    assert.ok(laptop.stdout.includes(`ok 1 - ${name} # SKIP ffmpeg and ffprobe are required for the frame fixture`), laptop.stdout)
    const ci = run({ CI: 'true' })
    assert.equal(ci.status, 1, ci.stdout)
    assert.ok(ci.stdout.includes(`not ok 1 - ${name}`), ci.stdout)
    assert.match(ci.stdout, /ffmpeg and ffprobe are required for the frame fixture, and CI installs them/)
  }
})
