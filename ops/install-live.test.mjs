// The installer's live path, run for real against a simulated launchd (fake-launchd.test-helper.cjs): the .env update,
// the swap of a definition, the rollback and the stop timeout. Each test has its own temporary checkout and home
// folder, and the simulated launchd refuses to run any real command or to load outside that folder.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync,
  statSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'

const fake = fileURLToPath(new URL('./fake-launchd.test-helper.cjs', import.meta.url))
const label = (kind) => `ontherecord.${kind}`
const uuid = '01234567-0123-0123-0123-0123456789ab'
const old = '<!-- installed before this run -->'
const plist = (file) => JSON.parse(spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', file], { encoding: 'utf8' }).stdout)

function fixture(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'meetings-install-live-')))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const root = join(dir, 'checkout')
  const home = join(dir, 'home')
  const agents = join(home, 'Library', 'LaunchAgents')
  mkdirSync(agents, { recursive: true })
  cpSync(new URL('.', import.meta.url), join(root, 'ops'), { recursive: true })
  // stand-ins for cloudflared and llama-server, for the installer's check that each service's program can run
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  for (const name of ['cloudflared', 'llama-server']) writeFileSync(join(bin, name), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
  for (const kind of ['tunnel', 'embed', 'rerank', 'ask', 'screens']) {
    const file = join(root, 'ops', `${label(kind)}.plist`)
    writeFileSync(file, readFileSync(file, 'utf8').replace(/\/opt\/homebrew\/bin\/(cloudflared|llama-server)/, (_, name) => join(bin, name)))
  }
  const state = join(dir, 'launchd.json')
  writeFileSync(state, JSON.stringify({ old, loaded: {}, exiting: {}, calls: [] }))
  const launchd = () => JSON.parse(readFileSync(state, 'utf8'))
  const setLaunchd = (change) => {
    const s = launchd()
    change(s)
    writeFileSync(state, JSON.stringify(s))
  }
  const env = { HOME: home, PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, TMPDIR: dir, FAKE_LAUNCHD_SANDBOX: dir, FAKE_LAUNCHD_STATE: state, FAKE_TUNNEL_ID: uuid }
  const install = (...args) => spawnSync(process.execPath, ['--require', fake, join(root, 'ops', 'install.cjs'), ...args], { cwd: dir, env, encoding: 'utf8' })
  // a definition rendered by an earlier run, marked as such, installed with the usual mode and loaded
  const preinstall = (kind, ...args) => {
    const out = join(dir, `earlier-${kind}`)
    const rendered = install('--dry-run', out, kind, ...args)
    assert.equal(rendered.status, 0, rendered.stderr)
    const file = join(agents, `${label(kind)}.plist`)
    writeFileSync(file, readFileSync(join(out, `${label(kind)}.plist`), 'utf8').replace('<plist ', `${old}\n<plist `))
    chmodSync(file, 0o644)
    setLaunchd((s) => {
      s.loaded[label(kind)] = 'old'
    })
    return file
  }
  // what the installer asked launchd to change, in order
  const changes = () => launchd().calls.filter((call) => !call.startsWith('print'))
  return { dir, root, home, agents, install, launchd, setLaunchd, preinstall, changes }
}

test('a first install loads the new definition and leaves only it behind', (t) => {
  const f = fixture(t)
  const result = f.install('server')
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, `loaded ${label('server')}\n`)
  assert.deepEqual(f.changes(), ['bootstrap server new'])
  assert.deepEqual(f.launchd().loaded, { [label('server')]: 'new' })
  assert.deepEqual(readdirSync(f.agents), [`${label('server')}.plist`])
  const installed = join(f.agents, `${label('server')}.plist`)
  assert.equal(statSync(installed).mode & 0o777, 0o600)
  assert.equal(plist(installed).WorkingDirectory, f.root)
  assert.equal(statSync(join(f.root, 'data')).mode & 0o777, 0o700)
  assert.equal(statSync(join(f.root, 'data', 'logs')).mode & 0o777, 0o700)
  assert.equal(existsSync(join(f.root, '.env')), false)
})

test('a reinstall whose new definition fails to load puts the old one back with its mode and loads it again', (t) => {
  const f = fixture(t)
  const installed = f.preinstall('server')
  const before = readFileSync(installed)
  // the old process takes a few checks to go after bootout, then launchd refuses the new definition
  f.setLaunchd((s) => {
    s.slowExit = { [label('server')]: 3 }
    s.failNew = [label('server')]
  })
  const result = f.install('server')
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Bootstrap failed: 5/)
  assert.deepEqual(f.changes(), ['bootout server', 'bootstrap server new failed', 'bootstrap server old'])
  assert.deepEqual(f.launchd().loaded, { [label('server')]: 'old' })
  assert.deepEqual(readFileSync(installed), before)
  assert.equal(statSync(installed).mode & 0o777, 0o644)
  assert.deepEqual(readdirSync(f.agents), [`${label('server')}.plist`])
})

test('all: when the tunnel fails to load after the server was replaced, both old definitions come back', (t) => {
  const f = fixture(t)
  const settings = `ACCESS_TEAM=team.example\nACCESS_AUD=fixture\nACCESS_USERS=ada@example.com=Ada\nTUNNEL_ID=${uuid}\n`
  writeFileSync(join(f.root, '.env'), settings)
  mkdirSync(join(f.home, '.cloudflared'))
  writeFileSync(join(f.home, '.cloudflared', `${uuid}.json`), '{}')
  const server = f.preinstall('server')
  const tunnel = f.preinstall('tunnel', uuid)
  f.setLaunchd((s) => {
    s.failNew = [label('tunnel')]
  })
  const result = f.install('all')
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Bootstrap failed: 5/)
  assert.deepEqual(f.changes(), [
    'bootout server', 'bootstrap server new', 'bootout tunnel', 'bootstrap tunnel new failed',
    'bootstrap tunnel old', 'bootout server', 'bootstrap server old',
  ])
  assert.deepEqual(f.launchd().loaded, { [label('server')]: 'old', [label('tunnel')]: 'old' })
  for (const file of [server, tunnel]) {
    assert.ok(readFileSync(file, 'utf8').includes(old), file)
    assert.equal(statSync(file).mode & 0o777, 0o644, file)
  }
  assert.deepEqual(readdirSync(f.agents).sort(), [`${label('server')}.plist`, `${label('tunnel')}.plist`])
  assert.equal(readFileSync(join(f.root, '.env'), 'utf8'), settings)
})

test('a model install writes .env through its link with its mode and an unfinished last line, and keeps a path with spaces and quotes whole', (t) => {
  const f = fixture(t)
  mkdirSync(join(f.dir, 'private'))
  const target = join(f.dir, 'private', 'meetings.env')
  writeFileSync(target, 'ACCESS_TEAM=team.example\nEMBED_URL=')
  chmodSync(target, 0o640)
  symlinkSync('../private/meetings.env', join(f.root, '.env'))
  const model = join(f.dir, 'models with space', "Qwen3 Embedding 8B 'Q8'.gguf")
  mkdirSync(dirname(model))
  writeFileSync(model, 'fixture')
  const result = f.install('embed', model)
  assert.equal(result.status, 0, result.stderr)
  const keyFile = join(f.root, 'data', 'embed.key')
  const key = readFileSync(keyFile, 'utf8').trim()
  assert.equal(readlinkSync(join(f.root, '.env')), '../private/meetings.env')
  assert.deepEqual({ ...parseEnv(readFileSync(target, 'utf8')) }, {
    ACCESS_TEAM: 'team.example', EMBED_URL: 'http://127.0.0.1:8799', EMBED_KEY: key, EMBED_MODEL: "Qwen3 Embedding 8B 'Q8'",
  })
  // the empty EMBED_URL takes its value where it stands, and the other two follow on lines of their own
  assert.equal(readFileSync(target, 'utf8'), `ACCESS_TEAM=team.example\nEMBED_URL="http://127.0.0.1:8799"\nEMBED_KEY="${key}"\nEMBED_MODEL="Qwen3 Embedding 8B 'Q8'"\n`)
  assert.equal(statSync(target).mode & 0o777, 0o640)
  assert.deepEqual(readdirSync(join(f.dir, 'private')), ['meetings.env'])
  const args = plist(join(f.agents, `${label('embed')}.plist`)).ProgramArguments
  assert.equal(args[args.indexOf('--model') + 1], model)
  assert.equal(args[args.indexOf('--api-key-file') + 1], keyFile)
  assert.equal(statSync(keyFile).mode & 0o777, 0o600)
  assert.deepEqual(f.changes(), ['bootstrap embed new'])
  assert.equal(`${result.stdout}${result.stderr}`.includes(key), false)
})

test('a stop that times out leaves the installed definition as it was, keeps the staged files and says where they are', (t) => {
  const f = fixture(t)
  const installed = f.preinstall('server')
  const before = readFileSync(installed)
  f.setLaunchd((s) => {
    s.slowExit = { [label('server')]: 1000 }
  })
  const result = f.install('server')
  assert.equal(result.status, 1)
  const staging = join(f.agents, '.meetings-install')
  assert.match(result.stderr, /timed out stopping ontherecord\.server; its installed definition is unchanged/)
  assert.ok(result.stderr.includes(`recovery files remain in ${staging}`), result.stderr)
  assert.deepEqual(f.changes(), ['bootout server'])
  assert.deepEqual(readFileSync(installed), before)
  assert.deepEqual(readdirSync(staging).sort(), [`${label('server')}.plist`, `${label('server')}.plist.previous`])
})

test('a staging folder left by an interrupted run stops the next run before launchd is asked anything', (t) => {
  const f = fixture(t)
  const installed = f.preinstall('server')
  const staging = join(f.agents, '.meetings-install')
  mkdirSync(staging)
  writeFileSync(join(staging, `${label('server')}.plist.previous`), 'kept for recovery')
  const result = f.install('server')
  assert.equal(result.status, 1)
  assert.match(result.stderr, /EEXIST/)
  assert.deepEqual(f.launchd().calls, [])
  assert.equal(readFileSync(join(staging, `${label('server')}.plist.previous`), 'utf8'), 'kept for recovery')
  assert.ok(readFileSync(installed, 'utf8').includes(old))
})

test('a change to .env during the install is kept, and the install is rolled back instead of writing over it', (t) => {
  const f = fixture(t)
  const envFile = join(f.root, '.env')
  writeFileSync(envFile, 'ACCESS_TEAM=team.example\n')
  const installed = f.preinstall('embed', join(f.dir, 'earlier.gguf'))
  const model = join(f.dir, 'm.gguf')
  writeFileSync(model, 'fixture')
  // .env gains a line while the new definition loads
  f.setLaunchd((s) => {
    s.editEnv = envFile
  })
  const result = f.install('embed', model)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /\.env changed during installation\. Retry with the current settings\./)
  assert.equal(readFileSync(envFile, 'utf8'), 'ACCESS_TEAM=team.example\nEDITED_MEANWHILE=1\n')
  assert.deepEqual(f.changes(), ['bootout embed', 'bootstrap embed new', 'bootout embed', 'bootstrap embed old'])
  assert.deepEqual(f.launchd().loaded, { [label('embed')]: 'old' })
  assert.ok(readFileSync(installed, 'utf8').includes(old))
  assert.deepEqual(readdirSync(f.agents), [`${label('embed')}.plist`])
  // the new key stays for the retry, and nothing staged for .env is left beside it
  assert.equal(statSync(join(f.root, 'data', 'embed.key')).mode & 0o777, 0o600)
  assert.deepEqual(readdirSync(f.root).filter((name) => name.startsWith('.env')), ['.env'])
})

test('a key file made again replaces the old key in .env where it stood, and an edit to .env meanwhile still stops it', (t) => {
  const f = fixture(t)
  const envFile = join(f.root, '.env')
  // copied from .env.example and filled in by an earlier install; data/embed.key has gone since (a move, a restore)
  const template = '# Local embedding server for meaning search\nEMBED_URL=\nEMBED_KEY=\nEMBED_MODEL=\n\nLOCAL_USER=Ada\n\n'
  const filled = 'EMBED_URL="http://127.0.0.1:8799"\nEMBED_KEY="old-old-old-old"\nEMBED_MODEL="m"\n'
  writeFileSync(envFile, template + filled)
  chmodSync(envFile, 0o640)
  const model = join(f.dir, 'm.gguf')
  writeFileSync(model, 'fixture')
  f.setLaunchd((s) => {
    s.editEnv = envFile
  })
  const refused = f.install('embed', model)
  assert.equal(refused.status, 1)
  assert.match(refused.stderr, /\.env changed during installation\. Retry with the current settings\./)
  assert.equal(readFileSync(envFile, 'utf8'), `${template}${filled}EDITED_MEANWHILE=1\n`)

  f.setLaunchd((s) => {
    delete s.editEnv
  })
  const result = f.install('embed', model)
  assert.equal(result.status, 0, result.stderr)
  const key = readFileSync(join(f.root, 'data', 'embed.key'), 'utf8').trim()
  assert.equal(readFileSync(envFile, 'utf8'), '# Local embedding server for meaning search\nEMBED_URL=\nEMBED_MODEL=\n\nLOCAL_USER=Ada\n\n' +
    `EMBED_URL="http://127.0.0.1:8799"\nEMBED_KEY="${key}"\nEMBED_MODEL="m"\nEDITED_MEANWHILE=1\n`)
  assert.equal(statSync(envFile).mode & 0o777, 0o640)
  assert.equal(result.stdout, `loaded ${label('embed')}\nupdated .env: EMBED_KEY (restart the server to pick up model settings)\n`)
  const printed = [refused, result].map((r) => r.stdout + r.stderr).join('')
  for (const value of [key, 'old-old-old-old']) assert.equal(printed.includes(value), false)
})

test('installing another model file names it in .env as the service runs it', (t) => {
  const f = fixture(t)
  const envFile = join(f.root, '.env')
  const ports = { embed: 8799, ask: 8801, screens: 8802 }
  mkdirSync(join(f.root, 'data'), { mode: 0o700 })
  const lines = ['SCREEN_SEARCH=local']
  for (const [kind, port] of Object.entries(ports)) {
    const prefix = kind.toUpperCase()
    writeFileSync(join(f.root, 'data', `${kind}.key`), `${kind}-fixture-key\n`, { mode: 0o600 })
    lines.push(`${prefix}_URL=http://127.0.0.1:${port}`, `${prefix}_KEY=${kind}-fixture-key`, `${prefix}_MODEL=Earlier-${kind}-Q8_0`)
  }
  writeFileSync(envFile, `${lines.join('\n')}\n`)
  mkdirSync(join(f.dir, 'models'))
  for (const kind of Object.keys(ports)) {
    const model = join(f.dir, 'models', `Other-${kind}-7B-Q8_0.gguf`)
    const vision = kind === 'screens' ? [join(f.dir, 'models', 'mmproj-Other-screens.gguf')] : []
    for (const file of [model, ...vision]) writeFileSync(file, 'fixture')
    const before = readFileSync(envFile, 'utf8')
    const result = f.install(kind, model, ...vision)
    assert.equal(result.status, 0, result.stderr)
    const args = plist(join(f.agents, `${label(kind)}.plist`)).ProgramArguments
    // the name the screens client compares with what llama-server reports
    const served = basename(args[args.indexOf('--model') + 1]).replace(/\.gguf$/i, '')
    const setting = `${kind.toUpperCase()}_MODEL`
    assert.equal(parseEnv(readFileSync(envFile, 'utf8'))[setting], served, kind)
    assert.equal(readFileSync(envFile, 'utf8'), before.replace(`${setting}=Earlier-${kind}-Q8_0`, `${setting}="${served}"`), kind)
    assert.ok(result.stdout.includes(`updated .env: ${setting} (restart the server to pick up model settings)\n`), result.stdout)
  }
})

test('a reinstall with nothing to change leaves .env as it was, byte for byte', (t) => {
  const f = fixture(t)
  const envFile = join(f.root, '.env')
  writeFileSync(envFile, 'ACCESS_TEAM=team.example\n# the installer fills in the models below\n')
  chmodSync(envFile, 0o640)
  for (const kind of ['embed', 'rerank']) {
    const model = join(f.dir, `${kind}-model.gguf`)
    writeFileSync(model, 'fixture')
    const first = f.install(kind, model)
    assert.equal(first.status, 0, first.stderr)
    assert.match(first.stdout, /^updated \.env: /m)
    const before = readFileSync(envFile)
    const { ino } = statSync(envFile)
    const again = f.install(kind, model)
    assert.equal(again.status, 0, again.stderr)
    assert.equal(again.stdout, `loaded ${label(kind)}\n`)
    assert.deepEqual(readFileSync(envFile), before, kind)
    assert.equal(statSync(envFile).ino, ino, `${kind}: .env was not written again`)
    assert.equal(statSync(envFile).mode & 0o777, 0o640)
  }
})
