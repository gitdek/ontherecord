import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync,
  statSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { parseEnv } from 'node:util'
import { envLine, modelEnv } from './install.cjs'

const uuid = '01234567-0123-0123-0123-0123456789ab'
const punctuation = "with space ' & # \\next <xml> \" -- __MODEL__"
const names = ['server', 'tunnel', 'embed', 'rerank', 'ask', 'screens']

function fixture(t, checkout = `checkout ${punctuation}`) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'meetings-installer-test-')))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const root = join(dir, checkout)
  const home = join(dir, `home ${punctuation}`)
  mkdirSync(home)
  cpSync(new URL('.', import.meta.url), join(root, 'ops'), { recursive: true })
  const envLink = 'dry-run-must-not-read-this'
  symlinkSync(envLink, join(root, '.env'))
  const path = process.execPath.slice(0, process.execPath.lastIndexOf('/'))
  const run = (output, ...args) => spawnSync('/bin/sh', [join(root, 'ops', 'install.sh'), '--dry-run', output, ...args], {
    cwd: dir,
    env: { PATH: `${path}:/usr/bin:/bin`, HOME: home, TMPDIR: dir },
    encoding: 'utf8',
  })
  return { dir, root, home, envLink, run }
}

test('dry-run renders and lints all six agents without accessing local configuration', (t) => {
  const { dir, root, home, envLink, run } = fixture(t)
  const model = `models ${punctuation}/local ${punctuation}.gguf`
  const projector = `models ${punctuation}/vision ${punctuation}.gguf`
  const outputs = { server: 'public', tunnel: 'public', embed: 'embed', rerank: 'rerank', ask: 'ask', screens: 'screens' }
  const combined = run('public', 'all', uuid)
  assert.equal(combined.status, 0, combined.stderr)
  for (const name of names.slice(2)) {
    const result = name === 'screens' ? run(name, name, model, projector) : run(name, name, model)
    assert.equal(result.status, 0, result.stderr)
  }
  assert.deepEqual(readdirSync(join(dir, 'public')).sort(), [
    'ontherecord.server.plist', 'ontherecord.tunnel.plist',
  ])
  for (const name of names) {
    const label = `ontherecord.${name}`
    const output = join(dir, outputs[name])
    const file = join(output, `${label}.plist`)
    assert.equal(statSync(output).mode & 0o777, 0o700)
    assert.equal(statSync(file).mode & 0o777, 0o600)
    const converted = spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', file], { encoding: 'utf8' })
    assert.equal(converted.status, 0, converted.stderr)
    const plist = JSON.parse(converted.stdout)
    assert.equal(plist.Label, label)
    assert.equal(plist.Umask, 63)
    assert.equal(plist.StandardErrorPath, join(root, 'data', 'logs', `${name}.log`))
    assert.equal(plist.StandardOutPath, plist.StandardErrorPath)
    const args = plist.ProgramArguments
    if (name === 'server') {
      assert.equal(plist.WorkingDirectory, root)
      assert.deepEqual(args, [process.execPath, '--env-file-if-exists=.env', 'server/index.ts'])
    } else if (name === 'tunnel') {
      assert.equal(plist.EnvironmentVariables.HOME, home)
      assert.equal(args[args.indexOf('--credentials-file') + 1], join(home, '.cloudflared', `${uuid}.json`))
      assert.equal(args.at(-1), uuid)
    } else {
      assert.equal(args[args.indexOf('--model') + 1], join(dir, model))
      assert.equal(args[args.indexOf('--api-key-file') + 1], join(root, 'data', `${name}.key`))
      assert.equal(args[args.indexOf('--host') + 1], '127.0.0.1')
      assert.ok(args.includes('--no-webui'))
    }
    if (name === 'screens') {
      assert.equal(args[args.indexOf('--mmproj') + 1], join(dir, projector))
      assert.equal(args[args.indexOf('--port') + 1], '8802')
      assert.ok(args.includes('--embedding'))
      assert.equal(args[args.indexOf('--pooling') + 1], 'last')
      assert.equal(args[args.indexOf('--sleep-idle-seconds') + 1], '600')
      // the longest search the app sends (about 6,000 tokens) fits in one slot
      assert.equal(Number(args[args.indexOf('--ctx-size') + 1]) / Number(args[args.indexOf('--parallel') + 1]), 8192)
      assert.equal(args[args.indexOf('--batch-size') + 1], args[args.indexOf('--ubatch-size') + 1])
    } else if (name !== 'server' && name !== 'tunnel') {
      assert.equal(args.includes('--mmproj'), false)
    }
  }
  assert.equal(readlinkSync(join(root, '.env')), envLink)
  assert.equal(existsSync(join(root, 'data')), false)
  assert.equal(existsSync(join(home, 'Library')), false)
  assert.equal(readdirSync(dir).some((name) => name.startsWith('meetings-plists-')), false)
})

test('the server agent runs Node through the stable link on PATH, not the versioned binary behind it', (t) => {
  const { dir, root, home } = fixture(t)
  const bin = join(dir, 'stable bin')
  mkdirSync(bin)
  symlinkSync(process.execPath, join(bin, 'node'))
  const result = spawnSync('/bin/sh', [join(root, 'ops', 'install.sh'), '--dry-run', 'rendered', 'server'], {
    cwd: dir,
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, TMPDIR: dir },
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr)
  const file = join(dir, 'rendered', 'ontherecord.server.plist')
  const converted = spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', file], { encoding: 'utf8' })
  assert.equal(JSON.parse(converted.stdout).ProgramArguments[0], join(bin, 'node'))
})

test('a malformed tunnel plist prevents publishing either rendered agent', (t) => {
  const { dir, root, run } = fixture(t)
  const file = join(root, 'ops', 'ontherecord.tunnel.plist')
  writeFileSync(file, readFileSync(file, 'utf8').replace('</dict>\n</plist>', '</array>\n</plist>'))
  const result = run('rendered', 'all', uuid)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /plist/)
  assert.equal(existsSync(join(dir, 'rendered')), false)
})

test('a valid XML plist with the wrong service label is rejected', (t) => {
  const { dir, root, run } = fixture(t)
  const file = join(root, 'ops', 'ontherecord.server.plist')
  writeFileSync(file, readFileSync(file, 'utf8').replace('ontherecord.server', 'unexpected.service'))
  const result = run('rendered', 'server')
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /unexpected Label/)
  assert.equal(existsSync(join(dir, 'rendered')), false)
})

test('dry-run refuses to overwrite an existing output directory', (t) => {
  const { dir, run } = fixture(t)
  const output = join(dir, 'rendered')
  mkdirSync(output)
  writeFileSync(join(output, 'keep'), 'unchanged')
  assert.notEqual(run(output, 'server').status, 0)
  assert.deepEqual(readdirSync(output), ['keep'])
  assert.equal(readFileSync(join(output, 'keep'), 'utf8'), 'unchanged')
})

test('a missing or non-executable binary for any selected agent stops live preflight before launchd', (t) => {
  const { dir, root, home } = fixture(t, 'checkout')
  const envFile = join(root, '.env')
  rmSync(envFile)
  writeFileSync(envFile, `ACCESS_TEAM=fixture
ACCESS_AUD=fixture
ACCESS_USERS=fixture
TUNNEL_ID=${uuid}
`)
  mkdirSync(join(home, '.cloudflared'))
  writeFileSync(join(home, '.cloudflared', `${uuid}.json`), '{}')

  const guard = join(dir, 'no-launchctl.cjs')
  writeFileSync(guard, `
    const cp = require('node:child_process')
    const spawnSync = cp.spawnSync
    cp.spawnSync = (file, ...args) => {
      if (file !== '/usr/bin/plutil') throw new Error('unexpected external command: ' + file)
      return spawnSync(file, ...args)
    }
  `)
  const executable = join(dir, 'cloudflared')
  const tunnel = join(root, 'ops', 'ontherecord.tunnel.plist')
  writeFileSync(tunnel, readFileSync(tunnel, 'utf8').replace('/opt/homebrew/bin/cloudflared', executable))
  const run = () => spawnSync(process.execPath, ['--require', guard, join(root, 'ops', 'install.cjs'), 'all'], {
    env: { HOME: home, TMPDIR: dir, PATH: '/usr/bin:/bin' },
    encoding: 'utf8',
  })
  const missing = run()
  assert.notEqual(missing.status, 0)
  assert.match(missing.stderr, /no executable for ontherecord\.tunnel/)

  writeFileSync(executable, 'fixture', { mode: 0o600 })
  const inaccessible = run()
  assert.notEqual(inaccessible.status, 0)
  assert.match(inaccessible.stderr, /executable for ontherecord\.tunnel cannot be run/)
  assert.deepEqual(readdirSync(join(home, 'Library', 'LaunchAgents')), [])
  assert.equal(existsSync(join(root, 'data')), false)
})

test('generated model names survive Node’s .env parsing', () => {
  for (const name of [punctuation, " apostrophe ' and literal \\n #<> ", 'line one\nline two', '$model `literal`']) {
    assert.equal(parseEnv(envLine('ASK_MODEL', name)).ASK_MODEL, name)
  }
  assert.throws(() => envLine('ASK_MODEL', "all three delimiters ' \" `"), /losslessly/)
})

test('the screens agent takes the model and its vision file, and the others take one file', (t) => {
  const { dir, run } = fixture(t)
  const cases = [['screens', 'model.gguf'], ['screens', 'model.gguf', 'mmproj.gguf', 'extra.gguf'], ['embed', 'model.gguf', 'mmproj.gguf'], ['ask', 'model.gguf', 'mmproj.gguf']]
  for (const [i, args] of cases.entries()) {
    const result = run(`out-${i}`, ...args)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /screens MODEL\.gguf MMPROJ\.gguf/)
    assert.equal(existsSync(join(dir, `out-${i}`)), false)
  }
})

test('a missing vision file stops the screens agent before launchd, as does a missing llama-server', (t) => {
  const { dir, root, home } = fixture(t, 'checkout')
  rmSync(join(root, '.env'))
  writeFileSync(join(root, '.env'), 'SCREEN_SEARCH=0\n')
  const guard = join(dir, 'no-launchctl.cjs')
  writeFileSync(guard, `
    const cp = require('node:child_process')
    const spawnSync = cp.spawnSync
    cp.spawnSync = (file, ...args) => {
      if (file !== '/usr/bin/plutil') throw new Error('unexpected external command: ' + file)
      return spawnSync(file, ...args)
    }
  `)
  const model = join(dir, 'Qwen3-VL-Embedding-2B-f16.gguf')
  const projector = join(dir, 'mmproj-Qwen3-VL-Embedding-2B-f16.gguf')
  writeFileSync(model, 'fixture')
  const run = () => spawnSync(process.execPath, ['--require', guard, join(root, 'ops', 'install.cjs'), 'screens', model, projector], {
    env: { HOME: home, TMPDIR: dir, PATH: '/usr/bin:/bin' },
    encoding: 'utf8',
  })
  const missing = run()
  assert.notEqual(missing.status, 0)
  assert.match(missing.stderr, /no vision model file at/)

  writeFileSync(projector, 'fixture')
  const plist = join(root, 'ops', 'ontherecord.screens.plist')
  writeFileSync(plist, readFileSync(plist, 'utf8').replace('/opt/homebrew/bin/llama-server', join(dir, 'llama-server')))
  const absent = run()
  assert.notEqual(absent.status, 0)
  assert.match(absent.stderr, /no executable for ontherecord\.screens/)
  assert.deepEqual(readdirSync(join(home, 'Library', 'LaunchAgents')), [])
  assert.equal(existsSync(join(root, 'data')), false)
  assert.equal(readFileSync(join(root, '.env'), 'utf8'), 'SCREEN_SEARCH=0\n')
})

test('the screens agent adds SCREENS_URL, SCREENS_KEY and SCREENS_MODEL to .env, on its own loopback port', () => {
  const settings = modelEnv('screens', '/models/qwen3-vl-embedding-2b/Qwen3-VL-Embedding-2B-f16.gguf', 'fixture-key')
  assert.deepEqual(settings, { SCREENS_URL: 'http://127.0.0.1:8802', SCREENS_KEY: 'fixture-key', SCREENS_MODEL: 'Qwen3-VL-Embedding-2B-f16' })
  assert.deepEqual(Object.keys(modelEnv('rerank', '/models/reranker.gguf', 'k')), ['RERANK_URL', 'RERANK_KEY'])
  assert.equal(modelEnv('embed', '/models/embedder.gguf', 'k').EMBED_URL, 'http://127.0.0.1:8799')
  const ports = ['embed', 'rerank', 'ask', 'screens'].map((kind) => new URL(modelEnv(kind, 'm.gguf', 'k')[`${kind.toUpperCase()}_URL`]).port)
  assert.equal(new Set(ports).size, 4)
  for (const [key, value] of Object.entries(settings)) assert.equal(parseEnv(envLine(key, value))[key], value)
})
