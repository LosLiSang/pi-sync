import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import { loadConfig, type SyncConfig, saveConfig } from "../src/config.js";
import { readRemoteSnapshot, runGit } from "../src/git.js";
import { hasMergeSession } from "../src/merge-session.js";
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

test("pull fast-forwards a fresh machine and --force overwrites diverged local files", async () => {
	// Machine A pushes.
	writeAgentFile("settings.json", '{"theme":"dark"}\n');
	const cfgA = await config({ remote: remoteDir });
	await operations.push(ctx(), cfgA);

	// Fresh machine: no state, no local file -> pull adopts the remote content.
	rmSync(path.join(home, ".pi", "agent", "pi-sync", "state.json"), { force: true });
	rmSync(path.join(home, ".pi", "agent", "settings.json"), { force: true });
	const fresh = await operations.pull(ctx(), cfgA);
	assert.equal(fresh.pulled, true);
	assert.equal(
		require("node:fs").readFileSync(path.join(home, ".pi", "agent", "settings.json"), "utf8"),
		'{"theme":"dark"}\n',
	);

	// Machine B edits locally; remote is unchanged -> pull is a no-op.
	writeAgentFile("settings.json", '{"theme":"local-stale"}\n');
	const noop = await operations.pull(ctx(), cfgA);
	assert.equal(noop.pulled, false);
	assert.match(noop.message, /local is ahead/u);

	// Remote changes too -> diverged -> plain pull writes nothing.
	await simulateRemotePush('{"theme":"remote-new"}\n');
	const diverged = await operations.pull(ctx(), cfgA);
	assert.equal(diverged.pulled, false);
	assert.equal(diverged.merged, false);
	assert.match(diverged.message, /diverged/u);
	assert.equal(
		require("node:fs").readFileSync(path.join(home, ".pi", "agent", "settings.json"), "utf8"),
		'{"theme":"local-stale"}\n',
	);

	// --force overwrites local with the remote snapshot.
	const forced = await operations.pull(ctx(), cfgA, { force: true });
	assert.equal(forced.pulled, true);
	assert.equal(
		require("node:fs").readFileSync(path.join(home, ".pi", "agent", "settings.json"), "utf8"),
		'{"theme":"remote-new"}\n',
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

test("merge resumes an incomplete resolution and --abort restores local files", async () => {
	writeAgentFile("settings.json", '{"theme":"dark"}\n');
	const cfg = await config();
	await operations.push(ctx(), cfg);

	await simulateRemotePush('{"theme":"remote-theme"}\n');
	writeAgentFile("settings.json", '{"theme":"local-theme"}\n');

	// Start a resolution and leave it incomplete.
	const { ctx: partialCtx } = resolverMock(["abort"]);
	const partial = await operations.pull(partialCtx, cfg, { merge: true });
	assert.equal(partial.merged, true);
	assert.equal(await hasMergeSession(), true);

	// merge with no session-aware state says nothing to resume if already done;
	// here it continues the session and completes it.
	const { ctx: resumeCtx } = resolverMock(["keep local"]);
	const resumed = await operations.merge(resumeCtx, cfg);
	assert.equal(resumed.merged, true);
	assert.equal(resumed.conflicts?.length, 0);
	assert.equal(await hasMergeSession(), false);
	const finalContent = require("node:fs").readFileSync(
		path.join(home, ".pi", "agent", "settings.json"),
		"utf8",
	);
	assert.equal(finalContent, '{"theme":"local-theme"}\n');

	// A new divergent merge, then --abort restores the local file.
	await simulateRemotePush('{"theme":"remote-theme-2"}\n');
	writeAgentFile("settings.json", '{"theme":"local-theme-2"}\n');
	const { ctx: abortStartCtx } = resolverMock(["abort"]);
	await operations.pull(abortStartCtx, cfg, { merge: true });
	assert.equal(await hasMergeSession(), true);

	await operations.merge(ctx(), cfg, { abort: true });
	assert.equal(await hasMergeSession(), false);
	assert.equal(
		require("node:fs").readFileSync(path.join(home, ".pi", "agent", "settings.json"), "utf8"),
		'{"theme":"local-theme-2"}\n',
	);
});

test("pull --merge applies cleanly when edits do not overlap", async () => {
	writeAgentFile("settings.json", '{"a":"base","b":"base"}\n');
	const cfg = await config();
	await operations.push(ctx(), cfg);

	// Remote changes field b only.
	await simulateRemotePush('{"a":"base","b":"remote"}\n');
	// Local changes field a only (pretty-printed JSON merges field-wise).
	writeAgentFile("settings.json", '{\n  "a": "local",\n  "b": "base"\n}\n');

	const result = await operations.pull(ctx(), cfg, { merge: true });
	assert.equal(result.merged, true);
	assert.equal(result.conflicts?.length, 0);
	assert.equal(await hasMergeSession(), false);
	const finalContent = require("node:fs").readFileSync(
		path.join(home, ".pi", "agent", "settings.json"),
		"utf8",
	);
	assert.ok(finalContent.includes('"a": "local"'));
	assert.ok(finalContent.includes('"b": "remote"'));
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

	// Fresh machine pulls both files back (no state, no local copies).
	rmSync(path.join(home, ".pi", "agent", "pi-sync", "state.json"), { force: true });
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

function resolverMock(selects: Array<string | undefined>, inputs: Array<string | undefined> = []) {
	let selectIndex = 0;
	let inputIndex = 0;
	const notifications: Array<{ message: string; level?: string }> = [];
	const ctx = createMockContext({
		hasUI: true,
		mode: "rpc",
		ui: {
			notify: (message: string, level = "info") => notifications.push({ message, level }),
			setStatus: () => undefined,
			confirm: async () => true,
			input: async () => inputs[inputIndex++],
			select: async () => selects[selectIndex++],
		},
	}).ctx;
	return { ctx, notifications };
}

test("pull --merge resolves divergent edits through the structured resolver", async () => {
	writeAgentFile("settings.json", '{"theme":"dark"}\n');
	const cfg = await config();
	await operations.push(ctx(), cfg);

	await simulateRemotePush('{"theme":"remote-theme"}\n');
	writeAgentFile("settings.json", '{"theme":"local-theme"}\n');

	const { ctx: mergeCtx } = resolverMock(["keep remote"]);
	const result = await operations.pull(mergeCtx, cfg, { merge: true });
	assert.equal(result.merged, true);
	assert.equal(result.conflicts?.length, 0);

	const finalContent = require("node:fs").readFileSync(
		path.join(home, ".pi", "agent", "settings.json"),
		"utf8",
	);
	assert.equal(finalContent, '{"theme":"remote-theme"}\n');
	assert.equal(await hasMergeSession(), false);
});

test("pull --merge persists an incomplete resolution and push refuses", async () => {
	writeAgentFile("settings.json", '{"theme":"dark"}\n');
	const cfg = await config();
	await operations.push(ctx(), cfg);

	await simulateRemotePush('{"theme":"remote-theme"}\n');
	writeAgentFile("settings.json", '{"theme":"local-theme"}\n');

	const { ctx: mergeCtx } = resolverMock(["abort"]);
	const result = await operations.pull(mergeCtx, cfg, { merge: true });
	assert.equal(result.merged, true);
	assert.ok(result.conflicts?.includes("settings.json"));
	assert.equal(await hasMergeSession(), true);

	// The conflict markers are on disk and push is blocked.
	const onDisk = require("node:fs").readFileSync(
		path.join(home, ".pi", "agent", "settings.json"),
		"utf8",
	);
	assert.ok(onDisk.includes("<<<<<<<"));
	const pushed = await operations.push(ctx(), cfg);
	assert.equal(pushed.pushed, false);
	assert.match(pushed.message, /merge is in progress/u);
});

test("status never fetches and shows state plus the next-step hint", async () => {
	writeAgentFile("settings.json", '{"theme":"dark"}\n');
	const cfg = await config();
	await operations.push(ctx(), cfg);

	const { ctx: s1, notifications: n1 } = createMockContext({ hasUI: true, mode: "rpc" });
	await operations.status(s1, cfg);
	const upToDate = n1.at(-1)?.message ?? "";
	assert.ok(upToDate.includes("state: sync: up-to-date"));
	assert.ok(upToDate.includes("next: nothing — all synced"));

	// Remote gains a change; status without fetch still shows the stale state.
	await simulateRemotePush('{"theme":"remote-change"}\n');
	const { ctx: s2, notifications: n2 } = createMockContext({ hasUI: true, mode: "rpc" });
	await operations.status(s2, cfg);
	const stale = n2.at(-1)?.message ?? "";
	assert.ok(stale.includes("sync: up-to-date"), "status must not fetch");

	// After a manual fetch, status reflects the new state and hints at pull.
	await operations.fetch(ctx(), cfg);
	const { ctx: s3, notifications: n3 } = createMockContext({ hasUI: true, mode: "rpc" });
	await operations.status(s3, cfg);
	const behind = n3.at(-1)?.message ?? "";
	assert.ok(behind.includes("state: sync: 1 behind — pull"));
	assert.ok(behind.includes("next: /sync pull"));
});

test("status --diff includes the content diff and status shows a merge in progress", async () => {
	writeAgentFile("settings.json", '{"theme":"dark"}\n');
	const cfg = await config();
	await operations.push(ctx(), cfg);

	await simulateRemotePush('{"theme":"remote-theme"}\n');
	writeAgentFile("settings.json", '{"theme":"local-theme"}\n');

	// Diverged: start a resolution and leave it incomplete.
	const { ctx: partialCtx } = resolverMock(["abort"]);
	await operations.pull(partialCtx, cfg, { merge: true });
	assert.equal(await hasMergeSession(), true);

	const { ctx: s, notifications } = createMockContext({ hasUI: true, mode: "rpc" });
	await operations.status(s, cfg, { diff: true });
	const message = notifications.at(-1)?.message ?? "";
	assert.ok(message.includes("merge in progress: 1 conflict block(s) unresolved"));
	assert.ok(message.includes("next: /sync merge"));
	assert.ok(message.includes('"theme"'), "--diff shows content hunks");
});
