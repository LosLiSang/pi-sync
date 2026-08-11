import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import {
	clearMergeSession,
	hasMergeSession,
	loadMergeSession,
	type MergeSessionData,
	saveMergeSession,
} from "../src/merge-session.js";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
let home: string;

beforeEach(() => {
	home = mkdtempSync(path.join(os.tmpdir(), "pi-sync-ms-"));
	process.env.PI_CODING_AGENT_DIR = path.join(home, ".pi", "agent");
});

afterEach(() => {
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	rmSync(home, { recursive: true, force: true });
});

const SESSION: MergeSessionData = {
	baselineRevision: "abc123",
	backupDir: path.join("backups", "2026-08-11T00-00-00-000Z"),
	createdAt: "2026-08-11T00:00:00.000Z",
	files: [
		{
			path: "settings.json",
			blocks: [
				{ local: "a", base: "b", remote: "c", resolution: undefined, choice: undefined },
				{ local: "x", base: "y", remote: "z", resolution: "picked", choice: "custom" },
			],
		},
		{
			path: "AGENTS.md",
			blocks: [{ local: "l", base: "b", remote: "r", resolution: "l", choice: "local" }],
		},
	],
};

test("merge session save/load round-trips block contents and resolutions", async () => {
	await saveMergeSession(SESSION);
	const loaded = await loadMergeSession();
	assert.ok(loaded);
	assert.equal(loaded.baselineRevision, "abc123");
	assert.equal(loaded.backupDir, SESSION.backupDir);
	assert.equal(loaded.files.length, 2);
	assert.deepEqual(loaded.files[0].blocks, SESSION.files[0].blocks);
	assert.deepEqual(loaded.files[1].blocks, SESSION.files[1].blocks);
});

test("missing merge session loads as undefined", async () => {
	assert.equal(await loadMergeSession(), undefined);
	assert.equal(await hasMergeSession(), false);
});

test("clear removes the session", async () => {
	await saveMergeSession(SESSION);
	assert.equal(await hasMergeSession(), true);
	await clearMergeSession();
	assert.equal(await loadMergeSession(), undefined);
	assert.equal(await hasMergeSession(), false);
});

test("malformed session JSON loads as undefined", async () => {
	const { writeFileSync, mkdirSync } = await import("node:fs");
	mkdirSync(path.join(home, ".pi", "agent", "pi-sync", "merge-session"), { recursive: true });
	writeFileSync(
		path.join(home, ".pi", "agent", "pi-sync", "merge-session", "session.json"),
		"not json",
	);
	assert.equal(await loadMergeSession(), undefined);
});

test("invalid block data invalidates the whole session", async () => {
	const { writeFileSync, mkdirSync } = await import("node:fs");
	mkdirSync(path.join(home, ".pi", "agent", "pi-sync", "merge-session"), { recursive: true });
	writeFileSync(
		path.join(home, ".pi", "agent", "pi-sync", "merge-session", "session.json"),
		JSON.stringify({
			baselineRevision: "x",
			backupDir: "b",
			createdAt: "c",
			files: [{ path: "f", blocks: [{ local: 1 }] }],
		}),
	);
	assert.equal(await loadMergeSession(), undefined);
});
