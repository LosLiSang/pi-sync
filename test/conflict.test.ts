import assert from "node:assert/strict";
import { test } from "vitest";
import { applyResolutions, parseConflictBlocks } from "../src/conflict.js";

const MERGED = [
	"line1",
	"<<<<<<< local",
	"local-a",
	"local-b",
	"||||||| base",
	"base-a",
	"=======",
	"remote-a",
	">>>>>>> remote",
	"line2",
	"<<<<<<< local",
	"x",
	"||||||| base",
	"y",
	"=======",
	"z",
	">>>>>>> remote",
	"end",
].join("\n");

test("parseConflictBlocks splits diff3 markers into blocks with sides", () => {
	const blocks = parseConflictBlocks(MERGED);
	assert.equal(blocks.length, 2);
	assert.equal(blocks[0].block.local, "local-a\nlocal-b");
	assert.equal(blocks[0].block.base, "base-a");
	assert.equal(blocks[0].block.remote, "remote-a");
	assert.equal(blocks[0].startLine, 1);
	assert.equal(blocks[0].endLine, 8);
	assert.equal(blocks[1].block.local, "x");
	assert.equal(blocks[1].block.base, "y");
	assert.equal(blocks[1].block.remote, "z");
});

test("parseConflictBlocks ignores marker labels after the prefix", () => {
	const text =
		"<<<<<<< C:\\tmp\\local\nA\n||||||| C:\\tmp\\base\nB\n=======\nC\n>>>>>>> C:\\tmp\\remote\n";
	const blocks = parseConflictBlocks(text);
	assert.equal(blocks.length, 1);
	assert.deepEqual(blocks[0].block, {
		local: "A",
		base: "B",
		remote: "C",
		resolution: undefined,
		choice: undefined,
	});
});

test("parseConflictBlocks returns nothing for marker-free text", () => {
	assert.deepEqual(parseConflictBlocks("plain\ncontent\n"), []);
});

test("parseConflictBlocks bails out of a malformed block", () => {
	const text = "<<<<<<< local\nno closing marker\nrest\n";
	assert.deepEqual(parseConflictBlocks(text), []);
});

test("applyResolutions splices every block with its resolution", () => {
	const resolved = applyResolutions(MERGED, ["LOCAL-KEPT", "custom\nmulti"]);
	assert.equal(resolved, ["line1", "LOCAL-KEPT", "line2", "custom", "multi", "end"].join("\n"));
});

test("applyResolutions preserves CRLF line endings", () => {
	const crlf = MERGED.replace(/\n/gu, "\r\n");
	const resolved = applyResolutions(crlf, ["A", "B"]);
	assert.equal(resolved, ["line1", "A", "line2", "B", "end"].join("\r\n"));
});

test("applyResolutions throws on count mismatch", () => {
	assert.throws(() => applyResolutions(MERGED, ["only-one"]), /block count changed/u);
});

test("applyResolutions throws on an unresolved block", () => {
	assert.throws(() => applyResolutions(MERGED, ["A", undefined]), /not resolved/u);
});
