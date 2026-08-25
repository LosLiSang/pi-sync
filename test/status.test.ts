import assert from "node:assert/strict";
import { test } from "vitest";
import { classifyState, syncBusyText, syncIndicatorText } from "../src/status.js";

function map(files: Record<string, string>): Map<string, string> {
	return new Map(Object.entries(files));
}

const INCLUDE = ["settings.json", "skills", "prompts", "models.json"];
const base = map({ "settings.json": '{"theme":"dark"}\n' });

test("identical local and remote (with base) is up-to-date", () => {
	const info = classifyState(base, base, base, false, INCLUDE);
	assert.equal(info.label, "up-to-date");
	assert.equal(syncIndicatorText(info), "sync: up-to-date");
});

test("local-only changes are ahead (push)", () => {
	const local = map({ "settings.json": '{"theme":"light"}\n' });
	const info = classifyState(local, base, base, false, INCLUDE);
	assert.equal(info.label, "ahead");
	assert.equal(info.ahead, 1);
	assert.equal(syncIndicatorText(info), "sync: 1 ahead — push");
});

test("remote-only changes are behind (pull)", () => {
	const remote = map({ "settings.json": '{"theme":"light"}\n' });
	const info = classifyState(base, remote, base, false, INCLUDE);
	assert.equal(info.label, "behind");
	assert.equal(info.behind, 1);
	assert.equal(syncIndicatorText(info), "sync: 1 behind — pull");
});

test("divergent edits on the same file are a conflict", () => {
	const local = map({ "settings.json": '{"theme":"local"}\n' });
	const remote = map({ "settings.json": '{"theme":"remote"}\n' });
	const info = classifyState(local, remote, base, false, INCLUDE);
	assert.equal(info.label, "conflict");
	assert.equal(info.conflicts, 1);
	assert.match(syncIndicatorText(info), /conflict/u);
});

test("changes on both sides in different files are a conflict", () => {
	const base2 = map({ "settings.json": '{"theme":"dark"}\n', "prompts/a.md": "a" });
	const local = map({ "settings.json": '{"theme":"local"}\n', "prompts/a.md": "a" });
	const remote = map({ "settings.json": '{"theme":"dark"}\n', "prompts/a.md": "a-remote" });
	const info = classifyState(local, remote, base2, false, INCLUDE);
	assert.equal(info.label, "conflict");
	assert.equal(info.ahead, 1);
	assert.equal(info.behind, 1);
});

test("fresh machine (no base) with matching local and remote is up-to-date, not a false conflict", () => {
	const local = map({ "settings.json": '{"theme":"dark"}\n' });
	const remote = map({ "settings.json": '{"theme":"dark"}\n' });
	const info = classifyState(local, remote, new Map(), false, INCLUDE);
	assert.equal(info.label, "up-to-date");
	assert.equal(info.conflicts, 0);
});

test("fresh machine with differing local and remote (no base) is a conservative conflict", () => {
	const local = map({ "settings.json": '{"theme":"local"}\n' });
	const remote = map({ "settings.json": '{"theme":"remote"}\n' });
	const info = classifyState(local, remote, new Map(), false, INCLUDE);
	assert.equal(info.label, "conflict");
	assert.equal(info.conflicts, 1);
});

test("no remote snapshot is unpublished", () => {
	const info = classifyState(map({ "settings.json": "x" }), new Map(), new Map(), false, INCLUDE);
	assert.equal(info.label, "unpublished");
	assert.equal(syncIndicatorText(info), "sync: unpublished — push");
});

test("a pending merge forces the conflict label", () => {
	const local = map({ "settings.json": '{"theme":"local"}\n' });
	const remote = map({ "settings.json": '{"theme":"remote"}\n' });
	const info = classifyState(local, remote, base, true, INCLUDE);
	assert.equal(info.label, "conflict");
	assert.equal(syncIndicatorText(info), "sync: conflict (1) — pull --merge or --force");
});

// --- Regression: legacy out-of-include remnants (old single-snapshot paths) ---

test("out-of-include remnants in remote & base do not count as ahead (the 75-ahead bug)", () => {
	// Remote/base carry legacy pi-sync/home/files/* and pi-sync/snapshot.json
	// that the local side never contains. They are outside the include scope and
	// must not be counted as local changes (false "ahead").
	const local = map({ "settings.json": '{"theme":"dark"}\n' });
	const remote = map({
		"settings.json": '{"theme":"dark"}\n',
		"pi-sync/snapshot.json": "{}\n",
		"pi-sync/home/files/settings.json": "x\n",
		"pi-sync/home/files/skills/x/SKILL.md": "# old\n",
	});
	// base carries the same remnants (the historical tree).
	const baseWithRemnants = map({
		"settings.json": '{"theme":"dark"}\n',
		"pi-sync/snapshot.json": "{}\n",
		"pi-sync/home/files/settings.json": "x\n",
		"pi-sync/home/files/skills/x/SKILL.md": "# old\n",
	});
	const info = classifyState(local, remote, baseWithRemnants, false, INCLUDE);
	assert.equal(info.label, "up-to-date");
	assert.equal(info.ahead, 0, "legacy remnants must not count as ahead");
	assert.equal(info.conflicts, 0);
});

test("out-of-include remnants elsewhere are still filtered for behind/conflict", () => {
	// A genuinely changed in-scope file still reports correctly alongside
	// a pile of out-of-include remnants.
	const local = map({ "settings.json": '{"theme":"dark"}\n' });
	const remote = map({
		"settings.json": '{"theme":"light"}\n',
		"pi-sync/home/files/keybindings.json": "zzz\n",
	});
	const info = classifyState(local, remote, base, false, INCLUDE);
	assert.equal(info.label, "behind");
	assert.equal(info.behind, 1);
	assert.equal(info.conflicts, 0);
});

test("local deletion of an in-scope file (base has it, remote keeps it) is ahead", () => {
	// Local removed settings.json; base & remote keep it. That is a local change
	// (deletion) → ahead, and must be reported (not dropped as unknown).
	const local = new Map<string, string>();
	const remote = map({ "settings.json": '{"theme":"dark"}\n' });
	const info = classifyState(local, remote, base, false, INCLUDE);
	assert.equal(info.label, "ahead");
	assert.equal(info.ahead, 1);
});

test("local addition of an in-scope file not in remote/base is ahead", () => {
	const local = map({ "settings.json": "a", "prompts/note.md": "# new\n" });
	const info = classifyState(
		local,
		map({ "settings.json": "a" }),
		map({ "settings.json": "a" }),
		false,
		INCLUDE,
	);
	assert.equal(info.label, "ahead");
	assert.equal(info.ahead, 1);
	assert.deepEqual(info.localChanged, ["prompts/note.md"]);
});

test("syncBusyText shows the in-flight background sync state", () => {
	assert.equal(syncBusyText(), "sync: fetching…");
	assert.equal(syncBusyText("fetch"), "sync: fetching…");
	assert.equal(syncBusyText("push"), "sync: pushing…");
});
