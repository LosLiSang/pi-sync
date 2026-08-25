# 🔄 pi-sync

A personal Pi extension that syncs Pi configuration through **Git** using the real
file tree — each synced file lives in the repo as its actual file, so conflict
detection and merging are handled by git itself.

> **Experimental.** A from-scratch rewrite that treats the remote repo as a
> genuine file tree instead of a single packed snapshot. Conflicts resolve
> through git's native three-way merge; the base is git's real merge-base, so a
> fresh machine or a force-pushed remote never causes a false conflict.

## ✨ Features

- **Real file tree, not a blob** — the remote branch holds `settings.json`,
  `skills/…`, `prompts/…` as real files. Git does per-path, per-line detection
  and merging; no hand-rolled snapshot engine.
- **Git-native conflict detection** — the base is git's merge-base, not a local
  anchor file. A new machine's first `pull` adopts the remote cleanly; a
  rewritten remote doesn't spuriously conflict.
- **Git-native three-way merge** — `/sync pull` merges the remote branch into
  the local side. Divergent edits produce real conflict markers in the actual
  files; `/sync merge` completes once you resolve them, `--abort` discards.
- **Deliberate commands** — nothing moves your files without being asked;
  `automatic` only observes at session start.
- **Sensible defaults** — one `pi-sync.json` points at a git remote and branch,
  an `include` list, and `automatic`.
- **No stored credentials** — git uses your existing SSH/credential helper.

## 📦 Install

```bash
pi install -l ~/Documents/code/pi-sync
```

or from npm once published:

```bash
pi install npm:@lisang233/pi-sync
```

## 🚀 Quick start

```bash
/sync init         # first-run wizard: remote, branch, include, automatic
/sync config       # view and edit the config at any time
/sync status       # config + sync state + next step (--diff for content)
/sync fetch        # pull the remote tree without applying
/sync pull         # fetch + merge (--force overwrites local)
/sync merge        # complete an in-progress merge (--abort discards)
/sync push         # publish the local tree (--force overwrites remote)
```

## ⚙️ Settings

The config lives at `~/.pi/agent/pi-sync.json` (agent dir honors `PI_CODING_AGENT_DIR`):

```json
{
	"remote": "git@github.com:you/pi-sync.git",
	"branch": "pi-sync",
	"include": [
		"settings.json",
		"keybindings.json",
		"models.json",
		"skills",
		"prompts",
		"themes",
		"extensions",
		"extension-settings"
	],
	"automatic": true
}
```

- `include` selects which agent-dir paths sync. The defaults are `settings.json`,
  `keybindings.json`, `models.json`, `skills`, `prompts`, `themes`, `extensions`,
  and `extension-settings`. Sessions and `AGENTS.md` are not synced by default.
- `automatic` only controls whether a non-destructive `fetch` runs at session
  start; the status-bar indicator always reflects the last known state.
- A mirror git repo lives under `<agent-dir>/pi-sync/mirror/` and is checked out
  on the configured branch.

> Note: with a real file tree, any sensitive token in a synced config is stored
> in the git repo as plaintext (like any dotfile repo). It is not hidden, and it
> is not encrypted. Use a private remote and a credential helper that keeps
> `~/.git-credentials` out of the repo.

## 🗂️ Package layout

```text
src/
  index.ts          extension entrypoint
  extension.ts      lifecycle, /sync command routes, session-start fetch
  config.ts         single-file config load/validate/save
  config-ui.ts      interactive config editor (view + edit fields)
  paths.ts          agent-dir paths and include normalization
  git.ts            git subprocess backend (real-file-tree fetch/push/merge)
  tree.ts           sync agent-dir <-> mirror work tree (real files)
  status.ts         sync-state derivation (git merge-base) and indicator
  diff.ts           content-level diff with JSON formatting and secret masking
  operations.ts     status/push/pull/fetch/merge orchestration
  wizard.ts         first-run setup wizard
test/               vitest unit + local-bare-repo end-to-end tests
```

## 🔎 Keywords

`pi-package` `pi-extension` `pi` `sync` `git`

## 📄 License

MIT
