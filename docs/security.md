# Security model

The archive holds other people's words, so the design starts from "two people and nobody else". This page says what stands between the internet and the meetings, and what an agent can and cannot do.

## Who gets in

- **Loopback only.** The server binds to `127.0.0.1`. cloudflared is the only way in from outside.
- **Cloudflare Access at the edge.** Access allows only the two listed emails and, for agents, the listed service tokens.
- **Checked again at the origin.** The server verifies Access's signed JWT on every request itself: issuer, audience, expiry, signature against the team's published keys, and the email or token allow-list. Anything that arrives through Cloudflare without a valid token is refused. Until `ACCESS_TEAM` and `ACCESS_AUD` are set, every request that did not come straight from this Mac is refused, and an empty `ACCESS_USERS` admits nobody.
- **"Straight from this Mac" is narrow.** It means a loopback connection that also names the server as `127.0.0.1`, `localhost` or `[::1]`, so a web page that points its own hostname at 127.0.0.1 (DNS rebinding) is not trusted.
- **One address outside Access, for agents that sign in with OAuth.** `CONNECTOR_URL` (a second hostname) serves only the MCP doors and the OAuth 2.1 steps that sign an agent in: registration (only Claude's callback addresses, or a callback on the agent's own machine), the token exchange (PKCE S256 only, codes good once for five minutes) and revocation. The approval step stays on the site, behind Access, so only a person on the policy can let an assistant in, and sees what is asking before approving. Every answer it sends back names the issuer (`iss`, RFC 9207, advertised in the metadata), so a client signed in to several servers can't be tricked into sending a code to the wrong one. Access tokens last an hour, refresh tokens rotate on every use, both are bound to the person and to the connection's scope, and only their hashes are stored (`data/connector.json`, owner-only). A read-only connection's token opens `/mcp/readonly` only; a read-and-write connection's opens `/mcp`, and `/mcp/readonly` too, where it gets the reading tools only. The **Lab** page lists every connected assistant and ends any of them at once.
- **Registration is rationed.** Anyone can reach the connector's registration step, so the server counts registrations by the caller's address, the one Cloudflare saw (an IPv6 address by its /64): 6 an hour from one address and 120 an hour from all of them together. An assistant registered in the last hour is never pushed out to make room for another, and one that never connected is dropped after a day. Someone with many addresses can still use up the overall ceiling for a while, and new assistants then wait for the hour to pass. Existing connections are unaffected. A rate limiting rule on that hostname at Cloudflare's edge stops a flood before it reaches the Mac ([`docs/cloudflare.md`](cloudflare.md#a-rate-limit-on-the-connector-hostname)).
- **Sign-ins run out.** Live-update streams end when the sign-in that opened them runs out, ten minutes at most, and reconnect through Access. A revoked session stops receiving updates soon. Slow or excess streams are dropped.

## What other websites can do

- **Link, nothing more.** Browsers' fetch metadata is checked on every request. Another site can link to a page here, but it cannot call the API, `/mcp`, the media or the live stream.
- **Writes from the web app** need same-origin JSON with the header `x-requested-with: meetings`, and any `Origin` must be this site's own.
- **`/mcp` and `/mcp/readonly`** take `application/json` only. An `Origin`, when one is sent, must be this site's own or one listed in `MCP_ORIGINS`, which defaults to `https://claude.ai` and `https://claude.com` so hosted assistants can connect. Command-line agents send no `Origin` and are accepted as before. Access still decides who gets in: the list only says which sites' connectors may ask.
- **No CORS headers, ever.** The server never tells a browser that another site may read its answers.
- **Nothing from outside.** A strict content security policy, and no third-party scripts, fonts or CDNs: pages make no requests outside this site.

## What an agent can do

- **A narrow door.** Service tokens can use `/mcp`, `/mcp/readonly` and the read-only parts of `/api`. They cannot load the web app.
- **Read by default.** A service token writes only when its entry in `ACCESS_SERVICE_TOKENS` ends in `:write`. `/mcp/readonly` offers only the 11 reading tools to any client, whatever its token says.
- **A person's connection writes as that person's agent.** Signing in through a hosted assistant gives that connection write access on `/mcp`, credited as "Ada's agent". Connect `/mcp/readonly` when the assistant should only read.
- **Rate limited.** An agent is stopped at 60 write calls a minute, so one stuck in a loop cannot flood the shared board or notebook. The count is kept per credited name: assistants signed in as the same person share it. Each name may also hold at most 200 of the board's 500 added tasks and 800 of the notebook's 2000 notes, and the notes in view and their earlier versions keep at most 64 MB of text, far less than one save can write. A deleted note no longer counts toward the notebook's limits and stays restorable until 500 newer deletions push it out or the notebook needs its room.
- **No silent overwrites.** Every board item has a revision number, and every notebook entry a version. A change based on an older one is refused and gets the current item or note back. See [`docs/board.md`](board.md).
- **No credentials in shared state.** A note or a board entry that looks like it holds a key, a token or a password is refused.
- **Data, not instructions.** Transcripts hold other people's words. The server's instructions tell every agent to treat what it returns as data, and a read-only connection cannot be talked into changing anything.

## Files and the folder

- **By id only.** Files are served only by id from the scanned folder. They are opened without following symlinks, and only if they are still the exact file the scan saw. ffmpeg reads them as plain local media files only.
- **A pinned folder.** The folder is pinned at startup and must not lead through a symlink, unless `MEETINGS_DIR_ALLOW_LINK=1`. Before every scan it is checked again without following links. If it is moved or replaced, also when a symlink is left where it was or where a folder above it was, scanning stops until a restart: the archive keeps what it had, and the server log says why.
- **Bad files are skipped.** A file the library cannot read or parse is skipped and named, never quoted, under **Cautions** on the **Lab** page. It never stops the scan.
- **Adds, never changes.** The server never changes or removes a file in the meetings folder. The one thing it adds, and only with `TRANSCRIBE_PYTHON` set, is a transcript beside a recording that has none: written whole under hidden names, which the scan skips, and given its real names only where they are free, both files or neither. A name that is taken is left as it is ([`docs/transcripts.md`](transcripts.md)).

## What stays on the Mac

- **Owner-only state.** Everything in `data/` is readable by the owner only, the logs included: every service starts with umask 077. The access log keeps the route, never the query string, so search terms and questions stay out of it. A download is logged by the file's id, and an agent's calls under the agent's name. A log past 5 MB is set aside as `<name>.1` when the server starts.
- **A second copy.** The board, the notebook and the speaker names are copied into `data/backups/` when the server starts and once a day, and a week of copies is kept. `BACKUP_DIR` adds more places, such as another disk: a copy on the same disk does not survive the disk. Each of those also gets a copy of the meetings folder, the recordings, transcripts and notes. `.env`, the model keys and `data/connector.json` are never copied anywhere.
- **Nothing written over an unreadable file.** If the board or the notebook exists but cannot be read, or is valid JSON in a shape the code doesn't expect, the server stops instead of starting empty, leaves the file where it is, and says why in its log. Bytes that aren't JSON at all are kept aside before that store starts empty.
- **Voiceprints.** The speaker job runs with none of the server's settings or keys in its environment and reads the recording as a plain local media file. Its voiceprints are only ever compared on this Mac. The app and agents see names, never voiceprints.
- **Transcripts.** The transcript job gets the recording already open, as a plain local file, and runs with none of the server's settings or keys: only where to find FFmpeg and the model. It is started offline (`HF_HUB_OFFLINE=1`), so the speech model is never fetched, and the sound it takes out is removed when it ends.
- **Models.** Text embeddings, reranking, transcription, speaker recognition and answer generation run locally. Screen search is opt-in, in one of two modes. In its local mode (`SCREEN_SEARCH=local`) frames and searches stay on the Mac: the picture model listens on loopback only and asks for its key, `SCREENS_URL` is refused unless it is `127.0.0.1`, `localhost` or `[::1]`, the OpenRouter key is never read, and nothing falls back to the hosted model. In its hosted mode (`SCREEN_SEARCH=1`) selected frames and explicit queries go to OpenRouter and its Google provider. Frame extraction and OCR run locally in both, with a restricted subprocess environment. [Screen search setup](screen-search.md)
- **Out of git.** `.env` and its variants, everything in `data/`, keys, certificates and the meetings themselves are outside the repository. The keys of the local models are generated into `data/*.key`. A pre-commit hook (`git config core.hooksPath .githooks`) runs gitleaks on every commit, and the check on GitHub runs it over the whole history.

## What no setting changes

An assistant connected to `/mcp` or `/mcp/readonly` receives what it reads on its provider's servers. Both people have agreed to that.

## The earlier reviews

A security review on 2026-11-09 confirmed no vulnerability and left 12 leads to validate. An audit the next day carried the ones still open, and they have been fixed since.
