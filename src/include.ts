import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { addIncludeItems, type SyncConfig, saveConfig } from "./config.js";
import { agentDir } from "./paths.js";

const MAX_LIST_ENTRIES = 200;
const DONE_LABEL = "✔ done — save and exit";
const UP_LABEL = ".. (go up)";

export interface AgentEntry {
	name: string;
	isDirectory: boolean;
}

/**
 * List files and directories under an agent-relative directory ("" = agent dir
 * root). Symlinks are skipped to match snapshot scanning. Directories sort
 * first, then files, both alphabetically.
 */
export async function listAgentEntries(relativeDir: string): Promise<AgentEntry[]> {
	const absolute = relativeDir ? path.join(agentDir(), relativeDir) : agentDir();
	let entries: Dirent[];
	try {
		entries = await fs.readdir(absolute, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const result: AgentEntry[] = [];
	for (const entry of entries) {
		if (entry.isSymbolicLink()) continue;
		if (entry.isDirectory() || entry.isFile()) {
			result.push({ name: entry.name, isDirectory: entry.isDirectory() });
		}
	}
	result.sort((left, right) =>
		left.isDirectory === right.isDirectory
			? left.name.localeCompare(right.name)
			: left.isDirectory
				? -1
				: 1,
	);
	return result;
}

/**
 * Interactive picker: browse the agent dir, add files or whole directories to
 * the include list, then persist the updated config. Returns the updated config
 * or undefined when cancelled or nothing was added.
 */
export async function runIncludePicker(
	ui: ExtensionUIContext,
	config: SyncConfig,
): Promise<SyncConfig | undefined> {
	let include = [...config.include];
	let current = "";
	let added = 0;
	ui.notify(`Current include (${include.length}): ${include.join(", ") || "none"}`, "info");

	for (;;) {
		const entries = await listAgentEntries(current);
		const options: string[] = [];
		if (current !== "") options.push(UP_LABEL);
		options.push(DONE_LABEL);
		const limited = entries.slice(0, MAX_LIST_ENTRIES);
		for (const entry of limited) {
			const full = current ? `${current}/${entry.name}` : entry.name;
			options.push(entry.isDirectory ? `${full}/` : full);
		}
		if (entries.length > limited.length) {
			options.push(`… ${entries.length - limited.length} more entries (not shown)`);
		}
		const choice = await ui.select(
			current ? `agent dir — browsing ${current}/` : "agent dir — pick files to sync",
			options,
		);
		if (choice === undefined) return undefined;
		if (choice === DONE_LABEL) break;
		if (choice === UP_LABEL) {
			current = parentOf(current);
			continue;
		}
		if (choice.startsWith("…")) continue;
		if (choice.endsWith("/")) {
			current = choice.slice(0, -1);
			continue;
		}
		try {
			include = addIncludeItems({ ...config, include }, [choice]).include;
			added += 1;
			ui.notify(`+ ${choice}`, "info");
		} catch (error) {
			ui.notify(errorMessage(error), "warning");
		}
	}
	if (added === 0) {
		ui.notify("No include items added.", "info");
		return undefined;
	}
	await saveConfig({ ...config, include });
	ui.notify(`Saved. include (${include.length}): ${include.join(", ") || "none"}`, "info");
	return { ...config, include };
}

function parentOf(relativeDir: string): string {
	const index = relativeDir.lastIndexOf("/");
	return index < 0 ? "" : relativeDir.slice(0, index);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
