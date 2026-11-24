import { hostname } from "node:os";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { type Conversation, createRegistry, defineExtension, type Harness, UsageDoc } from "@earendil-works/pi-durable";
import { CodingTools, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import { type PiAccess, pi } from "@rivet-dev/pi";
import type { SandboxProvider } from "@rivet-dev/sandbox-adapter";
import { agentOSProvider } from "@rivet-dev/sandbox-adapter/agentos";
import { dockerProvider } from "@rivet-dev/sandbox-adapter/docker";
import { BoardError, type HeldTask } from "@vercel/board";
import type { Registry } from "rivetkit";
import { boardAs } from "./board.js";
import { config, sleep, workerIndex } from "./config.js";
import type { pool } from "./pool.js";
import { briefFor, INSTRUCTIONS } from "./prompt.js";
import { boardTool, executorTool } from "./tools.js";

const ctx = BACKGROUND_CONTEXT;
/** Leases last at most 5 minutes; renew well before that. */
const RENEW_MS = 90_000;
const THINKING = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

type Current = {
	taskId: string;
	epoch: number;
	token: string;
	/** Pi's dedup key for the brief, so a restart resumes the same run instead of starting a second. */
	requestId: string;
	conversationId?: number;
	/** Set by the board tool's `ask`: the task is blocked with this instead of completed. */
	asked?: string;
	/** When the claim landed. */
	claimedAt?: number;
};

/** How the worker's last task ended. `lost` is a claim that ran out or was taken back. */
type Outcome = { taskId: string; outcome: "completed" | "blocked" | "failed" | "lost"; at: number; tokens: number };

type WorkerState = {
	current: Current | null;
	idleSince: number;
	completed: number;
	tokens: number;
	// Added after the first deploy, so workers created before it lack them until they're set.
	failed?: number;
	blocked?: number;
	last?: Outcome | null;
	/** The last claim error, cleared by the next claim request that succeeds. */
	error?: { message: string; at: number } | null;
};

/** Pi's Cloudflare AI Gateway provider: sends cf-aig-authorization and no upstream key, so the gateway's stored key is used. */
const GATEWAY = "cloudflare-ai-gateway";

/** Points Pi's Cloudflare provider at the gateway's custom provider instead of its built-in Anthropic route. */
function gatewayProvider() {
	const { accountId, gatewayId, url } = config.gateway;
	if (!accountId) throw new Error("CLOUDFLARE_ACCOUNT_ID is not set");
	if (!config.gateway.token) throw new Error("CLOUDFLARE_AI_GATEWAY_TOKEN is not set");
	process.env.CLOUDFLARE_ACCOUNT_ID = accountId;
	process.env.CLOUDFLARE_GATEWAY_ID = gatewayId;
	return {
		models: [
			{
				id: config.model,
				name: config.model,
				api: "anthropic-messages" as const,
				baseUrl: url,
				reasoning: true,
				input: ["text", "image"] as ("text" | "image")[],
				compat: { forceAdaptiveThinking: true, supportsTemperature: false },
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1_000_000,
				maxTokens: 128_000,
				thinkingLevelMap: { xhigh: "xhigh", max: "max" },
			},
		],
	};
}

function sandbox(): SandboxProvider | undefined {
	if (config.sandbox === "agentos") return agentOSProvider();
	if (config.sandbox === "docker") return dockerProvider({ image: process.env.SWARM_DOCKER_IMAGE ?? "node:24" });
	return undefined;
}

const provider = sandbox();
const registry = createRegistry();
registry.install(
	provider
		? CodingTools
		: defineExtension({ name: "files", tools: [createReadTool(), createWriteTool(), createEditTool()] }),
);

const tools = {
	mcp__swarm__board: boardTool,
	...(config.executor ? { mcp__executor__execute: executorTool } : {}),
};

function isClaimLost(error: unknown): boolean {
	return error instanceof BoardError && error.code === "claim_lost";
}

/** Resolves with `promise`, or with undefined once `signal` aborts. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) return resolve(undefined);
		signal.addEventListener("abort", () => resolve(undefined), { once: true });
		promise.then(resolve, reject);
	});
}

async function answerText(conversation: Conversation, answer: unknown): Promise<string> {
	const page = await conversation.entries({ minEntryId: answer, maxEntryId: answer } as never, 1, undefined, ctx);
	const message = page.items[0]?.model?.[0];
	if (message?.role !== "assistant") return "";
	return message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

async function tokensUsed(harness: Harness, conversation: Conversation): Promise<number> {
	const usage = await harness.snapshot(UsageDoc, conversation.id, ctx);
	return Object.values(usage?.models ?? {}).reduce((sum, model) => sum + (model.totalTokens ?? 0), 0);
}

export const worker = pi({
	model: `${GATEWAY}/${config.model}`,
	thinkingLevel: config.thinking,
	providers: { [GATEWAY]: gatewayProvider() },
	apiKeys: { [GATEWAY]: config.gateway.token },
	registry,
	sandbox: provider,
	tools,
	createState: (): WorkerState => ({ current: null, idleSince: Date.now(), completed: 0, tokens: 0 }),
	// Idle workers hold a claim request open on the board, so they never sleep.
	options: { noSleep: true },
	actions: {
		/** Wakes the worker. The pool calls it so every worker is running. */
		start: () => true,
		/** Read-only: what the worker is doing, for the dashboard. */
		status: (c) => ({
			name: c.key[0],
			pod: hostname(),
			permanent: workerIndex(c.key[0]) <= config.idleWorkers,
			taskId: c.state.current?.taskId ?? null,
			claimedAt: c.state.current?.claimedAt ?? null,
			asked: c.state.current?.asked ?? null,
			idleSince: c.state.current ? null : c.state.idleSince,
			completed: c.state.completed,
			failed: c.state.failed ?? 0,
			blocked: c.state.blocked ?? 0,
			tokens: c.state.tokens,
			last: c.state.last ?? null,
			error: c.state.error ?? null,
		}),
	},
	run: async (c) => {
		const name = c.key[0];
		const index = workerIndex(name);
		// Workers from before names (worker-0001…) are replaced by the pool's named ones.
		if (Number.isNaN(index)) {
			c.destroy();
			return;
		}
		const permanent = index <= config.idleWorkers;
		const board = boardAs(name);
		const signal = c.abortSignal;
		const harness = (c as unknown as PiAccess).pi;

		const settle = (current: Current, outcome: Outcome["outcome"], tokens: number) => {
			c.state.last = { taskId: current.taskId, outcome, at: Date.now(), tokens };
			if (outcome === "failed") c.state.failed = (c.state.failed ?? 0) + 1;
			if (outcome === "blocked") c.state.blocked = (c.state.blocked ?? 0) + 1;
		};

		const work = async (current: Current) => {
			const held: HeldTask = board.tasks.held(current.taskId, { epoch: current.epoch, token: current.token });
			let lost = false;
			let conversation: Conversation | undefined;
			let tokens = 0;
			const renew = setInterval(() => {
				held.renew().catch((error) => {
					if (!isClaimLost(error)) return console.warn(`[${name}] renew failed`, error);
					lost = true;
					void conversation?.abort(ctx);
				});
			}, RENEW_MS);
			try {
				// Renew at once: after a restart this is how a stale claim is found.
				await held.renew();
				const thread = await board.thread(current.taskId);
				const thinking = thread.message.labels?.thinking;
				if (current.conversationId) {
					conversation = await harness.conversation(current.conversationId as never, ctx);
				}
				if (!conversation) {
					conversation = await harness.createConversation(
						{
							ownership: { kind: "ownerless" },
							agent: {
								instructions: INSTRUCTIONS,
								...(thinking && THINKING.has(thinking) ? { thinkingLevel: thinking as ModelThinkingLevel } : {}),
							},
						},
						ctx,
					);
					current.conversationId = conversation.id as unknown as number;
				}
				const submission = await conversation.submit(
					{ type: "input", content: briefFor(thread), requestId: current.requestId },
					ctx,
				);
				const settled = await untilAborted(submission.wait(ctx), signal);
				// Shutting down: keep `current`, so the next generation renews and resumes this run.
				if (settled === undefined) return;
				tokens = await tokensUsed(harness, conversation);
				c.state.tokens += tokens;
				if (lost) {
					settle(current, "lost", tokens);
					return;
				}
				if (current.asked) {
					await held.block(current.asked, { kind: "needs_input" });
					settle(current, "blocked", tokens);
				} else if (settled.status === "done") {
					const answer = await answerText(conversation, settled.answer);
					// A reply syncs to Slack; the task result alone doesn't.
					await board.reply(current.taskId, answer.trim() || "Done.");
					await held.complete(`${answer.trim() || "Done."}\n\n_${name} · ${tokens.toLocaleString()} tokens_`);
					c.state.completed += 1;
					settle(current, "completed", tokens);
				} else {
					await held.fail(`${settled.reason ?? "unanswered"} (${name}, ${tokens} tokens)`);
					settle(current, "failed", tokens);
				}
			} catch (error) {
				if (isClaimLost(error)) {
					await conversation?.abort(ctx).catch(() => {});
					settle(current, "lost", tokens);
				} else {
					console.error(`[${name}] task ${current.taskId} failed`, error);
					await held.fail(error instanceof Error ? error.message : String(error)).catch(() => {});
					settle(current, "failed", tokens);
				}
			} finally {
				clearInterval(renew);
			}
			if (!signal.aborted) {
				c.state.current = null;
				c.state.idleSince = Date.now();
			}
		};

		while (!signal.aborted) {
			if (c.state.current) {
				await work(c.state.current);
				continue;
			}
			if (!permanent && Date.now() - c.state.idleSince > config.retireAfterMs) {
				await c
					.client<Registry<{ pool: typeof pool }>>()
					.pool.getOrCreate(["main"])
					.retired(index)
					.catch(() => {});
				c.destroy();
				return;
			}
			try {
				const claim = await board.tasks.claim(
					{
						channel: `${config.channel}/`,
						wait: config.claimWaitS,
						...(config.from.length ? { from: config.from } : {}),
					},
					{ signal },
				);
				if (c.state.error) c.state.error = null;
				if (!claim) continue;
				c.state.current = {
					taskId: claim.task.id,
					epoch: claim.epoch,
					token: claim.token,
					requestId: `${claim.task.id}#${claim.epoch}`,
					claimedAt: Date.now(),
				};
			} catch (error) {
				if (signal.aborted) return;
				c.state.error = { message: error instanceof Error ? error.message : String(error), at: Date.now() };
				const wait = error instanceof BoardError && error.retryAfter ? error.retryAfter * 1000 : 5_000;
				console.warn(`[${name}] claim failed, retrying in ${wait} ms`, error instanceof Error ? error.message : error);
				await sleep(wait + Math.random() * 2_000, signal);
			}
		}
	},
});
