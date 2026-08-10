import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG, loadConfig, type SyncConfig, saveConfig } from "./config.js";
import { DEFAULT_INCLUDE } from "./paths.js";

const INCLUDE_CHOICES = [
	"settings.json",
	"keybindings.json",
	"models.json",
	"skills",
	"prompts",
	"themes",
	"extensions",
	"extension-settings",
];

/**
 * First-run wizard: collect the git remote, branch, included content, and the
 * automatic-sync switch, then persist a single config file.
 */
export async function runSetupWizard(ui: ExtensionUIContext): Promise<SyncConfig | undefined> {
	const existing = await loadConfig();
	const hasConfig = existing.remote.length > 0;

	const remote = await ui.input("Git remote URL", "git@github.com:you/pi-sync.git or https://…");
	if (remote === undefined) return undefined;
	if (remote.trim().length === 0) {
		ui.notify("pi-sync setup cancelled: a git remote is required.", "warning");
		return undefined;
	}

	const branchInput = await ui.input("Remote branch", existing.branch || DEFAULT_CONFIG.branch);
	const branch = branchInput?.trim() || existing.branch || DEFAULT_CONFIG.branch;

	let include: string[];
	if (hasConfig) {
		const keep = await ui.confirm(
			"Keep current included content?",
			`Current: ${existing.include.join(", ") || "none"}\n\nChoose No to reselect.`,
		);
		include = keep ? [...existing.include] : await selectInclude(ui);
	} else {
		include = await selectInclude(ui);
	}

	const automatic = await ui.confirm(
		"Enable automatic sync?",
		"Sync in the background at session start and push on shutdown. You can change this later in pi-sync.json.",
	);

	const config: SyncConfig = {
		remote: remote.trim(),
		branch,
		include,
		automatic,
	};
	await saveConfig(config);
	ui.notify(`pi-sync configured: ${config.remote} (branch ${config.branch}).`, "info");
	return config;
}

async function selectInclude(ui: ExtensionUIContext): Promise<string[]> {
	const selected: string[] = [];
	for (const choice of INCLUDE_CHOICES) {
		const enabled = await ui.confirm(
			`Include ${choice}?`,
			`Sync ${choice} between machines.${choice === "settings.json" ? " (recommended)" : ""}`,
		);
		if (enabled) selected.push(choice);
	}
	if (selected.length === 0) {
		ui.notify("pi-sync setup cancelled: include at least one item.", "warning");
		return [...DEFAULT_INCLUDE];
	}
	return selected;
}
