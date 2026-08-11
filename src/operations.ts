import fs from "node:fs/promises";
import path from "node:path";
import type {
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import type { SyncConfig } from "./config.js";
import { backupRootDir, stateDir } from "./config.js";
import { applyResolutions, parseConflictBlocks } from "./conflict.js";
import { diffSummary, formatSnapshotDiff } from "./diff.js";
import {
	fetchRemote,
	isRemoteUpToDate,
	listHistory,
	publishSnapshot,
	readRemoteRevision,
	readRemoteSnapshot,
	readSnapshotAt,
} from "./git.js";
import {
	type MergeOutcome,
	mergeSnapshot,
	mergeTexts,
	planMerge,
	textFromSnapshot,
} from "./merge.js";
import {
	clearMergeSession,
	hasMergeSession,
	type MergeFileState,
	type MergeSessionData,
	saveMergeSession,
} from "./merge-session.js";
import { agentDir, syncRootPath } from "./paths.js";
import { runBlockResolver } from "./resolve.js";
import { createSnapshot, type Snapshot, snapshotSha256 } from "./snapshot.js";
import { loadState, saveState } from "./state.js";
import { deriveSyncStatus, syncIndicatorText } from "./status.js";

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

/**
 * Refresh the persistent status-bar sync indicator from the last known
 * local↔remote state. Never fetches; call after fetch/pull/push/merge.
 */
export async function refreshIndicator(ctx: OperationContext, config: SyncConfig): Promise<void> {
	try {
		const [local, remote, state] = await Promise.all([
			createSnapshot(config),
			readRemoteSnapshot(config),
			loadState(),
		]);
		const base = state?.lastRemoteRevision
			? await readSnapshotAt(state.lastRemoteRevision, { signal: ctx.signal })
			: undefined;
		ctx.ui.setStatus("sync", syncIndicatorText(deriveSyncStatus(local, remote, base)));
	} catch {
		ctx.ui.setStatus(
			"sync",
			syncIndicatorText({ label: "unknown", ahead: 0, behind: 0, conflicts: 0 }),
		);
	}
}

export async function status(ctx: CommandContext, config: SyncConfig): Promise<SyncResult> {
	await fetchRemote(config, { signal: ctx.signal });
	const [local, remote, remoteRevision, state] = await Promise.all([
		createSnapshot(config),
		readRemoteSnapshot(config),
		readRemoteRevision(config),
		loadState(),
	]);
	const localSummary = diffSummary(local, remote ?? emptySnapshot());
	const lines = [
		`remote: ${config.remote}`,
		`branch: ${config.branch}`,
		`automatic: ${config.automatic ? "enabled" : "disabled"}`,
		`included: ${config.include.join(", ") || "none"}`,
	];
	if (!remote) {
		lines.push("remote: empty — nothing synced yet");
	} else {
		lines.push(
			`remote: ${remote.files.length} files (${shortId(remoteRevision ?? "")})`,
			`local changes vs remote: ${describeChanges(localSummary)}`,
		);
	}
	if (state) {
		lines.push(`last applied: ${shortId(state.lastAppliedSnapshot)}`);
	}
	ctx.ui.notify(lines.join("\n"), localSummary.identical ? "info" : "warning");
	return { pushed: false, pulled: false, merged: false, message: "status" };
}

export async function diff(ctx: CommandContext, config: SyncConfig): Promise<SyncResult> {
	await fetchRemote(config, { signal: ctx.signal });
	const [local, remote] = await Promise.all([createSnapshot(config), readRemoteSnapshot(config)]);
	const header = [
		`remote: ${config.remote}`,
		`branch: ${config.branch}`,
		`included: ${config.include.join(", ") || "none"}`,
	].join("\n");
	if (!remote) {
		ctx.ui.notify(
			`${header}\n\nRemote is empty. Run /sync push to publish local content.`,
			"warning",
		);
		return { pushed: false, pulled: false, merged: false, message: "diff" };
	}
	ctx.ui.notify(`${header}\n\n${formatSnapshotDiff(local, remote)}`, "warning");
	return { pushed: false, pulled: false, merged: false, message: "diff" };
}

export async function push(
	ctx: CommandContext,
	config: SyncConfig,
	options: { force?: boolean } = {},
): Promise<SyncResult> {
	await fetchRemote(config, { signal: ctx.signal });
	if (await hasMergeSession()) {
		const message =
			"A merge is in progress. Resolve it (/sync merge) or discard it (/sync merge --abort) before pushing.";
		ctx.ui.notify(message, "error");
		return { pushed: false, pulled: false, merged: false, message };
	}
	const [local, remoteRevision, remote, state] = await Promise.all([
		createSnapshot(config),
		readRemoteRevision(config),
		readRemoteSnapshot(config),
		loadState(),
	]);
	if (
		remote &&
		state &&
		!isRemoteUpToDate(state.lastRemoteRevision, remoteRevision) &&
		!options.force
	) {
		const message =
			"Remote changed since the last sync. Run /sync fetch + /sync merge to reconcile, or /sync push --force to overwrite.";
		ctx.ui.notify(message, "error");
		return { pushed: false, pulled: false, merged: false, message };
	}
	const revision = await publishSnapshot(config, local, { signal: ctx.signal }, options.force);
	await saveState({
		version: 1,
		lastAppliedSnapshot: snapshotSha256(local),
		lastRemoteRevision: revision,
		lastHashes: Object.fromEntries(local.files.map((file) => [file.path, file.sha256])),
	});
	await clearMergeSession();
	await refreshIndicator(ctx, config);
	const message = `Pushed ${local.files.length} files from ${agentDir()} to ${config.branch}.`;
	ctx.ui.notify(message, "info");
	return { pushed: true, pulled: false, merged: false, message };
}

export async function pull(
	ctx: CommandContext,
	config: SyncConfig,
	options: { force?: boolean; merge?: boolean } = {},
): Promise<SyncResult> {
	await fetchRemote(config, { signal: ctx.signal });
	const [local, remote, remoteRevision, state] = await Promise.all([
		createSnapshot(config),
		readRemoteSnapshot(config),
		readRemoteRevision(config),
		loadState(),
	]);
	if (!remote) {
		const message = "Remote is empty. Run /sync push first.";
		ctx.ui.notify(message, "warning");
		return { pushed: false, pulled: false, merged: false, message };
	}
	const base = state?.lastRemoteRevision
		? await readSnapshotAt(state.lastRemoteRevision, { signal: ctx.signal })
		: undefined;
	const plan = planMerge(local, remote, base);
	const diverged =
		plan.conflicts.length > 0 || (plan.takeLocal.length > 0 && plan.takeRemote.length > 0);

	if (!diverged) {
		if (plan.takeRemote.length === 0) {
			const message =
				plan.takeLocal.length > 0
					? "Already up to date; local is ahead. Run /sync push to publish."
					: "Already up to date.";
			ctx.ui.notify(message, "info");
			await refreshIndicator(ctx, config);
			return { pushed: false, pulled: false, merged: false, message };
		}
		// Fast-forward: apply the merged snapshot (remote-only changes).
		const merged = mergeSnapshot(local, remote, plan);
		await applySnapshot(merged, config);
		await saveState({
			version: 1,
			lastAppliedSnapshot: snapshotSha256(merged),
			lastRemoteRevision: remoteRevision,
			lastHashes: Object.fromEntries(merged.files.map((file) => [file.path, file.sha256])),
		});
		await clearMergeSession();
		await refreshIndicator(ctx, config);
		const message = `Pulled ${plan.takeRemote.length} file(s) from ${config.branch} (${shortId(remoteRevision ?? "")}).`;
		ctx.ui.notify(message, "info");
		return { pushed: false, pulled: true, merged: false, message };
	}

	if (options.force) {
		const backup = await backupLocalFiles(local);
		await applySnapshot(remote, config);
		await saveState({
			version: 1,
			lastAppliedSnapshot: snapshotSha256(remote),
			lastRemoteRevision: remoteRevision,
			lastHashes: Object.fromEntries(remote.files.map((file) => [file.path, file.sha256])),
		});
		await clearMergeSession();
		await refreshIndicator(ctx, config);
		const message = `Overwrote local files with the remote snapshot (${remote.files.length} files). Backup: ${backup}`;
		ctx.ui.notify(message, "warning");
		return { pushed: false, pulled: true, merged: false, message };
	}

	if (options.merge) {
		return startMergeFlow(ctx, config, local, remote, base, plan, remoteRevision ?? "");
	}

	const message =
		"Local and remote diverged. /sync pull --merge to resolve conflicts, /sync pull --force to overwrite local files.";
	ctx.ui.notify(message, "warning");
	await refreshIndicator(ctx, config);
	return { pushed: false, pulled: false, merged: false, message, conflicts: plan.conflicts };
}

/**
 * Start a conflict-resolution session: apply remote-only and cleanly-merged
 * files, write diff3 markers for divergent files, then walk the blocks with
 * the structured resolver. Persists progress block-by-block; completion writes
 * the resolved files and clears the session.
 */
async function startMergeFlow(
	ctx: CommandContext,
	config: SyncConfig,
	local: Snapshot,
	remote: Snapshot,
	base: Snapshot | undefined,
	plan: MergeOutcome,
	remoteRevision: string,
): Promise<SyncResult> {
	if (await hasMergeSession()) {
		const message =
			"A merge is already in progress. Continue with /sync merge or discard it with /sync merge --abort.";
		ctx.ui.notify(message, "warning");
		return { pushed: false, pulled: false, merged: false, message };
	}
	const backup = await backupLocalFiles(local);
	const conflictContents = new Map<string, string>();
	const sessionFiles: MergeFileState[] = [];
	for (const filePath of plan.conflicts) {
		const merged = await mergeTexts(
			textFromSnapshot(base ?? emptySnapshot(), filePath),
			textFromSnapshot(local, filePath),
			textFromSnapshot(remote, filePath),
			ctx.signal,
		);
		conflictContents.set(filePath, merged.merged);
		const blocks = parseConflictBlocks(merged.merged);
		if (blocks.length > 0) {
			sessionFiles.push({
				path: filePath,
				merged: merged.merged,
				blocks: blocks.map((block) => block.block),
			});
		}
	}
	// Remote-only files and field-merged conflict files apply immediately;
	// divergent files get their diff3 markers written to disk.
	const toWrite = new Map<string, string>();
	for (const filePath of plan.takeRemote) {
		toWrite.set(filePath, textFromSnapshot(remote, filePath));
	}
	for (const [filePath, mergedText] of conflictContents) {
		if (!sessionFiles.some((file) => file.path === filePath)) {
			toWrite.set(filePath, mergedText);
		}
	}
	for (const file of sessionFiles) {
		toWrite.set(file.path, file.merged);
	}
	for (const [filePath, content] of toWrite) {
		await writeAgentContent(config, filePath, content);
	}
	const session: MergeSessionData = {
		baselineRevision: remoteRevision,
		backupDir: backup,
		createdAt: new Date().toISOString(),
		files: sessionFiles,
	};
	await saveMergeSession(session);
	await refreshIndicator(ctx, config);
	if (sessionFiles.length === 0) {
		return finishMergeSession(ctx, config, session, plan.takeRemote.length, plan.takeLocal.length);
	}
	const result = await runBlockResolver(ctx.ui, session);
	if (!result.completed) {
		const pending = countPendingBlocks(session);
		const message = `Merge in progress: ${pending} conflict block(s) left. /sync merge to continue, /sync merge --abort to discard.`;
		ctx.ui.notify(message, "warning");
		return {
			pushed: false,
			pulled: false,
			merged: true,
			message,
			conflicts: sessionFiles.map((file) => file.path),
		};
	}
	return finishMergeSession(ctx, config, session, plan.takeRemote.length, plan.takeLocal.length);
}

/** Write the resolved files, record the applied snapshot, and clear the session. */
async function finishMergeSession(
	ctx: CommandContext,
	config: SyncConfig,
	session: MergeSessionData,
	remoteTaken: number,
	localKept: number,
): Promise<SyncResult> {
	for (const file of session.files) {
		const content = applyResolutions(
			file.merged,
			file.blocks.map((block) => block.resolution),
		);
		await writeAgentContent(config, file.path, content);
	}
	const finalSnapshot = await createSnapshot(config);
	await saveState({
		version: 1,
		lastAppliedSnapshot: snapshotSha256(finalSnapshot),
		lastRemoteRevision: session.baselineRevision,
		lastHashes: Object.fromEntries(finalSnapshot.files.map((file) => [file.path, file.sha256])),
	});
	await clearMergeSession();
	await refreshIndicator(ctx, config);
	const resolved = session.files.reduce((sum, file) => sum + file.blocks.length, 0);
	const message = `Merged: ${resolved} conflict block(s) resolved, ${remoteTaken} remote, ${localKept} local. Run /sync push to publish.`;
	ctx.ui.notify(message, "info");
	return { pushed: false, pulled: false, merged: true, message, conflicts: [] };
}

function countPendingBlocks(session: MergeSessionData): number {
	return session.files.reduce(
		(sum, file) => sum + file.blocks.filter((block) => block.resolution === undefined).length,
		0,
	);
}

async function writeAgentContent(
	config: SyncConfig,
	relativePath: string,
	content: string,
): Promise<void> {
	const target = resolveSnapshotTarget(relativePath, config);
	if (!target) return;
	await fs.mkdir(path.dirname(target), { recursive: true });
	await fs.writeFile(target, content);
}

export async function fetch(
	ctx: CommandContext,
	config: SyncConfig,
	options: { quiet?: boolean } = {},
): Promise<SyncResult> {
	await fetchRemote(config, { signal: ctx.signal });
	const [remote, remoteRevision, local] = await Promise.all([
		readRemoteSnapshot(config),
		readRemoteRevision(config),
		createSnapshot(config),
	]);
	await refreshIndicator(ctx, config);
	if (!remote) {
		const message = "Remote is empty. Run /sync push to publish local content.";
		if (!options.quiet) ctx.ui.notify(message, "info");
		return { pushed: false, pulled: false, merged: false, message };
	}
	const summary = diffSummary(local, remote);
	const message = `Fetched ${remote.files.length} files from ${config.branch} (${shortId(remoteRevision ?? "")}). ${describeChanges(summary)}.`;
	if (!options.quiet) ctx.ui.notify(message, summary.identical ? "info" : "warning");
	return { pushed: false, pulled: false, merged: false, message };
}

export async function merge(ctx: CommandContext, config: SyncConfig): Promise<SyncResult> {
	await fetchRemote(config, { signal: ctx.signal });
	const [local, remote, remoteRevision, state] = await Promise.all([
		createSnapshot(config),
		readRemoteSnapshot(config),
		readRemoteRevision(config),
		loadState(),
	]);
	if (!remote) {
		const message = "Remote is empty. Run /sync push first.";
		ctx.ui.notify(message, "warning");
		return { pushed: false, pulled: false, merged: false, message };
	}
	const base = state?.lastRemoteRevision
		? await readSnapshotAt(state.lastRemoteRevision, { signal: ctx.signal })
		: undefined;
	const plan = planMerge(local, remote, base);

	// Line-level merge for divergent files; JSON files merge field-wise and
	// only files that still carry conflict markers count as unresolved.
	const conflictContents = new Map<string, string>();
	const unresolved: string[] = [];
	for (const filePath of plan.conflicts) {
		const merged = await mergeTexts(
			textFromSnapshot(base ?? emptySnapshot(), filePath),
			textFromSnapshot(local, filePath),
			textFromSnapshot(remote, filePath),
			ctx.signal,
		);
		conflictContents.set(filePath, merged.merged);
		if (merged.conflicted) unresolved.push(filePath);
	}
	const merged = mergeSnapshot(local, remote, plan, conflictContents);
	await backupLocalFiles(merged);
	await applySnapshot(merged, config);
	await saveState({
		version: 1,
		lastAppliedSnapshot: snapshotSha256(merged),
		lastRemoteRevision: remoteRevision,
		lastHashes: Object.fromEntries(merged.files.map((file) => [file.path, file.sha256])),
	});
	if (unresolved.length === 0) {
		const message = `Merged cleanly: ${plan.takeRemote.length} remote, ${plan.takeLocal.length} local, ${plan.conflicts.length} field-merged.`;
		ctx.ui.notify(message, "info");
		return { pushed: false, pulled: false, merged: true, message };
	}
	const message = [
		`Merged with ${unresolved.length} conflict(s):`,
		...unresolved.map((filePath) => `  ${filePath} (markers written; edit then /sync push)`),
	].join("\n");
	ctx.ui.notify(message, "warning");
	return { pushed: false, pulled: false, merged: true, message, conflicts: unresolved };
}

export async function history(ctx: CommandContext, config: SyncConfig): Promise<SyncResult> {
	await fetchRemote(config, { signal: ctx.signal });
	const entries = await listHistory({ signal: ctx.signal });
	if (entries.length === 0) {
		ctx.ui.notify("No pi-sync history on the remote branch yet.", "info");
		return { pushed: false, pulled: false, merged: false, message: "history" };
	}
	const lines = entries.map((entry) => `${shortId(entry.id)}  ${entry.date}  ${entry.message}`);
	ctx.ui.notify(lines.join("\n"), "info");
	return { pushed: false, pulled: false, merged: false, message: "history" };
}

/** Apply a snapshot by writing its files back into the agent directory. */
export async function applySnapshot(snapshot: Snapshot, config: SyncConfig): Promise<void> {
	for (const file of snapshot.files) {
		const target = resolveSnapshotTarget(file.path, config);
		if (!target) continue;
		await fs.mkdir(path.dirname(target), { recursive: true });
		await fs.writeFile(target, Buffer.from(file.contentBase64, "base64"));
	}
}

function resolveSnapshotTarget(relativePath: string, config: SyncConfig): string | undefined {
	if (relativePath.split("/").some((segment) => segment === "..")) return undefined;
	const entry = config.include.find((candidate) => {
		const lower = candidate.toLowerCase();
		return (
			relativePath.toLowerCase() === lower || relativePath.toLowerCase().startsWith(`${lower}/`)
		);
	});
	if (!entry) return undefined;
	const root = syncRootPath(entry);
	const suffix = relativePath.slice(entry.length);
	return path.join(root, suffix);
}

async function backupLocalFiles(local: Snapshot): Promise<string> {
	const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
	const directory = path.join(backupRootDir(), stamp);
	await fs.mkdir(directory, { recursive: true });
	for (const file of local.files) {
		const target = path.join(directory, file.path);
		await fs.mkdir(path.dirname(target), { recursive: true });
		await fs.writeFile(target, Buffer.from(file.contentBase64, "base64"));
	}
	return directory;
}

function describeChanges(summary: ReturnType<typeof diffSummary>): string {
	const parts: string[] = [];
	if (summary.added > 0) parts.push(`${summary.added} added`);
	if (summary.removed > 0) parts.push(`${summary.removed} removed`);
	if (summary.changed > 0) parts.push(`${summary.changed} changed`);
	return parts.length > 0 ? parts.join(", ") : "no differences";
}

function shortId(value: string): string {
	return value.length > 10 ? value.slice(0, 10) : value;
}

function emptySnapshot(): Snapshot {
	return { version: 1, createdAt: new Date().toISOString(), files: [] };
}

export { stateDir };
