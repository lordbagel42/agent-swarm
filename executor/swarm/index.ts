import { type Board, board, createTasksInChunks, type MessageView, type TaskInBatch } from "@vercel/board";
import {
	array,
	bearer,
	boolean,
	decodeJson,
	defineApp,
	defineProvider,
	type MutationContext,
	mutation,
	number,
	object,
	ProviderError,
	type QueryContext,
	query,
	router,
	secrets,
	string,
} from "apps";
import { SKILL } from "./skill.js";

/** raygen's team; the swarm's workers claim from this board's `work` channel and everything under it. */
const TEAM = "team_sQqIIVtfELXBYG1ZY4aHqpDb";
const CHANNEL = "work";
/** What this app writes as on the board: "executor via <the token's owner>". */
const PROFILE = "executor";
/** States a task stays in until someone acts: the swarm is done with it, or it needs an answer. */
const SETTLED = new Set(["completed", "failed", "canceled", "blocked"]);

const vercel = defineProvider({
	name: "Vercel board",
	hosts: ["api.vercel.com"],
	auth: {
		token: secrets({
			label: "Vercel token",
			fields: object({
				token: string({
					title: "Token",
					description:
						"The swarm's `BOARD_TOKEN`: a [Vercel token](https://vercel.com/account/settings/tokens) with access to team raygen. The swarm only takes tasks from this token's owner.",
				}),
			}),
			request: ({ token }) => bearer(token),
		}),
	},
	async health({ account, fetch, signal }) {
		const response = await fetch("https://api.vercel.com/v2/user", { signal, headers: account.headers() });
		if (response.status === 403) throw new ProviderError({ reason: "unauthorized", status: 403 });
		const { user } = await decodeJson(response, object({ user: object({ id: string(), username: string() }) }));
		return { accountInfo: { externalId: user.id, username: user.username } };
	},
});

const requirements = { app: { accounts: { vercel } } };

type Ctx = QueryContext<typeof requirements> | MutationContext<typeof requirements>;

/** The board as this app's profile, through Executor's network, which puts the token in on the way out. */
function boardFor(ctx: Ctx): Board {
	const auth = ctx.app.accounts.vercel.headers();
	return board({
		team: TEAM,
		fetch: (input, init = {}) => {
			const headers = new Headers(init.headers);
			for (const [name, value] of Object.entries(auth)) headers.set(name, value);
			// The board asks for redirect "error", which Executor's fetch doesn't take; a 3xx fails below either way.
			const redirect = init.redirect === "error" ? "manual" : init.redirect;
			return ctx.fetch(String(input instanceof Request ? input.url : input), { ...init, headers, redirect });
		},
	}).as(PROFILE);
}

/** The board's errors as one line the agent can act on. */
async function call<T>(work: () => Promise<T>): Promise<T> {
	try {
		return await work();
	} catch (error) {
		const e = error as { status?: number; code?: string; message?: string };
		if (e.code && e.status) throw new Error(`${e.status} ${e.code}: ${e.message}`);
		throw error;
	}
}

const clip = (text: string | null | undefined, max: number) =>
	!text ? undefined : text.length > max ? `${text.slice(0, max)}…` : text;

type Summary = {
	id: string;
	state: string;
	text?: string;
	worker?: string;
	question?: string;
	result?: string;
	reason?: string;
	needs?: string[];
};

/** A task in as few tokens as it takes: nulls and empties left out. */
function summary(root: MessageView, max: { text: number; result: number }): Summary {
	const task = root.task;
	const out: Summary = { id: root.id, state: task?.state ?? root.labels?.["board.task"] ?? "unknown" };
	const text = clip(max.text < 200 ? root.text.split("\n")[0] : root.text, max.text);
	if (text) out.text = text;
	if (task?.claim && task.state === "claimed") out.worker = task.claim.actor.split("+").pop();
	if (task?.blocked) out.question = clip(task.blocked.reason, max.result);
	const result = clip(task?.result, max.result);
	if (result) out.result = result;
	const reason = clip(task?.reason, max.result);
	if (reason) out.reason = reason;
	if (task?.needs?.length && task.state === "waiting") out.needs = task.needs;
	return out;
}

const short = { text: 120, result: 300 };
const full = { text: 8000, result: 8000 };

const Task = object({
	id: string(),
	state: string(),
	text: string().optional(),
	worker: string().optional(),
	question: string().optional(),
	result: string().optional(),
	reason: string().optional(),
	needs: array(string()).optional(),
});

const submit = mutation(
	{
		description:
			"Post tasks to the swarm. Each brief must stand alone: what to do, where, what's out of scope, how to check it's done. needs lists keys of other tasks in this call, or IDs of existing tasks, that must complete first.",
		input: object({
			tasks: array(
				object({
					text: string({ description: "The brief, written for a stranger with no memory." }),
					key: string({ description: "Short name other tasks in this call use in needs." }).optional(),
					needs: array(string()).optional(),
					thinking: string({
						description: "low for mechanical work, high for hard work; medium if left out.",
					}).optional(),
				}),
			),
			id: string({
				description: "Optional idempotency key: the same id with the same tasks returns the tasks it made.",
			}).optional(),
		}),
		output: object({ tasks: array(object({ key: string().optional(), id: string(), state: string() })) }),
	},
	async (ctx: MutationContext<typeof requirements>, input) => {
		const team = boardFor(ctx);
		const keys = new Set(input.tasks.flatMap((task) => (task.key ? [task.key] : [])));
		const plan: TaskInBatch[] = input.tasks.map((task) => ({
			...(task.key ? { key: task.key } : {}),
			text: task.text,
			...(task.thinking && task.thinking !== "medium" ? { labels: { thinking: task.thinking } } : {}),
			...(task.needs?.length ? { needs: task.needs.map((need) => (keys.has(need) ? { key: need } : need)) } : {}),
		}));
		const roots = await call(() => createTasksInChunks(team, CHANNEL, plan, input.id ? { id: input.id } : undefined));
		return {
			tasks: roots.map((root, n) => ({
				...(input.tasks[n].key ? { key: input.tasks[n].key } : {}),
				id: root.id,
				state: root.task?.state ?? "unknown",
			})),
		};
	},
);

const list = query(
	{
		description:
			"The swarm's most recently active tasks, latest last, one short line each. state: open (default: not yet completed, failed or canceled), all, or one of waiting, ready, claimed, blocked, completed, failed, canceled.",
		input: object({
			state: string().default("open"),
			limit: number({ description: "1 to 100." }).default(20),
		}),
		output: object({ tasks: array(Task) }),
	},
	async (ctx: QueryContext<typeof requirements>, input) => {
		const team = boardFor(ctx);
		const page = await call(() =>
			team.tasks.list({
				channel: CHANNEL,
				state: input.state as "open",
				latest: true,
				limit: Math.min(Math.max(1, input.limit), 100),
			}),
		);
		return { tasks: page.tasks.map((thread) => summary(thread.message, short)) };
	},
);

const read = query(
	{
		description: "One task: its state, full brief, result, and the thread's replies (who said what).",
		input: object({ id: string(), replies: number({ description: "Newest replies to include." }).default(20) }),
		output: object({
			task: Task,
			replies: array(object({ by: string(), text: string() })),
		}),
	},
	async (ctx: QueryContext<typeof requirements>, input) => {
		const team = boardFor(ctx);
		const thread = await call(() => team.thread(input.id, { limit: Math.min(Math.max(1, input.replies), 100) }));
		return {
			task: summary(thread.message, full),
			replies: thread.replies
				.filter((reply) => !reply.deleted && reply.text)
				.map((reply) => ({
					by: reply.author?.name ?? reply.by.profile ?? reply.by.actor,
					text: clip(reply.text, 4000) ?? "",
				})),
		};
	},
);

const wait = query(
	{
		description:
			"Wait until the given tasks are completed, failed, canceled or blocked (asking a question), up to timeout seconds. done is false on timeout: call again to keep waiting. Answer blocked tasks with answer.",
		input: object({
			ids: array(string()),
			until: string({ description: "all (default) or any." }).default("all"),
			timeout: number({ description: "Seconds, 1 to 240. Keep it under your MCP client's own timeout." }).default(50),
		}),
		output: object({ done: boolean(), tasks: array(Task) }),
	},
	async (ctx: QueryContext<typeof requirements>, input) => {
		if (input.ids.length > 50) throw new Error("wait takes at most 50 ids.");
		const team = boardFor(ctx);
		const deadline = Date.now() + Math.min(Math.max(1, input.timeout), 240) * 1000;
		for (;;) {
			const roots = await call(() => Promise.all(input.ids.map((id) => team.thread(id, { limit: 1 }))));
			const tasks = roots.map((thread) => summary(thread.message, full));
			const settled = tasks.filter((task) => SETTLED.has(task.state)).length;
			const done = input.until === "any" ? settled > 0 : settled === tasks.length;
			const left = deadline - Date.now();
			if (done || left <= 0) return { done, tasks };
			// Woken by any task in the swarm's channels finishing or blocking; then read the ones asked about again.
			await call(() =>
				team.wait(
					{ channel: `${CHANNEL}/`, label: ["board.task=completed|failed|canceled|blocked"] },
					{ timeout: Math.min(left, 20_000), signal: ctx.signal },
				),
			);
		}
	},
);

const answer = mutation(
	{
		description:
			"Answer a blocked task: posts the answer in its thread and puts it back on the board, where the next free worker picks it up with the whole thread.",
		input: object({ id: string(), text: string({ description: "The answer to the worker's question." }) }),
		output: Task,
	},
	async (ctx: MutationContext<typeof requirements>, input) => {
		const team = boardFor(ctx);
		await call(() => team.reply(input.id, input.text));
		return summary(await call(() => team.tasks.unblock(input.id)), short);
	},
);

const cancel = mutation(
	{
		description: "Cancel a task that hasn't finished. Tasks that need it wait for good, so cancel those too.",
		input: object({ id: string(), reason: string().default("Canceled by its submitter.") }),
		output: Task,
	},
	async (ctx: MutationContext<typeof requirements>, input) => {
		const team = boardFor(ctx);
		return summary(await call(() => team.tasks.cancel(input.id, input.reason)), short);
	},
);

export default defineApp(requirements, {
	tools: router(
		{ submit, list, read, wait, answer, cancel },
		{
			title: "Agent swarm",
			description:
				"Hand work to raygen's swarm of about 50 Pi agents through its Vercel Board (channel work). Read the swarm skill first.",
		},
	),
	skills: [SKILL],
});
