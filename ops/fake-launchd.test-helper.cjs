// A simulated launchd for ops/install-live.test.mjs, loaded with --require before ops/install.cjs. It takes over
// child_process, so the installer cannot run a real command: launchctl is answered from a JSON file in the test's
// folder, cloudflared from a fixture, and only plutil and chmod run for real, on files in that folder. It refuses to
// load unless the installer, HOME and the state file are all in that folder, so the real ~/Library/LaunchAgents and
// the checkout's .env stay out of reach. The installer's waits for launchd pass at once.
//
// The state file: `old` marks a definition installed before the run; `loaded` maps a label to the definition launchd
// runs ('old' or 'new'); after a bootout, `slowExit` keeps a label loaded for that many more checks; `failNew` lists
// labels whose new definition fails to load; `editEnv` names a .env that gains a line while a new definition loads;
// `calls` records what the installer asked, with short labels ("bootstrap server new failed").
const cp = require('node:child_process')
const { appendFileSync, readFileSync, writeFileSync } = require('node:fs')
const { userInfo } = require('node:os')
const { resolve, sep } = require('node:path')
const timers = require('node:timers/promises')

const sandbox = process.env.FAKE_LAUNCHD_SANDBOX ?? ''
const stateFile = process.env.FAKE_LAUNCHD_STATE ?? ''
const inside = (path) => typeof path === 'string' && resolve(path).startsWith(sandbox + sep)
if (!sandbox.startsWith('/') || !inside(stateFile) || !inside(process.env.HOME) || !inside(process.argv[1]) || inside(userInfo().homedir)) {
  throw new Error('fake launchd: the installer, HOME and the state file must be inside a temporary test folder')
}

const real = cp.spawnSync
for (const name of ['spawn', 'exec', 'execFile', 'execSync', 'execFileSync', 'fork']) {
  cp[name] = () => {
    throw new Error(`fake launchd: child_process.${name} is not available here`)
  }
}
timers.setTimeout = (_ms, value) => new Promise((done) => setImmediate(done, value))

const domain = `gui/${process.getuid()}`
const short = (label) => label.replace(/^ontherecord\./, '')
const answer = (status, stderr = '', stdout = '') => ({ pid: 0, output: [null, stdout, stderr], stdout, stderr, status, signal: null })
const labelOf = (plist) => JSON.parse(real('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', plist], { encoding: 'utf8' }).stdout).Label

function launchctl([verb, target, plist, ...extra]) {
  const state = { loaded: {}, exiting: {}, calls: [], ...JSON.parse(readFileSync(stateFile, 'utf8')) }
  const label = target?.startsWith(`${domain}/`) ? target.slice(domain.length + 1) : undefined
  let result
  if (extra.length) throw new Error(`fake launchd: unexpected launchctl ${verb} arguments`)
  if (verb === 'print' && target === domain && !plist) result = answer(0)
  else if (verb === 'print' && label && !plist) {
    state.calls.push(`print ${short(label)}`)
    if (state.exiting[label] > 0) {
      state.exiting[label]--
      result = answer(0)
    } else result = answer(state.loaded[label] ? 0 : 113)
  } else if (verb === 'bootout' && label && !plist) {
    state.calls.push(`bootout ${short(label)}`)
    if (!state.loaded[label]) result = answer(3, 'Boot-out failed: 3: No such process')
    else {
      delete state.loaded[label]
      state.exiting[label] = state.slowExit?.[label] ?? 0
      result = answer(0)
    }
  } else if (verb === 'bootstrap' && target === domain && inside(plist)) {
    const name = labelOf(plist)
    const version = readFileSync(plist, 'utf8').includes(state.old) ? 'old' : 'new'
    const refused = Boolean(state.loaded[name]) || state.exiting[name] > 0 || (version === 'new' && state.failNew?.includes(name))
    state.calls.push(`bootstrap ${short(name)} ${version}${refused ? ' failed' : ''}`)
    if (refused) result = answer(5, 'Bootstrap failed: 5: Input/output error')
    else {
      state.loaded[name] = version
      if (version === 'new' && state.editEnv) appendFileSync(state.editEnv, 'EDITED_MEANWHILE=1\n')
      result = answer(0)
    }
  } else throw new Error(`fake launchd: unexpected launchctl ${verb}`)
  writeFileSync(stateFile, JSON.stringify(state, null, 1))
  return result
}

cp.spawnSync = (file, args = [], options = {}) => {
  if (file === '/usr/bin/plutil' && inside(args.at(-1))) return real(file, args, options)
  if (file === 'chmod' && args.length === 3 && inside(args[2])) return real(file, args, options)
  if (file === 'cloudflared') return answer(0, '', JSON.stringify([{ id: process.env.FAKE_TUNNEL_ID }]))
  if (file === '/bin/launchctl') return launchctl(args)
  throw new Error(`fake launchd: refusing to run ${file}`)
}
// and the same for code that imports these modules instead of requiring them
require('node:module').syncBuiltinESMExports()
