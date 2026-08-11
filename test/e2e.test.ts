import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import { loadConfig, type SyncConfig, saveConfig } from "../src/config.js";
import { readRemoteSnapshot, runGit } from "../src/git.js";
import * as operations from "../src/operations.js";
import { createSnapshot } from "../src/snapshot.js";
import { loadState } from "../src/state.js";
import { createMockContext } from "./support.js";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
let home: string;
let remoteDir: string;

beforeEach(async () => {
	home = mkdtempSync(path.join(os.tmpdir(), "pi-sync-e2e-"));
	process.env.PI_CODING_AGENT_DIR = path.join(home, ".pi", "agent");
	remoteDir = path.join(home, "remote.git");
	mkdirSync(remoteDir, { recursive: true });
	await runGit(["init", "--bare", "--initial-branch=main"], { cwd: home });
	// Re-init into the bare directory directly: `git init --bare` above created
	// home/.git; move the repo into remoteDir for a clean remote path.
	await runGit(["init", "--bare", "--initial-branch=main", "."], { cwd: remoteDir });
});

afterEach(() => {
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	rmSync(home, { recursive: true, force: true });
});

async function config(overrides: Partial<SyncConfig> = {}): Promise<SyncConfig> {
	const value: SyncConfig = {
		remote: remoteDir,
		branch: "pi-sync",
		include: ["settings.json"],
		automatic: true,
		...overrides,
	};
	await saveConfig(value);
	return loadConfig();
}

function writeAgentFile(relative: string, content: string): void {
	const target = path.join(home, ".pi", "agent", relative);
	mkdirSync(path.dirname(target), { recursive: true });
	writeFileSync(target, content);
}

function ctx() {
	return createMockContext({ hasUI: true, mode: "rpc" }).ctx;
}

test("push publishes the local snapshot to the remote branch", async () => {
	writeAgentFile("settings.json", '{"theme":"dark"}\n');
	const cfg = await config();
	await operations.push(ctx(), cfg);

	const state = await loadState();
	assert.ok(state);
	assert.ok(state.lastRemoteRevision);

	// A second, fresh view of the remote sees the snapshot.
	const remote = await readRemoteSnapshot(cfg);
	assert.ok(remote);
	assert.equal(remote.files.length, 1);
	assert.equal(remote.files[0].path, "settings.json");
});

test("fetch then diff shows content-level changes", async () => {
	writeAgentFile("settings.json", '{"theme":"dark"}\n');
	const cfg = await config();
	await operations.push(ctx(), cfg);

	writeAgentFile("settings.json", '{"theme":"light"}\n');
	await operations.fetch(ctx(), cfg);
	const remote = await readRemoteSnapshot(cfg);
	assert.ok(remote);
	const local = await createSnapshot(cfg);
	assert.notEqual(
		local.files[0].sha256,
		remote.files.find((file) => file.path === "settings.json")?.sha256,
	);
});

test("pull overwrites local files with the remote snapshot", async () => {
	// Machine A pushes.
	writeAgentFile("settings.json", '{"theme":"dark"}\n');
	const cfgA = await config({ remote: remoteDir });
	await operations.push(ctx(), cfgA);

	// Machine B (fresh home) pulls and adopts the remote content.
	writeAgentFile("settings.json", '{"theme":"local-stale"}\n');
	await operations.pull(ctx(), cfgA);
	assert.equal(
		require("node:fs").readFileSync(path.join(home, ".pi", "agent", "settings.json"), "utf8"),
		'{"theme":"dark"}\n',
	);
});

test("push refuses when the remote changed unless --force", async () => {
	writeAgentFile("settings.json", '{"theme":"dark"}\n');
	const cfg = await config();
	await operations.push(ctx(), cfg);

	// Simulate another machine pushing a change to the same branch.
	await simulateRemotePush('{"theme":"remote-change"}\n');

	writeAgentFile("settings.json", '{"theme":"local-change"}\n');
	await operations.fetch(ctx(), cfg);
	const result = await operations.push(ctx(), cfg);
	assert.equal(result.pushed, false);
	assert.match(result.message, /Run \/sync fetch \+ \/sync merge/u);

	const forced = await operations.push(ctx(), cfg, { force: true });
	assert.equal(forced.pushed, true);
});

test("merge conflicts write markers for divergent edits", async () => {
	writeAgentFile("settings.json", '{"theme":"dark"}\n');
	const cfg = await config();
	await operations.push(ctx(), cfg);

	// Remote changes the same file on the same line.
	await simulateRemotePush('{"theme":"remote-theme"}\n');
	// Local also changes it.
	writeAgentFile("settings.json", '{"theme":"local-theme"}\n');

	await operations.fetch(ctx(), cfg);
	const result = await operations.merge(ctx(), cfg);
	assert.equal(result.merged, true);
	assert.ok(result.conflicts?.includes("settings.json"));

	const merged = require("node:fs").readFileSync(
		path.join(home, ".pi", "agent", "settings.json"),
		"utf8",
	);
	assert.ok(merged.includes("<<<<<<<"), "conflict markers are written");
	assert.ok(merged.includes(">>>>>>>"), "conflict markers are written");
});

test("merge applies cleanly when edits do not overlap", async () => {
	writeAgentFile("settings.json", '{"a":"base","b":"base"}\n');
	const cfg = await config();
	await operations.push(ctx(), cfg);

	// Remote changes field b only.
	await simulateRemotePush('{"a":"base","b":"remote"}\n');
	// Local changes field a only (pretty-printed JSON merges line-wise).
	writeAgentFile("settings.json", '{\n  "a": "local",\n  "b": "base"\n}\n');

	await operations.fetch(ctx(), cfg);
	const result = await operations.merge(ctx(), cfg);
	assert.equal(result.merged, true);
	assert.ok(!result.conflicts || result.conflicts.length === 0);
});

async function simulateRemotePush(content: string): Promise<void> {
	const cloneDir = path.join(home, "simulate");
	await runGit(["clone", "--quiet", "--branch", "pi-sync", remoteDir, cloneDir], { cwd: home });
	mkdirSync(path.join(cloneDir, "pi-sync"), { recursive: true });
	const snapshot = {
		version: 1,
		createdAt: new Date().toISOString(),
		files: [
			{
				path: "settings.json",
				sha256: createHash("sha256").update(content).digest("hex"),
				contentBase64: Buffer.from(content).toString("base64"),
			},
		],
	};
	writeFileSync(path.join(cloneDir, "pi-sync", "snapshot.json"), `${JSON.stringify(snapshot)}\n`);
	await runGit(["add", "--", "pi-sync/snapshot.json"], { cwd: cloneDir });
	await runGit(["commit", "--quiet", "-m", "simulated remote change"], { cwd: cloneDir });
	await runGit(["push", "--quiet", "origin", "HEAD:pi-sync"], { cwd: cloneDir });
	await rmSync(cloneDir, { recursive: true, force: true });
}

test("arbitrary agent-relative include entries push and pull", async () => {
	writeAgentFile("AGENTS.md", "# instructions\n");
	writeAgentFile("prompts/teach.md", "# teach\n");
	const cfg = await config({ include: ["AGENTS.md", "prompts/teach.md"] });
	await operations.push(ctx(), cfg);

	// Fresh machine pulls both files back.
	rmSync(path.join(home, ".pi", "agent", "AGENTS.md"), { force: true });
	rmSync(path.join(home, ".pi", "agent", "prompts"), { recursive: true, force: true });
	await operations.pull(ctx(), cfg);
	assert.equal(
		require("node:fs").readFileSync(path.join(home, ".pi", "agent", "AGENTS.md"), "utf8"),
		"# instructions\n",
	);
	assert.equal(
		require("node:fs").readFileSync(path.join(home, ".pi", "agent", "prompts", "teach.md"), "utf8"),
		"# teach\n",
	);
});

test("quiet fetch suppresses notifications and refreshes the indicator", async () => {
	writeAgentFile("settings.json", '{"theme":"dark"}\n');
	const cfg = await config();
	await operations.push(ctx(), cfg);

	const {
		ctx: quietCtx,
		notifications,
		statuses,
	} = createMockContext({ hasUI: true, mode: "rpc" });
	await operations.fetch(quietCtx, cfg, { quiet: true });
	assert.equal(notifications.length, 0);
	assert.ok(
		statuses.some((entry) => entry.key === "sync" && entry.text === "sync: up-to-date"),
		`expected up-to-date indicator, got ${JSON.stringify(statuses)}`,
	);
});

test("fetch refreshes the indicator when the remote has new changes", async () => {
	writeAgentFile("settings.json", '{"theme":"dark"}\n');
	const cfg = await config();
	await operations.push(ctx(), cfg);

	// Remote gains a change; local stays put.
	await simulateRemotePush('{"theme":"remote-change"}\n');

	const { ctx: fetchCtx, statuses } = createMockContext({ hasUI: true, mode: "rpc" });
	await operations.fetch(fetchCtx, cfg);
	assert.ok(
		statuses.some((entry) => entry.key === "sync" && entry.text === "sync: 1 behind — pull"),
		`expected behind indicator, got ${JSON.stringify(statuses)}`,
	);
});
