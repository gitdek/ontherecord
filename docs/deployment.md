# Deployment and rollback

## Runtime and checks

CI reads the Node version from `.node-version`. For a matching local run, select that version in your version manager and verify `node --version` before installing dependencies. The following commands use nvm.

```sh
nvm install "$(cat .node-version)"
nvm use "$(cat .node-version)"
node --version
npm ci
npm test
npm run typecheck
```

Run the launchd installer fixtures on macOS, using the same Node pin. They use temporary checkouts, homes and output directories, plus the system `plutil`.

```sh
node --test 'ops/**/*.test.mjs'
```

The Linux CI job also runs the full-history gitleaks check. For a staged-change check in a local clone with gitleaks installed, use `git config core.hooksPath .githooks`.

## Render an install for review

Use an output directory that does not yet exist. Dry-run lints the rendered files and checks their launchd labels and argument format. The executable binaries are required only for installation. It does not load services, read `.env`, create model keys, check model files or look up a tunnel.

```sh
scratch=$(mktemp -d)
ops/install.sh --dry-run "$scratch/server" server
ops/install.sh --dry-run "$scratch/web" all 01234567-0123-0123-0123-0123456789ab
ops/install.sh --dry-run "$scratch/ask" ask '/example/local models/Chat & Notes.gguf'
ops/install.sh --dry-run "$scratch/screens" screens '/example/local models/Pictures.gguf' '/example/local models/Pictures vision.gguf'
plutil -p "$scratch/ask/ontherecord.ask.plist"
```

The UUID in the example is for rendering only. For dry-run of `tunnel` or `all`, supply the intended tunnel UUID to see its resolved credentials path. `all` selects the server and tunnel. Run `embed`, `rerank`, `ask` and `screens` individually; `screens` takes the model and its vision file (mmproj).

The server plist records the executable selected as `node` when the installer runs. Use a persistent version-manager installation on the deployment Mac. The installer can render a checkout path containing a literal backslash. Node's ESM loader rejects such a path for the TypeScript server, so installing `server` or `all` from it is refused. A backslash in the home or model path can be passed to the relevant service as a literal argument.

## Update the code

A code change needs no reinstall of the services: the installed server definition runs `server/index.ts` from this checkout. From the repository root, pull and restart in one step, then reload every open tab:

```sh
git pull --ff-only && launchctl kickstart -k gui/$(id -u)/ontherecord.server
```

Pages load `web/` from the checkout as soon as the pull writes it, while the running server keeps the old code until it restarts, so the two steps go together. A tab opened before the restart keeps the old page until it is reloaded. To take a verified snapshot first, follow step 1 of the rollout below instead, which stops the server before the pull.

## Authorized rollout

1. Use the logged-in account that owns the services. Record the current code revision and runtime version, and keep owner-only copies of the existing plists and `.env` outside the checkout. Keep connector grants and the current board, notebook, and speaker state in place throughout a code-only rollout. Then stop the server, bring the checkout to the target revision and take a verified snapshot with the target code, from the repository root:

   ```sh
   launchctl bootout gui/$(id -u)/ontherecord.server
   git pull --ff-only
   npm run backup
   ```

   `npm run backup` prints the folder of each verified copy. Note them, and retain the snapshot separately from the config backup. It refuses while the server answers on its port, so the copy is taken with nothing writing. Because the target code takes it, it also checks the live board, notebook and speaker names against the target's readers: a file the new version can't read stops the copy here, naming the file and, for the board and the notebook, the record and field, before the new server starts. Fix it as in [the recovery runbook](recovery.md#when-a-live-file-fails-validation), or check out the recorded revision with `git checkout <revision>` and start the old version again. A code-only rollout then starts the server with the command below, reloads every open tab and goes on at step 4. A rollout that installs the server leaves it stopped until step 3 loads the new definition; if that install fails, start the restored definition with the same command.

   ```sh
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ontherecord.server.plist
   ```

2. Render the affected definitions using the target checkout, account, and runtime. Review their working directory, executable, model and credential paths, and private log locations. Confirm any Cloudflare Access changes separately. For the tunnel, set `ACCESS_TEAM`, `ACCESS_AUD`, and `ACCESS_USERS` in `.env`. Configure the tunnel UUID and its credential file in advance if this machine no longer carries the tunnel-management certificate.
3. Run only the required install commands. The installer stages and validates every selected plist, checks that its executable is runnable, and saves the previous definitions before stopping any selected service. It atomically replaces each plist and attempts to restore previous definitions and reload previously running services if replacement fails. It updates `.env` only after all selected services load, with Node-compatible quoting and the existing file mode. Newly generated keys are owner-only and retained for retry. An existing nonempty model URL is kept. Each install of a model service sets its key in `.env` to its key file and, except for the reranker, its model name to the installed model file, in place of any earlier value, and names the settings it changed.
4. Confirm the expected services are loaded, check health and the latest private logs, and verify read-only archive search and existing connector sessions. Verify the read/write doors with a fixture or a separately authorized write. If the installer changed model settings in `.env`, reinstall the server once to pick them up.

## Rollback

If a stop times out, automatic rollback reports an error, or the installer is interrupted, inspect the messages and the per-account staging directory `~/Library/LaunchAgents/.meetings-install`. It may hold validated `.previous` copies. The directory also prevents concurrent installer runs. Preserve it until you confirm no installer is running and have recovered the previous definitions.

If the initial shutdown times out, recheck the old service before taking action. The installed plist for the timed-out service remains in place, so bootstrap that definition if the old job subsequently unloads, with `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/<label>.plist`. The server's label is `ontherecord.server`, and the others are `ontherecord.tunnel`, `.embed`, `.rerank` and `.ask`.

For each replaced agent, boot out any replacement still loaded (`launchctl bootout gui/$(id -u)/<label>`), restore the saved plist at its original path with its original mode, lint it, then bootstrap it if it was running before rollout (`launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/<label>.plist`). Stop agents introduced by the rollout with the same `launchctl bootout` and remove only their newly installed definitions. Restore the old code and the changed configuration values without overwriting later edits or current application data. Leave the current connector grant store in place so rollback cannot revive revoked grants. Recheck service status, health and connector sign-ins after restarting.

## Optional local Ask activation

- Check hardware, free RAM and disk space, llama.cpp compatibility, and the model license. Prefer a suitable GGUF already on the deployment Mac. Choose a concrete configuration before approving any download or activation.
- Render the `ask` plist first and review its loopback port, API key file path, model path, and idle timeout. Keep inference on the Mac.
- After activation is authorized, install the model agent and restart the server if needed (`launchctl kickstart -k gui/$(id -u)/ontherecord.server`). Use a nonprivate fixture to verify streaming, citations, no-source behavior, and aborts.
- Record real-model latency, memory, and idle unload separately from mock test results.
