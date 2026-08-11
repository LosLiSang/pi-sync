# pi-sync

A personal Pi extension that syncs Pi configuration through Git. Single config file, deliberate git-style commands, and conflict resolution inside the Pi UI.

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
Downloads the remote snapshot into the local mirror without touching local files.

**merge**:
Applies a fetched snapshot into local files via three-way merge; divergent edits surface as conflict markers. Doubles as the resume entry point: an incomplete merge session is continued, `--abort` discards it and restores the pre-merge backup.
_Avoid_: merge-as-always-fresh (merge re-runs the last session)

**pull**:
Fetches and merges in one step. Without conflicts it applies directly; `--force` overwrites local files with the remote snapshot; `--merge` opens interactive conflict resolution. With conflicts and no flag it writes nothing and only tells you the two paths.
_Avoid_: overwrite-by-default

**push**:
Publishes the local snapshot to the remote branch. Rejected when the remote changed unless `--force`.

**automatic**:
Gates the non-destructive session-start observation (fetch or upstream check). Never applies changes by itself. With `automatic: false` no fetch happens at session start and the sync indicator shows only what manual commands last refreshed.
_Avoid_: auto-sync, background sync (the old auto push/pull/merge behavior)

**conflict resolution (闭环)**:
Resolving divergent edits inside the Pi UI — you observe a conflict and act on it in the same place, instead of being told to edit files elsewhere. Every observing command must lead to an actionable step. Resolution is structured per conflict block: keep local / keep remote / type a replacement, persisted block-by-block.
_Avoid_: dead-end diff, resolve-in-external-editor

## Rules

- The loop always closes: observe (status) → act (pull/push/merge) → observe again.
- Nothing moves local files without an explicit command; `automatic` only looks.
- The config file stays single and flat: `remote`, `branch`, `include`, `automatic`.
