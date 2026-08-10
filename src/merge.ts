import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runGit } from "./git.js";
import { fileHashMap, type Snapshot, snapshotFileContent } from "./snapshot.js";

export interface MergeOutcome {
	/** Files kept from the local side because only local changed. */
	takeLocal: string[];
	/** Files taken from the remote side because only remote changed. */
	takeRemote: string[];
	/** Files left with conflict markers for the user to resolve. */
	conflicts: string[];
	/** Files identical on both sides. */
	unchanged: string[];
}

export interface FileMerge {
	path: string;
	merged: string;
	conflicted: boolean;
}

/**
 * Three-way merge of local and remote snapshots against the base snapshot.
 * Per-file rule: unchanged files pass through, only-one-side-changed files are
 * taken from that side, and truly divergent files need a line-level merge.
 */
export function planMerge(
	local: Snapshot,
	remote: Snapshot,
	base: Snapshot | undefined,
): MergeOutcome {
	const localMap = fileHashMap(local);
	const remoteMap = fileHashMap(remote);
	const baseMap = fileHashMap(base ?? emptySnapshot());
	const paths = [...new Set([...localMap.keys(), ...remoteMap.keys()])].sort();
	const outcome: MergeOutcome = { takeLocal: [], takeRemote: [], conflicts: [], unchanged: [] };

	for (const filePath of paths) {
		const localHash = localMap.get(filePath);
		const remoteHash = remoteMap.get(filePath);
		if (localHash === remoteHash) {
			outcome.unchanged.push(filePath);
			continue;
		}
		const baseHash = baseMap.get(filePath);
		const localChanged = localHash !== baseHash;
		const remoteChanged = remoteHash !== baseHash;
		if (!remoteChanged) {
			outcome.takeLocal.push(filePath);
			continue;
		}
		if (!localChanged) {
			outcome.takeRemote.push(filePath);
			continue;
		}
		outcome.conflicts.push(filePath);
	}
	return outcome;
}

/**
 * Line-level three-way merge of two file texts against a base using git
 * merge-file. JSON files merge field-wise first (so single-line settings
 * don't conflict over formatting); divergent values fall back to git
 * merge-file conflict markers.
 */
export async function mergeTexts(
	base: string,
	local: string,
	remote: string,
	signal?: AbortSignal,
): Promise<{ merged: string; conflicted: boolean }> {
	const jsonMerged = tryJsonMerge(base, local, remote);
	if (jsonMerged !== undefined) {
		return { merged: jsonMerged, conflicted: false };
	}
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pi-sync-merge-"));
	try {
		const basePath = path.join(directory, "base");
		const localPath = path.join(directory, "local");
		const remotePath = path.join(directory, "remote");
		await fs.writeFile(basePath, base);
		await fs.writeFile(localPath, local);
		await fs.writeFile(remotePath, remote);
		try {
			// merge-file writes the result into the local file; it exits 1 when
			// conflicts remain and the merged content with markers is still written.
			await runGit(["merge-file", "--diff3", localPath, basePath, remotePath], { signal });
		} catch (error) {
			if (!isMergeConflictExit(error)) throw error;
		}
		const merged = await fs.readFile(localPath, "utf8");
		return { merged, conflicted: hasConflictMarkers(merged) };
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
}

/**
 * Field-level three-way merge for JSON documents. Returns undefined when the
 * documents are not all valid JSON or a value diverges on all three sides.
 */
function tryJsonMerge(base: string, local: string, remote: string): string | undefined {
	let baseValue: unknown;
	let localValue: unknown;
	let remoteValue: unknown;
	try {
		baseValue = JSON.parse(base);
		localValue = JSON.parse(local);
		remoteValue = JSON.parse(remote);
	} catch {
		return undefined;
	}
	const merged = mergeJsonValue(baseValue, localValue, remoteValue);
	if (!merged.ok) return undefined;
	return `${JSON.stringify(merged.value, null, 2)}\n`;
}

function mergeJsonValue(
	base: unknown,
	local: unknown,
	remote: unknown,
): { ok: true; value: unknown } | { ok: false } {
	if (local === remote) return { ok: true, value: local };
	if (base === local) return { ok: true, value: remote };
	if (base === remote) return { ok: true, value: local };
	if (isPlainObject(local) && isPlainObject(remote) && isPlainObject(base)) {
		const keys = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)]);
		const result: Record<string, unknown> = {};
		for (const key of keys) {
			const merged = mergeJsonValue(
				(base as Record<string, unknown>)[key],
				(local as Record<string, unknown>)[key],
				(remote as Record<string, unknown>)[key],
			);
			if (!merged.ok) return { ok: false };
			if (merged.value !== undefined) result[key] = merged.value;
		}
		return { ok: true, value: result };
	}
	return { ok: false };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasConflictMarkers(text: string): boolean {
	return (
		text.includes("<<<<<<<") ||
		text.includes(">>>>>>>") ||
		text.includes("|||||||") ||
		text.includes("=======")
	);
}

function isMergeConflictExit(error: unknown): boolean {
	return (
		error instanceof Error &&
		error.name === "GitCommandError" &&
		(error as { exitCode?: number | null }).exitCode === 1
	);
}

/**
 * Build the merged snapshot after resolving a merge plan: unchanged files pass
 * through, takeRemote files adopt the remote content, and conflict files use
 * the caller-provided merged text (falling back to local content).
 */
export function mergeSnapshot(
	local: Snapshot,
	remote: Snapshot,
	outcome: MergeOutcome,
	conflictContents: Map<string, string> = new Map(),
): Snapshot {
	const adoptRemote = new Set(outcome.takeRemote);
	const files: Snapshot["files"] = [];
	for (const file of local.files) {
		if (adoptRemote.has(file.path)) continue;
		const merged = conflictContents.get(file.path);
		if (merged !== undefined) {
			files.push({ ...file, contentBase64: Buffer.from(merged).toString("base64") });
			continue;
		}
		files.push(file);
	}
	for (const file of remote.files) {
		if (adoptRemote.has(file.path)) files.push(file);
	}
	files.sort((left, right) => left.path.localeCompare(right.path));
	return { version: local.version, createdAt: new Date().toISOString(), files };
}

export function emptySnapshot(): Snapshot {
	return { version: 1, createdAt: new Date().toISOString(), files: [] };
}

/** Read a file text from any snapshot by path. */
export function textFromSnapshot(snapshot: Snapshot, filePath: string): string {
	return snapshotFileContent(snapshot, filePath) ?? "";
}
