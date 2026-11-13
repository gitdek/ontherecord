// server/index.ts as launchd runs it: a process on a port. Each test runs a copy of the server from a scratch checkout,
// with its own DATA_DIR and meetings folder, so nothing it does can reach this checkout's data/.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { fixtureDir } from './fixtures.test-helper.ts'

async function checkout(t: TestContext) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'meetings-index-')))
  const meetings = await realpath(await fixtureDir())
  t.after(() => Promise.all([rm(base, { recursive: true, force: true }), rm(meetings, { recursive: true, force: true })]))
  const root = join(base, 'checkout')
  await cp(join(import.meta.dirname), join(root, 'server'), { recursive: true })
  await cp(join(import.meta.dirname, '..', 'package.json'), join(root, 'package.json'))
  const data = join(base, 'data')
  const home = join(base, 'home')
  await Promise.all([mkdir(data), mkdir(home)])
  const env = (port: number) => ({
    PATH: '/usr/bin:/bin', HOME: home, TMPDIR: base, HOST: '127.0.0.1', PORT: String(port),
    DATA_DIR: data, MEETINGS_DIR: meetings, DIARIZE_PYTHON: '',
  })
  return { root, data, index: join(root, 'server', 'index.ts'), env }
}

async function freePort() {
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const { port } = probe.address() as AddressInfo
  await new Promise((resolve) => probe.close(resolve))
  return port
}

// Holds start() at its first look at DATA_DIR/logs until the process gets SIGUSR2, so a test can ask while it starts.
const HOLD_START = `data:text/javascript,${encodeURIComponent(`
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
const readdir = fs.promises.readdir
const go = new Promise((resolve) => process.once('SIGUSR2', resolve))
const logs = join(process.env.DATA_DIR, 'logs')
fs.promises.readdir = async function (path, ...rest) {
  if (String(path) === logs) await go
  return readdir.call(this, path, ...rest)
}
syncBuiltinESMExports()
`)}`

test('a second server on a port in use stops at once with one line, before it reads or writes anything in DATA_DIR', async (t) => {
  const { data, index, env } = await checkout(t)
  const holder = createServer()
  await new Promise<void>((resolve) => holder.listen(0, '127.0.0.1', resolve))
  t.after(() => holder.close())
  const { port } = holder.address() as AddressInfo
  const result = spawnSync(process.execPath, [index], { env: env(port), encoding: 'utf8', timeout: 30_000 })
  assert.equal(result.status, 1, result.stderr)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, `port ${port} on 127.0.0.1 is in use: On the Record is probably running already, so this one stops here\n`)
  assert.deepEqual(await readdir(data), [])
})

test('the server takes its port first and answers 503 with Retry-After until it has started, then serves', async (t) => {
  const { index, env } = await checkout(t)
  const port = await freePort()
  const child = spawn(process.execPath, ['--import', HOLD_START, index], { env: env(port), stdio: ['ignore', 'pipe', 'pipe'] })
  t.after(() => child.kill('SIGKILL'))
  let output = ''
  child.stdout.on('data', (d) => (output += d))
  child.stderr.on('data', (d) => (output += d))
  const url = `http://127.0.0.1:${port}/api/library`
  let starting: Response | undefined
  for (let i = 0; i < 600 && !starting && child.exitCode === null; i++) starting = await fetch(url).catch(() => sleep(25).then(() => undefined))
  assert.ok(starting, `the server never answered: ${output}`)
  assert.equal(starting.status, 503)
  assert.equal(starting.headers.get('retry-after'), '5')
  assert.equal(starting.headers.get('cache-control'), 'private, no-store')
  assert.deepEqual(await starting.json(), { error: 'On the Record is starting; try again in a few seconds' })
  assert.doesNotMatch(output, /On the Record: http/)

  child.kill('SIGUSR2')
  let ready = await fetch(url)
  for (let i = 0; i < 600 && ready.status === 503; i++) {
    await ready.body?.cancel()
    await sleep(25)
    ready = await fetch(url)
  }
  assert.equal(ready.status, 200, output)
  assert.equal((await ready.json()).meetings.length, 2)
  assert.match(output, new RegExp(`On the Record: http://127\\.0\\.0\\.1:${port}  ·  2 meetings from `))
})

test('a server that cannot start ends with the reason, though its port is already taken', async (t) => {
  const { data, index, env } = await checkout(t)
  // valid JSON in a shape the board's validator refuses: startup stops before anything is written over it
  await writeFile(join(data, 'state.json'), '[]\n')
  const result = spawnSync(process.execPath, [index], { env: env(await freePort()), encoding: 'utf8', timeout: 30_000 })
  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stderr, /state\.json failed validation \(expected a board object\)/)
  assert.equal(await readFile(join(data, 'state.json'), 'utf8'), '[]\n')
})

test("the launchd services' logs in the checkout's data/logs are rotated at start, though DATA_DIR is elsewhere", async (t) => {
  const { root, index, env } = await checkout(t)
  const logs = join(root, 'data', 'logs')
  await mkdir(logs, { recursive: true })
  const long = Buffer.alloc(5_000_001, 'x')
  await writeFile(join(logs, 'server.log'), long)
  await writeFile(join(logs, 'tunnel.log'), 'short\n')
  const port = await freePort()
  const child = spawn(process.execPath, [index], { env: env(port), stdio: ['ignore', 'pipe', 'pipe'] })
  t.after(() => child.kill('SIGKILL'))
  let output = ''
  child.stdout.on('data', (d) => (output += d))
  child.stderr.on('data', (d) => (output += d))
  let status = 0
  for (let i = 0; i < 600 && status !== 200 && child.exitCode === null; i++) {
    status = await fetch(`http://127.0.0.1:${port}/api/library`).then(async (r) => (await r.body?.cancel(), r.status), () => 0)
    if (status !== 200) await sleep(25)
  }
  assert.equal(status, 200, output)
  assert.equal((await stat(join(logs, 'server.log'))).size, 0)
  assert.deepEqual(await readFile(join(logs, 'server.log.1')), long)
  assert.equal(await readFile(join(logs, 'tunnel.log'), 'utf8'), 'short\n')
  assert.match(output, /logs: server\.log was 5 MB; the old part is in server\.log\.1/)
})
