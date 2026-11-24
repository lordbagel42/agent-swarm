import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { NAMES } from "./names.js";

const env = process.env;

function int(name: string, fallback: number): number {
	const value = env[name];
	if (value === undefined || value === "") return fallback;
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer, got ${value}`);
	return parsed;
}

function list(name: string): string[] {
	return (env[name] ?? "")
		.split(",")
		.map((part) => part.trim())
		.filter(Boolean);
}

export const config = {
	/** Board channel tasks are posted to. Workers claim from it and every channel under it. */
	channel: env.SWARM_CHANNEL ?? "work",
	/** Board actor IDs whose tasks the swarm also takes, when submitters use another login than BOARD_TOKEN. */
	from: list("SWARM_FROM"),
	/** Workers kept alive and waiting on the board at all times. */
	idleWorkers: int("SWARM_IDLE_WORKERS", 300),
	/** Hard ceiling on workers, including ones spawned for a backlog. */
	maxWorkers: int("SWARM_MAX_WORKERS", 600),
	/** How long a spawned (non-permanent) worker waits without a task before it retires. */
	retireAfterMs: int("SWARM_RETIRE_AFTER_MS", 10 * 60_000),
	/** How often the pool checks the backlog. */
	poolIntervalMs: int("SWARM_POOL_INTERVAL_MS", 15_000),
	/** Seconds one claim request waits on the board for a ready task. */
	claimWaitS: int("SWARM_CLAIM_WAIT_S", 300),
	/** The model ID the gateway provider serves. */
	model: env.SWARM_MODEL ?? "claude-opus-5-5",
	thinking: (env.SWARM_THINKING ?? "medium") as ModelThinkingLevel,
	/** Where the shell and file tools run: agentos (Rivet Services), docker (local dev), or none (files in the actor). */
	sandbox: (env.SWARM_SANDBOX ?? "agentos") as "agentos" | "docker" | "none",
	/** Largest tool result, in characters, passed back to the model. */
	maxToolResultChars: int("SWARM_MAX_TOOL_RESULT_CHARS", 8_000),
	/**
	 * Model calls go through Cloudflare AI Gateway to its custom provider, which holds the upstream
	 * key. Workers only hold an AI Gateway token (AI Gateway Run), sent as cf-aig-authorization.
	 */
	gateway: {
		/** The gateway's custom provider, on the gateway's custom domain. */
		url: env.CLOUDFLARE_GATEWAY_URL ?? "https://ai.bagelindustries.com/custom-claude",
		/** Pi's gateway auth requires these even though the URL above already names the gateway. */
		accountId: env.CLOUDFLARE_ACCOUNT_ID ?? "",
		gatewayId: env.CLOUDFLARE_GATEWAY_ID ?? "default",
		token: env.CLOUDFLARE_AI_GATEWAY_TOKEN ?? "",
	},
	executor: env.EXECUTOR_URL ? { url: env.EXECUTOR_URL, token: env.EXECUTOR_TOKEN } : undefined,
};

/**
 * A worker's first name, its actor key and board profile: worker 1 is Ada. Past the last name the names
 * repeat with a number, as in Ada-2. Workers up to idleWorkers are permanent.
 */
export function workerName(index: number): string {
	const round = Math.floor((index - 1) / NAMES.length);
	const name = NAMES[(index - 1) % NAMES.length];
	return round === 0 ? name : `${name}-${round + 1}`;
}

export function workerIndex(name: string): number {
	const [first, round = "1"] = name.split("-");
	const position = NAMES.indexOf(first);
	return position < 0 ? Number.NaN : (Number(round) - 1) * NAMES.length + position + 1;
}

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		signal.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true },
		);
	});
}
