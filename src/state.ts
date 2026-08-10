import fs from "node:fs/promises";
import path from "node:path";
import { stateDir } from "./config.js";

const STATE_FILE_NAME = "state.json";
const STATE_VERSION = 1;

export interface SyncState {
	version: number;
	lastAppliedSnapshot: string;
	lastRemoteRevision: string | undefined;
	lastHashes: Record<string, string>;
}

export function stateFilePath(): string {
	return path.join(stateDir(), STATE_FILE_NAME);
}

export async function loadState(): Promise<SyncState | undefined> {
	let text: string;
	try {
		text = await fs.readFile(stateFilePath(), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return undefined;
	}
	return parseState(parsed);
}

export async function saveState(state: SyncState): Promise<void> {
	await fs.mkdir(stateDir(), { recursive: true });
	const serialized = `${JSON.stringify(state, null, "\t")}\n`;
	await fs.writeFile(stateFilePath(), serialized, { mode: 0o600 });
}

function parseState(value: unknown): SyncState | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (record.version !== STATE_VERSION || typeof record.lastAppliedSnapshot !== "string") {
		return undefined;
	}
	return {
		version: STATE_VERSION,
		lastAppliedSnapshot: record.lastAppliedSnapshot,
		lastRemoteRevision:
			typeof record.lastRemoteRevision === "string" ? record.lastRemoteRevision : undefined,
		lastHashes: isHashMap(record.lastHashes) ? record.lastHashes : {},
	};
}

function isHashMap(value: unknown): value is Record<string, string> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	return Object.values(value).every((item) => typeof item === "string");
}
