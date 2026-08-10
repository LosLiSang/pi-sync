import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { loadConfig, type SyncConfig } from "./config.js";
import { readRemoteSnapshot, readSnapshotAt } from "./git.js";
import { planMerge } from "./merge.js";
import * as operations from "./operations.js";
import { createSnapshot } from "./snapshot.js";
import { loadState } from "./state.js";
import { runSetupWizard } from "./wizard.js";

const STATUS_KEY = "sync";

interface BackgroundSync {
	settled: Promise<void>;
}

const COMMANDS = [
	"init",
	"status",
	"diff",
	"push",
	"pull",
	"fetch",
	"merge",
	"history",
	"config",
	"help",
] as const;

type Subcommand = (typeof COMMANDS)[number];

const USAGE = [
	"pi-sync — sync Pi configuration through Git",
	"",
	"usage: /sync <command> [options]",
	"",
	"commands:",
	"  init                first-run setup wizard",
	"  status              show local/remote change summary",
	"  diff                show content-level local/remote diff",
	"  fetch               fetch the remote snapshot without applying",
	"  merge               three-way merge remote changes into local files",
	"  push                publish local snapshot (--force overwrites remote changes)",
	"  pull                overwrite local files with the remote snapshot",
	"  history             list recent remote snapshot commits",
	"  config              show the effective config",
	"  help                show this help",
].join("\n");

export default function sync(pi: ExtensionAPI): void {
	let sessionAbort = new AbortController();
	let backgroundSync: BackgroundSync | undefined;

	const startBackgroundSync = (ctx: ExtensionContext, signal: AbortSignal) => {
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

	const drainBackgroundSync = async (signal?: AbortSignal): Promise<void> => {
		const current = backgroundSync;
		backgroundSync = undefined;
		if (!current) return;
		try {
			await (signal ? Promise.race([current.settled, waitForAbort(signal)]) : current.settled);
		} catch {
			// The shutdown deadline or a replacement aborted while draining; the
			// background sync observes its own session signal and settles on its own.
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
				await handleCommand(args, ctx);
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
		await drainBackgroundSync();
		try {
			const config = await loadConfig();
			if (signal.aborted) return;
			if (config.remote.length === 0) return; // not configured yet
			startBackgroundSync(ctx, signal);
		} catch (error) {
			if (signal.aborted) return;
			ctx.ui.notify(`pi-sync startup failed: ${errorMessage(error)}`, "warning");
		}
	});

	pi.on("session_shutdown", async (event, ctx) => {
		sessionAbort.abort(new DOMException("Session shut down", "AbortError"));
		const controller = new AbortController();
		const signal = combineSignals(controller.signal, AbortSignal.timeout(30_000));
		const reason =
			typeof event === "object" && event ? (event as { reason?: string }).reason : undefined;
		try {
			if (reason !== "reload") {
				await drainBackgroundSync(signal);
				if (signal.aborted) return;
				await runShutdownPush(ctx, signal);
			}
		} catch (error) {
			if (!signal.aborted) {
				ctx.ui.notify(`pi-sync session push skipped: ${errorMessage(error)}`, "warning");
			}
		} finally {
			controller.abort(new DOMException("Session shutdown finished", "AbortError"));
		}
	});
}

async function runAutomaticSync(ctx: ExtensionContext, signal: AbortSignal): Promise<void> {
	const config = await loadConfig();
	throwIfAborted(signal);
	if (config.remote.length === 0 || !config.automatic) return;
	ctx.ui.setStatus(STATUS_KEY, "syncing");
	try {
		await operations.fetch(ctx, config);
		throwIfAborted(signal);
		const direction = await decideAutoDirection(config, signal);
		throwIfAborted(signal);
		switch (direction) {
			case "push":
				await operations.push(ctx, config);
				return;
			case "pull":
				await operations.pull(ctx, config);
				return;
			case "merge":
				await operations.merge(ctx, config);
				return;
			case "none":
				return;
		}
	} finally {
		if (!signal.aborted) ctx.ui.setStatus(STATUS_KEY, undefined);
	}
}

async function decideAutoDirection(
	config: SyncConfig,
	signal: AbortSignal,
): Promise<"push" | "pull" | "merge" | "none"> {
	const [local, remote, state] = await Promise.all([
		createSnapshot(config),
		readRemoteSnapshot(config, { signal }),
		loadState(),
	]);
	throwIfAborted(signal);
	if (!remote) return "push";
	const base = state?.lastRemoteRevision
		? await readSnapshotAt(state.lastRemoteRevision, { signal })
		: undefined;
	throwIfAborted(signal);
	const plan = planMerge(local, remote, base);
	if (plan.conflicts.length > 0) return "merge";
	if (plan.takeLocal.length > 0 && plan.takeRemote.length > 0) return "merge";
	if (plan.takeLocal.length > 0) return "push";
	if (plan.takeRemote.length > 0) return "pull";
	return "none";
}

async function runShutdownPush(ctx: ExtensionContext, signal: AbortSignal): Promise<void> {
	const config = await loadConfig();
	throwIfAborted(signal);
	if (config.remote.length === 0 || !config.automatic) return;
	await operations.push(ctx, config);
}

async function handleCommand(rawArgs: string, ctx: ExtensionCommandContext): Promise<void> {
	const [first = "", ...restTokens] = rawArgs.trim().split(/\s+/u);
	const subcommand = normalizeSubcommand(first);
	if (subcommand === undefined || subcommand === "help") {
		ctx.ui.notify(USAGE, "info");
		return;
	}

	const config = await loadConfig();
	if (subcommand !== "init" && config.remote.length === 0) {
		ctx.ui.notify(
			"pi-sync is not configured. Run /sync init to set up the git remote, or edit pi-sync.json.",
			"warning",
		);
		return;
	}

	const force = restTokens.some((token) => token === "--force");

	switch (subcommand) {
		case "init":
			await runSetupWizard(ctx.ui);
			return;
		case "status":
			await operations.status(ctx, config);
			return;
		case "diff":
			await operations.diff(ctx, config);
			return;
		case "push":
			await operations.push(ctx, config, { force });
			return;
		case "pull":
			await operations.pull(ctx, config);
			return;
		case "fetch":
			await operations.fetch(ctx, config);
			return;
		case "merge":
			await operations.merge(ctx, config);
			return;
		case "history":
			await operations.history(ctx, config);
			return;
		case "config":
			ctx.ui.notify(
				[
					`remote: ${config.remote}`,
					`branch: ${config.branch}`,
					`automatic: ${config.automatic ? "enabled" : "disabled"}`,
					`included: ${config.include.join(", ") || "none"}`,
				].join("\n"),
				"info",
			);
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

function combineSignals(primary: AbortSignal, secondary?: AbortSignal): AbortSignal {
	return secondary ? AbortSignal.any([primary, secondary]) : primary;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
