import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import { loadConfig, type SyncConfig, saveConfig } from "../src/config.js";
import { readRemoteSnapshot, runGit } from "../src/git.js";
import * as operations from "../src/operations.js";
import { createMockContext } from "./support.js";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
let home: string;
let remoteDir: string;

beforeEach(async () => {
	home = mkdtempSync(path.join(os.tmpdir(), "pi-sync-mirror-"));
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

function ctx() {
	return createMockContext({ hasUI: true, mode: "rpc" }).ctx;
}

/**
 * Push a commit to the remote branch whose tree contains files but no
 * pi-sync/snapshot.json — the legacy/foreign-format state a real remote
 * carries before the new snapshot layout takes over.
 */
async function pushLegacyTree(files: Record<string, string>): Promise<void> {
	const cloneDir = path.join(home, "legacy");
	await runGit(["clone", "--quiet", remoteDir, cloneDir], { cwd: home });
	for (const [relative, content] of Object.entries(files)) {
		const target = path.join(cloneDir, relative);
		mkdirSync(path.dirname(target), { recursive: true });
		writeFileSync(target, content);
	}
	await runGit(["add", "--", "."], { cwd: cloneDir });
	await runGit(["commit", "--quiet", "-m", "legacy tree"], { cwd: cloneDir });
	// Force: the legacy commit is unrelated to anything already on the branch,
	// and the point is to replace the branch with a non-snapshot tree.
	await runGit(["push", "--quiet", "--force", "origin", "HEAD:pi-sync"], { cwd: cloneDir });
	rmSync(cloneDir, { recursive: true, force: true });
}

test("readRemoteSnapshot returns undefined when the remote lacks snapshot.json but the mirror disk has it", async () => {
	// A normal push leaves the mirror's local main tracking pi-sync/snapshot.json.
	writeAgentFile("settings.json", '{"theme":"dark"}\n');
	const cfg = await config();
	await operations.push(ctx(), cfg);

	// The remote branch is replaced with a legacy tree: files exist, but
	// pi-sync/snapshot.json does not. The mirror working tree still has the
	// file on disk, so `git show <ref>:pi-sync/snapshot.json` fails with the
	// "path '...' exists on disk, but not in '<ref>'" variant instead of the
	// "does not exist in" variant. Both must be treated as "no remote snapshot".
	await pushLegacyTree({ "pi-sync/home/files/legacy.json": "{}" });
	await runGit(["fetch", "--quiet", "origin", "pi-sync"], {
		cwd: path.join(home, ".pi", "agent", "pi-sync", "mirror"),
	});

	const remote = await readRemoteSnapshot(cfg);
	assert.equal(remote, undefined);
});

test("publish keeps the remote tree to a single snapshot file, dropping legacy files", async () => {
	// Remote starts in a legacy state: files on the branch, no snapshot.json.
	await pushLegacyTree({ "pi-sync/home/files/legacy.json": "{}" });

	writeAgentFile("settings.json", '{"theme":"dark"}\n');
	const cfg = await config();
	await operations.push(ctx(), cfg);

	// The published tree must contain exactly pi-sync/snapshot.json — the
	// legacy file must not ride along in the commit.
	const cloneDir = path.join(home, "verify");
	await runGit(["clone", "--quiet", "--branch", "pi-sync", remoteDir, cloneDir], {
		cwd: home,
	});
	const files = await runGit(["ls-tree", "-r", "--name-only", "HEAD"], { cwd: cloneDir });
	rmSync(cloneDir, { recursive: true, force: true });
	assert.deepEqual(files.stdout.trim().split("\n").filter(Boolean), ["pi-sync/snapshot.json"]);
});
