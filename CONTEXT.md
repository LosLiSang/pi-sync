# pi-sync

A personal Pi extension that syncs Pi configuration through Git. Single config file, deliberate git-style commands, and git-native merge on a real file tree.

## Language

**init**:
The first-run command that creates the config file and walks through the full configuration (remote, branch, include, automatic). Runs once; afterwards the config is edited through `config`.
_Avoid_: setup, wizard-as-everything

**config**:
The command that views and edits the existing configuration. The only place to change settings after init. No-argument runs show the config and enter a field-edit loop (remote/branch/include/automatic).
_Avoid_: settings display (read-only view is not config)

**status**:
The command that shows the effective config together with the local↔remote sync state, ending with the next actionable step. `status --diff` shows content-level differences.

**sync indicator**:
The persistent status-bar text (identical / ahead / behind / conflict / unknown) derived from the last known local↔remote state. It is refreshed by fetch, pull, push and merge — never by automatic observation alone.
_Avoid_: auto-sync status (a background sync that writes)

**fetch**:
Fetches the remote branch into the mirror and reports the content-level difference with the local side, without touching local files.

**merge**:
Completes an in-progress `git` merge. After `/sync pull` detects conflicts, the local configuration is kept intact while conflicts remain in the mirror. Resolution happens via `/sync merge --ours` / `--theirs`, `/sync mergetool`, or manual editing. `/sync merge` strictly validates that no conflict markers remain and that JSON files parse cleanly before committing and applying to the agent directory. `--abort` discards the merge and restores the pre-merge state.

**mergetool**:
Launches git's native mergetool in the mirror work tree (`/sync mergetool [tool]`), supporting interactive tools like vimdiff, nvimdiff, or vscode.

**pull**:
Fetches and merges the remote branch into the mirror with a real three-way merge. Without conflicts it applies the result to the agent dir; `--force` overwrites local files with the remote tree. A fresh machine (first sync) adopts the remote cleanly instead of doing a three-way merge against an empty base. Automatic session-start observation never pulls — it only fetches.
_Avoid_: overwrite-by-default, expect-automatic-pull (automatic is observe-only)

**push**:
Publishes the local file tree to the remote branch. Rejected when the remote changed unless `--force`.

**automatic**:
Gates the non-destructive session-start observation (fetch or upstream check). Never applies changes by itself. With `automatic: false` no fetch happens at session start and the sync indicator shows only what manual commands last refreshed.
_Avoid_: auto-sync, background sync (the old auto push/pull/merge behavior)

**conflict resolution (protected & guarded, 闭环)**:
Divergent edits are isolated in the mirror work tree without corrupting live agent configurations with broken JSON. Conflicts can be resolved via `/sync merge --ours` / `--theirs`, `/sync mergetool`, or editing. `/sync merge` enforces a strict guard against unresolved conflict markers and invalid JSON syntax; only clean trees are committed and applied to the live agent directory.
_Avoid_: dead-end diff, edit-elsewhere-without-a-commit-path

**real file tree (真实文件树)**:
The remote branch holds the include paths as real files (`settings.json`, `skills/…`, `prompts/…`), not a packed snapshot. Git's own three-way merge, diff and conflict detection operate on the working tree of a mirror repo checked out on the configured branch; the agent dir is the source of truth for the local side and is grafted into the mirror before each operation.
_Avoid_: packed-snapshot, hand-rolled-merge-engine

**merge-base (同步锚点)**:
The base of the three-way merge is git's real merge-base of the local branch and the remote branch, not a locally stored anchor. A fresh machine or a force-pushed remote therefore never causes a false conflict — the common ancestor is computed from history. With no shared ancestor (brand-new branch), files present on both sides with different content conservatively report as a conflict.
_Avoid_: state-anchor, empty-base assumption (treating every file as new)

**deletion (文件删除)**:
A file removed from the synced tree stops being synced and is dropped from the published tree on the next push. On `pull`/`merge`, a path absent from the applied tree is removed from the agent dir only when it falls under an include path (deletion propagation) — a local file outside the include scope is never touched.

## Rules

- The loop always closes: observe (status) → act (pull/push/merge) → observe again.
- Nothing moves local files without an explicit command; `automatic` only looks.
- The config file stays single and flat: `remote`, `branch`, `include`, `automatic`.
- Config content must round-trip byte-exactly; the mirror repo sets `core.autocrlf=false`/`core.eol=lf` so git never rewrites line endings.
- Sensitive tokens in synced configs are stored plaintext in the repo (like any dotfile repo); not encrypted, not masked on disk.
