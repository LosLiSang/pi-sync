import fs from "node:fs/promises";
import path from "node:path";
import { agentDir, normalizeInclude } from "./paths.js";

export const CONFIG_FILE_NAME = "pi-sync.json";

export interface SyncConfig {
	remote: string;
	branch: string;
	include: string[];
	automatic: boolean;
}

export const DEFAULT_CONFIG: SyncConfig = {
	remote: "",
	branch: "pi-sync",
	include: [
		"settings.json",
		"keybindings.json",
		"models.json",
		"skills",
		"prompts",
		"themes",
		"extensions",
		"extension-settings",
	],
	automatic: true,
};

export const SNAPSHOT_FILE = "snapshot.json";
export const BACKUP_DIR = "backups";

export function configPath(): string {
	return path.join(agentDir(), CONFIG_FILE_NAME);
}

export function stateDir(): string {
	return path.join(agentDir(), "pi-sync");
}

export function mirrorRepoDir(): string {
	return path.join(stateDir(), "mirror");
}

export function snapshotFilePath(): string {
	return path.join(mirrorRepoDir(), "pi-sync", SNAPSHOT_FILE);
}

export function backupRootDir(): string {
	return path.join(stateDir(), BACKUP_DIR);
}

export async function loadConfig(): Promise<SyncConfig> {
	let text: string;
	try {
		text = await fs.readFile(configPath(), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { ...DEFAULT_CONFIG };
		}
		throw error;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new Error(`pi-sync config is not valid JSON: ${configPath()}`, { cause: error });
	}
	return parseConfig(parsed);
}

export function parseConfig(value: unknown): SyncConfig {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Invalid pi-sync config: expected an object.");
	}
	const record = value as Record<string, unknown>;
	const remote = record.remote;
	if (typeof remote !== "string" || remote.trim().length === 0) {
		throw new Error("Invalid pi-sync config: remote must be a non-empty git URL.");
	}
	const branch = record.branch;
	if (branch !== undefined && typeof branch !== "string") {
		throw new Error("Invalid pi-sync config: branch must be a string.");
	}
	if (typeof branch === "string" && (!/^[\w./-]+$/u.test(branch) || branch.includes(".."))) {
		throw new Error("Invalid pi-sync config: branch contains unsafe characters.");
	}
	const include =
		record.include === undefined ? [...DEFAULT_CONFIG.include] : normalizeInclude(record.include);
	const automatic =
		record.automatic === undefined ? DEFAULT_CONFIG.automatic : parseBoolean(record.automatic);
	return {
		remote: remote.trim(),
		branch: (branch ?? DEFAULT_CONFIG.branch).trim(),
		include,
		automatic,
	};
}

/** Add include entries, validating them and rejecting duplicates. Returns a new config. */
export function addIncludeItems(config: SyncConfig, items: string[]): SyncConfig {
	const include = normalizeInclude([...config.include, ...items]);
	return { ...config, include };
}

export async function saveConfig(config: SyncConfig): Promise<void> {
	await fs.mkdir(agentDir(), { recursive: true });
	const serialized = `${JSON.stringify(config, null, "\t")}\n`;
	await fs.writeFile(configPath(), serialized, { mode: 0o600 });
}

function parseBoolean(value: unknown): boolean {
	if (typeof value === "boolean") return value;
	if (value === "true" || value === 1) return true;
	if (value === "false" || value === 0) return false;
	throw new Error("Invalid pi-sync config: automatic must be a boolean.");
}
