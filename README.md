# 🔄 pi-sync

A personal Pi extension that syncs Pi configuration through **Git** with git-style `fetch`/`pull`/`merge`/`push`, a single config file, and conflict resolution inside the Pi UI.

> **Experimental.** This is a from-scratch rewrite of the classic pi-sync flow: one config file, one git remote, content-level diffs, three-way merges, and deliberate commands that never move your files without asking.

## ✨ Features

- **Single config, direct connection** — one `pi-sync.json` points at one git remote and branch. No two-level setup/connection model.
- **Observe-only automatic** — `automatic: true` fetches at session start and shows a persistent status-bar indicator (up-to-date / ahead / behind / conflict). It never pushes, pulls or merges on its own.
- **Git-style pull** — `/sync pull` fetches and merges. Clean changes apply directly; divergence without a flag writes nothing; `--force` overwrites local files; `--merge` opens in-UI conflict resolution.
- **In-UI conflict resolution** — divergent edits are parsed into conflict blocks and resolved one at a time (keep local / keep remote / type a replacement). Progress persists across sessions; `/sync merge` resumes, `/sync merge --abort` restores the pre-merge backup.
- **JSON-aware merging** — single-line `settings.json`/`keybindings.json`/`models.json` merge field-wise, so formatting or an unrelated field change doesn't conflict.
- **Closed-loop status** — `/sync status` shows the effective config, the sync state, any in-progress merge, and the exact next step; `/sync status --diff` shows the content-level diff (JSON pretty-printed, secrets masked, bounded).
- **No stored credentials** — Git uses your existing SSH/credential-helper setup; the config file never holds tokens.

## 📦 Install

```bash
pi install -l ~/Documents/code/pi-sync
```

or from npm once published:

```bash
pi install npm:@loslisang/pi-sync
```

## 🚀 Quick start

```bash
/sync init         # first-run wizard: remote, branch, include, automatic
/sync config       # view and edit the config at any time
/sync status       # config + sync state + next step (--diff for content)
/sync fetch        # pull the remote snapshot without applying
/sync pull         # fetch + merge (--force overwrites, --merge resolves)
/sync merge        # continue an in-progress merge (--abort discards)
/sync push         # publish local snapshot (--force overwrites remote)
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

- `include` selects which agent-dir paths sync. The defaults are `settings.json`, `keybindings.json`, `models.json`, `skills`, `prompts`, `themes`, `extensions`, and `extension-settings`. Sessions and `AGENTS.md` are intentionally not included by default. Edit it any time with `/sync config`.
- `automatic` only controls whether a non-destructive fetch runs at session start; the status-bar indicator always reflects the last known state.
- State lives under `<agent-dir>/pi-sync/` (a mirror git repo, `state.json`, `merge-session/`, and backups).

## 🗂️ Package layout

```text
src/
  index.ts          extension entrypoint
  extension.ts      lifecycle, /sync command routes, session-start fetch
  config.ts         single-file config load/validate/save
  config-ui.ts      interactive config editor (view + edit fields)
  paths.ts          agent-dir paths and include normalization
  git.ts            git subprocess backend (fetch/push/show/merge-file)
  snapshot.ts       scan include paths into a hashed snapshot
  state.ts          last-applied snapshot + remote revision
  status.ts         sync-state derivation and indicator text
  merge-session.ts  persistent conflict-resolution session store
  conflict.ts       diff3 marker parsing and resolved-text splicing
  resolve.ts        structured block-by-block conflict resolver
  diff.ts           content-level diff with JSON formatting and secret masking
  merge.ts          three-way merge (JSON field-wise + git merge-file fallback)
  operations.ts     status/push/pull/fetch/merge
  wizard.ts         first-run setup wizard
test/               vitest unit + local-bare-repo end-to-end tests
```

## 🔎 Keywords

`pi-package` `pi-extension` `pi` `sync` `git`

## 📄 License

MIT
