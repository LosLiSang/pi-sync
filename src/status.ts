export type SyncStateLabel =
	| "unconfigured"
	| "unknown"
	| "up-to-date"
	| "unpublished"
	| "ahead"
	| "behind"
	| "conflict";

export interface SyncStatusInfo {
	label: SyncStateLabel;
	ahead: number;
	behind: number;
	conflicts: number;
}

export interface StateClassify {
	label: SyncStateLabel;
	ahead: number;
	behind: number;
	conflicts: number;
	/** Paths where only the local side changed (local "wins" / pushable). */
	localChanged: string[];
	/** Paths where only the remote side changed (pullable). */
	remoteChanged: string[];
	/** Paths where both sides changed on the same path (needs a real merge). */
	diverged: string[];
}

/**
 * Classify the sync state by three-way comparing the agent file tree against
 * the remote branch, using git's real merge-base as the base. Unlike the old
 * snapshot design (which used a local state.json anchor), the base here is the
 * true common ancestor, so a fresh machine or a rewritten remote never
 * produces a false conflict.
 *
 * `base` is the content map at the merge-base (empty when there is none, e.g.
 * a brand-new branch with no shared history). A path present in local & remote
 * with different content and no base is conservatively a divergence.
 */
export function classifyState(
	local: Map<string, string>,
	remote: Map<string, string>,
	base: Map<string, string>,
	mergePending: boolean,
): StateClassify {
	if (mergePending) {
		const diverged = [...new Set([...local.keys(), ...remote.keys()])].filter(
			(p) => local.get(p) !== remote.get(p),
		);
		return {
			label: "conflict",
			ahead: 0,
			behind: 0,
			conflicts: diverged.length,
			localChanged: [],
			remoteChanged: [],
			diverged,
		};
	}
	const paths = [...new Set([...local.keys(), ...remote.keys()])].sort();
	const localChanged: string[] = [];
	const remoteChanged: string[] = [];
	const diverged: string[] = [];
	for (const filePath of paths) {
		const localContent = local.get(filePath);
		const remoteContent = remote.get(filePath);
		if (localContent === remoteContent) continue;
		const baseContent = base.get(filePath);
		const localChangedSide = baseContent !== undefined ? localContent !== baseContent : true;
		const remoteChangedSide = baseContent !== undefined ? remoteContent !== baseContent : true;
		if (localChangedSide && remoteChangedSide) diverged.push(filePath);
		else if (localChangedSide) localChanged.push(filePath);
		else if (remoteChangedSide) remoteChanged.push(filePath);
	}

	let label: SyncStateLabel;
	if (remote.size === 0) label = "unpublished";
	else if (diverged.length > 0 || (localChanged.length > 0 && remoteChanged.length > 0)) {
		label = "conflict";
	} else if (remoteChanged.length > 0) {
		label = "behind";
	} else if (localChanged.length > 0) {
		label = "ahead";
	} else {
		label = "up-to-date";
	}
	return {
		label,
		ahead: localChanged.length,
		behind: remoteChanged.length,
		conflicts: diverged.length,
		localChanged,
		remoteChanged,
		diverged,
	};
}

/** Status-bar text while a background/foreground sync action is in flight. */
export function syncBusyText(action: "fetch" | "push" = "fetch"): string {
	return action === "push" ? "sync: pushing…" : "sync: fetching…";
}

/** Short status-bar text for the sync indicator. */
export function syncIndicatorText(info: SyncStatusInfo): string {
	switch (info.label) {
		case "unconfigured":
			return "sync: unconfigured";
		case "unknown":
			return "sync: unknown";
		case "up-to-date":
			return "sync: up-to-date";
		case "unpublished":
			return "sync: unpublished — push";
		case "ahead":
			return `sync: ${info.ahead} ahead — push`;
		case "behind":
			return `sync: ${info.behind} behind — pull`;
		case "conflict":
			return `sync: conflict (${info.conflicts}) — pull --merge or --force`;
	}
}
