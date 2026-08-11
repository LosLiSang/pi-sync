import fs from "node:fs/promises";
import path from "node:path";
import { stateDir } from "./config.js";

const SESSION_DIR = "merge-session";
const SESSION_FILE = "session.json";

export type BlockChoice = "local" | "remote" | "custom";

/** One divergent block from a merged file; resolution is set when the user resolves it. */
export interface ConflictBlock {
	local: string;
	base: string;
	remote: string;
	resolution: string | undefined;
	choice: BlockChoice | undefined;
}

export interface MergeFileState {
	path: string;
	blocks: ConflictBlock[];
}

/**
 * The persistent state of one conflict-resolution session. Lives in its own
 * file (block contents can be large) so state.json stays small and backward
 * compatible; only the presence of this file marks an incomplete merge.
 */
export interface MergeSessionData {
	baselineRevision: string;
	backupDir: string;
	createdAt: string;
	files: MergeFileState[];
}

export function mergeSessionDir(): string {
	return path.join(stateDir(), SESSION_DIR);
}

export function mergeSessionFilePath(): string {
	return path.join(mergeSessionDir(), SESSION_FILE);
}

export async function loadMergeSession(): Promise<MergeSessionData | undefined> {
	let text: string;
	try {
		text = await fs.readFile(mergeSessionFilePath(), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	try {
		return parseMergeSession(JSON.parse(text));
	} catch {
		return undefined;
	}
}

export async function saveMergeSession(session: MergeSessionData): Promise<void> {
	await fs.mkdir(mergeSessionDir(), { recursive: true });
	const serialized = `${JSON.stringify(session, null, "\t")}\n`;
	await fs.writeFile(mergeSessionFilePath(), serialized, { mode: 0o600 });
}

export async function clearMergeSession(): Promise<void> {
	await fs.rm(mergeSessionDir(), { recursive: true, force: true });
}

/** True when a merge session file exists and parses. */
export async function hasMergeSession(): Promise<boolean> {
	return (await loadMergeSession()) !== undefined;
}

function parseMergeSession(value: unknown): MergeSessionData | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (
		typeof record.baselineRevision !== "string" ||
		typeof record.backupDir !== "string" ||
		typeof record.createdAt !== "string" ||
		!Array.isArray(record.files)
	) {
		return undefined;
	}
	const files: MergeFileState[] = [];
	for (const file of record.files) {
		const parsed = parseMergeFile(file);
		if (!parsed) return undefined;
		files.push(parsed);
	}
	return {
		baselineRevision: record.baselineRevision,
		backupDir: record.backupDir,
		createdAt: record.createdAt,
		files,
	};
}

function parseMergeFile(value: unknown): MergeFileState | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (typeof record.path !== "string" || !Array.isArray(record.blocks)) return undefined;
	const blocks: ConflictBlock[] = [];
	for (const block of record.blocks) {
		const parsed = parseBlock(block);
		if (!parsed) return undefined;
		blocks.push(parsed);
	}
	return { path: record.path, blocks };
}

function parseBlock(value: unknown): ConflictBlock | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (
		typeof record.local !== "string" ||
		typeof record.base !== "string" ||
		typeof record.remote !== "string"
	) {
		return undefined;
	}
	const resolution = record.resolution ?? undefined;
	if (resolution !== undefined && typeof resolution !== "string") return undefined;
	const choice = record.choice ?? undefined;
	if (choice !== undefined && choice !== "local" && choice !== "remote" && choice !== "custom") {
		return undefined;
	}
	return { local: record.local, base: record.base, remote: record.remote, resolution, choice };
}
