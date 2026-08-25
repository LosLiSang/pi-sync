import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { SyncConfig } from "./config.js";
import { mirrorRepoDir } from "./config.js";
import { agentDir, syncRootPath } from "./paths.js";

export const MAX_SYNC_FILE_BYTES = 16 * 1024 * 1024;
const MAX_SCAN_FILES = 5_000;

export interface LocalFile {
	/** Agent-relative posix path (e.g. "skills/x/SKILL.md"). */
	path: string;
	/** Absolute source path under the agent dir. */
	source: string;
}

/**
 * Collect the real files under the configured include paths in the agent dir.
 * Symlinks are skipped; a path may appear under multiple include entries but is
 * scanned once. This is the "local side" of the sync — real files, not blobs.
 */
export async function collectAgentFiles(config: SyncConfig): Promise<LocalFile[]> {
	const files: LocalFile[] = [];
	const seen = new Set<string>();
	for (const entry of config.include) {
		const root = syncRootPath(entry);
		await collectRoot(root, files, seen);
	}
	files.sort((left, right) => left.path.localeCompare(right.path));
	return files;
}

async function collectRoot(root: string, files: LocalFile[], seen: Set<string>): Promise<void> {
	let stat: Awaited<ReturnType<typeof fs.lstat>>;
	try {
		stat = await fs.lstat(root);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	if (stat.isSymbolicLink()) return;
	if (stat.isFile()) {
		await collectFile(root, files, seen);
		return;
	}
	if (stat.isDirectory()) {
		await collectDirectory(root, files, seen);
	}
}

async function collectDirectory(
	directory: string,
	files: LocalFile[],
	seen: Set<string>,
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
			await collectDirectory(child, files, seen);
		} else if (dirent.isFile()) {
			await collectFile(child, files, seen);
		}
	}
}

async function collectFile(filePath: string, files: LocalFile[], seen: Set<string>): Promise<void> {
	const stat = await fs.stat(filePath);
	if (stat.size > MAX_SYNC_FILE_BYTES) return;
	const relative = path.relative(agentDir(), filePath).split(path.sep).join("/");
	if (!relative || relative.startsWith("../") || seen.has(relative)) return;
	seen.add(relative);
	files.push({ path: relative, source: filePath });
}

/** True when a relative path falls under an include entry (exact or dir prefix). */
export function pathMatchesInclude(relativePath: string, entry: string): boolean {
	const lower = entry.toLowerCase();
	const pathLower = relativePath.toLowerCase();
	return pathLower === lower || pathLower.startsWith(`${lower}/`);
}

/** Map an agent-relative path to its target inside the mirror work tree. */
export function mirrorTarget(relativePath: string): string {
	return path.join(mirrorRepoDir(), relativePath);
}

/** Map an agent-relative path to its absolute path under the agent dir. */
export function agentTarget(relativePath: string): string {
	return path.join(agentDir(), relativePath);
}

/** Read agent-file content as a path→content map for the include scope. */
export async function readAgentContents(config: SyncConfig): Promise<Map<string, string>> {
	const files = await collectAgentFiles(config);
	const map = new Map<string, string>();
	for (const file of files) {
		try {
			map.set(file.path, await fs.readFile(file.source, "utf8"));
		} catch {
			// Unreadable file — omit from the view.
		}
	}
	return map;
}

/** List the agent-relative paths currently present in the mirror include scope. */
export async function mirrorProjectedFiles(config: SyncConfig): Promise<string[]> {
	return collectMirrorFiles(mirrorRepoDir(), config);
}

/**
 * Overlay the agent dir's include content into the mirror work tree, deleting
 * any mirror files under an include-subtree that no longer exist on the local
 * side. This produces the "local side" tree for git to stage & merge.
 */
export async function graftAgentIntoMirror(
	config: SyncConfig,
	localFiles: LocalFile[],
): Promise<void> {
	const mirrorRoot = mirrorRepoDir();
	for (const file of localFiles) {
		const target = mirrorTarget(file.path);
		await fs.mkdir(path.dirname(target), { recursive: true });
		await fs.copyFile(file.source, target);
	}
	// Remove stale mirror files that are under an include path but absent locally.
	const stale = await collectMirrorFiles(mirrorRoot, config);
	for (const relative of stale) {
		if (!localFiles.some((file) => file.path === relative)) {
			await fs.rm(mirrorTarget(relative), { force: true });
		}
	}
	await removeEmptyDirs(mirrorRoot);
}

/** Collect all files currently in the mirror work tree that fall under an include path. */
async function collectMirrorFiles(mirrorRoot: string, config: SyncConfig): Promise<string[]> {
	const result: string[] = [];
	const seen = new Set<string>();
	await collectMirrorRoot(mirrorRoot, "", config, result, seen);
	return result;
}

async function collectMirrorRoot(
	mirrorRoot: string,
	relativeDir: string,
	config: SyncConfig,
	result: string[],
	seen: Set<string>,
): Promise<void> {
	let entries: Dirent[];
	try {
		entries = await fs.readdir(path.join(mirrorRoot, relativeDir), { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	entries.sort((left, right) => left.name.localeCompare(right.name));
	for (const dirent of entries) {
		const relative = relativeDir ? `${relativeDir}/${dirent.name}` : dirent.name;
		if (dirent.isSymbolicLink()) continue;
		if (dirent.isDirectory()) {
			await collectMirrorRoot(mirrorRoot, relative, config, result, seen);
		} else if (dirent.isFile()) {
			if (!config.include.some((entry) => pathMatchesInclude(relative, entry))) continue;
			if (seen.has(relative)) continue;
			seen.add(relative);
			result.push(relative);
		}
	}
}

/** Remove now-empty directories under the mirror root, bottom-up. */
async function removeEmptyDirs(root: string): Promise<void> {
	const dirs: string[] = [];
	const walk = async (dir: string): Promise<void> => {
		let entries: Dirent[];
		try {
			entries = await fs.readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const dirent of entries) {
			if (dirent.isDirectory()) await walk(path.join(dir, dirent.name));
		}
		dirs.push(dir);
	};
	await walk(root);
	for (const dir of dirs.reverse()) {
		if (dir === root) continue;
		try {
			const entries = await fs.readdir(dir);
			if (entries.length === 0) await fs.rmdir(dir);
		} catch {
			// ignore
		}
	}
}

/**
 * Apply the mirror work tree to the agent dir: copy include-scoped files over
 * and delete agent files under an include path that are absent from the mirror.
 */
export async function copyMirrorToAgent(config: SyncConfig): Promise<void> {
	const mirrorRoot = mirrorRepoDir();
	const projected = await mirrorProjectedFiles(config);
	for (const relative of projected) {
		const source = path.join(mirrorRoot, relative);
		const target = agentTarget(relative);
		await fs.mkdir(path.dirname(target), { recursive: true });
		await fs.copyFile(source, target);
	}
	// Delete agent files under an include path that are absent from the mirror.
	const localFiles = await collectAgentFiles(config);
	const projectedSet = new Set(projected);
	for (const file of localFiles) {
		if (projectedSet.has(file.path)) continue;
		await fs.rm(file.source, { force: true });
	}
}
