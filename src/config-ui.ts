import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { parseConfig, type SyncConfig, saveConfig } from "./config.js";
import { DEFAULT_INCLUDE, normalizeInclude } from "./paths.js";

export function formatConfig(config: SyncConfig): string {
	return [
		`remote: ${config.remote}`,
		`branch: ${config.branch}`,
		`automatic: ${config.automatic ? "enabled" : "disabled"}`,
		`included (${config.include.length}): ${config.include.join(", ") || "none"}`,
	].join("\n");
}

/**
 * Interactive config editor: show the current config, then loop over the
 * fields (remote/branch/include/automatic) letting the user change one at a
 * time. Each change is validated immediately; everything is saved atomically
 * when the user picks "done". Escaping discards pending changes.
 */
export async function runConfigEditor(ui: ExtensionUIContext, config: SyncConfig): Promise<void> {
	let current = { ...config };
	let dirty = false;
	ui.notify(formatConfig(current), "info");
	for (;;) {
		const field = await ui.select("pi-sync config — edit a field", [
			"remote",
			"branch",
			"include",
			"automatic",
			"done",
		]);
		if (field === undefined) {
			if (dirty) ui.notify("Config changes discarded.", "info");
			return;
		}
		if (field === "done") break;
		try {
			if (field === "include") {
				const result = await editInclude(ui, current);
				current = result.config;
				dirty = dirty || result.changed;
				continue;
			}
			let candidate: SyncConfig | undefined;
			if (field === "remote") {
				const value = await ui.input("Git remote URL", current.remote);
				if (value === undefined) continue;
				candidate = parseConfig({ ...current, remote: value.trim() });
			} else if (field === "branch") {
				const value = await ui.input("Remote branch", current.branch);
				if (value === undefined) continue;
				candidate = parseConfig({ ...current, branch: value.trim() || undefined });
			} else if (field === "automatic") {
				const value = await ui.confirm(
					"Enable automatic sync?",
					`Fetch at session start and refresh the indicator.\nCurrently: ${current.automatic ? "enabled" : "disabled"}`,
				);
				candidate = parseConfig({ ...current, automatic: value });
			}
			if (candidate) {
				current = candidate;
				dirty = true;
				const shown =
					field === "automatic"
						? current.automatic
							? "enabled"
							: "disabled"
						: field === "branch"
							? current.branch
							: current.remote;
				ui.notify(`${field}: ${shown}`, "info");
			}
		} catch (error) {
			ui.notify(errorMessage(error), "warning");
		}
	}
	await saveConfig(current);
	ui.notify(`Config saved.\n${formatConfig(current)}`, "info");
}

async function editInclude(
	ui: ExtensionUIContext,
	config: SyncConfig,
): Promise<{ config: SyncConfig; changed: boolean }> {
	let current = { ...config };
	let changed = false;
	for (;;) {
		const action = await ui.select(
			`include (${current.include.length}): ${current.include.join(", ") || "none"}`,
			["＋ add a path", "－ remove a path", "✔ done"],
		);
		if (action === undefined || action === "✔ done") return { config: current, changed };
		if (action === "＋ add a path") {
			const candidates = [
				...DEFAULT_INCLUDE.filter((name) => !current.include.includes(name)),
				"type a path…",
			];
			const picked = await ui.select("Add include path", candidates);
			if (picked === undefined) continue;
			let entry = picked;
			if (picked === "type a path…") {
				const typed = await ui.input("Agent-relative path to include (e.g. AGENTS.md)");
				if (typed === undefined) continue;
				entry = typed.trim();
			}
			if (entry.length === 0) continue;
			try {
				current = addInclude(current, entry);
				changed = true;
				ui.notify(`+ ${entry}`, "info");
			} catch (error) {
				ui.notify(errorMessage(error), "warning");
			}
		} else {
			if (current.include.length === 0) {
				ui.notify("Nothing to remove.", "info");
				continue;
			}
			const picked = await ui.select("Remove include path", current.include);
			if (picked === undefined) continue;
			current = {
				...current,
				include: normalizeInclude(current.include.filter((name) => name !== picked)),
			};
			changed = true;
			ui.notify(`− ${picked}`, "info");
		}
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Validate an additional include entry (throws on unsafe or duplicate). */
function addInclude(config: SyncConfig, entry: string): SyncConfig {
	return { ...config, include: normalizeInclude([...config.include, entry]) };
}
