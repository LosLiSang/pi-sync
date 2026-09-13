import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { SyncConfig } from "./config.js";
import { mirrorRepoDir, stateDir } from "./config.js";

const GIT_TIMEOUT_MS = 60_000;
const COMMIT_IDENTITY = { name: "pi-sync", email: "pi-sync@local" };

export class GitCommandError extends Error {
	readonly exitCode: number | null;
	readonly stderr: string;

	constructor(message: string, exitCode: number | null, stderr: string) {
		super(message);
		this.name = "GitCommandError";
		this.exitCode = exitCode;
		this.stderr = stderr;
	}
}

export interface GitRunOptions {
	signal?: AbortSignal;
	cwd?: string;
	input?: Buffer | string;
	timeoutMs?: number;
}

export interface GitRunResult {
	stdout: string;
	stderr: string;
}

/** Run one git command with a bounded timeout and prompt-free environment. */
export async function runGit(args: string[], options: GitRunOptions = {}): Promise<GitRunResult> {
	throwIfAborted(options.signal);
	const env: NodeJS.ProcessEnv = {
		...process.env,
		GIT_TERMINAL_PROMPT: "0",
		GCM_INTERACTIVE: "Never",
		GIT_ASKPASS: "",
		SSH_ASKPASS: "",
		SSH_ASKPASS_REQUIRE: "never",
		GIT_SSH_COMMAND: "ssh -oBatchMode=yes",
		GIT_AUTHOR_NAME: COMMIT_IDENTITY.name,
		GIT_AUTHOR_EMAIL: COMMIT_IDENTITY.email,
		GIT_COMMITTER_NAME: COMMIT_IDENTITY.name,
		GIT_COMMITTER_EMAIL: COMMIT_IDENTITY.email,
		LC_ALL: "C",
		LANG: "C",
	};
	const child = spawn("git", args, {
		cwd: options.cwd,
		env,
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
	});
	const stdout: Buffer[] = [];
	const stderr: Buffer[] = [];
	let settled = false;
	let terminationError: Error | undefined;

	const terminate = (error: Error) => {
		if (settled || terminationError) return;
		terminationError = error;
		child.kill("SIGTERM");
		setTimeout(() => {
			if (!settled) child.kill("SIGKILL");
		}, 2_000);
	};
	child.stdout.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
	child.stderr.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
	child.stdin.on("error", () => undefined);
	if (options.input !== undefined) child.stdin.end(options.input);
	else child.stdin.end();
	const onAbort = () => terminate(signalReason(options.signal));
	options.signal?.addEventListener("abort", onAbort, { once: true });
	const timer = setTimeout(
		() =>
			terminate(new Error(`Git command timed out after ${options.timeoutMs ?? GIT_TIMEOUT_MS}ms.`)),
		options.timeoutMs ?? GIT_TIMEOUT_MS,
	);

	try {
		const result = await new Promise<GitRunResult>((resolve, reject) => {
			child.once("error", reject);
			child.once("close", (code) => {
				settled = true;
				const stdoutText = Buffer.concat(stdout).toString("utf8");
				const stderrText = Buffer.concat(stderr).toString("utf8");
				if (terminationError) {
					reject(terminationError);
					return;
				}
				if (code !== 0) {
					reject(
						new GitCommandError(
							stderrText.trim() || `Git exited with status ${code ?? "unknown"}.`,
							code,
							stderrText,
						),
					);
					return;
				}
				resolve({ stdout: stdoutText, stderr: stderrText });
			});
		});
		return result;
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", onAbort);
	}
}

function gitCwd(): string {
	return mirrorRepoDir();
}

/** Ensure the mirror repo exists, is initialized and knows the remote. */
export async function ensureMirror(config: SyncConfig): Promise<void> {
	await fs.mkdir(stateDir(), { recursive: true });
	const repo = mirrorRepoDir();
	if (!(await pathExists(repo))) {
		await fs.mkdir(repo, { recursive: true });
		await runGit(["init", "-b", "main"], { cwd: repo });
	}
	// Never let git re-write line endings in the mirror; config content must
	// round-trip byte-exactly between the agent dir and the remote.
	await runGit(["config", "core.autocrlf", "false"], { cwd: repo });
	await runGit(["config", "core.eol", "lf"], { cwd: repo });
	await runGit(["config", "core.safecrlf", "false"], { cwd: repo });
	await runGit(["remote", "set-url", "origin", config.remote], { cwd: repo }).catch(async () => {
		await runGit(["remote", "add", "origin", config.remote], { cwd: repo });
	});
}

/**
 * Ensure the mirror work tree is checked out on the configured sync branch.
 * When the branch does not exist locally but exists on the remote, the local
 * branch is created tracking it (so a fresh machine starts equal to the remote
 * — no false conflict). Otherwise the local branch starts empty. The remote is
 * fetched first so origin/<branch> is up to date.
 *
 * Returns `fresh`=true when a local branch was just created (either tracking an
 * existing remote branch, or an empty orphan). This signals the first sync on
 * this machine, so a pull adopts the remote (clean checkout) instead of doing a
 * three-way merge against an implicitly-empty base.
 */
export async function ensureBranch(
	config: SyncConfig,
	options: GitRunOptions = {},
): Promise<{ fresh: boolean; remoteExists: boolean }> {
	await ensureMirror(config);
	await fetchRemote(config, options);
	const repo = gitCwd();
	const remoteRef = `refs/remotes/origin/${config.branch}`;
	const remoteExists = await refExists(remoteRef, options);
	if (!(await branchExists(config.branch))) {
		if (remoteExists) {
			await runGit(["checkout", "-B", config.branch, "-t", remoteRef], {
				cwd: repo,
				signal: options.signal,
			});
			return { fresh: true, remoteExists };
		}
		await runGit(["checkout", "--orphan", config.branch], { cwd: repo, signal: options.signal });
		return { fresh: true, remoteExists };
	}
	return { fresh: false, remoteExists };
}

/** Fetch the configured branch from the remote into origin/<branch>. */
export async function fetchRemote(config: SyncConfig, options: GitRunOptions = {}): Promise<void> {
	await ensureMirror(config);
	try {
		await runGit(["fetch", "--quiet", "origin", config.branch], {
			cwd: gitCwd(),
			signal: options.signal,
			timeoutMs: options.timeoutMs,
		});
	} catch (error) {
		// A fresh remote without the branch yet is a normal first-run state.
		if (error instanceof GitCommandError && error.stderr.includes("couldn't find remote ref")) {
			return;
		}
		throw error;
	}
}

/** Remote revision (commit sha) for the branch, or undefined when absent. */
export async function readRemoteRevision(
	config: SyncConfig,
	options: GitRunOptions = {},
): Promise<string | undefined> {
	if (!(await pathExists(mirrorRepoDir()))) return undefined;
	try {
		const result = await runGit(["rev-parse", `refs/remotes/origin/${config.branch}`], {
			cwd: gitCwd(),
			signal: options.signal,
			timeoutMs: options.timeoutMs,
		});
		return result.stdout.trim();
	} catch (error) {
		if (error instanceof GitCommandError && isMissingRefError(error.stderr)) return undefined;
		throw error;
	}
}

/** Read the file tree of the remote branch as a path→content map. */
export async function readRemoteFiles(
	config: SyncConfig,
	options: GitRunOptions = {},
): Promise<Map<string, string>> {
	return readFilesAt(`refs/remotes/origin/${config.branch}`, options);
}

/** Read the file tree at a specific ref as a path→content map. */
async function readFilesAt(ref: string, options: GitRunOptions = {}): Promise<Map<string, string>> {
	const repo = gitCwd();
	if (!(await pathExists(repo))) return new Map();
	try {
		const result = await runGit(["ls-tree", "-r", "--name-only", ref], {
			cwd: repo,
			signal: options.signal,
			timeoutMs: options.timeoutMs,
		});
		const entries = result.stdout.split("\n").filter(Boolean);
		const map = new Map<string, string>();
		for (const entry of entries) {
			try {
				const out = await runGit(["show", `${ref}:${entry}`], {
					cwd: repo,
					signal: options.signal,
					timeoutMs: options.timeoutMs,
				});
				map.set(entry, out.stdout);
			} catch {
				// Binary or unreadable path — skip for the diff view.
			}
		}
		return map;
	} catch (error) {
		if (error instanceof GitCommandError && isMissingRefError(error.stderr)) return new Map();
		throw error;
	}
}

/**
 * Read the content map at the merge-base of the local branch and the remote
 * branch; empty when no shared ancestor exists (fresh branch).
 */
export async function readMergeBase(
	config: SyncConfig,
	options: GitRunOptions = {},
): Promise<Map<string, string>> {
	const repo = gitCwd();
	const remoteRef = `refs/remotes/origin/${config.branch}`;
	if (!(await pathExists(repo)) || !(await refExists(remoteRef, options))) return new Map();
	let base: string;
	try {
		const result = await runGit(["merge-base", config.branch, remoteRef], {
			cwd: repo,
			signal: options.signal,
			timeoutMs: options.timeoutMs,
		});
		base = result.stdout.trim();
	} catch {
		return new Map();
	}
	if (!base) return new Map();
	return readFilesAt(base, options);
}

/** Read the content of a file at a specific git ref (e.g. "HEAD:settings.json"). */
export async function readCommitFile(
	ref: string,
	relativePath: string,
	options: GitRunOptions = {},
): Promise<string | undefined> {
	const repo = gitCwd();
	try {
		const out = await runGit(["show", `${ref}:${relativePath}`], {
			cwd: repo,
			signal: options.signal,
			timeoutMs: options.timeoutMs,
		});
		return out.stdout;
	} catch {
		return undefined;
	}
}

/** Stage all changes (after grafting the local side) in the mirror work tree. */
export async function stageAll(options: GitRunOptions = {}): Promise<void> {
	await runGit(["add", "-A"], { cwd: gitCwd(), signal: options.signal });
}

/** Commit the staged changes; returns false when nothing was staged. */
export async function commitSync(message: string, options: GitRunOptions = {}): Promise<boolean> {
	const repo = gitCwd();
	const hasStaged = await hasStagedChanges(options);
	if (!hasStaged) return false;
	await runGit(["commit", "--quiet", "-m", message], { cwd: repo, signal: options.signal });
	return true;
}

/**
 * Publish the current local branch tip to the remote branch. Requires the
 * local branch to be checked out; the caller commits the local side first.
 * When `force` is false a non-fast-forward push is rejected by git.
 */
export async function pushBranch(
	config: SyncConfig,
	options: GitRunOptions = {},
	force = false,
): Promise<void> {
	const repo = gitCwd();
	await runGit(
		["push", "--quiet", ...(force ? ["--force"] : []), "origin", `HEAD:${config.branch}`],
		{ cwd: repo, signal: options.signal, timeoutMs: options.timeoutMs },
	);
}

/**
 * Merge origin/<branch> into the current branch (real three-way merge with
 * merge-base from history). On conflict, git writes diff3/merge markers into
 * the work tree files and leaves MERGE_HEAD set. Returns whether a real merge
 * conflict is currently in progress (MERGE_HEAD set by git).
 */
export async function mergeRemote(
	config: SyncConfig,
	options: GitRunOptions = {},
): Promise<boolean> {
	const repo = gitCwd();
	try {
		await runGit(["merge", "--quiet", "--no-edit", `origin/${config.branch}`], {
			cwd: repo,
			signal: options.signal,
			timeoutMs: options.timeoutMs,
		});
		return false;
	} catch (error) {
		// git merge exits non-zero on conflicts; MERGE_HEAD marks the conflict.
		if (error instanceof GitCommandError) {
			const mergeHead = await pathExists(path.join(repo, ".git", "MERGE_HEAD"));
			if (mergeHead) return true;
			throw error;
		}
		throw error;
	}
}

/** List paths with unmerged (conflicted) entries after a failed merge. */
export async function listConflictedPaths(options: GitRunOptions = {}): Promise<string[]> {
	const result = await runGit(["diff", "--name-only", "--diff-filter=U"], {
		cwd: gitCwd(),
		signal: options.signal,
	});
	return result.stdout.split("\n").filter(Boolean);
}

/** Complete an in-progress merge: stage the resolved work tree and commit. */
export async function completeMerge(
	message: string,
	options: GitRunOptions = {},
): Promise<boolean> {
	await stageAll(options);
	const repo = gitCwd();
	try {
		await runGit(["commit", "--quiet", "-m", message], { cwd: repo, signal: options.signal });
		return true;
	} catch {
		return !(await isMergeInProgress(options));
	}
}

/** Check out our local version for all conflicted files in the mirror work tree. */
export async function checkoutOurs(options: GitRunOptions = {}): Promise<void> {
	await runGit(["checkout", "--ours", "--", "."], { cwd: gitCwd(), signal: options.signal });
	await stageAll(options);
}

/** Check out their remote version for all conflicted files in the mirror work tree. */
export async function checkoutTheirs(options: GitRunOptions = {}): Promise<void> {
	await runGit(["checkout", "--theirs", "--", "."], { cwd: gitCwd(), signal: options.signal });
	await stageAll(options);
}

/** Abort an in-progress merge, restoring the work tree to the pre-merge state. */
export async function abortMerge(options: GitRunOptions = {}): Promise<void> {
	await runGit(["merge", "--abort"], { cwd: gitCwd(), signal: options.signal });
}

/** Reset the work tree to the remote tip (used by pull --force). */
export async function resetHard(config: SyncConfig, options: GitRunOptions = {}): Promise<void> {
	await runGit(["reset", "--hard", `refs/remotes/origin/${config.branch}`], {
		cwd: gitCwd(),
		signal: options.signal,
	});
}

/** True when git has an unmerged (conflicted) merge in progress. */
export async function isMergeInProgress(_options: GitRunOptions = {}): Promise<boolean> {
	return pathExists(path.join(gitCwd(), ".git", "MERGE_HEAD"));
}

async function hasStagedChanges(options: GitRunOptions = {}): Promise<boolean> {
	const result = await runGit(["diff", "--cached", "--name-only"], {
		cwd: gitCwd(),
		signal: options.signal,
	});
	return result.stdout.length > 0;
}

/**
 * Commit-position summary of the local branch tip vs origin/<branch>.
 * ahead = commits on the local branch not on the remote; behind = commits on
 * the remote not on the local branch. A diverged state is ahead>0 && behind>0.
 */
export async function aheadBehind(
	config: SyncConfig,
	options: GitRunOptions = {},
): Promise<{ ahead: number; behind: number }> {
	const repo = gitCwd();
	const remoteRef = `refs/remotes/origin/${config.branch}`;
	if (!(await refExists(remoteRef, options))) return { ahead: 0, behind: 0 };
	try {
		const result = await runGit(
			["rev-list", "--left-right", "--count", `${config.branch}...${remoteRef}`],
			{ cwd: repo, signal: options.signal, timeoutMs: options.timeoutMs },
		);
		const [left, right] = result.stdout.trim().split(/\s+/u).map(Number) ?? [0, 0];
		return { ahead: left ?? 0, behind: right ?? 0 };
	} catch (error) {
		if (error instanceof GitCommandError && isMissingRefError(error.stderr)) {
			return { ahead: 0, behind: 0 };
		}
		throw error;
	}
}

async function branchExists(name: string): Promise<boolean> {
	const result = await runGit(["branch", "--list", name], { cwd: gitCwd() });
	return result.stdout.trim().length > 0;
}

async function refExists(ref: string, options: GitRunOptions = {}): Promise<boolean> {
	try {
		await runGit(["rev-parse", "--verify", ref], {
			cwd: gitCwd(),
			signal: options.signal,
		});
		return true;
	} catch {
		return false;
	}
}

async function pathExists(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}

function isMissingRefError(stderr: string): boolean {
	return (
		stderr.includes("does not have any commits yet") ||
		stderr.includes("unknown revision") ||
		stderr.includes("bad revision") ||
		stderr.includes("not a valid object name") ||
		stderr.includes("invalid object name") ||
		stderr.includes("does not exist in")
	);
}

function signalReason(signal: AbortSignal | undefined): Error {
	if (signal?.reason instanceof Error) return signal.reason;
	return new DOMException("The operation was aborted", "AbortError");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (!signal?.aborted) return;
	throw signalReason(signal);
}
