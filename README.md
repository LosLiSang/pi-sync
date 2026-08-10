# 🔄 pi-sync

A personal Pi extension that syncs Pi configuration through **Git** with background auto-sync and git-style `fetch`/`merge` conflict handling.

> **Experimental.** This is a from-scratch rewrite of the classic pi-sync flow: one config file, one git remote, content-level diffs, and three-way merges instead of force-or-lose conflicts.

## ✨ Features

- **Single config, direct connection** — one `pi-sync.json` points at one git remote and branch. No two-level setup/connection model.
- **Background auto-sync** — session start never blocks on the network; the sync runs in the background and is cancelled cleanly on session switch or shutdown. A bounded push runs at shutdown.
- **Git-style conflicts** — `/sync fetch` pulls the remote snapshot; `/sync merge` three-way merges it into your local files. Non-overlapping edits merge cleanly, divergent values write `<<<<<<<` markers for you to resolve, then `/sync push`.
- **JSON-aware merging** — single-line `settings.json`/`keybindings.json`/`models.json` merge field-wise, so formatting or an unrelated field change doesn't conflict.
- **Content-level diff** — `/sync diff` shows unified `-`/`+` hunks with context. JSON is pretty-printed first, secret-like values are masked, and output stays bounded.
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
/sync init        # wizard: git remote, branch, included content, automatic sync
/sync status      # local vs remote change summary
/sync diff        # content-level diff (JSON-aware, secrets masked)
/sync fetch       # pull the remote snapshot without applying
/sync merge       # three-way merge remote changes into local files
/sync push        # publish local snapshot (--force overwrites remote changes)
/sync pull        # overwrite local files with the remote snapshot
/sync history     # list recent remote snapshot commits
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

- `include` selects which agent-dir paths sync. The defaults are `settings.json`, `keybindings.json`, `models.json`, `skills`, `prompts`, `themes`, `extensions`, and `extension-settings`. Sessions and `AGENTS.md` are intentionally not included by default.
- State lives under `<agent-dir>/pi-sync/` (a mirror git repo, `state.json`, and backups).

## 🗂️ Package layout

```text
src/
  index.ts        extension entrypoint
  extension.ts    lifecycle, /sync command routes, background auto-sync
  config.ts       single-file config load/validate/save
  paths.ts        agent-dir paths and include normalization
  git.ts          git subprocess backend (fetch/push/log/show/merge-file)
  snapshot.ts     scan include paths into a hashed snapshot
  state.ts        last-applied snapshot + remote revision
  diff.ts         content-level diff with JSON formatting and secret masking
  merge.ts        three-way merge (JSON field-wise + git merge-file fallback)
  operations.ts   status/diff/push/pull/fetch/merge/history
  wizard.ts       first-run setup wizard
test/             vitest unit + local-bare-repo end-to-end tests
```

## 🔎 Keywords

`pi-package` `pi-extension` `pi` `sync` `git`

## 📄 License

MIT
