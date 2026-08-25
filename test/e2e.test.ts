import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import { loadConfig, type SyncConfig, saveConfig } from "../src/config.js";
import { isMergeInProgress, runGit } from "../src/git.js";
import * as operations from "../src/operations.js";
import { createMockContext } from "./support.js";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
let home: string;
let remoteDir: string;

beforeEach(async () => {
	home = mkdtempSync(path.join(os.tmpdir(), "pi-sync-e2e-"));
	process.env.PI_CODING_AGENT_DIR = path.join(home, ".pi", "agent");
	remoteDir = path.join(home, "remote.git");
	mkdirSync(remoteDir, { recursive: true });
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

function readAgentFile(relative: string): string {
	return readFileSync(path.join(home, ".pi", "agent", relative), "utf8");
}

function ctx() {
	return createMockContext({ hasUI: true, mode: "rpc" }).ctx;
}

test("push publishes the local file tree to the remote branch", async () => {
	writeAgentFile("settings.json", '{"theme":"dark"}\n');
	const cfg = await config();
	const result = await operations.push(ctx(), cfg);
	assert.equal(result.pushed, true);

	// The remote branch now holds the real file tree, not a snapshot blob.
	const cloneDir = path.join(home, "verify");
	await runGit(["clone", "--quiet", "--branch", "pi-sync", remoteDir, cloneDir], { cwd: home });
	const files = await runGit(["ls-tree", "-r", "--name-only", "HEAD"], { cwd: cloneDir });
	rmSync(cloneDir, { recursive: true, force: true });
	assert.deepEqual(files.stdout.trim().split("\n").filter(Boolean), ["settings.json"]);
	assert.equal(
		readFileSync(path.join(home, ".pi", "agent", "settings.json"), "utf8"),
		'{"theme":"dark"}\n',
	);
});

test("fetch then diff shows content-level changes", async () => {
	writeAgentFile("settings.json", '{"theme":"dark"}\n');
	const cfg = await config();
	await operations.push(ctx(), cfg);

	// Remote gains a change; local stays put.
	await simulateRemotePush({ "settings.json": '{"theme":"remote"}\n' });

	const { ctx: fetchCtx, notifications } = createMockContext({ hasUI: true, mode: "rpc" });
	await operations.fetch(fetchCtx, cfg);
	const message = notifications.at(-1)?.message ?? "";
	assert.match(message, /changed/u);
	const onDisk = readAgentFile("settings.json");
	assert.equal(onDisk, '{"theme":"dark"}\n'); // fetch is non-destructive
});

test("fresh machine pull adopts the remote (no false conflict)", async () => {
	// Machine A publishes.
	writeAgentFile("settings.json", '{"theme":"dark"}\n');
	const cfgA = await config({ remote: remoteDir });
	await operations.push(ctx(), cfgA);

	// Fresh machine: no local file, no mirror state.
	rmSync(path.join(home, ".pi", "agent", "settings.json"), { force: true });
	rmSync(path.join(home, ".pi", "agent", "pi-sync"), { recursive: true, force: true });

	// NOTE: the fresh machine shares the same agent dir as above after we wiped
	// the mirror, simulating a clean clone. Pull must adopt the remote.
	writeAgentFile("settings.json", '{"theme":"fresh-holds-something"}\n');
	const fresh = await operations.pull(ctx(), cfgA);
	assert.equal(fresh.pulled, true);
	assert.equal(readAgentFile("settings.json"), '{"theme":"dark"}\n');
}, 15_000);

test("pull fast-forwards when only the remote changed", async () => {
	writeAgentFile("settings.json", '{"theme":"dark"}\n');
	const cfg = await config();
	await operations.push(ctx(), cfg);

	// Remote changes; local unchanged -> pull applies it.
	await simulateRemotePush({ "settings.json": '{"theme":"remote-new"}\n' });
	const pulled = await operations.pull(ctx(), cfg);
	assert.equal(pulled.pulled, true);
	assert.equal(readAgentFile("settings.json"), '{"theme":"remote-new"}\n');
}, 15_000);

test("pull --force overwrites a diverged local with the remote", async () => {
	writeAgentFile("settings.json", '{"theme":"dark"}\n');
	const cfg = await config();
	await operations.push(ctx(), cfg);

	await simulateRemotePush({ "settings.json": '{"theme":"remote-new"}\n' });
	writeAgentFile("settings.json", '{"theme":"local-stale"}\n');

	const forced = await operations.pull(ctx(), cfg, { force: true });
	assert.equal(forced.pulled, true);
	assert.equal(readAgentFile("settings.json"), '{"theme":"remote-new"}\n');
}, 15_000);

test("push refuses when the remote changed unless --force", async () => {
	writeAgentFile("settings.json", '{"theme":"dark"}\n');
	const cfg = await config();
	await operations.push(ctx(), cfg);

	await simulateRemotePush({ "settings.json": '{"theme":"remote-change"}\n' });
	writeAgentFile("settings.json", '{"theme":"local-change"}\n');

	const result = await operations.push(ctx(), cfg);
	assert.equal(result.pushed, false);
	assert.match(result.message, /Run \/sync pull/u);

	const forced = await operations.push(ctx(), cfg, { force: true });
	assert.equal(forced.pushed, true);
}, 15_000);

test("pull and push round-trip keeps files in sync", async () => {
	writeAgentFile("settings.json", '{"theme":"dark"}\n');
	const cfg = await config();
	await operations.push(ctx(), cfg);
	assert.equal(readAgentFile("settings.json"), '{"theme":"dark"}\n');

	// Edit then push.
	writeAgentFile("settings.json", '{"theme":"light"}\n');
	await operations.push(ctx(), cfg);
	assert.equal(readAgentFile("settings.json"), '{"theme":"light"}\n');

	// Simulate another machine overwriting the remote, then pull --force.
	await simulateRemotePush({ "settings.json": '{"theme":"machine2"}\n' });
	await operations.pull(ctx(), cfg, { force: true });
	assert.equal(readAgentFile("settings.json"), '{"theme":"machine2"}\n');
}, 15_000);

test("arbitrary agent-relative include entries push and pull", async () => {
	writeAgentFile("AGENTS.md", "# instructions\n");
	writeAgentFile("prompts/teach.md", "# teach\n");
	const cfg = await config({ include: ["AGENTS.md", "prompts/teach.md"] });
	await operations.push(ctx(), cfg);

	// Fresh machine pulls both files back.
	rmSync(path.join(home, ".pi", "agent", "pi-sync"), { recursive: true, force: true });
	rmSync(path.join(home, ".pi", "agent", "AGENTS.md"), { force: true });
	rmSync(path.join(home, ".pi", "agent", "prompts"), { recursive: true, force: true });
	writeAgentFile("AGENTS.md", "# stale\n");
	writeAgentFile("prompts/teach.md", "# stale\n");
	await operations.pull(ctx(), cfg);
	assert.equal(readAgentFile("AGENTS.md"), "# instructions\n");
	assert.equal(readAgentFile("prompts/teach.md"), "# teach\n");
}, 15_000);

test("a real divergence is a merge conflict that /sync merge completes", async () => {
	writeAgentFile("settings.json", '{"theme":"dark"}\n');
	const cfg = await config();
	await operations.push(ctx(), cfg);

	await simulateRemotePush({ "settings.json": '{"theme":"remote"}\n' });
	writeAgentFile("settings.json", '{"theme":"local"}\n');

	const pulled = await operations.pull(ctx(), cfg);
	assert.equal(pulled.merged, true);
	assert.ok(pulled.conflicts?.includes("settings.json"));
	assert.equal(await isMergeInProgress(), true);
	// Local never silently changed; the file carries conflict markers.
	assert.match(readAgentFile("settings.json"), /<<<<<<</u);

	// Resolve externally: pick the local side, then /sync merge.
	const resolved = '{"theme":"resolved"}\n';
	writeAgentFile("settings.json", resolved);
	const merged = await operations.merge(ctx(), cfg);
	assert.equal(merged.merged, true);
	assert.equal(await isMergeInProgress(), false);
	assert.equal(readAgentFile("settings.json"), resolved);
}, 15_000);

test("status shows state and a next-step hint", async () => {
	writeAgentFile("settings.json", '{"theme":"dark"}\n');
	const cfg = await config();
	await operations.push(ctx(), cfg);

	const { ctx: s1, notifications: n1 } = createMockContext({ hasUI: true, mode: "rpc" });
	await operations.status(s1, cfg);
	const upToDate = n1.at(-1)?.message ?? "";
	assert.ok(upToDate.includes("state: sync: up-to-date"));
	assert.ok(upToDate.includes("next: nothing — all synced"));
}, 15_000);

test("status --diff lists a changed file", async () => {
	writeAgentFile("settings.json", '{"theme":"dark"}\n');
	const cfg = await config();
	await operations.push(ctx(), cfg);

	await simulateRemotePush({ "settings.json": '{"theme":"remote"}\n' });
	await operations.fetch(ctx(), cfg);
	const { ctx: s, notifications } = createMockContext({ hasUI: true, mode: "rpc" });
	await operations.status(s, cfg, { diff: true });
	const message = notifications.at(-1)?.message ?? "";
	assert.ok(message.includes("Different: settings.json"));
	assert.ok(message.includes('"theme"'));
}, 15_000);

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
		statuses.some((entry) => entry.key === "sync"),
		`expected an indicator refresh, got ${JSON.stringify(statuses)}`,
	);
}, 15_000);

async function simulateRemotePush(
	files: Record<string, string>,
	branch = "pi-sync",
): Promise<void> {
	const cloneDir = path.join(home, "simulate");
	await runGit(["clone", "--quiet", "--branch", branch, remoteDir, cloneDir], { cwd: home });
	for (const [name, content] of Object.entries(files)) {
		const target = path.join(cloneDir, name);
		mkdirSync(path.dirname(target), { recursive: true });
		writeFileSync(target, content);
	}
	await runGit(["add", "-A"], { cwd: cloneDir });
	await runGit(["commit", "--quiet", "-m", "simulated remote change"], { cwd: cloneDir });
	await runGit(["push", "--quiet", "origin", `HEAD:${branch}`], { cwd: cloneDir });
	await rmSync(cloneDir, { recursive: true, force: true });
}
