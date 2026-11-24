import { createClient } from "rivetkit/client";
import type { Outcome, PoolStatus, RivetNode, WorkerActivity, WorkerPhase, WorkerRow } from "./types";

/**
 * RIVET_ENDPOINT is `http(s)://<namespace>:<token>@host`, the same form the swarm uses: a self-hosted engine, or
 * Rivet Cloud's `https://<namespace>:<sk_token>@<cluster>-api.onrivet.dev`.
 */
function endpoint() {
	const raw = process.env.RIVET_ENDPOINT;
	if (!raw) throw new Error("RIVET_ENDPOINT is not set");
	const url = new URL(raw);
	const namespace = decodeURIComponent(url.username);
	const token = decodeURIComponent(url.password);
	url.username = "";
	url.password = "";
	return { raw, base: url.toString().replace(/\/$/, ""), namespace, token };
}

let client: ReturnType<typeof createClient> | undefined;

/** Untyped on purpose: the dashboard calls only the read-only `status` actions, whose results it declares below. */
function rivet() {
	client ??= createClient(endpoint().raw);
	return client;
}

type Handle = { action: (opts: { name: string; args: unknown[]; signal?: AbortSignal }) => Promise<unknown> };

/** Calls an actor's read-only `status` action, giving up after 5 s. */
function callStatus(handle: Handle) {
	return handle.action({ name: "status", args: [], signal: AbortSignal.timeout(5_000) });
}

/**
 * A worker's read-only `activity` action: its outcome history and one task's conversation, capped by the worker.
 * Called only for the worker someone has open; a worker built before the action rejects it.
 */
export async function workerActivity(name: string, taskId?: string): Promise<WorkerActivity> {
	const handle = rivet().get("worker", [name]) as Handle;
	return (await handle.action({
		name: "activity",
		args: taskId ? [taskId] : [],
		signal: AbortSignal.timeout(10_000),
	})) as WorkerActivity;
}

async function api<T>(path: string, query: Record<string, string> = {}): Promise<T> {
	const { base, namespace, token } = endpoint();
	const params = new URLSearchParams({ namespace, ...query });
	const response = await fetch(`${base}${path}?${params}`, {
		headers: { authorization: `Bearer ${token}` },
		signal: AbortSignal.timeout(10_000),
		cache: "no-store",
	});
	if (!response.ok) throw new Error(`Rivet ${path}: ${response.status} ${(await response.text()).slice(0, 200)}`);
	return (await response.json()) as T;
}

/** The runner pool the swarm's nodes join. */
const POOL = process.env.RIVET_POOL ?? "default";

type ActorView = { actor_id: string; key: string; name: string; destroy_ts: number | null };

/** Every live actor named `worker`, by key. The API pages 100 at a time. */
export async function listWorkerActors(): Promise<Map<string, string>> {
	const actors = new Map<string, string>();
	let cursor: string | null = null;
	for (let page = 0; page < 50; page++) {
		const query: Record<string, string> = { name: "worker", limit: "100" };
		if (cursor) query.cursor = cursor;
		const result: { actors: ActorView[]; pagination: { cursor: string | null } } = await api("/actors", query);
		for (const actor of result.actors) if (actor.destroy_ts === null) actors.set(actor.key, actor.actor_id);
		cursor = result.pagination.cursor;
		if (!cursor || result.actors.length === 0) break;
	}
	return actors;
}

export async function listNodes(): Promise<RivetNode[]> {
	type NodeView = {
		key: string;
		version: number;
		connected: boolean;
		stopping: boolean;
		create_ts: number;
		last_ping_ts: number | null;
	};
	const result = await api<{ nodes: NodeView[] }>(`/pools/${encodeURIComponent(POOL)}/nodes`);
	return result.nodes
		.map((node) => ({
			key: node.key,
			version: node.version,
			connected: node.connected,
			stopping: node.stopping,
			createdAt: node.create_ts,
			lastPingAt: node.last_ping_ts,
		}))
		.sort((a, b) => b.version - a.version || a.createdAt - b.createdAt);
}

export async function poolStatus(): Promise<PoolStatus> {
	const status = (await callStatus(rivet().get("pool", ["main"]))) as Partial<PoolStatus> & {
		permanent: number;
		extras: number;
		max: number;
		ready: number;
	};
	return {
		permanent: status.permanent,
		extras: status.extras,
		extraIndexes: status.extraIndexes ?? [],
		max: status.max,
		ready: status.ready,
		backlogSeen: status.backlogSeen ?? null,
		pod: status.pod ?? null,
	};
}

/** The worker's `status` action. Fields after `tokens` came later; older builds leave them out. */
type WorkerStatus = {
	name: string;
	taskId: string | null;
	idleSince: number | null;
	completed: number;
	tokens: number;
	pod?: string;
	permanent?: boolean;
	claimedAt?: number | null;
	asked?: string | null;
	failed?: number;
	blocked?: number;
	last?: Outcome | null;
	error?: { message: string; at: number } | null;
};

/** A claim error newer than this means the worker is backing off before it claims again. */
const BACKOFF_MS = 30_000;

function phaseOf(status: WorkerStatus, now: number): WorkerPhase {
	if (status.taskId) return status.asked ? "asking" : "working";
	if (status.error && now - status.error.at < BACKOFF_MS) return "backoff";
	return "claiming";
}

/** A worker nobody has read yet, until its first status arrives or the board says it holds a task. */
export function unreadWorker(key: string, actorId: string): WorkerRow {
	return {
		name: key,
		actorId,
		phase: "unread",
		permanent: true,
		pod: null,
		node: null,
		taskId: null,
		claimedAt: null,
		asked: null,
		idleSince: null,
		completed: 0,
		failed: 0,
		blocked: 0,
		tokens: 0,
		last: null,
		error: null,
		seenAt: null,
	};
}

/**
 * Calls one worker's `status`. Each call is an action through the engine's gateway, so the caller paces
 * them; a worker that doesn't answer keeps what was last read, marked unreachable.
 */
export async function readWorker(key: string, actorId: string, before: WorkerRow): Promise<WorkerRow> {
	const now = Date.now();
	try {
		const status = (await callStatus(rivet().get("worker", [key]))) as WorkerStatus;
		return {
			name: key,
			actorId,
			phase: phaseOf(status, now),
			permanent: status.permanent ?? before.permanent,
			pod: status.pod ?? null,
			node: null,
			taskId: status.taskId,
			claimedAt: status.claimedAt ?? null,
			asked: status.asked ?? null,
			idleSince: status.idleSince,
			completed: status.completed,
			failed: status.failed ?? 0,
			blocked: status.blocked ?? 0,
			tokens: status.tokens,
			last: status.last ?? null,
			error: status.error ?? null,
			seenAt: now,
		};
	} catch {
		return { ...before, actorId, phase: "unreachable" };
	}
}
