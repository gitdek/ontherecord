# How it finds meetings

The server watches `MEETINGS_DIR` and rebuilds within a second or two when anything changes (and every minute regardless). Open browsers update live.

The server reads that folder, and writes to it in two cases only. It adds a transcript beside a recording that has none, when `TRANSCRIBE_PYTHON` is set ([Transcripts](transcripts.md)). And notes an agent saves with `save_notes` land beside the recording of a meeting that has none, or replace its notes file when the agent saves over the version it read; every version replaced is kept in `data/notes-history/` ([Writing a meeting's notes](agents.md#writing-a-meetings-notes)). New files go in only under names that are free, and a file a person put in the folder is never removed. What people and agents add later (the board, the notebook, speaker names) and every cache live in `data/`, so the archive can be rebuilt from the folder at any time.

## Which files belong together

1. `meetings-index.json`, if present, decides which notes, videos and transcripts belong together, the meeting ids and titles, and which transcript is timed against which video. Any other file a meeting's entry names (subtitles, a verification report) stays with that meeting, and a text document it names, such as an agenda, is one of the meeting's documents and is searched with it. A copy trimmed at the start (`source_offset_seconds` on its `video_transcripts` entry) is placed on the full recording's clock, the one the notes use, so the player, transcript, notes, search and agents all show the same times.
2. Anything the index doesn't mention yet is grouped by its name and contents: notes and transcripts name their source video (`Source video:` / `Source recording:` lines), compressed copies share a base name with the original, and `- notes` / `- transcript` files with the same stem belong together. When the recording a transcript names is gone, deleted once a lighter copy was made or renamed, a copy of the same recording left in the folder stands in for it, unless that copy is trimmed. Any other text file, such as an agenda, goes with the meeting of the same date when there is exactly one, and its text is searched with that meeting's. Its date is the one in its name, or else the day it was saved, on this Mac's calendar. A name is only a hint about what a file is. A file called notes that doesn't open with `MEETING NOTES` is someone's own notes, and an agenda or a pasted chat with times in brackets has no timed line in it: each is a document of its meeting, never a meeting of its own, and its bullets never reach the board. Subtitles or a transcript JSON with nothing in them are left out and listed under **Loose files**.
3. Files are found by their path in the meetings folder, subfolders included. A bare name, in the index or on a `Source video:` line, stands for a file only while no other file in the folder tree has that name. When two files share one (`notes.txt` in two subfolders, say), a bare name means the one beside the file that names it, and files with such names are grouped only with files in their own folder.
4. Videos still being written (compression in progress) are left alone until they stop changing, then probed and thumbnailed in the background (`ffprobe`/`ffmpeg` from Homebrew). A file whose modification time is ahead of this Mac's clock, such as one unzipped from an archive made in a zone further east, counts as finished.

A meeting the index doesn't list yet is named by its date and the best title its files give so far: a recording's file name, then its transcript's title, then the notes' title. A file name's title is the name without its date (written `2026-10-02`, `2026_10_02` or `2026.10.02`, with the time and zone an exported recording carries after it), without the words of a lighter copy such as `compressed`, and without the role it ends in, such as `- notes`, `- transcript` or `Recording 1`. So `Acme_Product_Demo_2026_04_09_10_30_CDT_Recording_1.mp4` is "Acme Product Demo" on 9 April 2026. A file with no date anywhere is dated by the day it was saved, on this Mac's calendar. Its id changes as those arrive and again when the index lists it, but it keeps answering to the ids its files gave it on the way, so a shared link, a notebook link or a clock sync saved under one of them still finds it. That includes the ids names gave before November 2026, when a title kept the separators around its date. A meeting's own id always wins over another meeting's old one, and an old id that two meetings could both claim opens neither.

## What sort of recording it is

Most entries are meetings. An entry can also be a product demo, a training, a walkthrough or another sort of recording, and its kind says which. The kind comes from the first of these that gives one:

1. A `"kind"` key on the entry's session in `meetings-index.json`, such as `"kind": "demo"`.
2. A `Kind: Demo` line among the header lines of the notes, the ones before the first ALL-CAPS section. That line is not shown as part of the notes.
3. Otherwise it is a meeting. The kind is never guessed from a title or a file name.

A kind is a free label, not a fixed list: `demo`, `training` and `site visit` all work. It is kept in lowercase, with letters, digits, hyphens and single spaces only, and at most 24 characters. A value with nothing usable left in it counts as not given. An entry that is not a meeting shows its kind as a small label on its shelf card, on its page and beside its title in search results. Search finds entries by it with `kind:` (see [Search](search.md)), and agents get it from `list_meetings` and `get_meeting`.

An entry's session in `meetings-index.json` can also carry `"mask_screens": true`, or a list of words to mask as well, for a recording in which someone types their own details into a form on screen. The text read off its frames is then given with those masked ([`docs/screen-search.md`](screen-search.md)).

Run `npm run check` to see how the current folder is grouped without starting the server.

A file the library can't read or parse is skipped and named under **Cautions** on the **Lab** page, by its name only. It never stops the scan. When that file is `meetings-index.json`, the caution says so: meetings are grouped by name until it is fixed, and in the meantime they answer to the ids their files give them. One session of the index that can't be read, such as one nested too deep, is skipped with a caution that says which, and the rest of the index still counts. Files that sit in the folder without belonging to any meeting are listed on the Lab page too, under **Loose files**.

## Names people go by

People come from the participants line of each notes file. Someone written as William in one meeting and Bill in another is one person: the archive knows a few common short forms (William and Bill, Michael and Mike, Joseph and Joe), so `person:bill` finds both meetings.

An archive adds its own under `"nicknames"` at the top of `meetings-index.json`, beside `"sessions"`:

```json
"nicknames": { "sonja": ["sonia"], "elisabeth": ["liz", "beth"] }
```

Each key is a first name, and its list holds the other ways that name is written or said: a short form, or another spelling a transcript keeps producing. Someone whose first name is the key then answers to every name in the list, in search (`person:sonia`), on the board and for agents. Two entries with the same last name, one under the key and one under a name in its list, are one person. Names are single words of letters, in any case, and anything else in the list is left out. A nickname is matched wherever it stands as a word in running text, so one that is also an ordinary word ("will", "rob") would count as a mention every time it is used.

## Formats understood

| Kind | Shape |
| :-- | :-- |
| Notes (`.txt`) | A `MEETING NOTES:` title, an optional `Kind:` line, ALL-CAPS sections, numbered topics with `(mm:ss–mm:ss)` ranges, `- Owner: task` action items |
| Whisper JSON | `{"segments":[{"start","end","text"}]}`, timed as offsets into the recording |
| Bracketed transcript | `[hh:mm:ss - hh:mm:ss] text`, timed as offsets into the recording |
| Speaker-labelled transcript | `hh:mm:ss --> hh:mm:ss` blocks with the platform's speaker labels, on a wall clock |

A transcript that runs on a wall clock has to be lined up with its video once. The meeting page suggests where the video starts on that clock (worked out from the recording's file name), **Line them up** accepts it, the nudge buttons move it by 1 or 10 seconds if the screen and the words drift, and the confirmed value is shared between both people and remembered. It is kept under the meeting's id; after the id changes it is found under the old one, and the next sync saved is kept under the new one.

## The tape lab

The **Lab** page answers "how heavy is each tape?". Streaming goes from the Mac through the tunnel, so lighter files start faster and seek more smoothly. The page shows how much video the folder holds, which copy of each meeting the player picks, the `ffmpeg` line that makes any recording match the lightest encode in the folder, and a remux line for files whose index sits at the end. It also says whether `ffmpeg` is installed, how far the meaning index has got, and whether the Mac writes transcripts for recordings that have none, with how many wait or failed, and lists the cautions: those `meetings-index.json` carries, and any file that can't be read.

The player picks the lightest copy that covers the whole recording, unless the index names a browsing copy first. A copy with a picture comes before one with sound only, such as the audio a transcription step kept. A copy `ffprobe` can't read, such as one whose compression was stopped halfway, is never played, and the Lab says so instead of showing it as still being probed. The server tries such a copy again each time it starts.
