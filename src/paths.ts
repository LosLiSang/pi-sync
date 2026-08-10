import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const BUILT_IN_SYNC_FILES = [
	"settings.json",
	"keybindings.json",
	"models.json",
	"skills",
	"prompts",
	"themes",
] as const;

export type BuiltInSyncFile = (typeof BUILT_IN_SYNC_FILES)[number];

export const DEFAULT_INCLUDE: readonly string[] = [...BUILT_IN_SYNC_FILES];

const TOP_LEVEL_FILE_NAMES = new Set<string>(
	BUILT_IN_SYNC_FILES.filter((name) => name.includes(".")),
);

/** Absolute agent directory (e.g. ~/.pi/agent), honoring PI_CODING_AGENT_DIR. */
export function agentDir(): string {
	return getAgentDir();
}

/** Absolute source path for one include entry. Returns undefined for unknown entries. */
export function syncRootPath(entry: string): string | undefined {
	const root = getAgentDir();
	switch (entry) {
		case "settings.json":
			return path.join(root, "settings.json");
		case "keybindings.json":
			return path.join(root, "keybindings.json");
		case "models.json":
			return path.join(root, "models.json");
		case "skills":
			return path.join(root, "skills");
		case "prompts":
			return path.join(root, "prompts");
		case "themes":
			return path.join(root, "themes");
		default:
			return undefined;
	}
}

export function isBuiltInTopLevelFile(name: string): boolean {
	return TOP_LEVEL_FILE_NAMES.has(name);
}

/** Normalize and validate an include list; throws on unsafe or duplicate entries. */
export function normalizeInclude(value: unknown): string[] {
	if (!Array.isArray(value)) {
		throw new Error("Invalid pi-sync config: include must be an array.");
	}
	const result: string[] = [];
	const seen = new Set<string>();
	for (const item of value) {
		if (typeof item !== "string") {
			throw new Error("Invalid pi-sync config: include items must be strings.");
		}
		const trimmed = item.trim();
		const lower = trimmed.toLowerCase();
		const builtIn = BUILT_IN_SYNC_FILES.find((name) => name.toLowerCase() === lower);
		const normalized = builtIn ?? trimmed;
		if (seen.has(normalized)) {
			throw new Error(`Invalid pi-sync config: duplicate include item: ${trimmed}`);
		}
		if (!builtIn) {
			validateAgentRelativeInclude(normalized);
		}
		seen.add(normalized);
		result.push(normalized);
	}
	return result;
}

function validateAgentRelativeInclude(value: string): void {
	if (!value || value === "." || value === ".." || value.startsWith("../")) {
		throw new Error(`Invalid pi-sync config: unsafe include item: ${value}`);
	}
	if (path.posix.isAbsolute(value) || value.includes("\\")) {
		throw new Error(`Invalid pi-sync config: include items must be agent-relative paths: ${value}`);
	}
	const normalized = path.posix.normalize(value);
	if (normalized !== value) {
		throw new Error(`Invalid pi-sync config: include items must be normalized paths: ${value}`);
	}
}
