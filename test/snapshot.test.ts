import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import type { SyncConfig } from "../src/config.js";
import { createSnapshot, fileHashMap, snapshotFileContent } from "../src/snapshot.js";

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
