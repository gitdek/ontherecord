# Search what was on screen

**On screen** in Search and `in:screen` find frames in indexed recordings. A hit
opens the exact video at the frame's playback time. Use `in:screen in:notes` to
include the notes in the same search. The text index and the picture index
rank separately and the app combines their ranks.

Agents have three ways in. `search` with `in:screen` finds a moment: a match
is a result with its meeting, its time, when the screen it belongs to came up
and went, and the part of the screen that holds the words. `get_screens` reads a recording's screens in order, optionally
between two times, so an agent can follow a demo or a form step by step and
count what was shown. `include_screen: true` on `gather_context` adds screen
citations to a brief, which labels text read from frames as OCR. A hit without
OCR links to the recording for inspection. Ask uses the detected text as
evidence.

## Two ways to match pictures

The feature starts disabled. Once both archive owners agree, `SCREEN_SEARCH` in
the server's private `.env` turns it on in one of two modes. In both, FFmpeg
picks the frames and macOS Vision reads their text on the Mac. The modes differ
in which model compares a frame's picture with a search, and so in what leaves
the Mac.

| | Local · `SCREEN_SEARCH=local` | Hosted · `SCREEN_SEARCH=1` or `gemini` |
| :-- | :-- | :-- |
| Picture model | Qwen3-VL-Embedding-2B under llama-server on this Mac, at `SCREENS_URL` | Gemini Embedding 2 through OpenRouter, with `OPENROUTER_API_KEY` |
| What leaves the Mac | Nothing | Picked frames, up to 96 JPEGs a recording, and the words of explicit screen searches |
| Indexing flag | `--index` | `--send-to-gemini` |
| Frames a recording gives | Up to 960: it is looked at every 2 seconds, and a look is kept when the screen reads differently, after a cut, or after 10 seconds | Up to 96: the first of each cut, and one at least every 30 seconds |
| Index | `DATA_DIR/screens/local/`, 1,024 numbers a frame | `DATA_DIR/screens/`, 768 numbers a frame |
| Threshold above a frame's baseline | 0.18 | 0.06 |

Any other value leaves screen search off. Each mode keeps its own index, because
a frame's numbers only compare with numbers from the same model and the same
input recipe: switching modes loses nothing, and neither mode reads the other's.
A recording indexed in one mode is indexed again before its pictures match in
the other. Both `npm start` and `npm run dev` use the setting from `.env`.
[OpenRouter model](https://openrouter.ai/google/gemini-embedding-2)

## Set up the local model

1. Put the model's two GGUF files on the Mac: the f16 weights and the vision
   file that goes with them (`mmproj`), for example in
   `~/models/embeddings/qwen3-vl-embedding-2b/`.
2. Render the service for review. Nothing is installed or started:

   ```sh
   M=~/models/embeddings/qwen3-vl-embedding-2b
   ops/install.sh --dry-run "$(mktemp -d)/screens" screens "$M/Qwen3-VL-Embedding-2B-f16.gguf" "$M/mmproj-Qwen3-VL-Embedding-2B-f16.gguf"
   ```

3. Install it. launchd runs llama-server on `127.0.0.1:8802` with a random key
   in `data/screens.key`, and the installer adds `SCREENS_URL`, `SCREENS_KEY`
   and `SCREENS_MODEL` to `.env`:

   ```sh
   ops/install.sh screens "$M/Qwen3-VL-Embedding-2B-f16.gguf" "$M/mmproj-Qwen3-VL-Embedding-2B-f16.gguf"
   ```

4. Set `SCREEN_SEARCH=local` in `.env` and restart the server.
5. Preview a recording, then index it on the Mac (below).

The service loads the model with its vision file (`--mmproj`) and last-token
pooling (`--pooling last`, which the model needs). It listens on loopback only
and asks for its key on every request, `/props` included. It has two slots of
8,192 tokens: a 1280×720 frame takes about 940, and the longest search the app
sends (2,000 characters) at most about 6,000. Two requests at once, such as a
search during indexing, run side by side. Loaded, it holds about 6.5 GB of
memory. After 10 idle minutes it unloads, and the next request loads it again
in a second or two.

`SCREENS_URL` has to be an address on this Mac: `127.0.0.1`, `localhost` or
`[::1]`. Anything else counts as not configured. `SCREENS_MODEL` names the model
file the server runs, as the installer writes it, and the index is kept under
that name: if the server runs another file, picture matching stops until the two
agree. Each install sets `SCREENS_KEY` and `SCREENS_MODEL` to the service's key
and the name of the model file it runs, and `SCREENS_URL` when it is empty, so
after installing another model file, restart the server and index the recordings
again. Local mode never contacts OpenRouter, whatever else is set, and never
falls back to it. When the model server is down
or not configured, matches on the text read off frames remain, as in hosted mode
when OpenRouter is down.

## How the local model is asked

- **The recipe.** The model was trained on chat-formatted inputs, and
  llama-server adds no template to an embedding request, so the app wraps each
  input itself: `<|im_start|>system` and an instruction, then `<|im_start|>user`
  and the picture or the search, then `<|im_start|>assistant`. A frame gets the
  model's own instruction, "Represent the user's input." A search gets "Given a
  search, find the frame of a recorded business meeting (a slide, chart,
  document, app or camera view) that shows what it describes."
- **The picture.** It goes in as base64 beside that prompt, at the server's
  media marker. The server picks the marker at random each time it starts. The
  app reads it from `/props` when first needed, and once more when the server
  can't read a request, which is what a restart looks like. Unloading after idle
  minutes keeps the marker.
- **The search.** A search becomes text inside the wrapper, so the app first
  takes out the media marker and every `<|` and `|>`. A search can neither break
  the request nor rewrite the instruction.
- **The numbers.** The model answers with 2,048 numbers. The app keeps the
  first 1,024 and scales them back to length 1, which the model is trained to
  support. A frame then takes about 21 KB in the index file plus the text read
  off it, so a full local index of 960 frames is 21 to 26 MB.
- **The identity.** An index records `SCREENS_MODEL` and a hash of the wrapper,
  both instructions, the vector size, how frames are picked and how much text
  is kept for one. A change to any of them leaves the old index unused until
  the recording is indexed again.
- **Fidelity.** llama.cpp's picture path is close to the reference
  implementation, not identical with it: 0.967 similarity between the two, by
  the GGUF converter's own measurement.

## Index one recording

Use the meeting ID from its URL or from `list_meetings`. The default command
previews how many frames the index would hold and removes the preview files
afterward. It sends nothing anywhere. In local mode the preview reads the text
off every look, so it takes a few minutes for an hour of video.

```sh
npm run index-screens -- MEETING_ID
```

Then index it in the active mode. Each flag works only in its own mode, so a
frame never leaves the Mac by mistake. Run it for each approved recording.

```sh
npm run index-screens -- MEETING_ID --index             # local: embedded on this Mac
npm run index-screens -- MEETING_ID --send-to-gemini    # hosted: up to 96 JPEGs to Gemini through OpenRouter
```

Both read the default playable copy, and the two modes pick frames differently.

Hosted, where every frame is sent, FFmpeg picks the first frame of each cut of
the picture and one after 30 seconds without a cut, at most 96 a recording. A
recording too long for that spreads its frames evenly.

On the Mac nothing is sent, so the recording is looked at every 2 seconds and
macOS Vision reads every look. A look is kept when:

- **the screen reads differently** from the last kept one: more than a tenth of
  the words on the two screens are on only one of them, and at least three are.
  A letter read wrong, or a name on a camera view read two ways, is the same
  screen. The comparison is with the last kept look, so a page typed into a
  word at a time is kept again once enough of it has changed.
- **the picture cut** since the look before it, whatever it reads.
- **10 seconds have passed** without either, so a picture that changes without
  its words changing is still sampled.

An index holds at most 960 frames. A recording over two hours is looked at less
often than every 2 seconds, and one with more screens than that has the bar
raised, then its kept looks thinned evenly. Without the text reader only the
cuts and the clock keep a look.

Either way a screen that is up for less than a couple of seconds can be missed,
and camera shots are included. The text kept for a frame is its first 6,000
characters: a full page of an app in a browser reads to over 3,000, and the
earlier limit of 1,600 lost the lower half of such a page. Frames are read at
1,280 pixels wide. Reading them at the recording's full size was tried on a
dozen frames and gave more words on some pages and fewer on others. Preview the
count for the meeting before indexing.

## Reading a recording's screens in order

`get_screens` gives an agent what search cannot: every screen of a stretch,
in order. It reads the index back and joins the frames that belong to one
screen: the ones the clock or a cut kept while nothing changed, the ones kept
while an answer was being typed, a list opened over a form and closed again,
and a frame read with a word wrong. That screen is given once, in its fullest
reading, and lasts until the next one comes up. A frame that brings three or
more new words and has lost some of the old ones is the next screen: a page
scrolled on, another step, or a box that opened and pushed the page down as
it was typed into. New words are counted against the reading the screen is
given in, so words typed one at a time add up until they show. So nothing that
was read is dropped, and a 52-minute demo reads back as about 200 screens from
617 frames. Each line is one screen. One that continues a screen given earlier
in the same answer, a page scrolled on or filled in further, gives only what
it added or changed, so a long page scrolled through is its first screen and
then what each further screen brought, not the whole page again:

```text
[12:02–12:08] Taste Quiz 4 of 7 Your Cup Roast Level Light roast Medium roast …
[12:08–12:10] (same page) new: Sweetener Type None Sugar Only Other Syrups
    said: (the transcript lines that began while this screen was up)
[21:12–21:14] (the page at 20:32 again) new: … Order packed … Resend … Next
```

The two readings are lined up word by word, and what lies between the words
they share in the same order is what is new. Lining up by position keeps a new
block whole: a question whose options repeat those of the question above it is
given with its options, where a list of words not seen before would leave them
out. A long word read a letter off is taken as the same word, since the small
print of a full page reads a little differently at every look. Words that are
on at least half the screens given so far, such as the titles of a browser's
tabs, do not count as new on their own. A screen
continues the earlier one it is most like, usually the one before it and
sometimes a page that was left and come back to, when the two share more than
a third of their words in order; a step of a form shares about a quarter with
the step before it and is given whole. `full_text: true` gives every screen
whole, which is the way to read one screen exactly. On the first real recording
this brings nine minutes of full pages from 100,000 characters
to about 33,000, and the whole 52 minutes from 129,000 to 58,000.

Times are on the meeting's clock, the one its notes and `get_transcript` use,
so the two tools line up. With `with_transcript: true` the answer also gives,
under each screen, what was said while it was up, so one call answers both
what a screen offered and what the presenter said they chose. One answer
carries about 24,000 characters, an amount an assistant can take in while
someone waits on a call, and says where to go on from. What was said is given
only for the stretch asked for. When the same words are read off nearly every screen, a
name under a camera view for instance, the answer says so once.

What it cannot give: which option someone chose (a ticked box does not read as
text; the transcript often says it), anything that was up for under a couple
of seconds, and the pictures themselves. A full page scrolled fast reads
badly: its small print comes out garbled, differently each time, and those
misreadings show up as new words. The reader reports full confidence on such
lines, so they cannot be told apart, and its language correction was tried on
twelve frames and changed one word in a hundred.

## Masking what someone typed

A presenter who runs a live product types their own details into it: a phone
number, a birth date, a home address. A recording asks for those to be masked
with one key on its session in `meetings-index.json`:

```json
{ "id": "2026-10-09-product-demo", "kind": "demo", "mask_screens": true }
```

The key can also be a list of words, for what no shape tells: a street, the
name of a shop. Each is masked as `[masked]` wherever it starts a word, to
the end of that word, so the start of a name covers every way it was typed or
read. Words of three to sixty characters are taken, forty at most.

```json
{ "id": "2026-10-09-product-demo", "kind": "demo", "mask_screens": ["Harbour Bak", "Maple Grove"] }
```

Screen search, Ask, briefs and `get_screens` then give the text read off its
frames with typed details replaced by what they were: `[email]`, `[phone]`,
`[date]`, `[address]`, `[card]`, `[number]`. They are told by their shape: an
email address, a phone number, a card number or its last four digits, a date
beside a birth label or in a year before 2010, a street address. The shapes
allow for how a text reader writes them (a date with a full stop in it), for
how a form shows them (the suggestions under an address box, an address cut
short in its field, a phone number with all but its last digits hidden) and
for typing in progress (the first digits beside a phone or birth label, an
email address that has its @ and not yet its ending). Prices, timers, order dates, years on their own, a
calendar's days, counts and web addresses are left alone, and what was masked
cannot be searched for.

The masking is done to what is given out, not to the index, so it takes effect
when the key is saved and needs no indexing again. It goes by shape, so it can
miss a detail written an unusual way, and it does not cover the recording
itself or names. A recording without the key is given as read: a contact
detail on a slide of an ordinary meeting is usually something to find.

The index stores recording IDs, times, OCR and each frame's numbers under
`DATA_DIR/screens/local/` or `DATA_DIR/screens/`. OCR runs through macOS Vision
when available. A failed embedding leaves the previous snapshot intact. A
successful index for the same recording version is reused on another run. The
server reads new snapshots on the next screen query.

The JPEGs wait in a `meetings-screens-` folder in the system's temporary folder,
and a lock beside the index (`<recording id>.lock`) keeps a second run off the
same recording. A run removes both, and a preview its folder, when it finishes,
fails, or is stopped with Ctrl-C, by closing its terminal or with `kill`. A run
killed outright (`kill -9`, a crash) leaves them: the next run sees that the
lock's process is gone and takes the lock over, and the folder stays until it is
removed by hand or by the system's clean-up of old temporary files. A lock that
is held names its process and its file.

## What leaves the Mac

- **Local mode.** Nothing. Frames, their text and searches stay on the Mac, and
  the model server listens on loopback only.
- **Hosted mode.** The picked JPEGs, when a recording is indexed with
  `--send-to-gemini`. The words of a settled `in:screen` query, a Follow or Ask
  request with that filter, or an MCP brief with `include_screen: true`, when
  eligible frames exist. They go to OpenRouter and its Google provider.
- **Never, in either mode.** `find_connections` runs no screen search, so the work
  an agent pastes into it is not sent anywhere.
- **Both.** Filters such as meeting, person and date apply locally. Matches on
  the text read off frames remain when the picture model can't be reached.

## What counts as a match

A frame matches in one of two ways, and the two ranked lists are combined.

- **Its text.** The text read off the frame has to contain at least half of
  the search's words, not counting small words such as "the" or "for".
- **Its picture.** A frame without text, such as a camera view, resembles
  every search a little, so each frame is judged against its own baseline:
  its similarity to eight generic reference searches (`SCREEN_REFERENCE`),
  embedded once per server start the same way as searches. The search has to
  score above that baseline by the mode's threshold: 0.06 with Gemini
  (`SCREEN_MIN_LIFT`), 0.18 with the local model (`LOCAL_SCREEN.minLift`). The
  two models score on different scales.

A search gives one hit for each stretch of a recording. Frames that follow each
other in a recording's index and all match are one stretch, and its best-ranked
frame stands for it. A page that stays up, or is scrolled through, would
otherwise fill the list with itself and push every other moment out.

On seven made-up frames (five slides, two camera views), direct and reworded
questions each found their slide with Gemini, and unrelated or nonsense
searches found nothing. Without the baseline, a nonsense word matched the camera
frames as strongly as a real question matched its slide.

### How the local threshold was set

The local model was measured on 28 made-up 1280×720 frames from a fictional
coffee roaster's meeting: text slides, a revised copy of one and a build of
another, a table, a bar chart, a line chart, a spreadsheet, a code editor, a
terminal, a web page, a boxes-and-arrows diagram, a phone app, blank and
title-only slides, and four camera views. 72 searches went with them: 19 that
share words with their frame, 18 reworded to share none, 16 that say how a frame
looks, 6 on a related topic no frame answers (the cafe's opening hours, say),
8 unrelated and 5 nonsense. Separation is the chance that a search's right frame
lifts higher than the strongest wrong frame of a search.

| Search instruction, 1,024 numbers | Weakest match: direct · reworded | Strongest non-match: related · unrelated or nonsense | Right frame first, of 53 | Separation | At 0.18: found, of 53 · reworded, of 18 · searches without an answer that match, of 19 |
| :-- | :-- | :-- | --: | --: | :-- |
| None, the input unwrapped | 0.17 · 0.04 | 0.18 · 0.11 | 44 | 0.835 | 27 · 6 · 0 |
| "Represent the user's input." | 0.22 · 0.10 | 0.18 · 0.10 | 45 | 0.831 | 30 · 7 · 0 |
| "Retrieve images or text relevant to the user's query." | 0.23 · 0.06 | 0.18 · 0.08 | 43 | 0.833 | 25 · 3 · 1 |
| "Find a screenshot that shows what the user is searching for." | 0.19 · 0.03 | 0.18 · 0.07 | 44 | 0.851 | 23 · 0 · 0 |
| "Find a document image that matches the given query." | 0.21 · 0.01 | 0.17 · 0.08 | 42 | 0.835 | 22 · 0 · 0 |
| "Given a search, find the frame of a recorded business meeting (…)" | 0.21 · 0.08 | 0.17 · 0.10 | 45 | 0.878 | 28 · 6 · 0 |

The meeting instruction separates best, and two other wordings of the same task
came second and third (0.863 and 0.856). With it, the vector sizes compare as
follows:

| Numbers | Separation | Right frame first, of 53 | At 0.18: found, of 53 | Index file for 96 frames |
| --: | --: | --: | --: | :-- |
| 2,048 | 0.885 | 46 | 27 | About 4.2 MB |
| 1,536 | 0.877 | 44 | 29 | About 3.2 MB |
| 1,024 | 0.878 | 45 | 28 | About 2.1 MB |
| 768 | 0.890 | 44 | 29 | Smaller |
| 512 | 0.900 | 48 | 29 | Smaller |

The smaller sizes come out slightly ahead, by less than 72 searches can tell
apart, so the index keeps 1,024 numbers: half the room of the full 2,048, which
counts now that a local index holds up to 480 frames. With them, direct matches came out
0.21 to 0.53 above baseline and reworded ones 0.08 to 0.24. Related topics
reached 0.17 and unrelated or nonsense searches 0.10, so 0.18 keeps every search
without an answer out.

End to end, the same frames were cut into a 3½-minute recording, with camera
views between slides on the same template. FFmpeg picked 29 frames, macOS Vision
read their text, `--index` embedded them on the Mac, and the app answered each
search through `/api/search` with text and picture matches combined. All 19
direct searches found their frame, 18 of them first. 6 of 18 reworded searches
found theirs, and 3 of 16 that say how a frame looks. None of the 19 searches
without an answer returned anything.

This shows the recipe, the threshold and the whole path work on made-up frames.
It does not show how they do on real recordings: compressed video, small text,
real camera views and many more frames per search. A search worded differently
from its slide finds it only about a third of the time, and two pictures that
mostly look alike, such as two slides on one template, can outscore the right
one. The threshold still needs checking against real recordings, with an
evaluation set of questions whose answers are visible on screen.

The first real recording was indexed on 2026-11-12: a 52-minute product demo.
Ten searches for things on its screens were tried: a slide's title, a step of a
form, a page described by how it looks. Nine put a frame from the right minutes
first. The tenth, which described a page by what someone does on it, found the
page but put a slide on the same subject ahead of it. Two searches about
nothing in the recording brought back nothing. That is a spot check, not the
evaluation set: reworded searches and near-miss topics have not been measured
on real frames.

How frames are picked on the Mac was settled on that recording, in three steps:

| Frames picked | Frames | Words on screen the index does not hold | Work on the Mac |
| :-- | --: | --: | --: |
| The hosted way: cuts, and one every 30 seconds, at most 96 | 96 | not measured | not measured |
| Cuts, and one at least every 10 seconds | 318 | 141 of 1,145 (12%) | about 7 minutes |
| A look every 2 seconds, kept when the screen reads differently | 628 | 3 of 1,145 (0.3%) | about 11 minutes |
| The same, with a full page of text kept for a frame | 617 | 3 of 1,182 (0.3%) | about 10 minutes |

The words counted are the ones read off the screen at two looks in a row, two
seconds apart, so a word read wrong once is not counted. With 96 frames a
screen that was up for ten seconds, such as the one asking for a verification
code, was not found at all. With 318, most of what was missing were steps of a
form in a phone app, each up for a few seconds: a search for the words of one
such step found nothing, and now finds its moment. The last row counts against
full pages: with the earlier limit of 1,600 characters a frame, the 628 frames
lacked 30 of those 1,182 words, the lower halves of full pages. The same ten
searches score the same on every row from the second on, and the index file is
14 MB.
[OpenRouter embedding API](https://openrouter.ai/docs/api_reference/embeddings)
