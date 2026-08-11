import type { ConflictBlock } from "./merge-session.js";

/** A parsed diff3 conflict block with its line span in the merged text. */
export interface ParsedConflictBlock {
	block: ConflictBlock;
	/** Line index of the "<<<<<<<" marker. */
	startLine: number;
	/** Line index of the ">>>>>>>" marker (inclusive). */
	endLine: number;
}

const MARKER_OPEN = "<<<<<<<";
const MARKER_BASE = "|||||||";
const MARKER_SEP = "=======";
const MARKER_CLOSE = ">>>>>>>";

/**
 * Parse diff3 conflict markers (as written by `git merge-file --diff3`) into
 * independent blocks. Malformed blocks are skipped rather than failing the
 * whole file. Marker labels (anything after the marker prefix) are ignored.
 */
export function parseConflictBlocks(mergedText: string): ParsedConflictBlock[] {
	const lines = mergedText.split(/\r?\n/u);
	const blocks: ParsedConflictBlock[] = [];
	let index = 0;
	while (index < lines.length) {
		if (lines[index].startsWith(MARKER_OPEN)) {
			const startLine = index;
			const localEnd = findMarker(lines, index + 1, [MARKER_BASE, MARKER_SEP, MARKER_CLOSE]);
			if (localEnd === undefined) break;
			const baseStart = localEnd;
			const baseEnd = findMarker(lines, baseStart + 1, [MARKER_SEP, MARKER_CLOSE]);
			if (baseEnd === undefined) break;
			const sep = baseEnd;
			const remoteEnd = findMarker(lines, sep + 1, [MARKER_CLOSE]);
			if (remoteEnd === undefined) break;
			blocks.push({
				block: {
					local: lines.slice(startLine + 1, localEnd).join("\n"),
					base: lines.slice(baseStart + 1, sep).join("\n"),
					remote: lines.slice(sep + 1, remoteEnd).join("\n"),
					resolution: undefined,
					choice: undefined,
				},
				startLine,
				endLine: remoteEnd,
			});
			index = remoteEnd + 1;
			continue;
		}
		index += 1;
	}
	return blocks;
}

/**
 * Rebuild the merged text with conflict blocks replaced by their resolutions.
 * `resolutions[i]` is the resolved content for block i; undefined is an error.
 * Preserves the merged text's line-ending style.
 */
export function applyResolutions(
	mergedText: string,
	resolutions: Array<string | undefined>,
): string {
	const eol = mergedText.includes("\r\n") ? "\r\n" : "\n";
	const lines = mergedText.split(/\r?\n/u);
	const blocks = parseConflictBlocks(mergedText);
	if (blocks.length !== resolutions.length) {
		throw new Error(
			`Conflict block count changed (${blocks.length} on disk vs ${resolutions.length} in session). Re-run /sync pull --merge or /sync merge --abort.`,
		);
	}
	for (let index = blocks.length - 1; index >= 0; index -= 1) {
		const resolution = resolutions[index];
		if (resolution === undefined) {
			throw new Error(`Conflict block ${index + 1} is not resolved yet.`);
		}
		const block = blocks[index];
		const replacement = resolution.split(/\r?\n/u);
		lines.splice(block.startLine, block.endLine - block.startLine + 1, ...replacement);
	}
	return lines.join(eol);
}

function findMarker(lines: string[], from: number, markers: string[]): number | undefined {
	for (let index = from; index < lines.length; index += 1) {
		if (markers.some((marker) => lines[index].startsWith(marker))) return index;
	}
	return undefined;
}
