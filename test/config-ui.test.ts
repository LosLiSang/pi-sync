import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, test } from "vitest";
import type { SyncConfig } from "../src/config.js";
import { loadConfig, saveConfig } from "../src/config.js";
import { formatConfig, runConfigEditor } from "../src/config-ui.js";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
let home: string;

const CONFIG: SyncConfig = {
	remote: "git@example.com:me/pi.git",
	branch: "pi-sync",
	include: ["settings.json"],
	automatic: true,
};

beforeEach(() => {
	home = mkdtempSync(path.join(os.tmpdir(), "pi-sync-config-"));
	process.env.PI_CODING_AGENT_DIR = path.join(home, ".pi", "agent");
});

afterEach(() => {
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	rmSync(home, { recursive: true, force: true });
});

function mockUi(
	selects: Array<string | undefined>,
	inputs: Array<string | undefined> = [],
	confirms: Array<boolean> = [],
) {
	let selectIndex = 0;
	let inputIndex = 0;
	let confirmIndex = 0;
	const notifications: Array<{ message: string; level: string }> = [];
	const ui = {
		notify: (message: string, level = "info") => notifications.push({ message, level }),
		setStatus: () => undefined,
		confirm: async () => confirms[confirmIndex++],
		input: async () => inputs[inputIndex++],
		select: async () => selects[selectIndex++],
	};
	return { ui: ui as unknown as ExtensionUIContext, notifications };
}

test("editor saves a changed remote on done", async () => {
	await saveConfig(CONFIG);
	const { ui } = mockUi(["remote", "done"], ["git@new.example.com:me/pi.git"]);

	await runConfigEditor(ui, CONFIG);

	const saved = await loadConfig();
	assert.equal(saved.remote, "git@new.example.com:me/pi.git");
	assert.equal(saved.branch, "pi-sync");
});

test("editor changes branch and automatic", async () => {
	await saveConfig(CONFIG);
	const { ui } = mockUi(["branch", "automatic", "done"], ["main"], [false]);

	await runConfigEditor(ui, CONFIG);

	const saved = await loadConfig();
	assert.equal(saved.branch, "main");
	assert.equal(saved.automatic, false);
});

test("editor adds, picks defaults, and removes include entries", async () => {
	await saveConfig(CONFIG);
	const { ui } = mockUi(
		[
			"include",
			"＋ add a path",
			"type a path…",
			"＋ add a path",
			"keybindings.json",
			"－ remove a path",
			"settings.json",
			"✔ done",
			"done",
		],
		["AGENTS.md"],
	);

	await runConfigEditor(ui, CONFIG);

	const saved = await loadConfig();
	// settings.json removed; AGENTS.md typed in; keybindings.json picked from defaults.
	assert.deepEqual(saved.include, ["AGENTS.md", "keybindings.json"]);
});

test("editor keeps the default multi-select behavior for built-ins", async () => {
	await saveConfig(CONFIG);
	const { ui } = mockUi(["include", "＋ add a path", "keybindings.json", "✔ done", "done"]);

	await runConfigEditor(ui, CONFIG);

	const saved = await loadConfig();
	assert.deepEqual(saved.include, ["settings.json", "keybindings.json"]);
});

test("editor discards changes on cancel", async () => {
	await saveConfig(CONFIG);
	const { ui, notifications } = mockUi(["remote", undefined], ["git@new.example.com:me/pi.git"]);

	await runConfigEditor(ui, CONFIG);

	const saved = await loadConfig();
	assert.equal(saved.remote, CONFIG.remote);
	assert.ok(notifications.some((note) => /discarded/u.test(note.message)));
});

test("editor rejects an invalid remote and keeps the editor alive", async () => {
	await saveConfig(CONFIG);
	const { ui, notifications } = mockUi(["remote", "done"], ["   "]);

	await runConfigEditor(ui, CONFIG);

	const saved = await loadConfig();
	assert.equal(saved.remote, CONFIG.remote);
	assert.ok(notifications.some((note) => note.level === "warning"));
});

test("formatConfig renders all fields", () => {
	const text = formatConfig(CONFIG);
	assert.ok(text.includes("git@example.com:me/pi.git"));
	assert.ok(text.includes("branch: pi-sync"));
	assert.ok(text.includes("automatic: enabled"));
	assert.ok(text.includes("included (1): settings.json"));
});
