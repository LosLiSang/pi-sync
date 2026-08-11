import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { type MergeSessionData, saveMergeSession } from "./merge-session.js";

export interface ResolveResult {
	/** True when every block now has a resolution. */
	completed: boolean;
	resolved: number;
}

const KEEP_LOCAL = "keep local";
const KEEP_REMOTE = "keep remote";
const TYPE_REPLACEMENT = "type replacement";
const ABORT = "abort";

/**
 * Structured conflict resolution: walk the unresolved blocks one at a time and
 * let the user keep the local side, keep the remote side, or type a
 * replacement. Each block is persisted as it resolves, so an interrupted run
 * resumes from where it stopped (/sync merge).
 */
export async function runBlockResolver(
	ui: ExtensionUIContext,
	session: MergeSessionData,
): Promise<ResolveResult> {
	const pending: Array<{ file: MergeSessionData["files"][number]; index: number }> = [];
	for (const file of session.files) {
		for (let index = 0; index < file.blocks.length; index += 1) {
			if (file.blocks[index].resolution === undefined) {
				pending.push({ file, index });
			}
		}
	}
	if (pending.length === 0) return { completed: true, resolved: 0 };

	let resolved = 0;
	for (const { file, index } of pending) {
		const block = file.blocks[index];
		const choice = await ui.select(`${file.path} — conflict ${index + 1}/${file.blocks.length}`, [
			KEEP_LOCAL,
			KEEP_REMOTE,
			TYPE_REPLACEMENT,
			ABORT,
		]);
		if (choice === undefined || choice === ABORT) {
			await saveMergeSession(session);
			return { completed: false, resolved };
		}
		if (choice === KEEP_LOCAL) {
			block.resolution = block.local;
			block.choice = "local";
		} else if (choice === KEEP_REMOTE) {
			block.resolution = block.remote;
			block.choice = "remote";
		} else {
			const custom = await ui.input(`Replacement for ${file.path} block ${index + 1}`);
			if (custom === undefined) {
				await saveMergeSession(session);
				return { completed: false, resolved };
			}
			block.resolution = custom;
			block.choice = "custom";
		}
		resolved += 1;
		await saveMergeSession(session);
	}
	return { completed: true, resolved };
}
