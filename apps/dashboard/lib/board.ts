import { type Board, board, type MessageView, type ThreadSummaryView } from "@vercel/board";
import type { TaskRow, TaskState, ThreadDetail } from "./types";

const CHANNEL = `${process.env.SWARM_CHANNEL ?? "work"}/`;
const PAGE = 200;
/** Open tasks are listed in full up to this many; past it the queue is long enough that more rows don't help. */
const MAX_OPEN = 1000;

let team: Board | undefined;

/** Reads as BOARD_TOKEN's own identity, the one that posts and owns the swarm's tasks. Never writes. */
function handle(): Board {
	team ??= board(process.env.BOARD_NAME ? { name: process.env.BOARD_NAME } : {});
	return team;
}

/** A claim past its lease is over, whatever the board last wrote. */
function stateNow(task: NonNullable<MessageView["task"]>, now: number): TaskState {
	if (task.state === "claimed" && task.claim && Date.parse(task.claim.until) <= now) return "ready";
	return task.state as TaskState;
}

/** `vercel:user:abc+Ada` is profile Ada. */
function profileOf(actor: string): string {
	const plus = actor.lastIndexOf("+");
	return plus === -1 ? actor : actor.slice(plus + 1);
}

function toRow(root: MessageView, replies: number, last: MessageView | null, now: number): TaskRow | null {
	const task = root.task;
	if (!task) return null;
	return {
		id: root.id,
		channel: root.channel,
		text: root.text ?? "",
		state: stateNow(task, now),
		author: root.author?.name ?? root.author?.handle ?? root.by.actor,
		createdAt: root.createdAt,
		lastAt: last?.createdAt ?? root.createdAt,
		replies,
		labels: Object.fromEntries(Object.entries(root.labels ?? {}).filter(([key]) => !key.startsWith("board."))),
		needs: task.needs.map(String),
		lastWorker: last?.author?.kind === "agent" ? (last.by.profile ?? null) : null,
		claim:
			task.claim && stateNow(task, now) === "claimed"
				? { worker: profileOf(task.claim.actor), until: task.claim.until }
				: null,
		blocked: task.blocked,
		result: task.result,
		reason: task.reason,
	};
}

/** Every open task, plus the recently active finished ones. */
export async function readTasks(): Promise<TaskRow[]> {
	const now = Date.now();
	const tasks = handle().tasks;
	const byId = new Map<string, ThreadSummaryView>();
	const recent = await tasks.list({ channel: CHANNEL, state: "all", latest: true, limit: PAGE });
	for (const summary of recent.tasks) byId.set(summary.message.id, summary);
	let after: string | undefined;
	for (let read = 0; read < MAX_OPEN; ) {
		const page = await tasks.list({ channel: CHANNEL, state: "open", limit: PAGE, ...(after ? { after } : {}) });
		for (const summary of page.tasks) byId.set(summary.message.id, summary);
		read += page.tasks.length;
		if (page.tasks.length < PAGE || !page.cursor) break;
		after = page.cursor;
	}
	return [...byId.values()]
		.map((summary) => toRow(summary.message, summary.replies, summary.last, now))
		.filter((row): row is TaskRow => row !== null)
		.sort((a, b) => b.lastAt.localeCompare(a.lastAt));
}

/** One task's whole thread. */
export async function readThread(id: string): Promise<ThreadDetail | null> {
	const thread = await handle().thread(id);
	const replies = thread.replies.filter((reply) => !reply.deleted);
	const task = toRow(thread.message, replies.length, replies.at(-1) ?? null, Date.now());
	if (!task) return null;
	return {
		task,
		messages: [thread.message, ...replies].map((message) => ({
			id: message.id,
			author: message.author?.name ?? message.author?.handle ?? message.by.actor,
			kind: message.author?.kind ?? "person",
			worker: message.author?.kind === "agent" ? (message.by.profile ?? null) : null,
			text: message.text ?? "",
			createdAt: message.createdAt,
		})),
	};
}
