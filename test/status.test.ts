import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "vitest";
import type { Snapshot } from "../src/snapshot.js";
import { deriveSyncStatus, syncBusyText, syncIndicatorText } from "../src/status.js";

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function snap(files: Record<string, string>): Snapshot {
	return {
		version: 1,
		createdAt: "2026-01-01T00:00:00.000Z",
		files: Object.entries(files).map(([path, content]) => ({
			path,
			sha256: sha256(content),
			contentBase64: Buffer.from(content).toString("base64"),
		})),
	};
}

test("identical local and remote is up-to-date", () => {
	const s = snap({ "settings.json": '{"theme":"dark"}\n' });
	const info = deriveSyncStatus(s, s, s);
	assert.equal(info.label, "up-to-date");
	assert.equal(syncIndicatorText(info), "sync: up-to-date");
});

test("local-only changes are ahead (push)", () => {
	const base = snap({ "settings.json": '{"theme":"dark"}\n' });
	const local = snap({ "settings.json": '{"theme":"light"}\n' });
	const info = deriveSyncStatus(local, base, base);
	assert.equal(info.label, "ahead");
	assert.equal(info.ahead, 1);
	assert.equal(syncIndicatorText(info), "sync: 1 ahead — push");
});

test("remote-only changes are behind (pull)", () => {
	const base = snap({ "settings.json": '{"theme":"dark"}\n' });
	const remote = snap({ "settings.json": '{"theme":"light"}\n' });
	const info = deriveSyncStatus(base, remote, base);
	assert.equal(info.label, "behind");
	assert.equal(info.ahead, 0);
	assert.equal(info.behind, 1);
	assert.equal(syncIndicatorText(info), "sync: 1 behind — pull");
});

test("divergent edits on the same file are a conflict", () => {
	const base = snap({ "settings.json": '{"theme":"dark"}\n' });
	const local = snap({ "settings.json": '{"theme":"local"}\n' });
	const remote = snap({ "settings.json": '{"theme":"remote"}\n' });
	const info = deriveSyncStatus(local, remote, base);
	assert.equal(info.label, "conflict");
	assert.equal(info.conflicts, 1);
	assert.match(syncIndicatorText(info), /conflict/u);
});

test("changes on both sides in different files are a conflict", () => {
	const base = snap({ "a.json": "a", "b.json": "b" });
	const local = snap({ "a.json": "a-local", "b.json": "b" });
	const remote = snap({ "a.json": "a", "b.json": "b-remote" });
	const info = deriveSyncStatus(local, remote, base);
	assert.equal(info.label, "conflict");
	assert.equal(info.ahead, 1);
	assert.equal(info.behind, 1);
});

test("no remote snapshot is unpublished", () => {
	const local = snap({ "settings.json": "x" });
	const info = deriveSyncStatus(local, undefined, undefined);
	assert.equal(info.label, "unpublished");
	assert.equal(syncIndicatorText(info), "sync: unpublished — push");
});

test("syncBusyText shows the in-flight background sync state", () => {
	assert.equal(syncBusyText(), "sync: fetching…");
	assert.equal(syncBusyText("fetch"), "sync: fetching…");
	assert.equal(syncBusyText("push"), "sync: pushing…");
});
