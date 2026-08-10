export function createMockContext(overrides: Record<string, unknown> = {}) {
	const notifications: Array<{ message: string; level?: string }> = [];
	const ctx = {
		cwd: overrides.cwd ?? process.cwd(),
		mode: overrides.mode ?? "rpc",
		hasUI: overrides.hasUI ?? true,
		ui: {
			notify(message: string, level = "info") {
				notifications.push({ message, level });
			},
			setStatus: () => undefined,
			confirm: async () => true,
			input: async () => undefined,
			select: async () => undefined,
		},
		isIdle: () => true,
		hasPendingMessages: () => false,
		isProjectTrusted: () => false,
		abort: () => undefined,
		getContextUsage: () => undefined,
		sessionManager: {
			getSessionId: () => "test-session",
			getSessionName: () => undefined,
			getBranch: () => [],
			getEntries: () => [],
		},
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({ ok: false, error: "missing" }),
			getAvailable: () => [],
			getAll: () => [],
			isUsingOAuth: () => false,
		},
		...overrides,
	};
	return {
		ctx: ctx as never,
		notifications,
	};
}
