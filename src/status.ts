import { pathMatchesInclude } from "./tree.js";

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
 *
 * `include` is the include declaration. The remote and base maps are projected
 * onto the include scope before comparison, so out-of-include paths (for
 * example legacy `pi-sync/home/...` remnants from the old single-snapshot
 * architecture) never pollute the state. A path the local side does not contain
 * is never treated as a local change, which fixes the false "ahead" when the
 * remote carries leftover paths the local never synced.
 */
export function classifyState(
	local: Map<string, string>,
	remote: Map<string, string>,
	base: Map<string, string>,
	mergePending: boolean,
	include: string[],
): StateClassify {
	const inInclude = (p: string) => include.some((entry) => pathMatchesInclude(p, entry));
	const remoteP = new Map([...remote].filter(([p]) => inInclude(p)));
	const baseP = new Map([...base].filter(([p]) => inInclude(p)));

	if (mergePending) {
		const diverged = [...new Set([...local.keys(), ...remoteP.keys()])]
			.filter((p) => local.get(p) !== remoteP.get(p))
			.filter(inInclude);
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
	const paths = [...new Set([...local.keys(), ...remoteP.keys()])].filter(inInclude).sort();
	const localChanged: string[] = [];
	const remoteChanged: string[] = [];
	const diverged: string[] = [];
	for (const filePath of paths) {
		const localContent = local.get(filePath);
		const remoteContent = remoteP.get(filePath);
		if (localContent === remoteContent) continue;
		const baseContent = baseP.get(filePath);
		const baseHas = baseContent !== undefined;
		// A side is "changed" only if it actually holds the path and its content
		// differs from the base (an added or deleted file counts). Without a base
		// (fresh branch) fall back to "the side holds the path".
		const localChangedSide = baseHas ? localContent !== baseContent : localContent !== undefined;
		const remoteChangedSide = baseHas ? remoteContent !== baseContent : remoteContent !== undefined;
		if (localChangedSide && remoteChangedSide) diverged.push(filePath);
		else if (localChangedSide) localChanged.push(filePath);
		else if (remoteChangedSide) remoteChanged.push(filePath);
	}

	let label: SyncStateLabel;
	if (remoteP.size === 0) label = "unpublished";
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
			return `sync: conflict (${info.conflicts}) — /sync merge`;
	}
}
