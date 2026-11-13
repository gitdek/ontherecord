// What the project asks of Node, wherever it says so. scripts/index-screens.ts runs only when import.meta.main is true,
// which Node has had since 24.2: on 24.0 or 24.1, `npm run index-screens` would end at once, having done nothing.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

const root = join(import.meta.dirname, '..')
// major and minor, so that 24 < 24.2 < 24.10 < 25
const rank = (version: string) => {
  const [major, minor = 0] = version.split('.').map(Number)
  return major * 1000 + minor
}

test('package.json, its lock file and the README ask for the same Node, 24.2 or newer', async () => {
  const engines = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).engines.node
  const locked = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8')).packages[''].engines.node
  const readme = await readFile(join(root, 'README.md'), 'utf8')
  const minimum = /^>=(\d+(?:\.\d+)*)$/.exec(engines)?.[1]
  assert.ok(minimum && rank(minimum) >= rank('24.2'), engines)
  assert.equal(locked, engines)
  // the badge, its description and the requirement under "Run it"
  assert.equal(/badge\/Node-(\d+(?:\.\d+)*)%2B/.exec(readme)?.[1], minimum)
  assert.deepEqual([...readme.matchAll(/Node (\d+(?:\.\d+)*) or newer/g)].map((m) => m[1]), [minimum, minimum])
})
