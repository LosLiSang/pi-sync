import assert from "node:assert/strict";
import { test } from "vitest";
import { diffSummary, formatDiff } from "../src/diff.js";

function map(files: Record<string, string>): Map<string, string> {
	return new Map(Object.entries(files));
}

test("diffSummary counts added, removed, and changed files", () => {
	const local = map({
		"settings.json": "a",
		"skills/only-local.md": "x",
	});
	const remote = map({
		"settings.json": "b",
		"prompts/only-remote.md": "y",
	});
	const summary = diffSummary(local, remote);
	assert.deepEqual(summary, { changed: 1, added: 1, removed: 1, identical: false });
	assert.equal(diffSummary(local, local).identical, true);
});

test("formatDiff renders unified hunks with JSON pretty-print", () => {
	const local = map({ "settings.json": '{"theme":"dark"}\n' });
	const remote = map({ "settings.json": '{"theme":"light"}\n' });
	const output = formatDiff(local, remote);
	assert.match(output, /Different: settings\.json/u);
	assert.match(output, /"theme": "dark"/u);
	assert.match(output, /"theme": "light"/u);
	assert.match(output, /@@/u);
});

test("formatDiff masks secret values", () => {
	const local = map({
		"settings.json": '{"apiKey":"sk-ant-secret123456789012345678901234"}\n',
	});
	const remote = map({
		"settings.json": '{"apiKey":"sk-ant-other987654321098765432109876"}\n',
	});
	const output = formatDiff(local, remote);
	assert.equal(output.includes("sk-ant-secret123456789012345678901234"), false);
	assert.equal(output.includes("sk-ant-other987654321098765432109876"), false);
	assert.match(output, /\*\*\*\*/u);
});

test("formatDiff reports identical trees", () => {
	const local = map({ "settings.json": "same\n" });
	const remote = map({ "settings.json": "same\n" });
	assert.match(formatDiff(local, remote), /No file differences\./u);
});

test("formatDiff stays bounded and lists every changed path", () => {
	const lines = (suffix: string) =>
		Array.from(
			{ length: 40 },
			(_, index) => `line ${String(index).padStart(2, "0")} ${suffix}`,
		).join("\n");
	const local = map(
		Object.fromEntries(
			Array.from({ length: 30 }, (_, index) => [
				`extensions/a${String(index).padStart(2, "0")}.json`,
				`${lines("local")}\n`,
			]),
		),
	);
	const remote = map(
		Object.fromEntries(
			Array.from({ length: 30 }, (_, index) => [
				`extensions/a${String(index).padStart(2, "0")}.json`,
				`${lines("remote")}\n`,
			]),
		),
	);
	const output = formatDiff(local, remote);
	assert.match(output, /content hunks truncated/u);
	assert.match(output, /Different: extensions\/a29\.json/u);
	assert.ok(output.split("\n").length < 2_000, "output must stay bounded");
	assert.ok(
		output.match(/Different: extensions\/a\d+\.json/gu)?.length === 30,
		"every changed path is listed",
	);
});
