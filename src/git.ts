import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { SyncConfig } from "./config.js";
import { mirrorRepoDir, snapshotFilePath, stateDir } from "./config.js";
import type { Snapshot } from "./snapshot.js";

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

/** Ensure the local mirror repository exists, is initialized, and knows the remote. */
export async function ensureMirror(config: SyncConfig): Promise<void> {
	await fs.mkdir(stateDir(), { recursive: true });
	const repo = mirrorRepoDir();
	if (!(await pathExists(repo))) {
		await fs.mkdir(repo, { recursive: true });
		await runGit(["init", "-b", "main"], { cwd: repo });
		await runGit(["remote", "add", "origin", config.remote], { cwd: repo });
	}
	await runGit(["remote", "set-url", "origin", config.remote], { cwd: repo });
}

/** Fetch the configured branch from the remote into origin/<branch>. */
export async function fetchRemote(config: SyncConfig, options: GitRunOptions = {}): Promise<void> {
	await ensureMirror(config);
	try {
		await runGit(["fetch", "--quiet", "origin", config.branch], {
			cwd: mirrorRepoDir(),
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

/** Read the remote snapshot for the branch; returns undefined when the branch has no snapshot. */
export async function readRemoteSnapshot(
	config: SyncConfig,
	options: GitRunOptions = {},
): Promise<Snapshot | undefined> {
	const repo = mirrorRepoDir();
	if (!(await pathExists(repo))) return undefined;
	const ref = `refs/remotes/origin/${config.branch}`;
	try {
		const result = await runGit(["show", `${ref}:pi-sync/snapshot.json`], {
			cwd: repo,
			signal: options.signal,
			timeoutMs: options.timeoutMs,
		});
		return JSON.parse(result.stdout) as Snapshot;
	} catch (error) {
		if (error instanceof GitCommandError && isMissingRefError(error.stderr)) return undefined;
		throw error;
	}
}

/** Read the snapshot stored at a specific revision; undefined when absent. */
export async function readSnapshotAt(
	revision: string,
	options: GitRunOptions = {},
): Promise<Snapshot | undefined> {
	try {
		const result = await runGit(["show", `${revision}:pi-sync/snapshot.json`], {
			cwd: mirrorRepoDir(),
			signal: options.signal,
			timeoutMs: options.timeoutMs,
		});
		return JSON.parse(result.stdout) as Snapshot;
	} catch (error) {
		if (error instanceof GitCommandError && isMissingRefError(error.stderr)) return undefined;
		throw error;
	}
}

/** Remote revision (commit sha) for the branch, or undefined when the branch is absent. */
export async function readRemoteRevision(
	config: SyncConfig,
	options: GitRunOptions = {},
): Promise<string | undefined> {
	if (!(await pathExists(mirrorRepoDir()))) return undefined;
	const ref = `refs/remotes/origin/${config.branch}`;
	try {
		const result = await runGit(["rev-parse", ref], {
			cwd: mirrorRepoDir(),
			signal: options.signal,
			timeoutMs: options.timeoutMs,
		});
		return result.stdout.trim();
	} catch (error) {
		if (error instanceof GitCommandError && isMissingRefError(error.stderr)) return undefined;
		throw error;
	}
}

/** Publish a snapshot to the remote branch as one commit. */
export async function publishSnapshot(
	config: SyncConfig,
	snapshot: Snapshot,
	options: GitRunOptions = {},
	force = false,
): Promise<string> {
	const repo = mirrorRepoDir();
	// The mirror is disposable (it only tracks pi-sync/snapshot.json). Advance
	// it to the fetched remote tip so the publish push fast-forwards; the
	// caller has already decided it is safe to publish. Missing ref = first push.
	try {
		await runGit(["reset", "--hard", `refs/remotes/origin/${config.branch}`], {
			cwd: repo,
			signal: options.signal,
		});
	} catch {
		// Remote branch does not exist yet; publish from the empty HEAD.
	}
	// The mirror tracks only pi-sync/snapshot.json. The reset aligned the
	// index to the remote tip, which may carry legacy or foreign paths;
	// empty the index so the published commit never drags them along.
	await runGit(["read-tree", "--empty"], { cwd: repo, signal: options.signal });
	await fs.mkdir(path.dirname(snapshotFilePath()), { recursive: true });
	await fs.writeFile(snapshotFilePath(), `${JSON.stringify(snapshot, null, "\t")}\n`, {
		mode: 0o600,
	});
	await runGit(["add", "--", snapshotFilePath()], { cwd: repo, signal: options.signal });
	await runGit(["commit", "--quiet", "-m", `pi-sync: ${snapshot.files.length} files`], {
		cwd: repo,
		signal: options.signal,
	});
	await runGit(
		["push", "--quiet", ...(force ? ["--force"] : []), "origin", `HEAD:${config.branch}`],
		{
			cwd: repo,
			signal: options.signal,
			timeoutMs: options.timeoutMs,
		},
	);
	// The pushed revision is the commit we just created on HEAD; the
	// remote-tracking ref is only refreshed by fetch, so read HEAD directly.
	const result = await runGit(["rev-parse", "HEAD"], {
		cwd: repo,
		signal: options.signal,
	});
	return result.stdout.trim();
}

/** List recent snapshot commits on the remote branch (newest first). */
export async function listHistory(
	options: GitRunOptions = {},
): Promise<Array<{ id: string; date: string; message: string }>> {
	try {
		const result = await runGit(
			["log", "--format=%H%x00%cI%x00%s", "-n", "20", "--", "pi-sync/snapshot.json"],
			{ cwd: mirrorRepoDir(), signal: options.signal, timeoutMs: options.timeoutMs },
		);
		return result.stdout
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => {
				const [id, date, ...messageParts] = line.split("\u0000");
				return { id: id ?? "", date: date ?? "", message: messageParts.join("\u0000") };
			});
	} catch (error) {
		if (error instanceof GitCommandError && isMissingRefError(error.stderr)) return [];
		throw error;
	}
}

export function isRemoteUpToDate(
	localRevision: string | undefined,
	remoteRevision: string | undefined,
): boolean {
	return localRevision !== undefined && localRevision === remoteRevision;
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
		stderr.includes("does not exist in") ||
		// git resolves <ref>:<path> by checking the working tree too: when the
		// path is absent from the ref but a same-named file exists on disk it
		// reports "exists on disk, but not in '<ref>'". Both mean the ref has
		// no snapshot file.
		stderr.includes("exists on disk, but not in")
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
