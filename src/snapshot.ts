import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { SyncConfig } from "./config.js";
import { agentDir, syncRootPath } from "./paths.js";

export const SNAPSHOT_VERSION = 1;
export const MAX_SYNC_FILE_BYTES = 16 * 1024 * 1024;
const MAX_SCAN_FILES = 5_000;

export interface SnapshotFile {
	path: string;
	sha256: string;
	contentBase64: string;
}

export interface Snapshot {
	version: number;
	createdAt: string;
	files: SnapshotFile[];
}

export function snapshotSha256(snapshot: Snapshot): string {
	return createHash("sha256")
		.update(Buffer.from(JSON.stringify(snapshot)))
		.digest("hex");
}

export function fileHashMap(snapshot: Snapshot): Map<string, string> {
	return new Map(snapshot.files.map((file) => [file.path, file.sha256]));
}

/** Build the current snapshot of the configured include paths under the agent dir. */
export async function createSnapshot(config: SyncConfig): Promise<Snapshot> {
	const files: SnapshotFile[] = [];
	const seen = new Set<string>();
	for (const entry of config.include) {
		const root = syncRootPath(entry);
		if (!root) continue;
		await collectFiles(root, agentDir(), files, seen, entry);
	}
	files.sort((left, right) => left.path.localeCompare(right.path));
	return { version: SNAPSHOT_VERSION, createdAt: new Date().toISOString(), files };
}

async function collectFiles(
	root: string,
	baseDir: string,
	files: SnapshotFile[],
	seen: Set<string>,
	entry: string,
): Promise<void> {
	let stat: Awaited<ReturnType<typeof fs.lstat>>;
	try {
		stat = await fs.lstat(root);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	if (stat.isSymbolicLink()) return;
	if (stat.isFile()) {
		await collectFile(root, baseDir, files, seen, entry);
		return;
	}
	if (!stat.isDirectory()) return;
	await collectDirectory(root, baseDir, files, seen, entry);
}

async function collectDirectory(
	directory: string,
	baseDir: string,
	files: SnapshotFile[],
	seen: Set<string>,
	entry: string,
): Promise<void> {
	let entries: Dirent[];
	try {
		entries = await fs.readdir(directory, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	entries.sort((left, right) => left.name.localeCompare(right.name));
	for (const dirent of entries) {
		if (files.length >= MAX_SCAN_FILES) return;
		if (dirent.isSymbolicLink()) continue;
		const child = path.join(directory, dirent.name);
		if (dirent.isDirectory()) {
			await collectDirectory(child, baseDir, files, seen, entry);
		} else if (dirent.isFile()) {
			await collectFile(child, baseDir, files, seen, entry);
		}
	}
}

async function collectFile(
	filePath: string,
	baseDir: string,
	files: SnapshotFile[],
	seen: Set<string>,
	_entry: string,
): Promise<void> {
	const stat = await fs.stat(filePath);
	if (stat.size > MAX_SYNC_FILE_BYTES) return;
	const content = await fs.readFile(filePath);
	if (content.includes(0)) return;
	const relative = path.relative(baseDir, filePath).split(path.sep).join("/");
	if (!relative || relative.startsWith("../") || seen.has(relative)) return;
	seen.add(relative);
	files.push({
		path: relative,
		sha256: sha256Buffer(content),
		contentBase64: content.toString("base64"),
	});
}

function sha256Buffer(content: Buffer): string {
	return createHash("sha256").update(content).digest("hex");
}

/** Decode snapshot file content; returns undefined for unknown paths. */
export function snapshotFileContent(snapshot: Snapshot, filePath: string): string | undefined {
	const file = snapshot.files.find((candidate) => candidate.path === filePath);
	if (!file) return undefined;
	return Buffer.from(file.contentBase64, "base64").toString("utf8");
}
