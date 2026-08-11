import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import type { SyncConfig } from "../src/config.js";
import {
	createSnapshot,
	fileHashMap,
	projectSnapshot,
	snapshotFileContent,
} from "../src/snapshot.js";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
let home: string;

const CONFIG: SyncConfig = {
	remote: "unused",
	branch: "pi-sync",
	include: ["settings.json", "keybindings.json", "skills"],
	automatic: true,
};

beforeEach(() => {
	home = mkdtempSync(path.join(os.tmpdir(), "pi-sync-snapshot-"));
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

test("createSnapshot scans configured include paths relative to the agent dir", async () => {
	mkdirSync(agentDir(), { recursive: true });
	mkdirSync(path.join(agentDir(), "skills"), { recursive: true });
	writeFileSync(path.join(agentDir(), "settings.json"), '{"theme":"dark"}\n');
	writeFileSync(path.join(agentDir(), "skills", "a.md"), "# a\n");
	writeFileSync(path.join(agentDir(), "keybindings.json"), "{}\n");

	const snapshot = await createSnapshot(CONFIG);
	const hashes = fileHashMap(snapshot);
	assert.deepEqual([...hashes.keys()].sort(), ["keybindings.json", "settings.json", "skills/a.md"]);
	assert.equal(snapshotFileContent(snapshot, "settings.json"), '{"theme":"dark"}\n');
});

test("createSnapshot skips missing roots, symlinks, and NUL binaries", async () => {
	mkdirSync(agentDir(), { recursive: true });
	writeFileSync(path.join(agentDir(), "settings.json"), '{"theme":"dark"}\n');
	mkdirSync(path.join(agentDir(), "skills"), { recursive: true });
	writeFileSync(path.join(agentDir(), "skills", "binary.bin"), Buffer.from([0, 1, 2]));
	try {
		symlinkSync(path.join(agentDir(), "settings.json"), path.join(agentDir(), "skills", "link"));
	} catch {
		// Symlinks may require privileges on Windows; skip when unavailable.
	}

	const snapshot = await createSnapshot(CONFIG);
	const hashes = fileHashMap(snapshot);
	assert.deepEqual([...hashes.keys()].sort(), ["settings.json"]);
});

test("createSnapshot hashes are stable across identical content", async () => {
	mkdirSync(agentDir(), { recursive: true });
	writeFileSync(path.join(agentDir(), "settings.json"), '{"theme":"dark"}\n');
	const first = await createSnapshot(CONFIG);
	const second = await createSnapshot(CONFIG);
	assert.equal(fileHashMap(first).get("settings.json"), fileHashMap(second).get("settings.json"));
});

test("createSnapshot captures arbitrary agent-relative include entries", async () => {
	mkdirSync(agentDir(), { recursive: true });
	mkdirSync(path.join(agentDir(), "prompts"), { recursive: true });
	writeFileSync(path.join(agentDir(), "AGENTS.md"), "# instructions\n");
	writeFileSync(path.join(agentDir(), "prompts", "teach.md"), "# teach\n");

	const config: SyncConfig = { ...CONFIG, include: ["AGENTS.md", "prompts/teach.md"] };
	const snapshot = await createSnapshot(config);
	const hashes = fileHashMap(snapshot);
	assert.deepEqual([...hashes.keys()].sort(), ["AGENTS.md", "prompts/teach.md"]);
	assert.equal(snapshotFileContent(snapshot, "AGENTS.md"), "# instructions\n");
});

test("projectSnapshot keeps only paths under the include set", async () => {
	const snapshot = {
		version: 1,
		createdAt: "2026-08-11T00:00:00.000Z",
		files: [
			{ path: "settings.json", sha256: "a", contentBase64: "c2V0dGluZ3M=" },
			{ path: "skills/foo/SKILL.md", sha256: "b", contentBase64: "c2tpbGw=" },
			// A sibling that merely shares the prefix must not match.
			{ path: "skillsfoo/other.md", sha256: "c", contentBase64: "bm8=" },
			{ path: "prompts/teach.md", sha256: "d", contentBase64: "dGVhY2g=" },
		],
	};
	const projected = projectSnapshot(snapshot, ["settings.json", "skills"]);
	assert.deepEqual(
		projected.files.map((file) => file.path),
		["settings.json", "skills/foo/SKILL.md"],
	);
	// Matching is case-insensitive on both sides.
	const upper = projectSnapshot(snapshot, ["Settings.json", "SKILLS"]);
	assert.deepEqual(
		upper.files.map((file) => file.path),
		["settings.json", "skills/foo/SKILL.md"],
	);
	// Fully-matching include set returns the same snapshot unchanged.
	const same = projectSnapshot(snapshot, ["settings.json", "skills", "skillsfoo", "prompts"]);
	assert.equal(same, snapshot);
});
