import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import {
	addIncludeItems,
	loadConfig,
	parseConfig,
	type SyncConfig,
	saveConfig,
} from "../src/config.js";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
let home: string;

beforeEach(() => {
	home = mkdtempSync(path.join(os.tmpdir(), "pi-sync-test-"));
	process.env.PI_CODING_AGENT_DIR = path.join(home, ".pi", "agent");
});

afterEach(() => {
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	rmSync(home, { recursive: true, force: true });
});

test("addIncludeItems validates additions and rejects duplicates", () => {
	const config: SyncConfig = {
		remote: "git@x:y.git",
		branch: "pi-sync",
		include: ["settings.json"],
		automatic: true,
	};
	const updated = addIncludeItems(config, ["AGENTS.md", "prompts/teach.md"]);
	assert.deepEqual(updated.include, ["settings.json", "AGENTS.md", "prompts/teach.md"]);
	assert.throws(() => addIncludeItems(config, ["../evil"]), /unsafe include item/u);
	assert.throws(() => addIncludeItems(config, ["settings.json"]), /duplicate include item/u);
	assert.throws(() => addIncludeItems(config, ["C:\\abs"]), /must be agent-relative paths/u);
});

test("loadConfig returns defaults when no config file exists", async () => {
	const config = await loadConfig();
	assert.equal(config.remote, "");
	assert.equal(config.branch, "pi-sync");
	assert.deepEqual(config.include, [
		"settings.json",
		"keybindings.json",
		"models.json",
		"skills",
		"prompts",
		"themes",
		"extensions",
		"extension-settings",
	]);
	assert.equal(config.automatic, true);
});

test("saveConfig then loadConfig round-trips and writes private permissions", async () => {
	await saveConfig({
		remote: "git@github.com:me/pi.git",
		branch: "sync",
		include: ["settings.json", "skills"],
		automatic: false,
	});
	const config = await loadConfig();
	assert.equal(config.remote, "git@github.com:me/pi.git");
	assert.equal(config.branch, "sync");
	assert.deepEqual(config.include, ["settings.json", "skills"]);
	assert.equal(config.automatic, false);
});

test("parseConfig rejects missing remote", () => {
	assert.throws(() => parseConfig({}), /remote must be a non-empty git URL/u);
	assert.throws(() => parseConfig({ remote: "  " }), /remote must be a non-empty git URL/u);
});

test("parseConfig rejects unsafe branch names", () => {
	assert.throws(() => parseConfig({ remote: "x", branch: "a b" }), /unsafe characters/u);
	assert.throws(() => parseConfig({ remote: "x", branch: "a..b" }), /unsafe characters/u);
});

test("parseConfig rejects malformed JSON file", async () => {
	mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
	writeFileSync(path.join(home, ".pi", "agent", "pi-sync.json"), "not json", {
		mode: 0o600,
	});
	await assert.rejects(loadConfig(), /not valid JSON/u);
});

test("parseConfig validates include lists", () => {
	assert.throws(() => parseConfig({ remote: "x", include: ["../evil"] }), /unsafe include item/u);
	assert.throws(
		() => parseConfig({ remote: "x", include: ["settings.json", "settings.json"] }),
		/duplicate include item/u,
	);
	const config = parseConfig({ remote: "x", include: ["SETTINGS.JSON", "skills"] });
	assert.deepEqual(config.include, ["settings.json", "skills"]);
});
