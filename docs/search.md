# Search

One search covers the notes, the action items, the transcripts, the documents attached to meetings, the notebook and what the board says about each item. It works by keyword, and by meaning when a local embedding model is running. **⌘K** opens it from any page, and agents reach the same index through the `search` tool.

## Keyword search

An in-memory index (`server/search.ts`) is rebuilt whenever the folder changes. A change to the board or the notebook swaps only their part of it. Ranking is BM25 with light stemming, so "roast", "roasted" and "roasting" find each other.

- **Every word must appear.** If nothing holds them all, the search falls back to passages with any of them and says so.
- **Small words.** Words such as "the", "to" or "on" are left out, unless the search has nothing else: "one on one" or "to do" looks for those words as they are.
- **Captions run on.** People finish a sentence on the next caption, so a transcript line counts as holding a word that the line just before or after it holds, within 20 seconds. Such a stretch is one hit. A quoted phrase can run on across the break the same way.
- **Prefixes while typing.** In the palette, the last word matches as a prefix from 2 letters, so results arrive before the word is finished. The search page treats what is in the box as a finished query.
- **Typos.** A word of 4 letters or more that matches nothing is tried against the index's own words: 1 edit away, or 2 for words of 8 letters or more. The results say which words were used instead.

Where a word is found matters as much as how often:

| Found in | Weight |
| :-- | :-- |
| Meeting title | 3 |
| Topic title | 2.2 |
| Summary · action item | 1.8 |
| Notebook entry | 1.7 |
| Board update (a reason, evidence, a note, a hold) | 1.6 |
| Note | 1.4 |
| Next step | 1.1 |
| Transcript line · attached document | 1 |
| Caveat | 0.8 |

Hits are grouped by meeting. Each one carries a link to its moment on the tape, and a hit on an action item carries the item's id and current status. An action item from a meeting's notes opens that meeting at the moment it was agreed. What only the board holds, such as a task added there, corrected wording or an update, opens the item's card on the board.

## Filters

| Write | To get |
| :-- | :-- |
| `"cold brew"` | The exact phrase |
| `-decaf` | Nothing that mentions the word |
| `-"cold brew"` | Nothing that holds the phrase |
| `person:ada` (also `who:`, `with:`, `@ada`) | Only meetings Ada took part in, by first name, nickname, last name or the full name as one word (`person:ada-byron`). Several names mean all of them. A name nobody has matches nothing. So does a name several people share, and the answer lists who they are. Someone the notes write two ways, such as William Byron and Bill Byron, is one person |
| `in:notes` | Titles, summaries, topics, notes, next steps and caveats |
| `in:actions` (also `in:todo`, `in:board`) | Action items and what the board says about them |
| `in:updates` | Only what was written on items after the meeting: reasons, evidence, notes, holds, checks that found nothing |
| `in:transcript` (also `in:said`) | Only what was said |
| `in:notebook` (also `in:kb`) | Only the notebook |
| `in:docs` | Only the documents attached to meetings, such as an agenda |
| `in:screen` | Indexed moments from video frames, when screen search is enabled |
| `status:on_hold` | Board items by where they stand now: `open`, `on_hold`, `done` or `canceled`. Only items and what the board says about them |
| `owner:ada` | Board items that are Ada's |
| `after:2026-10-15` (also `since:`) | Meetings on or after the date |
| `before:2026-11-01` (also `until:`) | Meetings on or before the date |
| `on:2026-10-27` | Meetings on the date |
| `meeting:launch` | One meeting, by its id or part of it |
| `kind:demo` | Only entries of that sort, such as demos or trainings. `kind:meeting` finds the entries with no other kind. Write a space in a kind as a hyphen (`kind:site-visit`). Several kinds mean any of them |
| `-kind:demo` | Everything except entries of that sort |

Filters work alone: `person:ada after:2026-10-15` lists the meetings Ada joined since then, and `status:on_hold owner:ada` lists Ada's parked items. A filter that can't mean anything, such as `after:soon`, `status:maybe` or a kind no entry has (`kind:webinar`), matches nothing, and the answer names it.

A filter's value comes straight after the colon. In a sentence such as "Owner: Grace" or "what did we agree on: the pilot scope", a word with a colon is a word like any other. A filter with nothing after it at the very end of the box, as in `pilot owner:`, is one still being typed: it matches nothing until it has a value.

## Meaning search

Keyword search finds the words. Meaning search finds passages about the same thing even when they share no words. While someone is typing, the search page lists keyword hits by meeting. A settled search (Enter, a filter, or a pause) shows one ranked list instead: keyword hits and passages close in meaning fused by reciprocal rank, with the reranker's vote when it runs, the way the agents' tools rank. A row found by its words says **exact** when the list also holds rows found by meaning, and a row the meaning index agrees with says so. **By meeting** groups the same results, including matches found by meaning alone. The palette, which searches on every keystroke, stays with keywords. Both indexes apply the same filters. The embedding model receives the search terms with the filter syntax removed.

**Follow it across the meetings** (`/follow?q=…`) lays one topic, person or decision out oldest first: the moments each meeting gave it, the board items it touched as they stand now, and the notebook entries about it. Every meeting with a moment about it is there, however often other meetings mention it, with its count of moments and its five strongest.

With a local chat model installed (`ops/install.sh ask MODEL.gguf`), **Ask** next to the search box answers a question in a few sentences from the same ranked passages. The model is asked to cite each claim and to say when the passages do not answer the question. Numbered citations link to a board item, note, attached document or transcript moment. The UI distinguishes a cited answer, an uncited answer, unknown citation IDs and an interrupted stream. Citation status checks the references against the supplied sources. Answer generation runs on the Mac. Explicit screen searches can find frames first, with the local picture model or, in hosted mode, Gemini, and the local model answers from their OCR. [Screen search setup](screen-search.md)

It runs on the same Mac, through llama.cpp:

```bash
ops/install.sh embed ~/models/embeddings/Qwen3-Embedding-8B-Q8_0.gguf    # 127.0.0.1:8799
ops/install.sh rerank ~/models/embeddings/Qwen3-Reranker-4B.Q8_0.gguf    # 127.0.0.1:8800, optional
```

Each command runs `llama-server` under launchd with a random API key (`data/*.key`, owner-only) and adds its URL and key to `.env`. Nothing is sent to a hosted model.

- **What gets embedded.** Notes, transcripts, attached documents, the notebook, and what the board says about each item. A transcript is cut into passages of up to 150 words or 90 seconds that close where the speaker changes, and each opens with the end of the last speaker's turn, so a thought cut in two is whole in one of them. The speakers' names are in the text that is embedded. An exclusion or a quoted phrase reads only what was said, so `-ada` leaves out a passage that mentions Ada, not every passage she spoke in.
- **Embedded once.** Vectors are keyed by a hash of their content in `data/vectors/`, so only new or changed passages cost anything, and the old vector of a passage that changed or went doesn't stay in memory. Installing another model with `ops/install.sh embed` names it in `EMBED_MODEL`, and once the server restarts the index is rebuilt for it in the background.
- **If the model is down**, keyword search carries on alone. The **Lab** page shows the model and how far the index has got.
- **A passage the model refuses**, such as one too long for it, stays out of meaning search until it changes, and everything else is embedded around it. The **Lab** page counts such passages, and the server log says where each one is.
- **The reranker** reads the question together with each of the 20 strongest passages, and its order counts as one more vote in the ranking. It takes about 3 seconds per question, so it votes on a settled search, on the passages **Ask** answers from and in the agents' `gather_context` and `find_connections`, never while typing. It unloads itself after 10 idle minutes.

## How the models and passages were picked

`scripts/eval-embeddings.ts` is a bake-off on the archive's own meetings. The reviewed notes say where each topic and action item was discussed, so each one's title should find those transcript passages. On 2026-11-10 it asked 176 such questions:

| Approach | Right passage first |
| :-- | :-- |
| Qwen3-Embedding-8B and keywords, top 20 reranked by Qwen3-Reranker-4B | 67% |
| Qwen3-Embedding-8B and keywords | 65% |
| Qwen3-Embedding-8B | 61% |
| Keyword search | 45% |

With the earlier fixed windows the same stages scored 64%, 58% and 61%. Speaker turns without the overlap scored lower (57% by meaning), and so did the meeting's title and date in front of each passage (49%), so neither is used. The first bake-off also tried EmbeddingGemma 2 (39%) and bge-small (38%).

What the bake-off measures is how transcripts are cut into passages and which models embed and rerank them. It searches transcript passages only, and it ranks them its own way, not the server's:

- It asks Qwen3-Embedding-8B with its own instruction (a topic or action item from a meeting's notes), not the one the server puts in front of every search.
- Its keyword side is the index's `related()` over transcript lines, where a settled search runs `search()`.
- It fuses the two lists by reciprocal rank over their top 100, with no 0.42 cutoff and without merging a passage into the transcript lines it covers.
- Its reranker reorders the top 20 by score, where the server adds the reranker's order as one more vote.

So the numbers are a gate for the passages and the models: a new way of cutting transcripts, or another embedding or reranking model, that scores lower doesn't ship. A change to the query instruction, the fusion, the cutoff or the reranker's vote doesn't move them, so the bake-off can't approve or block it. Re-run the bake-off as the archive grows, with `--passages` to compare the cuts again:

```bash
node --env-file-if-exists=.env scripts/eval-embeddings.ts models.json --passages --rerank-url http://127.0.0.1:8800 --rerank-key data/rerank.key
```

## The API

`GET /api/search?q=…&limit=…` answers `{ query, total, hits, meetings, terms, fuzzy, loose, unknownPeople, ambiguousPeople, badFilters, related }`. `fuzzy` lists the words a typo was matched to, `loose` is true when the search fell back to any of the words, `unknownPeople` lists names in `person:` that nobody has, `ambiguousPeople` the names that fit several people with the id that names each (`person:ada-byron`), `badFilters` the filters that can't mean anything, and `related` holds the passages close in meaning. `&typing=0` marks a finished query: prefix matching is switched off, `related` is filled in, and `fused` holds the one ranked list with `reranked` saying whether the reranker voted (`&rerank=0` skips it).

`GET /api/follow?q=…` follows a topic across the meetings, oldest first: `{ meetings, items, notebook }`, each meeting with its strongest moments. `POST /api/ask { question }` streams newline-separated JSON: the numbered sources, then the answer as it is written, then one terminal event. A completed answer sends `{ done: true, cited, grounding }`, where `grounding` is `cited`, `uncited`, `invalid` or `no-sources`. An interrupted answer sends `{ error }` while the client remains connected. A request with no eligible sources returns a local message without calling the model. When the question holds a filter that can't mean anything, a name nobody has or a name several people share, the message names it, since nothing was searched. The endpoint answers 503 until a local chat model is set up.

## Limits

- The reranker takes about 3 seconds, so it votes on a settled search, never while typing.
- Transcripts are automatic and can mishear a name or a number, which is why typo tolerance and meaning search exist. Notes a person wrote or checked are the reliable layer.
