// Node entry: serves the meeting archive from MEETINGS_DIR on 127.0.0.1, for cloudflared to publish behind
// Cloudflare Access. Everything the server does is in app.ts; this file only starts it.
import { createServer } from 'node:http'
import { join } from 'node:path'
import { createApp, type App } from './app.ts'
import { configFrom } from './config.ts'

// everything this server writes (state, notebook, vectors, thumbnails, backups) is for this Mac's owner only
process.umask(0o077)

const config = configFrom(process.env)

// The port comes first. A second copy (started by hand while launchd runs one, or by launchd while the port is
// held) stops here, before it reads or writes anything in DATA_DIR. Until start() is done, requests are told to
// come back in a few seconds.
let app: App | undefined
const server = createServer((req, res) => {
  if (!app) {
    res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store', 'Retry-After': '5' })
    return void res.end(JSON.stringify({ error: 'On the Record is starting; try again in a few seconds' }))
  }
  void app.handler(req, res).catch(() => {
    console.error('request handler failed outside the response boundary')
    res.destroy()
  })
})
const listening = await new Promise<boolean>((resolve, reject) => {
  const failed = (err: NodeJS.ErrnoException) => (err.code === 'EADDRINUSE' ? resolve(false) : reject(err))
  server.once('error', failed).listen(config.port, config.host, () => {
    server.off('error', failed)
    resolve(true)
  })
})

if (!listening) {
  console.error(`port ${config.port} on ${config.host} is in use: On the Record is probably running already, so this one stops here`)
  process.exitCode = 1
} else {
  // the launchd services write their logs to the checkout's data/logs, wherever DATA_DIR is
  const started = await createApp(config, { serviceLogs: join(import.meta.dirname, '..', 'data', 'logs') })
  // an unreadable board or notebook stops the server here, before anything is written over it
  await started.start()
  app = started
  console.log(`On the Record: http://${config.host}:${config.port}  ·  ${app.lib().meetings.length} meetings from ${config.meetingsDir}`)
  if (!app.gate.configured) console.log('Cloudflare Access verification is OFF (set ACCESS_TEAM and ACCESS_AUD): only requests from this Mac are allowed.')
  else if (!config.users.size) console.warn('ACCESS_USERS is empty: no person can sign in through Cloudflare (agents with listed service tokens still can).')
}
