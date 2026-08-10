import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, test } from "vitest";
import type { SyncConfig } from "../src/config.js";
import { loadConfig, saveConfig } from "../src/config.js";
import { listAgentEntries, runIncludePicker } from "../src/include.js";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
let home: string;

const BASE_CONFIG: SyncConfig = {
	remote: "git@example.com:me/pi.git",
	branch: "pi-sync",
	include: ["settings.json"],
	automatic: true,
};

beforeEach(() => {
	home = mkdtempSync(path.join(os.tmpdir(), "pi-sync-include-"));
	process.env.PI_CODING_AGENT_DIR = path.join(home, ".pi", "agent");
});

afterEach(() => {
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	rmSync(home, { recursive: true, force: true });
});

function agentDir(): string {
	return path.join(home, ".pi", "agent");
}

function configPath(): string {
	return path.join(agentDir(), "pi-sync.json");
}

function writeAgentFile(relative: string, content = ""): void {
	const target = path.join(agentDir(), relative);
	mkdirSync(path.dirname(target), { recursive: true });
	writeFileSync(target, content);
}

function mockUi(selects: Array<string | undefined>) {
	let index = 0;
	const notifications: Array<{ message: string; level: string }> = [];
	const ui = {
		notify: (message: string, level = "info") => notifications.push({ message, level }),
		setStatus: () => undefined,
		confirm: async () => true,
		input: async () => undefined,
		select: async () => selects[index++],
	};
	return { ui: ui as unknown as ExtensionUIContext, notifications };
}

test("picker browses into a directory, adds a file, and persists", async () => {
	writeAgentFile("settings.json", "{}");
	writeAgentFile("prompts/teach.md", "# teach\n");
	writeAgentFile("notes/a.md", "# a\n");
	const { ui, notifications } = mockUi(["prompts/", "prompts/teach.md", "✔ done — save and exit"]);

	const result = await runIncludePicker(ui, BASE_CONFIG);

	assert.ok(result);
	assert.deepEqual(result.include, ["settings.json", "prompts/teach.md"]);
	assert.deepEqual((await loadConfig()).include, ["settings.json", "prompts/teach.md"]);
	assert.ok(notifications.some((note) => note.message === "+ prompts/teach.md"));
});

test("picker goes up and cancels without writing anything", async () => {
	writeAgentFile("prompts/teach.md", "# teach\n");
	const { ui } = mockUi(["prompts/", ".. (go up)", undefined]);

	const result = await runIncludePicker(ui, BASE_CONFIG);

	assert.equal(result, undefined);
	assert.equal(existsSync(configPath()), false);
});

test("picker warns on duplicates and adds nothing when only duplicates picked", async () => {
	writeAgentFile("settings.json", "{}");
	const { ui, notifications } = mockUi(["settings.json", "✔ done — save and exit"]);

	const result = await runIncludePicker(ui, BASE_CONFIG);

	assert.equal(result, undefined);
	assert.equal(existsSync(configPath()), false);
	assert.ok(
		notifications.some(
			(note) => note.level === "warning" && /duplicate include item/u.test(note.message),
		),
	);
});

test("picker persists additions over an existing saved config", async () => {
	writeAgentFile("settings.json", "{}");
	writeAgentFile("AGENTS.md", "# instructions\n");
	await saveConfig(BASE_CONFIG);
	const { ui } = mockUi(["AGENTS.md", "✔ done — save and exit"]);

	const result = await runIncludePicker(ui, BASE_CONFIG);

	assert.ok(result);
	assert.deepEqual(result.include, ["settings.json", "AGENTS.md"]);
	assert.deepEqual((await loadConfig()).include, ["settings.json", "AGENTS.md"]);
});

test("listAgentEntries sorts directories first and skips symlinks", async () => {
	mkdirSync(agentDir(), { recursive: true });
	writeAgentFile("b-file.txt");
	writeAgentFile("a-dir/x.txt");
	writeAgentFile("c.txt");
	try {
		symlinkSync(path.join(agentDir(), "c.txt"), path.join(agentDir(), "link"));
	} catch {
		// Symlinks may require privileges on Windows; skip when unavailable.
	}

	const entries = await listAgentEntries("");
	assert.deepEqual(
		entries.map((entry) => entry.name),
		["a-dir", "b-file.txt", "c.txt"],
	);
	assert.deepEqual(
		entries.map((entry) => entry.isDirectory),
		[true, false, false],
	);
});

test("listAgentEntries returns [] for a missing directory", async () => {
	assert.deepEqual(await listAgentEntries("does-not-exist"), []);
});
