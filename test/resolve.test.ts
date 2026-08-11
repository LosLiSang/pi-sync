import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, test } from "vitest";
import { loadMergeSession, type MergeSessionData, saveMergeSession } from "../src/merge-session.js";
import { runBlockResolver } from "../src/resolve.js";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
let home: string;

const SESSION: MergeSessionData = {
	baselineRevision: "abc",
	backupDir: "backups/x",
	createdAt: "2026-08-11T00:00:00.000Z",
	files: [
		{
			path: "settings.json",
			blocks: [
				{
					local: "local-a",
					base: "base-a",
					remote: "remote-a",
					resolution: undefined,
					choice: undefined,
				},
				{ local: "x", base: "y", remote: "z", resolution: undefined, choice: undefined },
			],
		},
	],
};

beforeEach(() => {
	home = mkdtempSync(path.join(os.tmpdir(), "pi-sync-resolve-"));
	process.env.PI_CODING_AGENT_DIR = path.join(home, ".pi", "agent");
});

afterEach(() => {
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	rmSync(home, { recursive: true, force: true });
});

function mockUi(selects: Array<string | undefined>, inputs: Array<string | undefined> = []) {
	let selectIndex = 0;
	let inputIndex = 0;
	const ui = {
		notify: () => undefined,
		setStatus: () => undefined,
		confirm: async () => true,
		input: async () => inputs[inputIndex++],
		select: async () => selects[selectIndex++],
	};
	return ui as unknown as ExtensionUIContext;
}

test("resolver keeps local, remote and custom blocks and completes", async () => {
	const session: MergeSessionData = {
		baselineRevision: "abc",
		backupDir: "backups/x",
		createdAt: "2026-08-11T00:00:00.000Z",
		files: [
			{
				path: "settings.json",
				blocks: [
					{
						local: "local-a",
						base: "base-a",
						remote: "remote-a",
						resolution: undefined,
						choice: undefined,
					},
					{ local: "x", base: "y", remote: "z", resolution: undefined, choice: undefined },
					{ local: "p", base: "q", remote: "r", resolution: undefined, choice: undefined },
				],
			},
		],
	};
	await saveMergeSession(session);
	const loaded = (await loadMergeSession()) as MergeSessionData;
	const ui = mockUi(["keep local", "keep remote", "type replacement"], ["my custom text"]);

	const result = await runBlockResolver(ui, loaded);

	assert.equal(result.completed, true);
	assert.equal(result.resolved, 3);
	assert.equal(loaded.files[0].blocks[0].resolution, "local-a");
	assert.equal(loaded.files[0].blocks[0].choice, "local");
	assert.equal(loaded.files[0].blocks[1].resolution, "z");
	assert.equal(loaded.files[0].blocks[1].choice, "remote");
	assert.equal(loaded.files[0].blocks[2].resolution, "my custom text");
	assert.equal(loaded.files[0].blocks[2].choice, "custom");

	// Persisted for resume.
	const persisted = await loadMergeSession();
	assert.ok(persisted);
	assert.equal(persisted.files[0].blocks[0].choice, "local");
	assert.equal(persisted.files[0].blocks[2].choice, "custom");
});

test("resolver abort keeps progress persisted", async () => {
	await saveMergeSession(SESSION);
	const session = (await loadMergeSession()) as MergeSessionData;
	const ui = mockUi(["keep local", "abort"]);

	const result = await runBlockResolver(ui, session);

	assert.equal(result.completed, false);
	assert.equal(result.resolved, 1);
	const persisted = await loadMergeSession();
	assert.ok(persisted);
	assert.equal(persisted.files[0].blocks[0].resolution, "local-a");
	assert.equal(persisted.files[0].blocks[1].resolution, undefined);
});

test("resolver cancel on input also keeps progress", async () => {
	await saveMergeSession(SESSION);
	const session = (await loadMergeSession()) as MergeSessionData;
	const ui = mockUi(["keep local", "type replacement"], [undefined]);

	const result = await runBlockResolver(ui, session);

	assert.equal(result.completed, false);
	assert.equal(result.resolved, 1);
});

test("resolver with nothing pending completes immediately", async () => {
	const session: MergeSessionData = {
		...SESSION,
		files: [
			{
				path: "a.md",
				blocks: [
					{ local: "l", base: "b", remote: "r", resolution: "l", choice: "local" },
					{ local: "l2", base: "b2", remote: "r2", resolution: "custom", choice: "custom" },
				],
			},
		],
	};
	const ui = mockUi([]);
	const result = await runBlockResolver(ui, session);
	assert.equal(result.completed, true);
	assert.equal(result.resolved, 0);
});
