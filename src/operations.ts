import fs from "node:fs/promises";
import path from "node:path";
import type {
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import type { SyncConfig } from "./config.js";
import { shortId, stateDir } from "./config.js";
import { formatConfig } from "./config-ui.js";
import { diffSummary, formatDiff } from "./diff.js";
import {
	abortMerge,
	aheadBehind,
	checkoutOurs,
	checkoutTheirs,
	commitSync,
	completeMerge,
	ensureBranch,
	ensureMirror,
	fetchRemote,
	isMergeInProgress,
	listConflictedPaths,
	mergeRemote,
	pushBranch,
	readCommitFile,
	readMergeBase,
	readRemoteFiles,
	readRemoteRevision,
	resetHard,
	stageAll,
} from "./git.js";
import { agentDir } from "./paths.js";
import { classifyState, type StateClassify, syncIndicatorText } from "./status.js";
import {
	agentTarget,
	collectAgentFiles,
	copyMirrorToAgent,
	graftAgentIntoMirror,
	mirrorProjectedFiles,
	mirrorTarget,
	readAgentContents,
} from "./tree.js";

export interface SyncResult {
	pushed: boolean;
	pulled: boolean;
	merged: boolean;
	message: string;
	conflicts?: string[];
}

export interface OperationContext {
	ui: ExtensionUIContext;
	signal?: AbortSignal;
}

export type CommandContext = ExtensionCommandContext | ExtensionContext;

const LOCAL_COMMIT_MESSAGE = "pi-sync: local";

/** Refresh the persistent status-bar sync indicator from the last known state. */
export async function refreshIndicator(ctx: OperationContext, config: SyncConfig): Promise<void> {
	try {
		const info = await computeState(config, ctx.signal);
		ctx.ui.setStatus("sync", syncIndicatorText(info));
	} catch {
		ctx.ui.setStatus(
			"sync",
			syncIndicatorText({ label: "unknown", ahead: 0, behind: 0, conflicts: 0 }),
		);
	}
}

/**
 * Build the current classification by comparing the agent file tree to the
 * remote branch. Uses git's real merge-base as the base, so a fresh machine or
 * a rewritten remote never causes a false conflict. Does not graft or write.
 */
async function computeState(config: SyncConfig, signal?: AbortSignal): Promise<StateClassify> {
	await ensureMirror(config);
	const [local, remote, base, mergePending] = await Promise.all([
		readAgentContents(config),
		readRemoteFiles(config, { signal }),
		readMergeBase(config, { signal }),
		isMergeInProgress({ signal }),
	]);
	return classifyState(local, remote, base, mergePending, config.include);
}

export async function status(
	ctx: CommandContext,
	config: SyncConfig,
	options: { diff?: boolean } = {},
): Promise<SyncResult> {
	// status never fetches; it reflects the last known mirror state.
	const info = await computeState(config, ctx.signal);
	await refreshIndicator(ctx, config);
	const lines = [formatConfig(config), `state: ${syncIndicatorText(info)}`];
	if (info.label === "conflict") {
		lines.push(`conflicting file(s): ${info.diverged.slice(0, 5).join(", ") || "(resolving)"}`);
	}
	lines.push(nextStepHint(info));
	if (options.diff) {
		const remote = await readRemoteFiles(config, { signal: ctx.signal });
		const local = await readAgentContents(config);
		lines.push("", formatDiff(local, remote));
	}
	const level = info.label === "up-to-date" ? "info" : "warning";
	ctx.ui.notify(lines.join("\n"), level);
	return { pushed: false, pulled: false, merged: false, message: "status" };
}

/** The closed-loop hint: what to do next given the current state. */
function nextStepHint(info: StateClassify): string {
	switch (info.label) {
		case "unconfigured":
			return "next: /sync init";
		case "unpublished":
			return "next: /sync push";
		case "up-to-date":
			return "next: nothing — all synced";
		case "ahead":
			return "next: /sync push to publish local changes";
		case "behind":
			return "next: /sync pull to fetch and apply remote changes";
		case "conflict":
			return "next: /sync merge (--ours or --theirs), or /sync pull --force to overwrite local";
		case "unknown":
			return "next: /sync fetch to check the remote";
	}
}

export async function push(
	ctx: CommandContext,
	config: SyncConfig,
	options: { force?: boolean } = {},
): Promise<SyncResult> {
	const { remoteExists } = await ensureBranch(config, { signal: ctx.signal });
	if (await isMergeInProgress({ signal: ctx.signal })) {
		const message =
			"A merge is in progress. Resolve it (/sync merge) or discard it (/sync merge --abort) before pushing.";
		ctx.ui.notify(message, "error");
		return { pushed: false, pulled: false, merged: false, message };
	}
	// Stage the local (agent) side as the current branch tip, then publish.
	const files = await collectAgentFiles(config);
	await graftAgentIntoMirror(config, files);
	await stageAll({ signal: ctx.signal });
	await commitLocalSide({ signal: ctx.signal });

	if (remoteExists && !options.force && !(await isFastForward(config, ctx.signal))) {
		const message =
			"Remote changed since the last sync. Run /sync pull to merge, or /sync push --force to overwrite.";
		ctx.ui.notify(message, "error");
		return { pushed: false, pulled: false, merged: false, message };
	}

	await pushBranch(config, { signal: ctx.signal }, options.force);
	await refreshIndicator(ctx, config);
	const message = `Pushed ${files.length} file(s) from ${stateDir()} to ${config.branch}.`;
	ctx.ui.notify(message, "info");
	return { pushed: true, pulled: false, merged: false, message };
}

/** True when the remote tip is an ancestor of the local branch tip (a safe fast-forward). */
async function isFastForward(config: SyncConfig, signal?: AbortSignal): Promise<boolean> {
	const { behind } = await aheadBehind(config, { signal });
	return behind === 0;
}

async function commitLocalSide(options: { signal?: AbortSignal } = {}): Promise<void> {
	await commitSync(LOCAL_COMMIT_MESSAGE, options);
}

export async function pull(
	ctx: CommandContext,
	config: SyncConfig,
	options: { force?: boolean } = {},
): Promise<SyncResult> {
	const { fresh, remoteExists } = await ensureBranch(config, { signal: ctx.signal });
	if (await isMergeInProgress({ signal: ctx.signal })) {
		const message =
			"A merge is already in progress. Continue with /sync merge or discard it with /sync merge --abort.";
		ctx.ui.notify(message, "warning");
		return { pushed: false, pulled: false, merged: false, message };
	}
	if (!remoteExists) {
		const message = "Remote is empty. Run /sync push first.";
		ctx.ui.notify(message, "warning");
		return { pushed: false, pulled: false, merged: false, message };
	}

	// Force: throw away the local side and adopt the remote directly.
	if (options.force) {
		await forceAdoptRemote(config, ctx.signal);
		await refreshIndicator(ctx, config);
		const remote = await readRemoteFiles(config, { signal: ctx.signal });
		const message = `Overwrote local files with the remote tree (${remote.size} files).`;
		ctx.ui.notify(message, "warning");
		return { pushed: false, pulled: true, merged: false, message };
	}

	// Fresh machine (first sync): adopt the remote so it never false-conflicts.
	if (fresh) {
		await copyMirrorToAgent(config);
		await refreshIndicator(ctx, config);
		const remote = await readRemoteFiles(config, { signal: ctx.signal });
		const message = `Pulled ${remote.size} file(s) from ${config.branch} — initial sync.`;
		ctx.ui.notify(message, "info");
		return { pushed: false, pulled: true, merged: false, message };
	}

	// Stage local (agent) side as the branch tip, then git merge origin.
	const files = await collectAgentFiles(config);
	await graftAgentIntoMirror(config, files);
	await stageAll({ signal: ctx.signal });
	await commitLocalSide({ signal: ctx.signal });

	const conflicted = await mergeRemote(config, { signal: ctx.signal });
	if (conflicted) {
		await refreshIndicator(ctx, config);
		const conflicts = await listConflictedPaths({ signal: ctx.signal });
		let remoteRevision = "";
		try {
			remoteRevision = (await readRemoteRevision(config, { signal: ctx.signal })) ?? "";
		} catch {
			// ignore
		}
		const conflictList = conflicts.length > 0 ? ` (${conflicts.join(", ")})` : "";
		const message = `Merge conflict in ${conflicts.length} file(s)${conflictList}. Local configuration in ${agentDir()} was preserved. Edit files or resolve with /sync merge --ours / --theirs. Then run /sync merge. (remote ${shortId(
			remoteRevision,
		)})`;
		ctx.ui.notify(message, "warning");
		return { pushed: false, pulled: false, merged: false, message, conflicts };
	}

	await copyMirrorToAgent(config);
	await refreshIndicator(ctx, config);
	const remote = await readRemoteFiles(config, { signal: ctx.signal });
	const message = `Pulled ${remote.size} file(s) from ${config.branch}.`;
	ctx.ui.notify(message, "info");
	return { pushed: false, pulled: true, merged: false, message };
}

/** Throw away the local agent side and adopt the remote tree (--force pull). */
async function forceAdoptRemote(config: SyncConfig, signal?: AbortSignal): Promise<void> {
	await resetHard(config, { signal });
	await copyMirrorToAgent(config);
}

export async function fetch(
	ctx: CommandContext,
	config: SyncConfig,
	options: { quiet?: boolean } = {},
): Promise<SyncResult> {
	await fetchRemote(config, { signal: ctx.signal });
	const { fresh, remoteExists } = await ensureBranch(config, { signal: ctx.signal });
	const [local, remote] = await Promise.all([
		readAgentContents(config),
		remoteExists ? readRemoteFiles(config, { signal: ctx.signal }) : new Map<string, string>(),
	]);
	await refreshIndicator(ctx, config);
	if (!remoteExists || remote.size === 0) {
		const message = "Remote is empty. Run /sync push to publish local content.";
		if (!options.quiet) ctx.ui.notify(message, "info");
		return { pushed: false, pulled: false, merged: false, message };
	}
	const summary = diffSummary(local, remote);
	const message = `Fetched ${remote.size} files from ${config.branch}. ${describeChanges(summary)}.`;
	if (!options.quiet) {
		ctx.ui.notify(message, summary.identical ? "info" : "warning");
	}
	// On a fresh machine, fetch alone must not overwrite the agent.
	void fresh;
	return { pushed: false, pulled: false, merged: false, message };
}

export interface FileValidationError {
	path: string;
	line?: number;
	reason: string;
}

/**
 * Validate that the mirror work tree has resolved all conflicts and produced
 * valid JSON for any .json files before allowing completeMerge to commit.
 */
export async function validateResolvedMirror(
	config: SyncConfig,
	signal?: AbortSignal,
): Promise<FileValidationError[]> {
	const errors: FileValidationError[] = [];
	const unmerged = await listConflictedPaths({ signal });
	for (const file of unmerged) {
		errors.push({ path: file, reason: "unmerged git conflict" });
	}

	const projected = await mirrorProjectedFiles(config);
	for (const relative of projected) {
		const fullPath = mirrorTarget(relative);
		let content: string;
		try {
			content = await fs.readFile(fullPath, "utf8");
		} catch {
			continue;
		}

		const lines = content.split(/\r?\n/u);
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (
				line.startsWith("<<<<<<<") ||
				line.startsWith("=======") ||
				line.startsWith(">>>>>>>") ||
				line.startsWith("|||||||")
			) {
				errors.push({
					path: relative,
					line: i + 1,
					reason: `unresolved conflict marker: ${line.slice(0, 12).trim()}`,
				});
				break;
			}
		}

		if (relative.toLowerCase().endsWith(".json")) {
			try {
				JSON.parse(content);
			} catch (err) {
				errors.push({
					path: relative,
					reason: `invalid JSON syntax: ${(err as Error).message}`,
				});
			}
		}
	}
	return errors;
}

export interface MergeOptions {
	abort?: boolean;
	ours?: boolean;
	theirs?: boolean;
}

export async function merge(
	ctx: CommandContext,
	config: SyncConfig,
	options: MergeOptions = {},
): Promise<SyncResult> {
	if (options.abort) {
		if (!(await isMergeInProgress({ signal: ctx.signal }))) {
			const message = "No merge in progress to abort.";
			ctx.ui.notify(message, "info");
			return { pushed: false, pulled: false, merged: false, message };
		}
		await abortMerge({ signal: ctx.signal });
		await refreshIndicator(ctx, config);
		const message = "Merge aborted; local files restored to the pre-merge state.";
		ctx.ui.notify(message, "info");
		return { pushed: false, pulled: false, merged: false, message };
	}

	if (!(await isMergeInProgress({ signal: ctx.signal }))) {
		const message =
			"No merge in progress. Run /sync pull to merge remote changes into local files.";
		ctx.ui.notify(message, "info");
		return { pushed: false, pulled: false, merged: false, message };
	}

	if (options.ours && options.theirs) {
		const message = "Cannot specify both --ours and --theirs.";
		ctx.ui.notify(message, "error");
		return { pushed: false, pulled: false, merged: false, message };
	}

	if (options.ours) {
		await checkoutOurs({ signal: ctx.signal });
	} else if (options.theirs) {
		await checkoutTheirs({ signal: ctx.signal });
	} else {
		// Graft any user modifications from the agent directory into mirror if the
		// user manually edited the agent file while resolving.
		const localFiles = await collectAgentFiles(config);
		for (const file of localFiles) {
			try {
				const agentContent = await fs.readFile(file.source, "utf8");
				const headContent = await readCommitFile("HEAD", file.path, { signal: ctx.signal });
				if (headContent === undefined || agentContent !== headContent) {
					const target = mirrorTarget(file.path);
					await fs.mkdir(path.dirname(target), { recursive: true });
					await fs.writeFile(target, agentContent, "utf8");
				}
			} catch {
				// Unreadable file — ignore
			}
		}
		await stageAll({ signal: ctx.signal });
	}

	// Validate mirror files before completing merge.
	const errors = await validateResolvedMirror(config, ctx.signal);
	if (errors.length > 0) {
		const errorDetails = errors
			.slice(0, 5)
			.map((e) => `  - ${agentTarget(e.path)}${e.line ? `:${e.line}` : ""}: ${e.reason}`)
			.join("\n");
		const message = [
			`Cannot complete merge: ${errors.length} unresolved issue(s) detected.`,
			errorDetails,
			"",
			`To resolve manually, edit files in: ${agentDir()}`,
			"Or choose a resolution strategy:",
			"  /sync merge --ours     (keep local configuration)",
			"  /sync merge --theirs   (use remote configuration)",
			"  /sync merge --abort    (discard merge and restore)",
		].join("\n");
		ctx.ui.notify(message, "error");
		return { pushed: false, pulled: false, merged: false, message };
	}

	const completed = await completeMerge(LOCAL_COMMIT_MESSAGE, { signal: ctx.signal });
	await copyMirrorToAgent(config);
	await refreshIndicator(ctx, config);
	const message = completed
		? "Merge completed. Applied cleanly to local configuration. Run /sync push to publish."
		: "Merge has no further changes to record. Run /sync push to publish.";
	ctx.ui.notify(message, "info");
	return { pushed: false, pulled: false, merged: true, message };
}

function describeChanges(summary: ReturnType<typeof diffSummary>): string {
	const parts: string[] = [];
	if (summary.added > 0) parts.push(`${summary.added} added`);
	if (summary.removed > 0) parts.push(`${summary.removed} removed`);
	if (summary.changed > 0) parts.push(`${summary.changed} changed`);
	return parts.length > 0 ? parts.join(", ") : "no differences";
}

export { stateDir };
