# Recover the board, notebook, speaker names and meetings folder

The server copies `DATA_DIR/state.json`, `DATA_DIR/notebook.json` and
`DATA_DIR/speakers/names.json` to `DATA_DIR/backups/` and each directory listed in
`BACKUP_DIR`. The speaker file contains voiceprints. Give it the same protection
as the notebook. Caches, logs and connector credentials are not copied. The
meetings folder gets its own copy: see [the copy of the meetings
folder](#the-copy-of-the-meetings-folder). The per-recording voice results in
`DATA_DIR/speakers/` (one `<key>.json` for each recording) are not copied,
though copies the earlier version took hold them: the background job works
them out again from the recordings.

Each destination is checked at startup for a verified copy less than one hour
old. Startup waits only for the copy in `DATA_DIR/backups/`, the one made before
anything is written; the `BACKUP_DIR` folders get theirs in the background. The
server then checks hourly and takes a fresh copy at each destination after one
day. A destination that doesn't answer within ten minutes, such as a network
share whose host is asleep, counts as failed for that run. A failed destination
retries at the next check regardless of its last copy's age. The log records
each verified publication and identifies which destination failed. Confirm a
separate disk is mounted before counting a copy there as protection against
loss of the server's disk.

Each copy's check needs owner-only file modes, so a `BACKUP_DIR` folder must be
on a disk formatted APFS or Mac OS Extended. On exFAT or FAT, the formats many
new external drives come in, file permissions can't be set, and on exFAT every
file reads back as `0700`. Before its first copy, each destination gets a file
written as `0600`, and one that reads it back otherwise is named once in the log
and gets no copies until the server restarts: `backup: no copies go to
/Volumes/Backup/meetings: a file written there as 600 reads back as 700`.
Reformat that disk or choose another folder.

A snapshot lists the files present at capture in `manifest.json`, with byte
counts and SHA-256 checksums. The server verifies the file inventory, checksums
and saved record shapes before publishing. It keeps the three newest verified
copies and the newest for each day in the last seven days. A copy dated more
than a minute after the clock, taken while the clock ran ahead, is kept and
named in the log, but it counts neither as a recent copy nor as one of the three
newest, so the daily copies go on. Copies the earlier version took (named by
time alone, holding only the board, the notebook and `speakers/`) go a week
after they were taken once three verified copies exist in the same folder. Until
then the newest three of them stay whatever their age, as that version always
kept its newest three.

Finder's `.DS_Store` and the AppleDouble `._` files macOS writes beside files
are not part of a copy: the checks leave them out of the folder listings, while
the files in the manifest and their checksums are still checked exactly, so a
copy opened in Finder still verifies and is pruned like any other. Unverified
copies and unrelated directories stay in place. A staging directory named
`.meetings-backup-*` can remain after a crash. Check that the server is stopped
and that the directory is an abandoned staging copy before removing it. A save
killed between writing its temp file and the rename leaves a full private copy
of that file beside it, named like `state.json.tmp-<id>`. When the server
starts, each store removes its own such files that are more than an hour old.

Each captured file comes from one inode, even if the application replaces it
while the backup is running. The three files can represent different moments.
For a coordinated snapshot before a restore or a rollout, stop the server (see
below) and run `npm run backup` from the repository root. It takes a verified
copy at every destination now and prints where each one is. It refuses while the
server answers on its port, since a copy taken while it writes can miss a
change, unless run as `npm run backup -- --while-running`. It checks each file
with the checkout's own readers, so run from a newer checkout it also says
whether that version can start on the live files.

A failed save rejects its request. A change to a board item's state, or to a
speaker name, stays in memory and pending, and a later successful full save
includes it. An identical board or speaker edit retries the pending write and
refreshes other readers after it succeeds. A task added, deleted or restored,
and any change to the notebook, is taken back when its save fails: the error
means it did not happen, no later save writes it, and the same request can be
sent again without saving it twice.

## The copy of the meetings folder

When `BACKUP_DIR` is set, the server also keeps a copy of the meetings folder:
the recordings, transcripts, notes and `meetings-index.json`. It goes in a
folder named `meetings` inside each `BACKUP_DIR` folder, so
`BACKUP_DIR=/Volumes/Backup` puts it in `/Volumes/Backup/meetings/`. Files keep
their place in the folder, two folders deep, as the archive reads them. Names
starting with `.` or `~$` are left out, as the archive leaves them out.

The copy goes one way and only adds. A file is copied when the copy lacks it,
or when its size or modification time differ. Nothing in the copy is ever
removed or renamed, so a file taken out of the meetings folder stays in the
copy. Nothing is ever written to the meetings folder. Each copy keeps the
modification time of its file.

It runs in the background, one file at a time, so neither startup nor any page
waits for it. It runs once after the server starts and again whenever a scan
finds the files changed. A recording still being written waits for a later
pass. A file that fails is named in the log, never what it holds, and tried
again ten minutes later or at the next change. The **Lab** page says how the
last pass went.

Each file is first written beside its final name as `.mirror-<id>.part`, its
size checked, then renamed into place. A pass cut short, by a restart say,
leaves a part behind, and the next pass removes it.

Some folders get no copy, and the log says why:

- A `BACKUP_DIR` folder that isn't there. It is never made, so a disk that
  isn't mounted doesn't fill the startup disk instead.
- A folder that can't be written, or a `meetings` in it that is a link or a
  file.
- A folder whose copy would land in the meetings folder or hold it, as when
  `BACKUP_DIR` is the folder above a meetings folder named `meetings`.

A link inside the copy is never followed: the file it stands for is named in
the log and not copied. The snapshots above need owner-only file modes. This
copy does not, so it also works on exFAT or in a Google Drive folder.

### What is not copied

Secrets are deliberately not copied anywhere, by the snapshots or by this copy:
`.env`, the model keys in the checkout's `data/`, and `data/connector.json`. A
lost `.env` is filled in again from `.env.example` and the services it names.
Lost model keys mean `ops/install.sh` runs again. A lost `connector.json` means
everyone connects their agents again. The caches in `DATA_DIR` are not copied
either: the server makes them again from the meetings folder.

### Restore the meetings folder from the copy

Restore into a new folder first, check it, then swap it in. The copy can hold
files removed from the meetings folder on purpose since. Take those out by hand
after the restore.

1. Stop the service. The server pins the meetings folder when it starts, so it
   must start again after the swap.

   ```sh
   launchctl bootout gui/$(id -u)/ontherecord.server
   ```

2. Copy the copy into a new folder beside the meetings folder. `ditto` keeps
   the modification times. Then remove any part a pass left behind.

   ```sh
   copy='/Volumes/Backup/meetings'
   restored="$HOME/Pictures/Screenshots/meetings-restored"
   ditto "$copy" "$restored"
   find "$restored" -name '.mirror-*.part' -type f -delete
   ```

   A Google Drive folder may hold some files only online. Make it keep them on
   this Mac first (in Finder, Make available offline), or `ditto` waits while
   each one downloads.

3. Check it: the file count and the size should match what you expect, and
   `meetings-index.json` should be there.

   ```sh
   find "$restored" -type f | wc -l
   du -sh "$restored"
   ls -l "$restored/meetings-index.json"
   ```

4. Swap it in, keeping what was there.

   ```sh
   mv "$HOME/Pictures/Screenshots/meetings" "$HOME/Pictures/Screenshots/meetings-before-restore"
   mv "$restored" "$HOME/Pictures/Screenshots/meetings"
   ```

5. Start the service and check the startup log and a meeting or two.

   ```sh
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ontherecord.server.plist
   ```

Use the `MEETINGS_DIR` path from `.env` in place of
`~/Pictures/Screenshots/meetings` if it is set.

## When a live file fails validation

A read error stops startup. Inspect the reported path, owner and permissions
before retrying. Speaker names are the exception, since they can be typed
again: if `speakers/names.json` can't be read, the server starts without them
and says so in its log, and refuses every change to them until the file is
fixed and the server restarted, so the file is never written over.

Bytes that aren't valid JSON (a write cut off) are moved to a unique
`.corrupt-*` path and that store starts empty. The file set aside holds the
original bytes: preserve it separately while deciding which snapshot or records
to recover. If the move fails, startup stops and the store blocks writes.

A board (`state.json`) or notebook (`notebook.json`) that is valid JSON but
fails validation stops startup instead, and the file is left exactly where it
is. Its records are most likely fine and the code doesn't expect them (an older
or newer version), so starting empty would hide the live board. The log names
the record by its id or its place in the list, and the field that doesn't fit,
for example `invalid board action record "a1b2c3d4e5": history[0].at` or
`invalid note [12] "n-0123456789": revisions[2].tags[1]`.

Speaker names keep every entry that passes validation. The log line says how
many entries were left out and names them by key, the file as it was is copied
once to a `.corrupt-*` path, and the names that loaded are written back. A
backup takes a names file only when every entry passes, so a copy due as the
server starts fails once and is taken at the next hourly check. If the copy
aside can't be made, the server starts with the names that loaded and refuses
changes to them until the file is fixed and the server restarted. A names file
that isn't a map of names at all is moved aside like bad bytes, so the archive
stays online and names can be typed again.

The connector's file (`connector.json`) holds the assistants registered on the
connector address and their connections, as hashes of their tokens, and no
snapshot holds it. Bytes that aren't JSON and JSON in an unexpected shape are
both moved to a unique `connector.json.corrupt-*` path beside it, the log names
that path, and the server starts with no assistants and no connections. Each
person then connects their agents again and approves them on the site. Nothing
is restored from the file set aside, so a connection that was ended stays
ended.

For a board or notebook that stops startup, run the matching version, restore
a verified snapshot, or fix the record. To fix a record, work on a copy while
the service is stopped. launchd starts the server again within ten seconds of
`launchctl stop` or `kill`, and a start that reads a file caught half saved, or
with one slip in it, moves it aside as bad bytes and comes up with an empty
board that is then saved over the fix. Run these from the repository root, with
the path the log names in place of `data/state.json`.

1. Stop the service.

   ```sh
   launchctl bootout gui/$(id -u)/ontherecord.server
   ```

2. Copy the file into a new private folder and edit the copy there.

   ```sh
   fix_dir="$(mktemp -d "${TMPDIR:-/tmp}/meetings-fix.XXXXXX")"
   cp -p data/state.json "$fix_dir/state.json"
   ```

3. Check that the copy loads with this version's readers. This prints `fits`,
   or the record and field that still don't, without printing any record.

   ```sh
   node --input-type=module - "$fix_dir/state.json" <<'NODE'
   import { readFile } from 'node:fs/promises'
   import { basename } from 'node:path'
   import { decodeNotes } from './server/notebook.ts'
   import { parseJson } from './server/persistence.ts'
   import { decodeState } from './server/state.ts'

   const [, , file] = process.argv
   const decode = { 'state.json': decodeState, 'notebook.json': decodeNotes }[basename(file)]
   if (!decode) throw new Error('name the copy state.json or notebook.json')
   try {
     decode(parseJson(await readFile(file)))
     console.log(`fits: ${file}`)
   } catch (err) {
     console.error(`doesn't fit: ${err.message}`)
     process.exitCode = 1
   }
   NODE
   ```

4. Move the copy into place, keeping the original in the private folder.

   ```sh
   chmod 600 "$fix_dir/state.json"
   mv data/state.json "$fix_dir/state.json.original"
   mv "$fix_dir/state.json" data/state.json
   ```

5. Start the service and check the startup log.

   ```sh
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ontherecord.server.plist
   ```

## Verify and stage a restore

Run from the repository root with the pinned Node version. Set `snapshot` to a
published snapshot directory. This stages files in a new private directory and
loads them through the same readers as the server. It prints counts without
printing notes or voiceprints, and `Staged at` only when every check passed.

```sh
snapshot='/path/to/a/verified-snapshot'
restore_dir="$(mktemp -d "${TMPDIR:-/tmp}/meetings-restore.XXXXXX")"
node --input-type=module - "$snapshot" "$restore_dir" <<'NODE' && printf 'Staged at %s\n' "$restore_dir"
import { constants } from 'node:fs'
import { chmod, copyFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { verifyBackup } from './server/backup.ts'
import { Notebook } from './server/notebook.ts'
import { Speakers } from './server/speakers.ts'
import { Store } from './server/state.ts'

const [, , snapshot, restoreDir] = process.argv
const files = await verifyBackup(snapshot)
for (const { path } of files) {
  const target = join(restoreDir, path)
  await mkdir(dirname(target), { recursive: true, mode: 0o700 })
  await copyFile(join(snapshot, path), target, constants.COPYFILE_EXCL)
  await chmod(target, 0o600)
}
const store = new Store(join(restoreDir, 'state.json'))
const notebook = new Notebook(join(restoreDir, 'notebook.json'))
const speakers = new Speakers(restoreDir, { python: '', segmentation: '', embedding: '', script: '', readText: '' }, () => {})
await Promise.all([store.load(), notebook.load(), speakers.load()])
console.log({
  files: files.map((file) => file.path),
  actions: Object.keys(store.state.actions).length,
  tasks: store.state.tasks.length,
  deletedTasks: store.state.trash.length,
  notes: notebook.notes.length,
  knownNames: speakers.known().length,
})
NODE
```

Check representative action IDs, aliases, sync offsets, task and note revisions,
deleted items and speaker attributions against the expected state. The automated
drill in `server/backup.test.ts` exercises these checks on synthetic data.

For a live restore, stop the service with `launchctl bootout`. Neither
`launchctl stop` nor `kill` is enough: launchd starts the server again within
ten seconds, it loads the files still in place, and its next save writes them
over the restored ones.

```sh
launchctl bootout gui/$(id -u)/ontherecord.server
```

Keep a separate copy of the current three files and any quarantined originals;
`npm run backup` takes a verified one if they still load. Copy only the staged
files selected for recovery back under their original names, as the service
owner, with files at mode `0600` and the speaker directory at `0700`. If the
chosen snapshot omits a file, decide separately whether to keep the
corresponding live file or move it aside. Start the service, then check the
startup log and representative records before resuming writes.

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ontherecord.server.plist
```

## Stage a copy in the earlier format

A copy the earlier version took, such as `data/backups/2026-11-10T053012Z`, is
named by time alone and has no `manifest.json`, so `verifyBackup` refuses it.
Stage it the same way without the manifest check. This reads each of the
board, the notebook and the speaker names that the copy holds, checks it with
this version's readers, writes it to a new private directory and loads it the
way the server does. It names a file that doesn't fit, and prints `Staged at`
only when every check passed.

```sh
snapshot='/path/to/an/earlier-format-copy'
restore_dir="$(mktemp -d "${TMPDIR:-/tmp}/meetings-restore.XXXXXX")"
node --input-type=module - "$snapshot" "$restore_dir" <<'NODE' && printf 'Staged at %s\n' "$restore_dir"
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { decodeNotes, Notebook } from './server/notebook.ts'
import { parseJson, readRegularFile } from './server/persistence.ts'
import { decodeSavedNames, Speakers } from './server/speakers.ts'
import { decodeState, Store } from './server/state.ts'

const [, , snapshot, restoreDir] = process.argv
const files = []
for (const [path, decode] of [['state.json', decodeState], ['notebook.json', decodeNotes], ['speakers/names.json', decodeSavedNames]]) {
  const bytes = await readRegularFile(join(snapshot, path))
  if (!bytes) continue
  try {
    decode(parseJson(bytes))
  } catch (err) {
    throw new Error(`${path} doesn't fit: ${err.message}`)
  }
  const target = join(restoreDir, path)
  await mkdir(dirname(target), { recursive: true, mode: 0o700 })
  await writeFile(target, bytes, { mode: 0o600, flag: 'wx' })
  files.push(path)
}
if (!files.length) throw new Error(`${snapshot} holds no board, notebook or speaker names`)
const store = new Store(join(restoreDir, 'state.json'))
const notebook = new Notebook(join(restoreDir, 'notebook.json'))
const speakers = new Speakers(restoreDir, { python: '', segmentation: '', embedding: '', script: '', readText: '' }, () => {})
await Promise.all([store.load(), notebook.load(), speakers.load()])
console.log({
  files,
  actions: Object.keys(store.state.actions).length,
  tasks: store.state.tasks.length,
  deletedTasks: store.state.trash.length,
  notes: notebook.notes.length,
  knownNames: speakers.known().length,
})
NODE
```

Check the staged state as above, then put the files in place as for a live
restore. The copy's per-recording voice results (`speakers/<key>.json`) need no
restoring: once the server is running, the background job works them out again
from the recordings, and the restored names attach to them. Check that a
transcript or two shows the expected names once it has finished.
