import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { loadConfig, type SyncConfig } from "./config.js";
import { runConfigEditor } from "./config-ui.js";
import * as operations from "./operations.js";
import { syncBusyText } from "./status.js";
import { runSetupWizard } from "./wizard.js";

const STATUS_KEY = "sync";

interface BackgroundSync {
	settled: Promise<void>;
}

const COMMANDS = ["init", "status", "push", "pull", "fetch", "merge", "config", "help"] as const;

type Subcommand = (typeof COMMANDS)[number];

const USAGE = [
	"pi-sync — sync Pi configuration through Git",
	"",
	"usage: /sync <command> [options]",
	"",
	"commands:",
	"  init                first-run setup wizard",
	"  config              view and edit the config",
	"  status              config + sync state + next step (--diff for content)",
	"  fetch               fetch the remote tree without applying",
	"  pull                fetch + merge (--force overwrites local)",
	"  merge               complete merge (--abort, --ours, --theirs)",
	"  push                publish local tree (--force overwrites remote)",
	"  help                show this help",
].join("\n");

export default function sync(pi: ExtensionAPI): void {
	let sessionAbort = new AbortController();
	let backgroundSync: BackgroundSync | undefined;
	let backgroundPush: BackgroundSync | undefined;

	const startBackgroundSync = (ctx: ExtensionContext, signal: AbortSignal) => {
		// While the automatic fetch is in flight the indicator shows the busy
		// state; refreshIndicator replaces it with the real state when done.
		ctx.ui.setStatus(STATUS_KEY, syncBusyText());
		const settled = (async () => {
			try {
				await runAutomaticSync(ctx, signal);
			} catch (error) {
				if (signal.aborted) return;
				ctx.ui.setStatus(STATUS_KEY, undefined);
				ctx.ui.notify(`pi-sync auto sync skipped: ${errorMessage(error)}`, "warning");
			}
		})();
		backgroundSync = { settled };
	};

	// Publish in the background so the TUI stays interactive while git talks
	// to the remote (fetch + push can take many seconds). The indicator shows
	// "pushing…"; operations.push notifies the outcome when it settles.
	const startBackgroundPush = (
		ctx: ExtensionCommandContext,
		config: SyncConfig,
		force: boolean,
		signal: AbortSignal,
	) => {
		ctx.ui.setStatus(STATUS_KEY, syncBusyText("push"));
		const settled = (async () => {
			try {
				await operations.push(ctx, config, { force });
			} catch (error) {
				if (signal.aborted) return;
				ctx.ui.setStatus(STATUS_KEY, undefined);
				ctx.ui.notify(`pi-sync push failed: ${errorMessage(error)}`, "error");
			}
		})();
		backgroundPush = { settled };
	};

	const drainBackgroundTasks = async (signal?: AbortSignal): Promise<void> => {
		const tasks = [backgroundSync, backgroundPush];
		backgroundSync = undefined;
		backgroundPush = undefined;
		for (const current of tasks) {
			if (!current) continue;
			try {
				await (signal ? Promise.race([current.settled, waitForAbort(signal)]) : current.settled);
			} catch {
				// The shutdown deadline or a replacement aborted while draining; the
				// background task observes its own session signal and settles on its own.
			}
		}
	};

	pi.registerCommand("sync", {
		description: "Sync Pi configuration through Git",
		getArgumentCompletions: (prefix) => {
			const [first = "", ...rest] = prefix.trim().split(/\s+/u);
			if (rest.length > 0) return null;
			return COMMANDS.filter((name) => name.startsWith(first)).map((name) => ({
				value: name,
				label: name,
			}));
		},
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				throw new Error(
					"/sync requires TUI or RPC mode so results and safety prompts are observable.",
				);
			}
			try {
				await handleCommand(args, ctx, async (pushCtx, config, force) => {
					if (backgroundPush) {
						pushCtx.ui.notify("A push is already in progress.", "warning");
						return;
					}
					// Wait for the session-start automatic fetch so the two
					// background tasks never contend on the mirror repo, then run
					// the publish without blocking the TUI.
					await drainBackgroundTasks();
					if (sessionAbort.signal.aborted) return;
					startBackgroundPush(pushCtx, config, force, sessionAbort.signal);
				});
			} catch (error) {
				if (sessionAbort.signal.aborted) return;
				ctx.ui.setStatus(STATUS_KEY, undefined);
				ctx.ui.notify(errorMessage(error), "error");
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		sessionAbort.abort(new DOMException("Session replaced", "AbortError"));
		sessionAbort = new AbortController();
		const signal = sessionAbort.signal;
		ctx.ui.setStatus(STATUS_KEY, undefined);
		await drainBackgroundTasks();
		try {
			const config = await loadConfig();
			if (signal.aborted) return;
			if (config.remote.length === 0 || !config.automatic) return; // not configured or manual-only
			startBackgroundSync(ctx, signal);
		} catch (error) {
			if (signal.aborted) return;
			ctx.ui.notify(`pi-sync startup failed: ${errorMessage(error)}`, "warning");
		}
	});

	pi.on("session_shutdown", async () => {
		// automatic only observes; aborting the in-flight fetch is enough. No
		// shutdown push — nothing writes local files without an explicit command.
		sessionAbort.abort(new DOMException("Session shut down", "AbortError"));
	});
}

async function runAutomaticSync(ctx: ExtensionContext, signal: AbortSignal): Promise<void> {
	const config = await loadConfig();
	throwIfAborted(signal);
	if (config.remote.length === 0 || !config.automatic) return;
	// Non-destructive: fetch the remote snapshot and refresh the status-bar
	// indicator. Never pushes, pulls or merges on its own.
	await operations.fetch(ctx, config, { quiet: true });
}

async function handleCommand(
	rawArgs: string,
	ctx: ExtensionCommandContext,
	runPush: (ctx: ExtensionCommandContext, config: SyncConfig, force: boolean) => Promise<void>,
): Promise<void> {
	const [first = "", ...restTokens] = rawArgs.trim().split(/\s+/u);
	const subcommand = normalizeSubcommand(first);
	if (subcommand === undefined || subcommand === "help") {
		ctx.ui.notify(USAGE, "info");
		return;
	}

	// init re-creates the config from scratch: it must work even when the
	// existing pi-sync.json is broken or in an old format.
	if (subcommand === "init") {
		await runSetupWizard(ctx.ui);
		return;
	}

	const config = await loadConfig();
	if (config.remote.length === 0) {
		ctx.ui.notify(
			"pi-sync is not configured. Run /sync init to set up the git remote, or edit pi-sync.json.",
			"warning",
		);
		return;
	}

	const force = restTokens.some((token) => token === "--force");

	switch (subcommand) {
		case "status":
			await operations.status(ctx, config, {
				diff: restTokens.some((token) => token === "--diff"),
			});
			return;
		case "push":
			await runPush(ctx, config, force);
			return;
		case "pull":
			await operations.pull(ctx, config, { force });
			return;
		case "fetch":
			await operations.fetch(ctx, config);
			return;
		case "merge":
			await operations.merge(ctx, config, {
				abort: restTokens.some((token) => token === "--abort"),
				ours: restTokens.some((token) => token === "--ours"),
				theirs: restTokens.some((token) => token === "--theirs"),
			});
			return;
		case "config":
			await runConfigEditor(ctx.ui, config);
			return;
	}
}

function normalizeSubcommand(value: string): Subcommand | undefined {
	if (value === "") return undefined;
	if (COMMANDS.includes(value as Subcommand)) return value as Subcommand;
	const matches = COMMANDS.filter((name) => name.startsWith(value));
	return matches.length === 1 ? matches[0] : undefined;
}

function throwIfAborted(signal: AbortSignal): void {
	if (!signal.aborted) return;
	throw signal.reason instanceof Error
		? signal.reason
		: new DOMException("The operation was aborted", "AbortError");
}

function waitForAbort(signal: AbortSignal): Promise<never> {
	return new Promise((_resolve, reject) => {
		const rejectWithReason = () =>
			reject(
				signal.reason instanceof Error
					? signal.reason
					: new DOMException("The operation was aborted", "AbortError"),
			);
		if (signal.aborted) {
			rejectWithReason();
			return;
		}
		signal.addEventListener("abort", rejectWithReason, { once: true });
	});
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
