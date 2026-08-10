import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "vitest";
import { hasConflictMarkers, mergeSnapshot, mergeTexts, planMerge } from "../src/merge.js";
import type { Snapshot } from "../src/snapshot.js";

function snapshot(files: Array<{ path: string; content: string }>): Snapshot {
	return {
		version: 1,
		createdAt: new Date().toISOString(),
		files: files.map((file) => ({
			path: file.path,
			sha256: createHash("sha256").update(file.content).digest("hex"),
			contentBase64: Buffer.from(file.content).toString("base64"),
		})),
	};
}

test("planMerge takes remote when only remote changed", () => {
	const base = snapshot([{ path: "settings.json", content: "base" }]);
	const local = snapshot([{ path: "settings.json", content: "base" }]);
	const remote = snapshot([{ path: "settings.json", content: "remote change" }]);
	const plan = planMerge(local, remote, base);
	assert.deepEqual(plan.takeRemote, ["settings.json"]);
	assert.deepEqual(plan.takeLocal, []);
	assert.deepEqual(plan.conflicts, []);
});

test("planMerge takes local when only local changed", () => {
	const base = snapshot([{ path: "settings.json", content: "base" }]);
	const local = snapshot([{ path: "settings.json", content: "local change" }]);
	const remote = snapshot([{ path: "settings.json", content: "base" }]);
	const plan = planMerge(local, remote, base);
	assert.deepEqual(plan.takeLocal, ["settings.json"]);
	assert.deepEqual(plan.takeRemote, []);
});

test("planMerge flags divergent files as conflicts", () => {
	const base = snapshot([{ path: "settings.json", content: "base" }]);
	const local = snapshot([{ path: "settings.json", content: "local" }]);
	const remote = snapshot([{ path: "settings.json", content: "remote" }]);
	const plan = planMerge(local, remote, base);
	assert.deepEqual(plan.conflicts, ["settings.json"]);
});

test("planMerge treats identical files as unchanged", () => {
	const base = snapshot([
		{ path: "a", content: "x" },
		{ path: "b", content: "y" },
	]);
	const local = snapshot([
		{ path: "a", content: "x" },
		{ path: "b", content: "y2" },
	]);
	const remote = snapshot([
		{ path: "a", content: "x" },
		{ path: "b", content: "y" },
	]);
	const plan = planMerge(local, remote, base);
	assert.deepEqual(plan.unchanged, ["a"]);
	assert.deepEqual(plan.takeLocal, ["b"]);
});

test("planMerge with no base treats everything as changed", () => {
	const local = snapshot([{ path: "a", content: "1" }]);
	const remote = snapshot([{ path: "a", content: "2" }]);
	const plan = planMerge(local, remote, undefined);
	assert.deepEqual(plan.conflicts, ["a"]);
});

test("mergeTexts merges non-overlapping edits cleanly", async () => {
	const base = "one\ntwo\nthree\n";
	const local = "one\nlocal\ntwo\nthree\n";
	const remote = "one\ntwo\nthree\nremote\n";
	const result = await mergeTexts(base, local, remote);
	assert.equal(result.conflicted, false);
	assert.match(result.merged, /local/u);
	assert.match(result.merged, /remote/u);
	assert.match(result.merged, /one/u);
});

test("mergeTexts produces conflict markers for overlapping edits", async () => {
	const base = "one\ntwo\n";
	const local = "one\nLOCAL\n";
	const remote = "one\nREMOTE\n";
	const result = await mergeTexts(base, local, remote);
	assert.equal(result.conflicted, true);
	assert.ok(hasConflictMarkers(result.merged));
	assert.match(result.merged, /LOCAL/u);
	assert.match(result.merged, /REMOTE/u);
});

test("mergeSnapshot adopts remote files and keeps local conflict content", () => {
	const local = snapshot([
		{ path: "a", content: "local-a" },
		{ path: "c", content: "local-c" },
	]);
	const remote = snapshot([
		{ path: "b", content: "remote-b" },
		{ path: "c", content: "remote-c" },
	]);
	const merged = mergeSnapshot(
		local,
		remote,
		{ takeLocal: ["a"], takeRemote: ["b"], conflicts: ["c"], unchanged: [] },
		new Map([["c", "merged-c"]]),
	);
	const byPath = new Map(merged.files.map((file) => [file.path, file.contentBase64]));
	assert.equal(Buffer.from(byPath.get("a") ?? "", "base64").toString("utf8"), "local-a");
	assert.equal(Buffer.from(byPath.get("b") ?? "", "base64").toString("utf8"), "remote-b");
	assert.equal(Buffer.from(byPath.get("c") ?? "", "base64").toString("utf8"), "merged-c");
});
