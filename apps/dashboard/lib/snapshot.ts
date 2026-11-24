import { readTasks } from "./board";
import { kubeConfigured, readCluster } from "./kube";
import { listNodes, listWorkerActors, poolStatus, readWorker, unreadWorker } from "./rivet";
import {
	type NodeRow,
	type PodRow,
	type PoolStatus,
	type RivetNode,
	type Snapshot,
	type Source,
	TASK_STATES,
	type TaskRow,
	type TaskState,
	type WorkerRow,
} from "./types";

/**
 * How old each source may get while someone has the page open. Sources are read when a page request finds them
 * stale, so nothing runs while nobody watches, and it works the same on a long-lived server and on serverless.
 */
const MAX_AGE = { board: 4_000, rivet: 15_000, workers: 1_000, kube: 15_000 };
/**
 * Each worker's `status` is read about once per this long: a worker read takes the share of workers due since the
 * last one, so Rivet sees about workers / 60 actions a second however often pages ask.
 */
const WORKER_REFRESH_MS = Number(process.env.WORKER_STATUS_INTERVAL_S ?? 60) * 1000;
const NAMESPACES = (process.env.KUBE_NAMESPACES ?? "agent-swarm,rivet").split(",").map((part) => part.trim());

type SourceName = keyof Snapshot["sources"];

type State = {
	sources: Snapshot["sources"];
	tasks: TaskRow[];
	pool: PoolStatus | null;
	actors: Map<string, string>;
	rivetNodes: RivetNode[];
	workers: Map<string, WorkerRow>;
	cluster: { nodes: NodeRow[]; unscheduled: PodRow[] };
	/** Where the staggered worker reads resume, in key order, and when the last one started. */
	workerCursor: number;
	workerReadAt: number;
	/** When each source was last attempted, and its read in flight, shared by concurrent requests. */
	attempted: Record<SourceName, number>;
	inFlight: Partial<Record<SourceName, Promise<void>>>;
};

const empty = (): Source => ({ ok: false, at: null, error: null });

// One collector per server process, kept across hot reloads in development.
const globalState = globalThis as unknown as { swarmDashboard?: State };
globalState.swarmDashboard ??= {
	sources: { board: empty(), rivet: empty(), workers: empty(), kube: empty() },
	tasks: [],
	pool: null,
	actors: new Map(),
	rivetNodes: [],
	workers: new Map(),
	cluster: { nodes: [], unscheduled: [] },
	workerCursor: 0,
	workerReadAt: 0,
	attempted: { board: 0, rivet: 0, workers: 0, kube: 0 },
	inFlight: {},
};
const state: State = globalState.swarmDashboard;

/** The error and its cause: undici says only "fetch failed", and the cause says why (refused, reset, DNS). */
function message(error: unknown): string {
	if (!(error instanceof Error)) return String(error);
	const cause = error.cause as { code?: string; message?: string } | undefined;
	return cause ? `${error.message}: ${cause.code ?? cause.message}` : error.message;
}

async function track(source: keyof Snapshot["sources"], read: () => Promise<void>) {
	try {
		await read();
		state.sources[source] = { ok: true, at: Date.now(), error: null };
	} catch (error) {
		state.sources[source] = { ...state.sources[source], ok: false, error: message(error) };
		console.warn(`[dashboard] ${source}: ${message(error)}`);
	}
}

const readers: Record<keyof Snapshot["sources"], () => Promise<void>> = {
	board: () =>
		track("board", async () => {
			state.tasks = await readTasks();
		}),
	rivet: () =>
		track("rivet", async () => {
			// Each keeps its last good value when its read fails, and any failure marks the source.
			const [pool, nodes, actors] = await Promise.allSettled([poolStatus(), listNodes(), listWorkerActors()]);
			if (pool.status === "fulfilled") state.pool = pool.value;
			if (nodes.status === "fulfilled") state.rivetNodes = nodes.value;
			if (actors.status === "fulfilled") state.actors = actors.value;
			const failed = [pool, nodes, actors].find((result) => result.status === "rejected");
			if (failed) throw failed.reason;
		}),
	workers: () =>
		track("workers", async () => {
			const keys = [...state.actors.keys()].sort();
			// Follow the actor list: new workers start unread, destroyed ones drop out.
			const rows = new Map<string, WorkerRow>();
			for (const key of keys) {
				rows.set(key, state.workers.get(key) ?? unreadWorker(key, state.actors.get(key) ?? ""));
			}
			state.workers = rows;
			if (keys.length === 0) return;
			const now = Date.now();
			// Capped, so the first read after a quiet spell doesn't call every worker at once.
			const elapsed = Math.min(5_000, state.workerReadAt ? now - state.workerReadAt : MAX_AGE.workers);
			state.workerReadAt = now;
			const share = Math.min(keys.length, Math.ceil((keys.length * elapsed) / WORKER_REFRESH_MS));
			const batch = Array.from({ length: share }, (_, i) => keys[(state.workerCursor + i) % keys.length]);
			state.workerCursor = (state.workerCursor + share) % keys.length;
			const read = await Promise.all(
				batch.map((key) => readWorker(key, state.actors.get(key) ?? "", rows.get(key) as WorkerRow)),
			);
			for (const row of read) if (state.workers.has(row.name)) state.workers.set(row.name, row);
		}),
	kube: async () => {
		if (!kubeConfigured()) {
			state.sources.kube = { ok: false, at: null, error: "not configured" };
			return;
		}
		await track("kube", async () => {
			state.cluster = await readCluster(NAMESPACES);
		});
	},
};

/** A worker as the board's claims show it now, over its last status. */
function withClaim(worker: WorkerRow, task: TaskRow | undefined): WorkerRow {
	if (worker.phase === "unreachable") return worker;
	if (task) {
		if (worker.taskId === task.id) return worker;
		return { ...worker, phase: "working", taskId: task.id, claimedAt: null, asked: null, idleSince: null };
	}
	if (!worker.taskId) return worker;
	// Its status says it holds a task the board no longer shows it holding: it has settled since.
	return { ...worker, phase: worker.seenAt ? "claiming" : "unread", taskId: null, claimedAt: null, asked: null };
}

/** Reads a source when it's stale, once at a time: concurrent requests wait on the same read. */
function refresh(source: SourceName): Promise<void> {
	const running = state.inFlight[source];
	if (running) return running;
	if (Date.now() - state.attempted[source] < MAX_AGE[source]) return Promise.resolve();
	state.attempted[source] = Date.now();
	const read = readers[source]().finally(() => {
		delete state.inFlight[source];
	});
	state.inFlight[source] = read;
	return read;
}

/** The latest of everything, reading what has gone stale first. */
export async function snapshot(): Promise<Snapshot> {
	await Promise.all([refresh("board"), refresh("rivet"), refresh("kube")]);
	// After Rivet, which lists the workers this reads a share of.
	await refresh("workers");

	const podNode = new Map<string, string>();
	for (const node of state.cluster.nodes) for (const pod of node.pods) podNode.set(pod.name, node.name);
	// The board lowercases profiles: show them as the workers' names, Ada rather than ada.
	const names = new Map([...state.workers.values()].map((worker) => [worker.name.toLowerCase(), worker.name]));
	const named = (profile: string) => names.get(profile.toLowerCase()) ?? profile;
	const tasks = state.tasks.map((task) => ({
		...task,
		claim: task.claim && { ...task.claim, worker: named(task.claim.worker) },
		lastWorker: task.lastWorker && named(task.lastWorker),
	}));
	// Statuses are up to a minute old; the board's claims are seconds old, so they decide who holds what.
	const claims = new Map<string, TaskRow>();
	for (const task of tasks) if (task.claim) claims.set(task.claim.worker, task);
	const workers = [...state.workers.values()]
		.map((worker) => withClaim(worker, claims.get(worker.name)))
		.map((worker) => ({ ...worker, node: worker.pod ? (podNode.get(worker.pod) ?? null) : null }))
		.sort((a, b) => a.name.localeCompare(b.name));

	const counts = Object.fromEntries(TASK_STATES.map((name) => [name, 0])) as Record<TaskState, number>;
	for (const task of tasks) counts[task.state] += 1;

	return {
		at: Date.now(),
		kubernetes: kubeConfigured(),
		sources: state.sources,
		tasks,
		counts,
		pool: state.pool,
		workers,
		rivetNodes: state.rivetNodes,
		cluster: state.cluster,
	};
}
