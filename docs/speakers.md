# Who is speaking

Every transcript line names its speaker. A background job on the Mac (`scripts/diarize.py`) works out who is talking in each recording. It runs at low priority, one recording at a time, and takes about 4 minutes per hour of audio. Nothing about anyone's voice leaves the Mac.

## How it works

1. **Voices.** [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) splits the audio into turns with the pyannote segmentation model and tells voices apart with NeMo TitaNet voiceprints. sherpa-onnx's own grouping splits each person into many fragments, so fragments are merged by their averaged voiceprint. On the archive's own meetings the same person scores 0.9 or more against themselves, and different people about 0.1.
2. **Lines.** Each transcript line goes to the voice heard most while it was spoken, unless the line's own voice clearly belongs to someone else (a quick "exactly" in the middle of another person's turn).
3. **Names.** Google Meet outlines the tile of whoever is talking in light blue. For each voice, a few moments when it talks alone are looked at, the highlighted tile is found, and its name label is read with macOS Vision (`scripts/read-text.swift`). A name needs at least two reads and most of the votes. "Ada Lovelace" shows as "Ada" when the people list knows her. So does a tile whose first word is her first name or nickname and whose rest fits the rest of her name: the same once anything in brackets and trailing punctuation are dropped ("Ada Lovelace (Presenting)"), an initial or the start of it ("Ada L."), or misread by a letter ("Ada Lovelase"; two letters in a name of eight or more, none in one of two). With a middle name on one side, the last names decide. A guest goes by first name ("Wren Ashby" as "Wren"), but keeps the whole name when that first name belongs to a known person the rest doesn't fit, or starts another name read on the same call, so a guest "Grace Kim" doesn't read as the Grace the archive knows. A guest whose last name is that close to a known person's with the same first name is taken for that person. People sharing a microphone share a tile, so when one tile is read for two voices, the name goes to the voice that sounds like that person in other meetings, and a tile name is dropped when the voice clearly belongs to someone else.
4. **Everywhere else.** A voice named in one meeting, off the screen or by a person, is recognised by its voiceprint in the others and shown as a guess, "Ada?", until someone confirms it. Anything left is "Speaker N".

## Naming a voice by hand

Click a name in the transcript tab to name or rename a voice. **Hear them** plays that voice's lines. A name given by a person always wins over one read off the screen, and everyone signed in sees the change live. A trailing question mark is dropped, since that is how a guess is shown, and a name that is empty without it is refused.

The name stays with the voice when the job runs again because the recording was renamed, moved, copied back or re-encoded, a lighter copy took over, or the transcript was redone under the same file name. Each name keeps the transcript it was given in, and goes to the voice in the new run whose voiceprint matches it; the newest name wins. **Forget name** goes back to the automatic name. A name saved before names kept their transcript is given it once the server finds it under its recording's current key, at the first start, in one save of the names file that changes nothing else; a file edited by hand gets it with the next change instead. A name whose recording changed before that only helps guess, as names from other meetings do.

## Where the names go

Agents get the names in `get_transcript`. Captions, search passages and agent briefs carry them too. Over MCP a guessed name keeps its question mark ("Ada?") and an unnamed voice stays "Speaker N", so an agent can tell a guess from a confirmed name.

Voiceprints and names stay in `data/speakers/`, readable by the owner only. The app and agents see names, never voiceprints. If the names file can't be read, the archive starts without the names and refuses changes to them until the file is fixed and the server restarted, so it is never written over. A saved entry that fails validation is left out and the rest load. The [recovery runbook](recovery.md) has the details.

## Transcripts that arrive with speaker labels

A transcript that comes with the meeting platform's own speaker labels (a caption export's "Speaker 3") keeps them. Each label is named the same way, from the highlighted tiles in the meeting's video, placed on the transcript's clock by the meeting's sync: the one confirmed on the page, or else the one suggested from the recording's file name. That works even when the video has no sound, and it runs again when the sync changes.

## Setup (once)

The job needs a Python 3.9 or newer virtual environment with sherpa-onnx and numpy, plus the two models, under `~/models/diarization`. To keep them elsewhere, point `DIARIZE_PYTHON`, `DIARIZE_SEGMENTATION` and `DIARIZE_EMBEDDING` at them. Reading names needs Xcode's `swift`. Without it voices are still told apart and can be named by hand.

```bash
python3 -m venv ~/models/diarization/venv && ~/models/diarization/venv/bin/pip install sherpa-onnx numpy
mkdir -p ~/models/diarization/segmentation ~/models/diarization/embedding
curl -L https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2 | tar xj -C ~/models/diarization/segmentation
curl -L -o ~/models/diarization/embedding/nemo_en_titanet_large.onnx https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/nemo_en_titanet_large.onnx
```

The release really is spelled "recongition".

Without any of this the archive still works: transcript lines carry no speaker names.
