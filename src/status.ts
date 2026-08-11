import { planMerge } from "./merge.js";
import type { Snapshot } from "./snapshot.js";

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

/**
 * Derive the sync state from the local snapshot, the remote snapshot, and the
 * base snapshot (the last remote revision we applied). A missing remote means
 * nothing has ever been published; divergent or two-sided changes are a
 * conflict, one-sided changes are ahead (push) or behind (pull).
 */
export function deriveSyncStatus(
	local: Snapshot,
	remote: Snapshot | undefined,
	base: Snapshot | undefined,
): SyncStatusInfo {
	if (!remote) {
		return { label: "unpublished", ahead: 0, behind: 0, conflicts: 0 };
	}
	const plan = planMerge(local, remote, base);
	if (plan.conflicts.length > 0 || (plan.takeLocal.length > 0 && plan.takeRemote.length > 0)) {
		return {
			label: "conflict",
			ahead: plan.takeLocal.length,
			behind: plan.takeRemote.length,
			conflicts: plan.conflicts.length,
		};
	}
	if (plan.takeLocal.length > 0) {
		return { label: "ahead", ahead: plan.takeLocal.length, behind: 0, conflicts: 0 };
	}
	if (plan.takeRemote.length > 0) {
		return { label: "behind", ahead: 0, behind: plan.takeRemote.length, conflicts: 0 };
	}
	return { label: "up-to-date", ahead: 0, behind: 0, conflicts: 0 };
}

/** Short status-bar text while a background sync (automatic fetch) is in flight. */
export function syncBusyText(): string {
	return "sync: fetching…";
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
