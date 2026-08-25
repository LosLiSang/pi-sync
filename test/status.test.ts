import assert from "node:assert/strict";
import { test } from "vitest";
import { classifyState, syncBusyText, syncIndicatorText } from "../src/status.js";

function map(files: Record<string, string>): Map<string, string> {
	return new Map(Object.entries(files));
}

const base = map({ "settings.json": '{"theme":"dark"}\n' });

test("identical local and remote (with base) is up-to-date", () => {
	const info = classifyState(base, base, base, false);
	assert.equal(info.label, "up-to-date");
	assert.equal(syncIndicatorText(info), "sync: up-to-date");
});

test("local-only changes are ahead (push)", () => {
	const local = map({ "settings.json": '{"theme":"light"}\n' });
	const info = classifyState(local, base, base, false);
	assert.equal(info.label, "ahead");
	assert.equal(info.ahead, 1);
	assert.equal(syncIndicatorText(info), "sync: 1 ahead — push");
});

test("remote-only changes are behind (pull)", () => {
	const remote = map({ "settings.json": '{"theme":"light"}\n' });
	const info = classifyState(base, remote, base, false);
	assert.equal(info.label, "behind");
	assert.equal(info.behind, 1);
	assert.equal(syncIndicatorText(info), "sync: 1 behind — pull");
});

test("divergent edits on the same file are a conflict", () => {
	const local = map({ "settings.json": '{"theme":"local"}\n' });
	const remote = map({ "settings.json": '{"theme":"remote"}\n' });
	const info = classifyState(local, remote, base, false);
	assert.equal(info.label, "conflict");
	assert.equal(info.conflicts, 1);
	assert.match(syncIndicatorText(info), /conflict/u);
});

test("changes on both sides in different files are a conflict", () => {
	const base2 = map({ "a.json": "a", "b.json": "b" });
	const local = map({ "a.json": "a-local", "b.json": "b" });
	const remote = map({ "a.json": "a", "b.json": "b-remote" });
	const info = classifyState(local, remote, base2, false);
	assert.equal(info.label, "conflict");
	assert.equal(info.ahead, 1);
	assert.equal(info.behind, 1);
});

test("fresh machine (no base) with matching local and remote is up-to-date, not a false conflict", () => {
	const local = map({ "settings.json": '{"theme":"dark"}\n' });
	const remote = map({ "settings.json": '{"theme":"dark"}\n' });
	const info = classifyState(local, remote, new Map(), false);
	assert.equal(info.label, "up-to-date");
	assert.equal(info.conflicts, 0);
});

test("fresh machine with differing local and remote (no base) is a conservative conflict", () => {
	const local = map({ "settings.json": '{"theme":"local"}\n' });
	const remote = map({ "settings.json": '{"theme":"remote"}\n' });
	const info = classifyState(local, remote, new Map(), false);
	assert.equal(info.label, "conflict");
	assert.equal(info.conflicts, 1);
});

test("no remote snapshot is unpublished", () => {
	const info = classifyState(map({ "settings.json": "x" }), new Map(), new Map(), false);
	assert.equal(info.label, "unpublished");
	assert.equal(syncIndicatorText(info), "sync: unpublished — push");
});

test("a pending merge forces the conflict label", () => {
	const local = map({ "settings.json": '{"theme":"local"}\n' });
	const remote = map({ "settings.json": '{"theme":"remote"}\n' });
	const info = classifyState(local, remote, base, true);
	assert.equal(info.label, "conflict");
	assert.equal(syncIndicatorText(info), "sync: conflict (1) — pull --merge or --force");
});

test("syncBusyText shows the in-flight background sync state", () => {
	assert.equal(syncBusyText(), "sync: fetching…");
	assert.equal(syncBusyText("fetch"), "sync: fetching…");
	assert.equal(syncBusyText("push"), "sync: pushing…");
});
