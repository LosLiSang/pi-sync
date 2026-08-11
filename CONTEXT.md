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
Pull fetch behavior: a file absent from base but present remotely (new remote file, fresh machine) is pulled automatically (takeRemote); a file present in base but missing locally is treated as a local deletion and is **not** pulled back by a plain pull — status shows ahead and hints at push; `--force` or `--merge` (choose remote) restores it. Automatic session-start observation never pulls — it only fetches.
_Avoid_: overwrite-by-default, expect-automatic-pull (automatic is observe-only)

**push**:
Publishes the local snapshot to the remote branch. Rejected when the remote changed unless `--force`.

**automatic**:
Gates the non-destructive session-start observation (fetch or upstream check). Never applies changes by itself. With `automatic: false` no fetch happens at session start and the sync indicator shows only what manual commands last refreshed.
_Avoid_: auto-sync, background sync (the old auto push/pull/merge behavior)

**conflict resolution (闭环)**:
Resolving divergent edits inside the Pi UI — you observe a conflict and act on it in the same place, instead of being told to edit files elsewhere. Every observing command must lead to an actionable step. Resolution is structured per conflict block: keep local / keep remote / type a replacement, persisted block-by-block.
_Avoid_: dead-end diff, resolve-in-external-editor

**snapshot projection (快照投影)**:
The snapshot filtered to the include declaration. The local snapshot is always a projection (`createSnapshot` scans include only); remote and historical snapshots are projected before use. Merge (planMerge) and difference reports (fetch/status) operate only on projected snapshots — paths outside include never participate in merging and never appear in reports.
_Avoid_: raw-remote comparison (reporting stale out-of-include paths)

**base snapshot (同步锚点)**:
The snapshot at the last applied remote revision (`state.lastRemoteRevision`) — the ancestor of the three-way merge. It is the anchor that distinguishes deletion from never-synced: a path present in base but missing in local/remote means deletion; absent from base means new. With no base (fresh machine, lost state, force-pushed remote), files present on both sides with different content conservatively report as conflicts.
_Avoid_: empty-base assumption (treating every file as new)

**snapshot deletion (快照删除)**:
Removing a path from the snapshot — it stops being synced and is dropped from the published tree on the next push. Local disk files are never physically deleted by pi-sync (`applySnapshot` writes only; include shrinkage stops syncing a path but leaves the disk file alone).
_Avoid_: delete-on-pull (physically removing files the user may want to keep)

## Rules

- The loop always closes: observe (status) → act (pull/push/merge) → observe again.
- Nothing moves local files without an explicit command; `automatic` only looks.
- The config file stays single and flat: `remote`, `branch`, `include`, `automatic`.
