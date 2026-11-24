import { arr, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createTasksInChunks, type TaskInBatch } from "@vercel/board";
import { boardAs } from "./board.js";
import { config } from "./config.js";

/** What every tool needs from the worker actor: its name and the task it holds. */
export type WorkerToolContext = {
	key: readonly string[];
	state: { current: { taskId: string; asked?: string } | null };
};

function text(value: string, isError = false) {
	const limit = config.maxToolResultChars;
	const clipped =
		value.length > limit ? `${value.slice(0, limit)}\n…[${value.length - limit} more characters cut]` : value;
	return { output: [{ type: "text" as const, text: clipped }], isError };
}

const boardParameters = obj({
	op: oneOf(["reply", "ask", "subtasks", "read"]),
	text: opt(str({ description: "reply: the progress note. ask: the question, with your recommended answer." })),
	id: opt(str({ description: "read: the task ID to read, such as one your task depends on." })),
	tasks: opt(
		arr(
			obj({
				key: str({ description: "Short unique key, used by needs." }),
				text: str({ description: "The full brief, written for a stranger." }),
				needs: opt(arr(str(), { description: "Keys of tasks in this list that must finish first." })),
			}),
			{ description: "subtasks: the pieces to post for other workers." },
		),
	),
});

/** The worker's only way to the board. Credentials stay in the worker; the model never sees them. */
export const boardTool = {
	description:
		"The swarm's task board. op=reply posts a short progress note on your task. op=ask posts a blocking question; stop after it. op=subtasks posts tasks for other workers. op=read returns another task's thread.",
	parameters: boardParameters,
	outputLimits: { maxBytes: config.maxToolResultChars },
	async execute(c: WorkerToolContext, args: { op: string; text?: string; id?: string; tasks?: TaskInBatch[] }) {
		const current = c.state.current;
		if (!current) return text("You hold no task.", true);
		const board = boardAs(c.key[0]);
		switch (args.op) {
			case "reply": {
				if (!args.text) return text("reply needs text.", true);
				await board.reply(current.taskId, { text: args.text, noSync: true });
				return text("Posted.");
			}
			case "ask": {
				if (!args.text) return text("ask needs text.", true);
				await board.reply(current.taskId, args.text);
				current.asked = args.text.split("\n")[0].slice(0, 200);
				return text("Question posted. Stop now: end your turn with one line saying what you're waiting for.");
			}
			case "subtasks": {
				if (!args.tasks?.length) return text("subtasks needs tasks.", true);
				const plan = args.tasks.map((task) => ({
					key: task.key,
					text: `${task.text}\n\n(Split from task ${current.taskId}.)`,
					...(task.needs?.length ? { needs: task.needs.map((key) => ({ key: String(key) })) } : {}),
				}));
				const created = await createTasksInChunks(board, config.channel, plan, {
					id: `${current.taskId}-${plan.map((task) => task.key).join(",")}`.slice(0, 120),
				});
				return text(`Posted ${created.length} tasks: ${created.map((task) => task.id).join(", ")}`);
			}
			case "read": {
				if (!args.id) return text("read needs id.", true);
				const thread = await board.thread(args.id);
				const lines = [thread.message.text, ...thread.replies.map((reply) => `- ${reply.text}`)];
				const state = thread.message.labels?.["board.task"];
				return text(`${state ? `[${state}] ` : ""}${lines.join("\n")}`);
			}
			default:
				return text(`Unknown op ${args.op}.`, true);
		}
	},
};

let executor: Promise<Client> | undefined;

function executorClient(): Promise<Client> {
	const target = config.executor;
	if (!target) throw new Error("EXECUTOR_URL is not set");
	executor ??= (async () => {
		const client = new Client({ name: "agent-swarm", version: "0.1.0" });
		const headers: Record<string, string> = target.token ? { authorization: `Bearer ${target.token}` } : {};
		await client.connect(new StreamableHTTPClientTransport(new URL(target.url), { requestInit: { headers } }));
		return client;
	})().catch((error) => {
		executor = undefined;
		throw error;
	});
	return executor;
}

/** Executor's code mode: one tool, so the swarm's tool list stays a few hundred tokens however many integrations exist. */
export const executorTool = {
	description:
		"Run a short JavaScript program against every connected integration (GitHub, Slack, Linear, ...). Inside it, `await tools.search({ query })` finds tools, `await tools.search.describe({ paths })` shows signatures, and app tools are async functions such as `await tools.github.getIssue({...})`. Return only the fields you need.",
	parameters: obj({ code: str({ description: "The program's body. Use top-level await and return the result." }) }),
	outputLimits: { maxBytes: config.maxToolResultChars },
	async execute(_c: WorkerToolContext, args: { code: string }) {
		const client = await executorClient();
		const result = await client.callTool({ name: "execute", arguments: { code: args.code } });
		const content = (result.content ?? []) as Array<{ type: string; text?: string }>;
		const body = content.map((block) => (block.type === "text" ? block.text : `[${block.type}]`)).join("\n");
		return text(body || JSON.stringify(result.structuredContent ?? null), Boolean(result.isError));
	},
};
