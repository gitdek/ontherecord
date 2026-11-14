# Transcripts written on the Mac

A recording that arrives without a transcript gets one. A background job on the Mac takes the sound out with FFmpeg, hears it with [MLX Whisper](https://github.com/ml-explore/mlx-examples/tree/main/whisper), and places the transcript beside the recording, where the archive finds it like any transcript someone put there. Speaker detection, search, captions and agents then use it as they use every other. It is off until `TRANSCRIBE_PYTHON` is set, and nothing about it leaves the Mac.

## What is written, and where

Two files, beside the recording, named after it:

| File | What it holds |
| :-- | :-- |
| `<recording> - transcript.txt` | A short header (`MACHINE TRANSCRIPT:` and the meeting's title, `Source video:` or, for a sound file, `Source recording:` with the recording's name, `Duration:`, and the line `Written on this Mac by On the Record with <model>. Words can be misheard.`), then one line per stretch of speech: `[00:01:24 - 00:01:29] We still need a head barista for Riverside.` |
| `<recording> - transcript.json` | The same lines with times to the millisecond, the language heard, the model, and how sure the model was of each line, which the archive uses to dim the silence Whisper sometimes fills with "Thank you." |

A recording whose own name would make those names read as something else, such as `Release notes walkthrough.mp4` (a file called notes is notes), gets `Transcript <its id> - transcript.txt` and `.json` instead. The text file names the recording either way, so the two still go together. The meeting keeps its id and its title.

The server never writes over a file, and never changes or removes one. Both files are written whole under hidden names first, which the scan skips, and then given their real names with a hard link, which fails where a name is taken. They go in together or not at all: if either name is taken, before or while they go in, neither is left. On a disk without hard links, such as one formatted exFAT, each file is created straight under its name, again only where that name is free.

## Which recordings get one

A meeting gets a transcript when it has none, `meetings-index.json` does not list it, and its recording has sound, runs 5 seconds or more, has finished being written and has been read by ffprobe. The job hears the copy the player plays, or, when that copy has no sound, the lightest copy of the same length that has. The transcript is timed against the copy the player plays.

A meeting the index lists is left as it is: the index says which files are its, so a transcript for it goes into the index by hand.

Jobs run one at a time, newest recording first, at low priority. On an M-series Mac the turbo model writes about a tenth of a recording's length or faster: a made-up meeting of 2 minutes 19 seconds took 10 seconds on 2026-11-13, loading the model included.

## Settings

| Variable | Purpose |
| :-- | :-- |
| `TRANSCRIBE_PYTHON` | A Python that has `mlx_whisper`. Empty, the default, turns the job off |
| `TRANSCRIBE_MODEL` | A folder that holds an MLX Whisper model, or the name of one already in the Hugging Face cache. Default `mlx-community/whisper-large-v3-turbo` |
| `TRANSCRIBE_LANGUAGE` | The language spoken, as a code such as `en` or `de`. Empty lets the model tell from the first 30 seconds |

The server never downloads a model. It starts the job with `HF_HUB_OFFLINE=1`, and a model that is not on the Mac leaves the job off, with the reason on the **Lab** page. The model is fetched once, by hand:

```bash
python3 -m venv ~/models/whisper/venv && ~/models/whisper/venv/bin/pip install mlx-whisper      # Apple silicon only
~/models/whisper/venv/bin/python -c "import huggingface_hub as h; h.snapshot_download('mlx-community/whisper-large-v3-turbo')"   # about 1.6 GB, once
```

Then `TRANSCRIBE_PYTHON=/Users/you/models/whisper/venv/bin/python` in `.env`, and a restart.

## Where a transcript stands

The meeting's **Files** tab says when one is waiting its turn, being written, or failed and why. The **Lab** page says in one line whether the job is on, which model it uses, and how many recordings wait or failed. An agent that asks `get_transcript` for such a meeting hears the same: one is being written and when to call again, or why writing it failed.

## What leaves the Mac

Nothing, from the job. FFmpeg reads the recording as a plain local file, handed to it already open, and writes the sound to `DATA_DIR/transcribe/`, which is removed when the job ends. The speech model runs on the Mac with no network: the job gets only `PATH`, `HOME`, `TMPDIR`, `LANG` and, when they are set, `HF_HOME` and `HF_HUB_CACHE` to find the model, and none of the server's other settings or keys. The transcript it places is a file in the folder like any other, so a copy of the folder made with `BACKUP_DIR` takes it along, wherever that copy is kept.

## Limits

- **Words can be misheard.** Names, numbers and brand words most of all: in the trial, one word in 340 came out as a brand name that sounds like it. The transcript says so in its header, and agents are told it is a machine transcript.
- **A failed job waits for a restart.** It is tried again when the server starts, or at once when the recording changes. A job stopped because a transcript turned up meanwhile, from anyone, is not a failure: theirs is the one kept.
- **A taken name stops it.** A file already under one of the transcript's names, such as an empty JSON file, fails the job before anything is heard, and the **Files** tab names the file.
- **Speakers come after.** The transcript carries no names when it lands. Speaker detection then runs on it like any other ([`docs/speakers.md`](speakers.md)).
- **A server stopped mid-write** can leave a hidden `.<id>.writing` file beside the recording. The scan skips it, and it can be deleted.
