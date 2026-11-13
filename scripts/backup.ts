// npm run backup: a verified snapshot of the board, the notebook and the speaker names now, in data/backups and
// each BACKUP_DIR folder, for a restore or a rollout, printing where each copy is. The point is a copy with nothing
// writing, so it refuses while something answers on the server's port unless run with --while-running. Each file
// is checked with this checkout's readers first, so it also says whether this code can start on the files.
import { existsSync } from 'node:fs'
import { connect } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { backup } from '../server/backup.ts'
import { configFrom } from '../server/config.ts'

// what the server writes is for this Mac's owner only, and so is a copy of it
process.umask(0o077)

const config = configFrom(process.env)
const answers = await new Promise<boolean>((settle) => {
  const socket = connect({ host: config.host, port: config.port })
  socket.setTimeout(2000)
  socket.once('connect', () => {
    socket.destroy()
    settle(true)
  })
  socket.once('timeout', () => {
    socket.destroy()
    settle(false)
  })
  socket.once('error', () => settle(false))
})
if (answers && !process.argv.includes('--while-running')) {
  console.error(`Something answers on ${config.host}:${config.port}, most likely the server, and a copy taken while it writes can miss a change. Stop it first:
  launchctl bootout gui/$(id -u)/ontherecord.server
or copy anyway with: npm run backup -- --while-running`)
  process.exit(1)
}
if (!['state.json', 'notebook.json', 'speakers/names.json'].some((path) => existsSync(join(config.dataDir, path)))) {
  console.error(`Nothing to copy: ${config.dataDir} holds no board, notebook or speaker names. Is DATA_DIR right?`)
  process.exit(1)
}

const dests = [...new Set([join(config.dataDir, 'backups'), ...config.backupDirs].map((dest) => resolve(dest)))]
const made = await backup(config.dataDir, dests)
for (const path of made) console.log(`backup: verified copy in ${path}`)
const missed = dests.filter((dest) => !made.some((path) => dirname(path) === dest))
for (const dest of missed) console.error(`backup: no copy in ${dest}; the reason is above`)
// a folder that never answered may still hold a call open
process.exit(missed.length ? 1 : 0)
