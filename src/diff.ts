import { createTwoFilesPatch } from "diff";

const HUNK_CONTEXT_LINES = 2;
const MAX_HUNK_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_HUNK_LINES = 300;
const SECRET_MASK = "****";
const TRUNCATED_MARKER = "… (hunk truncated)";

const SECRET_PATTERNS = [
	/AWS_SECRET_ACCESS_KEY\s*[=:]\s*['"]?[A-Za-z0-9/+]{35,}/i,
	/(ANTHROPIC|OPENAI|GEMINI|GOOGLE|FIRECRAWL|GITHUB|CLOUDFLARE|R2|S3)_[A-Z0-9_]*(KEY|TOKEN|SECRET)\s*[=:]\s*['"]?[^\s'"]{12,}/i,
	/sk-ant-[A-Za-z0-9_-]{20,}/,
	/sk-[A-Za-z0-9]{20,}/,
	/gh[pousr]_[A-Za-z0-9_]{20,}/,
];

export interface DiffSummary {
	changed: number;
	added: number;
	removed: number;
	identical: boolean;
}

/** Summarize the difference between two path→content maps (agent vs remote). */
export function diffSummary(local: Map<string, string>, remote: Map<string, string>): DiffSummary {
	const paths = new Set([...local.keys(), ...remote.keys()]);
	let added = 0;
	let removed = 0;
	let changed = 0;
	for (const filePath of paths) {
		if (!local.has(filePath)) added += 1;
		else if (!remote.has(filePath)) removed += 1;
		else if (local.get(filePath) !== remote.get(filePath)) changed += 1;
	}
	return { changed, added, removed, identical: added === 0 && removed === 0 && changed === 0 };
}

/** Content-level diff of local vs remote path→content maps (JSON pretty, masked, bounded). */
export function formatDiff(local: Map<string, string>, remote: Map<string, string>): string {
	const allPaths = [...new Set([...local.keys(), ...remote.keys()])].sort();
	const lines = [`local: ${local.size} files`, `remote: ${remote.size} files`, ""];
	let totalChanges = 0;
	let hunkBudget = MAX_TOTAL_HUNK_LINES;
	let truncated = false;
	const appendHunks = (hunks: string[]) => {
		if (hunks.length === 0) return;
		lines.push(...hunks.map((line) => `  ${line}`));
		hunkBudget -= hunks.length;
		if (hunks.at(-1) === TRUNCATED_MARKER) truncated = true;
	};
	for (const filePath of allPaths) {
		if (!local.has(filePath)) {
			lines.push(`Remote only: ${filePath}`);
			totalChanges += 1;
			if (hunkBudget <= 0) truncated = true;
			else appendHunks(contentHunks("", remote.get(filePath) ?? "", hunkBudget));
		} else if (!remote.has(filePath)) {
			lines.push(`Local only: ${filePath}`);
			totalChanges += 1;
			if (hunkBudget <= 0) truncated = true;
			else appendHunks(contentHunks("", local.get(filePath) ?? "", hunkBudget));
		} else if (local.get(filePath) !== remote.get(filePath)) {
			lines.push(`Different: ${filePath}`);
			totalChanges += 1;
			if (hunkBudget <= 0) truncated = true;
			else {
				const texts = diffTexts(remote.get(filePath), local.get(filePath));
				appendHunks(contentHunks(texts.before, texts.after, hunkBudget));
			}
		}
	}
	if (totalChanges === 0) lines.push("No file differences.");
	else if (truncated) lines.push("(content hunks truncated; all changed paths are listed)");
	return lines.join("\n");
}

function diffTexts(before: string | undefined, after: string | undefined) {
	const beforePretty = before !== undefined ? prettyJson(before) : undefined;
	const afterPretty = after !== undefined ? prettyJson(after) : undefined;
	if (beforePretty !== undefined || afterPretty !== undefined) {
		return { before: beforePretty ?? "", after: afterPretty ?? "" };
	}
	return { before: before ?? "", after: after ?? "" };
}

function prettyJson(text: string): string | undefined {
	try {
		return JSON.stringify(JSON.parse(text), null, 2);
	} catch {
		return undefined;
	}
}

function contentHunks(before: string, after: string, maxLines: number): string[] {
	if (before === after) return [];
	if (maxLines <= 0) return [];
	if (before.length > MAX_HUNK_FILE_BYTES || after.length > MAX_HUNK_FILE_BYTES) return [];
	const patch = createTwoFilesPatch("", "", before, after, "", "", {
		context: HUNK_CONTEXT_LINES,
	});
	const lines: string[] = [];
	let inHunks = false;
	for (const line of patch.split("\n")) {
		if (!inHunks) {
			if (line.startsWith("@@")) inHunks = true;
			else continue;
		}
		if (line === "" || line === "\\ No newline at end of file") continue;
		if (lines.length >= maxLines) {
			lines[maxLines - 1] = TRUNCATED_MARKER;
			break;
		}
		lines.push(sanitizeHunkLine(line));
	}
	return lines;
}

function sanitizeHunkLine(line: string): string {
	const prefix =
		line.startsWith("+") || line.startsWith("-") || line.startsWith(" ") ? line[0] : "";
	const content = prefix ? line.slice(1) : line;
	return `${prefix}${safeTerminalText(maskSecrets(content))}`;
}

function maskSecrets(text: string): string {
	let masked = text;
	for (const pattern of SECRET_PATTERNS) {
		masked = masked.replace(new RegExp(pattern.source, "giu"), (match) => {
			const separator = match.search(/[=:]/u);
			if (separator >= 0 && separator < match.length - 1) {
				return `${match.slice(0, separator + 1)}${SECRET_MASK}`;
			}
			return SECRET_MASK;
		});
	}
	return masked;
}

function safeTerminalText(value: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: Escape untrusted terminal controls.
	return value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, "?");
}
