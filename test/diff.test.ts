import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "vitest";
import { diffSummary, formatSnapshotDiff } from "../src/diff.js";
import type { Snapshot } from "../src/snapshot.js";

function snapshot(id: string, files: Array<{ path: string; content: string }>): Snapshot {
	return {
		version: 1,
		createdAt: id,
		files: files.map((file) => ({
			path: file.path,
			sha256: createHash("sha256").update(file.content).digest("hex"),
			contentBase64: Buffer.from(file.content).toString("base64"),
		})),
	};
}

test("diffSummary counts added, removed, and changed files", () => {
	const local = snapshot("local", [
		{ path: "settings.json", content: "a" },
		{ path: "skills/only-local.md", content: "x" },
	]);
	const remote = snapshot("remote", [
		{ path: "settings.json", content: "b" },
		{ path: "prompts/only-remote.md", content: "y" },
	]);
	const summary = diffSummary(local, remote);
	assert.deepEqual(summary, { changed: 1, added: 1, removed: 1, identical: false });
	assert.equal(diffSummary(local, local).identical, true);
});

test("formatSnapshotDiff renders unified hunks with JSON pretty-print", () => {
	const local = snapshot("local", [{ path: "settings.json", content: '{"theme":"dark"}\n' }]);
	const remote = snapshot("remote", [{ path: "settings.json", content: '{"theme":"light"}\n' }]);
	const output = formatSnapshotDiff(local, remote);
	assert.match(output, /Different: settings\.json/u);
	assert.match(output, /"theme": "dark"/u);
	assert.match(output, /"theme": "light"/u);
	assert.match(output, /@@/u);
});

test("formatSnapshotDiff masks secret values", () => {
	const local = snapshot("local", [
		{ path: "settings.json", content: '{"apiKey":"sk-ant-secret123456789012345678901234"}\n' },
	]);
	const remote = snapshot("remote", [
		{ path: "settings.json", content: '{"apiKey":"sk-ant-other987654321098765432109876"}\n' },
	]);
	const output = formatSnapshotDiff(local, remote);
	assert.equal(output.includes("sk-ant-secret123456789012345678901234"), false);
	assert.equal(output.includes("sk-ant-other987654321098765432109876"), false);
	assert.match(output, /\*\*\*\*/u);
});

test("formatSnapshotDiff reports identical snapshots", () => {
	const local = snapshot("local", [{ path: "settings.json", content: "same\n" }]);
	const remote = snapshot("remote", [{ path: "settings.json", content: "same\n" }]);
	assert.match(formatSnapshotDiff(local, remote), /No file differences\./u);
});

test("formatSnapshotDiff stays bounded and lists every changed path", () => {
	const lines = (suffix: string) =>
		Array.from(
			{ length: 40 },
			(_, index) => `line ${String(index).padStart(2, "0")} ${suffix}`,
		).join("\n");
	const local = snapshot(
		"local",
		Array.from({ length: 30 }, (_, index) => ({
			path: `extensions/a${String(index).padStart(2, "0")}.json`,
			content: `${lines("local")}\n`,
		})),
	);
	const remote = snapshot(
		"remote",
		Array.from({ length: 30 }, (_, index) => ({
			path: `extensions/a${String(index).padStart(2, "0")}.json`,
			content: `${lines("remote")}\n`,
		})),
	);
	const output = formatSnapshotDiff(local, remote);
	assert.match(output, /content hunks truncated/u);
	assert.match(output, /Different: extensions\/a29\.json/u);
	assert.ok(output.split("\n").length < 2_000, "output must stay bounded");
	assert.ok(
		output.match(/Different: extensions\/a\d+\.json/gu)?.length === 30,
		"every changed path is listed",
	);
});
