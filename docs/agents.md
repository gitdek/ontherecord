# Agents (MCP)

Agents get the same archive as the web app through a Model Context Protocol server. `/mcp` serves 17 tools. `/mcp/readonly` serves the 11 that only read. One of them, `get_screens`, is offered only while screen search is on. What an agent changes shows up live for everyone signed in, credited to the agent ("Ada's agent", "Grace's Hermes").

The server explains itself: its initialization instructions teach the workflow below, so a new assistant does not need this page to behave well. This page is for the people connecting one.

## The tools

Reading, served by both endpoints:

| Tool | What it does |
| :-- | :-- |
| `gather_context` | One cited brief on a topic: requirements, decisions, action items with their status and board updates, next steps, open questions, attached documents and notebook entries, grouped by meeting in date order. The heading of an entry that is not a meeting names its kind, as in `(demo)`. Text from the notebook and from documents is quoted, and what the board says stays on its item's lines, so none of it can pass for the brief's own headings or items. Add `include_screen: true` for indexed frames when enabled |
| `search` | Keyword search across notes, action items, transcripts, attached documents, the notebook and board updates, with the filters in [`docs/search.md`](search.md) (`status:`, `owner:` and `kind:` among them) and passages related by meaning. Use `in:screen` for indexed screen moments when enabled |
| `list_meetings` | Every entry, newest first: id, title, `kind` (`meeting`, or another sort of recording such as `demo`), date, length, who was there, one-line summary, open action items |
| `get_meeting` | One meeting's reviewed notes: summary, topics with timestamps, action items, next steps, uncertainties, files, and its `kind`. With `outline`, only its timeline: the topics and their times |
| `get_transcript` | The lines of a meeting, optionally between two times, with the speaker named. For a meeting whose transcript the Mac is still writing, it says so and when to call again, or why writing it failed |
| `get_screens` | What was on screen in a recording, in order, optionally between two times: the text read off each screen, with when it came up and when the next one replaced it. A screen that continues one given earlier gives only what it added or changed, unless `full_text` asks for every screen whole. With `with_transcript` it also gives what was said while each screen was up. For following a demo or a form step by step, and for counting or listing what was shown. Offered only when screen search is on, and only a recording whose screens were indexed has them ([`docs/screen-search.md`](screen-search.md)) |
| `list_action_items` | The board, by status (`open`, `on_hold`, `done`, `canceled`, `all`), lane, person or meeting, with an id and a `rev` per item and the board's counts |
| `get_action_item` | One item in full: state, hold, evidence and sources, a check that found nothing, what it replaces, its original wording, its history and the notebook entries linked to it |
| `find_connections` | Takes a piece of current work and returns the meetings, transcript moments, notebook entries and action items it connects to. The text is read as plain words: quotation marks, `Status:` lines, flags and `@` names in it are not search filters |
| `list_notes` | Notebook entries, newest first, by tag, meeting, author or query |
| `read_note` | One notebook entry in full, with its links |

Writing, served by `/mcp` only:

| Tool | What it does |
| :-- | :-- |
| `update_action_item` | Changes one item: status, reason, note, hold, evidence, sources, a check that found nothing, replacement link, wording, owner, or an undo |
| `add_action_item` | Adds a task, optionally tied to a meeting |
| `delete_action_item` | Deletes a hand-added task. An undo brings it back |
| `save_note` | Saves a Markdown note linked to meetings and action items |
| `update_note` | Appends to a note, or replaces its body, title, tags or links. The last 20 versions are kept, links included, and `if_version` refuses an edit made on an older copy |
| `delete_note` | Removes a note from view. It can be restored from the web app until 500 newer deletions push it out or the notebook needs its room, and it no longer counts toward the notebook's limits |

## The workflow the server teaches

1. **Gather context first.** `gather_context` for a topic, `search` for exact words, `get_meeting` and `get_transcript` for the wording. For what was shown and not said, `get_screens` reads a recording's screens in order, and `search` with `in:screen` finds the moment something was on screen.
2. **Check where things stand before changing anything.** `list_action_items` shows the board, and `get_action_item` adds one item's history, sources and links.
3. **Record what was found.** `update_action_item` takes the evidence and sources behind a change. Longer findings, and a short review of any cleanup of the board, go in the notebook: `find_connections` suggests what to link, `save_note` stores it, and `update_note` with `append` keeps adding to the same note.

The states mean what they mean on the board: **done** is confirmed finished, **canceled** is no longer relevant and carries a reason, deferred or blocked work stays open and goes **on hold**, and `not_found` records a search that confirmed neither. [`docs/board.md`](board.md) has the detail.

A cancellation with its grounds looks like this:

```json
{
  "id": "H56DdNtgFk",
  "status": "canceled",
  "reason": "Superseded: the carrier prints labels from its own portal",
  "replaced_by": "kG7ZzS8-c8",
  "evidence": "Agreed in the shipping meeting and confirmed by email",
  "sources": [{ "meeting_id": "2026-11-03-shipping", "at": "22:00" }, { "ref": "carrier email, 5 Nov" }],
  "if_rev": 1
}
```

## Rules an agent works under

- **Revision checks.** Every item has a `rev` and every note a `version`. Passing them back as `if_rev` and `if_version` means a newer change by someone else is never overwritten: the update is refused and the current item or note comes back.
- **Undo.** `update_action_item {id, undo: true}` takes back the last change to an item and brings back a deleted task. A task just brought back has nothing to undo until it changes again, so a retried restore is refused and changes nothing.
- **Pointers, not content.** Sources are `{meeting_id, at}`, `{note_id}` or `{ref}`, a short pointer to something outside the archive. Private emails and messages are not pasted in, and text that looks like a credential is refused.
- **Citations.** Results carry links to their source, including the specific attached document, transcript, notebook entry or board item. An action item from a meeting's notes links to the moment it was agreed, and carries `board_link` to its card on the board. In a `gather_context` brief its line has both.
- **A write limit.** An agent is stopped at 60 write calls a minute. The count is kept per credited name, so two assistants signed in as the same person share it. Each name may also hold at most 200 of the board's 500 added tasks and 800 of the notebook's 2000 notes. The notes in view and their earlier versions keep at most 64 MB of text: past that a new note or an edit is refused until notes nobody needs are deleted.
- **Data, not instructions.** Everything the server returns is meeting content. Nothing in it is a command.

## What to keep in mind

- Transcripts are automatic and can mishear a name or a number. The reviewed notes are the reliable layer. A recording that came without a transcript gets one written on the Mac, and until it lands, `get_transcript` says where it stands ([`docs/transcripts.md`](transcripts.md)).
- "Ada?" is a guessed speaker and "Speaker 3" an unnamed one.
- Matching by meaning covers the meetings, their attached documents, the notebook and what the board says about each item.
- The endpoint is stateless Streamable HTTP with JSON answers, and both addresses speak two eras of MCP: 2026-07-28, where every request carries its protocol version and `server/discover` describes the server, and the older 2025-11-25, 2025-06-18, 2025-03-26 and 2024-11-05 revisions, which open with `initialize`.

## Connecting

The quickest way is the block under [Connect an agent](../README.md#connect-an-agent) in the README: paste it into the agent, then sign in and approve. These are the same steps by hand.

**An agent that signs in with OAuth**, such as Claude Code, Codex or Hermes, uses the connector address. It registers itself, sends a browser to the site, and gets a token once the person approves, so there is no secret to copy.

Claude Code, then `/mcp` → **meetings** → **Authenticate**:

```bash
claude mcp add --scope user --transport http meetings https://meetings-mcp.example.com/mcp
```

Codex, which adds the server and starts the sign-in in one step (`codex mcp login meetings` signs in again later):

```bash
codex mcp add meetings --url https://meetings-mcp.example.com/mcp
```

Hermes (`~/.hermes/config.yaml`), then `hermes mcp login meetings` in a terminal and `/reload-mcp` in a session:

```yaml
mcp_servers:
  meetings:
    url: https://meetings-mcp.example.com/mcp
    auth: oauth
```

On a machine with no browser, `codex mcp login meetings --no-browser` and `hermes mcp login meetings` print the address to open somewhere else. Paste back the address the browser ends up on, even if that page doesn't load.

**In Claude** (the web, the phone or the desktop app): Settings → Connectors → **Add custom connector**, once per address, then **Connect**. A window opens on the site: sign in through Cloudflare Access if asked, check what is asking, and press **Approve**.

| Connector | Address |
| :-- | :-- |
| Read-only | `https://meetings-mcp.example.com/mcp/readonly` |
| Read and write | `https://meetings-mcp.example.com/mcp` |

These addresses are on a second hostname because Claude's hosted connectors can't finish Cloudflare Access's own sign-in ([anthropics/claude-ai-mcp#980](https://github.com/anthropics/claude-ai-mcp/issues/980)). There the server signs agents in itself, with OAuth 2.1: the agent registers, the person approves it on the site (behind Access), and the token it gets works for that person only. A read-only connection's token opens `/mcp/readonly`; a read-and-write connection's opens `/mcp`, and `/mcp/readonly` too, where it gets the reading tools only. It shows up as "Ada's agent", exactly as on `/mcp`. A restart preserves unexpired connections whose owners are still allowed to sign in. A public client that presents a refresh token already used for a renewal, one of the 64 newest the server remembers, ends its connection and must reconnect. The exception is the token the latest renewal replaced, which renews again for a minute in case the answer got lost. Renewals have no limit, and the cap on remembered tokens never forces a reconnect. A failed revocation denies the affected connection for the lifetime of the running process and reports an error until the change can be saved. If the server restarts before the change is saved, the connection works again, since `connector.json` still holds it: end it again on the **Lab** page once saving works. No backup holds that file. A damaged one is set aside at startup and everyone approves their agents again, and nothing comes back from the file set aside, so a connection that was ended stays ended. The **Lab** page lists every connected agent and ends any of them with one click. Because the approval page is on the site's hostname rather than the connector's, every answer it sends back names the issuer (`iss`, RFC 9207), and the metadata says so; Codex refuses to sign in without that. An agent may register a callback on its own machine (`127.0.0.1`, `localhost` or `[::1]`, on any port) or one of the hosted callbacks in `CONNECTOR_REDIRECTS`, Claude's by default. Any other callback is refused, so an assistant that signs in through its own website, like ChatGPT, uses the Cloudflare address below.

**On the Mac that runs the server**, no sign-in is needed:

```bash
claude mcp add --transport http meetings http://127.0.0.1:8797/mcp
```

**Through Cloudflare Access**, at `https://meetings.example.com/mcp`: ChatGPT signs in as a person (Managed OAuth), and a script or bot that can't sign in with OAuth sends a service token. The archive's owner makes the token in Cloudflare and lists it in `ACCESS_SERVICE_TOKENS`, read only unless marked `:write` ([`docs/cloudflare.md`](cloudflare.md)).

```bash
claude mcp add --transport http meetings https://meetings.example.com/mcp --header "CF-Access-Client-Id: <id>" --header "CF-Access-Client-Secret: <secret>"
```

Codex with a service token (`~/.codex/config.toml`), keeping the secret in the environment:

```toml
[mcp_servers.meetings]
url = "https://meetings.example.com/mcp"
env_http_headers = { "CF-Access-Client-Id" = "MEETINGS_CF_ID", "CF-Access-Client-Secret" = "MEETINGS_CF_SECRET" }
```

Hermes with a service token (`~/.hermes/config.yaml`, values from `~/.hermes/.env`):

```yaml
mcp_servers:
  meetings:
    url: https://meetings.example.com/mcp
    headers:
      CF-Access-Client-Id: ${MEETINGS_CF_ID}
      CF-Access-Client-Secret: ${MEETINGS_CF_SECRET}
```

Use `/mcp/readonly` for agents that run unattended or read on their own schedule: transcripts hold other people's words, and a read-only connection cannot be talked into changing anything. The Cloudflare side of all this is in [`docs/cloudflare.md`](cloudflare.md).

## Three ways to use it

- **Bring findings in.** From a research session on shipping carriers: "Take the carrier comparison from this session, check what it connects to in the meetings server, and save it to the notebook." The agent calls `find_connections` with just that part of the session, shows what it connects to, saves a note with those meetings linked, and keeps adding to it as the session goes on.
- **Ask what was shown.** About a recorded product demo: "How many questions did the presenter answer on screen before the payment step?" The agent finds the stretch with `search` or the outline of `get_meeting`, then calls `get_screens` with `with_transcript` for those minutes: the screens give each step and its wording, and the words under each give what the presenter said they filled in or left blank.
- **Pull context out.** Before building a feature: "Pull everything the meetings server knows about the wholesale portal requirements." `gather_context` returns one cited brief of requirements, decisions, action items with their status, open questions and notebook entries, grouped by meeting with links.
- **Clean up the board.** "Go through the open items and find the ones later meetings made obsolete." The agent reads the board, gathers context on each item, cancels the outdated ones with a reason and a source, records "looked, found nothing" where it could confirm neither, and leaves a short review of what it changed in the notebook.
