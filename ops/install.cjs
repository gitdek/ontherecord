const { spawnSync } = require('node:child_process')
const { randomBytes } = require('node:crypto')
const {
  accessSync, chmodSync, constants, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  realpathSync, renameSync, rmSync, statSync, writeFileSync,
} = require('node:fs')
const { tmpdir } = require('node:os')
const { basename, dirname, join, resolve } = require('node:path')
const { setTimeout: delay } = require('node:timers/promises')
const { parseEnv } = require('node:util')

// CommonJS lets the installer load even when the checkout path contains a literal backslash.
const root = resolve(__dirname, '..')
const home = process.env.HOME
const modelPorts = { embed: 8799, rerank: 8800, ask: 8801, screens: 8802 }
const plistLabel = (kind) => `ontherecord.${kind}`

function run(file, args) {
  const result = spawnSync(file, args, { encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || result.stdout?.trim() || `${basename(file)} exited with status ${result.status}`)
  }
  return result.stdout
}

function ifPresent(operation) {
  try {
    return operation()
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}

// Use Node's .env grammar, not shell quoting. In double quotes Node interprets a literal
// backslash followed by n, so check that the selected delimiter really round-trips.
function envLine(key, value) {
  for (const quote of ['"', "'", '`']) {
    if (value.includes(quote)) continue
    const line = `${key}=${quote}${value}${quote}\n`
    if (parseEnv(line)[key] === value) return line
  }
  throw new Error(`${key} cannot be represented losslessly in Node's .env format. Choose a simpler value.`)
}

function validatePlist(file, label, rendered = false) {
  const plutil = '/usr/bin/plutil'
  run(plutil, ['-lint', '-s', '--', file])
  const plist = JSON.parse(run(plutil, ['-convert', 'json', '-o', '-', '--', file]))
  if (plist.Label !== label) throw new Error(`unexpected Label in ${basename(file)}`)
  if (!rendered) return
  const args = plist.ProgramArguments
  if (!Array.isArray(args) || !args.length || args.some((arg) => typeof arg !== 'string') || !args[0].startsWith('/')) {
    throw new Error(`invalid ProgramArguments in ${basename(file)}`)
  }
  const executable = plist.Program ?? args[0]
  if (typeof executable !== 'string' || !executable.startsWith('/')) {
    throw new Error(`invalid Program in ${basename(file)}`)
  }
  return executable
}

// launchd needs an absolute path to Node that survives upgrades. process.execPath is the resolved binary
// (Homebrew's versioned Cellar folder, gone after the next `brew upgrade node`), so prefer the first `node` on
// PATH that runs this same binary, such as the /opt/homebrew/bin/node link that follows upgrades.
function stableNode() {
  const running = realpathSync(process.execPath)
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (!dir.startsWith('/')) continue
    const candidate = join(dir, 'node')
    try {
      accessSync(candidate, constants.X_OK)
      if (realpathSync(candidate) === running) return candidate
    } catch {
      // not here; try the next folder on PATH
    }
  }
  return process.execPath
}

function renderPlist(staging, kind, substitutions) {
  const label = plistLabel(kind)
  const template = readFileSync(join(root, 'ops', `${label}.plist`), 'utf8')
  const values = { ROOT: root, HOME: home, NODE: stableNode(), ...substitutions }
  const xml = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;', '\r': '&#13;' }
  // Substitute only template string values. A path can itself contain placeholder-like
  // text or characters (such as --) that would break an XML comment.
  const rendered = template.replace(/<string>[^<]*<\/string>/g, (entry) =>
    entry.replace(/__([A-Z]+)__/g, (placeholder, key) => {
      if (!Object.hasOwn(values, key)) throw new Error(`missing value for ${placeholder} in ${label}`)
      return values[key].replace(/[&<>"'\r]/g, (character) => xml[character])
    }))
  const file = join(staging, `${label}.plist`)
  writeFileSync(file, rendered, { mode: 0o600 })
  const executable = validatePlist(file, label, true)
  return { label, file, executable }
}

// What .env says about a model service: where it listens, its key and, except for the reranker, the model's name
// (SCREENS_URL, SCREENS_KEY and SCREENS_MODEL for screens).
function modelEnv(kind, model, key) {
  const prefix = kind.toUpperCase()
  return {
    [`${prefix}_URL`]: `http://127.0.0.1:${modelPorts[kind]}`,
    [`${prefix}_KEY`]: key,
    ...(kind === 'rerank' ? {} : { [`${prefix}_MODEL`]: basename(model, '.gguf') }),
  }
}

function tunnelSettings(id) {
  if (!/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(id)) {
    throw new Error('supply a tunnel UUID as TUNNEL_ID')
  }
  return { TUNNEL: id, CREDENTIALS: join(home, '.cloudflared', `${id}.json`) }
}

function envFile() {
  const path = join(root, '.env')
  const existing = ifPresent(() => lstatSync(path))
  const file = existing?.isSymbolicLink() ? realpathSync(path) : path
  const source = ifPresent(() => readFileSync(file))
  return { file, source, values: parseEnv(source?.toString() ?? '') }
}

// Where each definition in .env text starts and ends, as Node's parser reads it: a definition takes its line or, when
// its value opens a quote that closes on a later line, every line up to that one. The text is read as latin1, so the
// positions are bytes and the rest of the file is copied as it is.
function envDefinitions(text) {
  const definitions = []
  const endOfLine = (from) => {
    const end = text.indexOf('\n', from)
    return end === -1 ? text.length : end
  }
  for (let start = 0; start < text.length;) {
    let end = endOfLine(start)
    const match = /^ *([^ #=][^=]*)= *(["'`]?)/.exec(text.slice(start, end))
    if (match) {
      let key = match[1].replace(/ +$/, '')
      if (key.startsWith('export ')) key = key.slice(7).replace(/^ +/, '')
      const close = match[2] ? text.indexOf(match[2], start + match[0].length) : -1
      if (close !== -1) end = endOfLine(close)
      definitions.push({ key, start, end })
    }
    start = end + 1
  }
  return definitions
}

// A setting .env already defines takes its new value where Node reads it, at its last definition, and any earlier
// definitions of it go, so it is defined once. A setting .env doesn't define yet is added at the end.
function prepareEnv(env, additions) {
  if (!Object.keys(additions).length) return
  const { file, source } = env
  const original = source ?? Buffer.alloc(0)
  const definitions = envDefinitions(original.toString('latin1'))
  const edits = []
  let added = ''
  for (const [key, value] of Object.entries(additions)) {
    const earlier = definitions.filter((definition) => definition.key === key)
    const last = earlier.pop()
    if (!last) added += envLine(key, value)
    else edits.push(...earlier.map(({ start, end }) => ({ start, end: end + 1, line: '' })), { ...last, line: envLine(key, value).slice(0, -1) })
  }
  const parts = []
  let at = 0
  for (const { start, end, line } of edits.sort((a, b) => a.start - b.start)) {
    parts.push(original.subarray(at, start), Buffer.from(line))
    at = end
  }
  parts.push(original.subarray(at))
  if (added) parts.push(Buffer.from('\n' + added))
  const nextContent = Buffer.concat(parts)
  const parsed = parseEnv(nextContent.toString())
  for (const [key, value] of Object.entries({ ...env.values, ...additions })) {
    if (parsed[key] !== value) throw new Error(`unable to preserve .env parsing for ${key}`)
  }
  const staging = mkdtempSync(join(dirname(file), '.env.meetings-install-'))
  try {
    const next = join(staging, 'env')
    writeFileSync(next, nextContent, { mode: 0o600 })
    if (source) chmodSync(next, statSync(file).mode & 0o777)
    return { staging, next, file, source }
  } catch (error) {
    rmSync(staging, { recursive: true, force: true })
    throw error
  }
}

function publishEnv({ next, file, source }) {
  const previous = ifPresent(() => readFileSync(file))
  if (source ? !previous?.equals(source) : previous) {
    throw new Error('.env changed during installation. Retry with the current settings.')
  }
  renameSync(next, file)
}

function requireFile(file, description) {
  if (!ifPresent(() => statSync(file))?.isFile()) throw new Error(`refusing: no ${description} at ${file}`)
}

function requireExecutable({ label, executable }) {
  requireFile(executable, `executable for ${label}`)
  try {
    accessSync(executable, constants.X_OK)
  } catch (cause) {
    throw new Error(`refusing: executable for ${label} cannot be run at ${executable}`, { cause })
  }
}

function lookupTunnel() {
  const found = JSON.parse(run('cloudflared', ['tunnel', 'list', '--name', 'meetings', '--output', 'json']))
  if (found.length !== 1 || !found[0].id) throw new Error('no unique tunnel named meetings on this account')
  return found[0].id
}

const launchctl = '/bin/launchctl'
const domain = `gui/${process.getuid()}`
const isLoaded = (label) => spawnSync(launchctl, ['print', `${domain}/${label}`], { stdio: 'ignore' }).status === 0

async function stop(label) {
  const bootout = spawnSync(launchctl, ['bootout', `${domain}/${label}`], { stdio: 'ignore' })
  if (bootout.status !== 0 && isLoaded(label)) throw new Error(`could not stop ${label}`)
  // launchd can return from bootout before the old process is gone.
  for (let i = 0; i < 100 && isLoaded(label); i++) await delay(200)
  if (isLoaded(label)) {
    const error = new Error(`timed out stopping ${label}; its installed definition is unchanged`)
    error.code = 'LAUNCHD_STOP_TIMEOUT'
    throw error
  }
}

function prepareReplacement(agents, service) {
  service.dst = join(agents, basename(service.file))
  const previous = ifPresent(() => lstatSync(service.dst))
  service.wasLoaded = isLoaded(service.label)
  if (previous) {
    if (!previous.isFile()) throw new Error(`refusing to replace a non-regular plist for ${service.label}`)
    service.backup = service.file + '.previous'
    copyFileSync(service.dst, service.backup)
    chmodSync(service.backup, previous.mode & 0o777)
    validatePlist(service.backup, service.label)
    chmodSync(service.file, previous.mode & 0o777)
  } else if (service.wasLoaded) {
    throw new Error(`cannot replace ${service.label} without its installed plist for rollback`)
  }
}

async function replaceService(service) {
  if (service.wasLoaded) {
    await stop(service.label)
    service.stopped = true
  }
  renameSync(service.file, service.dst)
  service.replaced = true
  run(launchctl, ['bootstrap', domain, service.dst])
}

async function rollBack(service) {
  if (service.replaced) {
    if (isLoaded(service.label)) await stop(service.label)
    if (service.backup) renameSync(service.backup, service.dst)
    else rmSync(service.dst)
  }
  if (service.stopped) run(launchctl, ['bootstrap', domain, service.dst])
}

function renderOnly(services, output) {
  mkdirSync(output, { mode: 0o700 })
  try {
    for (const { file } of services) copyFileSync(file, join(output, basename(file)))
  } catch (error) {
    rmSync(output, { recursive: true, force: true })
    throw error
  }
}

async function main(args) {
  const dryRun = args[0] === '--dry-run'
  const [output, kind, argument, ...extra] = dryRun ? args.slice(1) : [undefined, ...args]
  const model = Object.hasOwn(modelPorts, kind)
  // the picture model for screen search also takes its vision file (mmproj)
  const vision = kind === 'screens' ? extra.shift() : undefined
  const needsTunnel = kind === 'tunnel' || kind === 'all'
  const needsArgument = model || (dryRun && needsTunnel)
  if (!home || !['server', 'tunnel', 'all', ...Object.keys(modelPorts)].includes(kind) ||
      (dryRun && !output) || needsArgument !== Boolean(argument) || (kind === 'screens') !== Boolean(vision) || extra.length) {
    throw new Error('usage: ops/install.sh server|tunnel|all|embed MODEL.gguf|rerank MODEL.gguf|ask MODEL.gguf|screens MODEL.gguf MMPROJ.gguf\n' +
      '       ops/install.sh --dry-run NEW_DIRECTORY server|tunnel UUID|all UUID|embed MODEL.gguf|rerank MODEL.gguf|ask MODEL.gguf|screens MODEL.gguf MMPROJ.gguf')
  }

  if (!dryRun && (kind === 'server' || kind === 'all') && root.includes('\\')) {
    throw new Error('Node cannot start the server from a checkout path containing a backslash')
  }

  const agents = join(home, 'Library', 'LaunchAgents')
  const staging = dryRun ? mkdtempSync(join(tmpdir(), 'meetings-plists-')) : join(agents, '.meetings-install')
  if (!dryRun) {
    mkdirSync(agents, { recursive: true, mode: 0o700 })
    mkdirSync(staging, { mode: 0o700 })
  }
  const services = []
  let preserveStaging = false
  let envUpdate
  try {
    const env = !dryRun && (model || needsTunnel) ? envFile() : undefined
    const additions = {}
    let tunnel
    if (needsTunnel) {
      if (!dryRun) {
        for (const key of ['ACCESS_TEAM', 'ACCESS_AUD', 'ACCESS_USERS']) {
          if (!env.values[key]?.trim()) throw new Error(`refusing: set ${key} in .env first`)
        }
      }
      const id = dryRun ? argument : env.values.TUNNEL_ID?.trim() || lookupTunnel()
      tunnel = tunnelSettings(id)
      if (!dryRun) {
        requireFile(tunnel.CREDENTIALS, 'tunnel credentials file')
        if (!env.values.TUNNEL_ID?.trim()) additions.TUNNEL_ID = id
      }
    }
    if (model) {
      const file = resolve(argument)
      const key = join(root, 'data', `${kind}.key`)
      const projector = vision && resolve(vision)
      if (!dryRun) requireFile(file, 'model file')
      if (!dryRun && projector) requireFile(projector, 'vision model file')
      services.push(renderPlist(staging, kind, { MODEL: file, KEYFILE: key, ...(projector ? { MMPROJ: projector } : {}) }))
    }
    if (kind === 'server' || kind === 'all') services.push(renderPlist(staging, 'server'))
    if (needsTunnel) services.push(renderPlist(staging, 'tunnel', tunnel))

    // All selected artifacts have passed plutil before this point.
    if (dryRun) return renderOnly(services, resolve(output))
    for (const service of services) requireExecutable(service)
    // Suppress the GUI domain dump. Only its availability matters here.
    if (spawnSync(launchctl, ['print', domain], { stdio: 'ignore' }).status !== 0) {
      throw new Error('launchd GUI domain is unavailable. Run the installer as the logged-in user.')
    }
    for (const service of services) prepareReplacement(agents, service)

    const data = join(root, 'data')
    mkdirSync(join(data, 'logs'), { recursive: true, mode: 0o700 })
    chmodSync(data, 0o700)
    run('chmod', ['-R', 'go-rwx', data])
    if (model) {
      const key = join(data, `${kind}.key`)
      if (!ifPresent(() => statSync(key))?.size) writeFileSync(key, randomBytes(24).toString('hex') + '\n', { mode: 0o600 })
      // .env gets the key and the model this service now runs, and its address unless .env has one already
      for (const [name, value] of Object.entries(modelEnv(kind, argument, readFileSync(key, 'utf8').trim()))) {
        if (name.endsWith('_URL') ? !env.values[name]?.trim() : env.values[name] !== value) additions[name] = value
      }
    }
    envUpdate = prepareEnv(env, additions)
    for (const service of services) await replaceService(service)
    if (envUpdate) publishEnv(envUpdate)
    for (const { label } of services) console.log(`loaded ${label}`)
    if (envUpdate) console.log(model ? `updated .env: ${Object.keys(additions).join(', ')} (restart the server to pick up model settings)` : 'added TUNNEL_ID to .env')
    if (kind === 'screens' && env.values.SCREEN_SEARCH !== 'local') console.log('screen search uses this model once .env says SCREEN_SEARCH=local and the server restarts')
  } catch (error) {
    if (error.code === 'LAUNCHD_STOP_TIMEOUT') preserveStaging = true
    for (const service of services.reverse()) {
      if (!service.stopped && !service.replaced) continue
      try {
        await rollBack(service)
      } catch (rollbackError) {
        preserveStaging = true
        console.error(`could not roll back ${service.label}: ${rollbackError.message}`)
      }
    }
    if (preserveStaging) console.error(`recovery files remain in ${staging}`)
    throw error
  } finally {
    if (envUpdate) rmSync(envUpdate.staging, { recursive: true, force: true })
    if (!preserveStaging) rmSync(staging, { recursive: true, force: true })
  }
}

exports.envLine = envLine
exports.modelEnv = modelEnv

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
