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
 * How often each source is read while someone has the page open. Rivet is one engine on a Pi, so its reads are
 * slow and spread out: the worker loop ticks every second and reads only that second's share of the workers.
 */
const INTERVALS = { board: 4_000, rivet: 15_000, workers: 1_000, kube: 15_000 };
/** Each worker's `status` is read once per this long (staggered), so the engine sees workers / 60 actions a second. */
const WORKER_REFRESH_MS = Number(process.env.WORKER_STATUS_INTERVAL_S ?? 60) * 1000;
/** Polling stops this long after the last page request, so an unwatched dashboard costs nothing. */
const IDLE_AFTER_MS = 120_000;
const NAMESPACES = (process.env.KUBE_NAMESPACES ?? "agent-swarm,rivet").split(",").map((part) => part.trim());

type State = {
	sources: Snapshot["sources"];
	tasks: TaskRow[];
	pool: PoolStatus | null;
	actors: Map<string, string>;
	rivetNodes: RivetNode[];
	workers: Map<string, WorkerRow>;
	cluster: { nodes: NodeRow[]; unscheduled: PodRow[] };
	/** Where the staggered worker reads resume, in key order. */
	workerCursor: number;
	lastRequest: number;
	running: boolean;
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
	lastRequest: 0,
	running: false,
};
const state: State = globalState.swarmDashboard;

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
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
			const share = Math.min(keys.length, Math.ceil((keys.length * INTERVALS.workers) / WORKER_REFRESH_MS));
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

let warming: Promise<void> | null = null;

/**
 * Reads every source once, then keeps each on its own loop, so a slow one never holds up the others.
 * The loops stop once nobody has asked for a while, and the next request starts them again.
 */
function start(): Promise<void> {
	if (state.running && warming) return warming;
	state.running = true;
	warming = (async () => {
		await Promise.all([readers.board(), readers.rivet(), readers.kube()]);
		// After the first Rivet read, which lists the workers. This reads one tick's share, not all of them.
		await readers.workers();
		const loop = async (source: keyof typeof readers) => {
			while (Date.now() - state.lastRequest < IDLE_AFTER_MS) {
				await new Promise((resolve) => setTimeout(resolve, INTERVALS[source]));
				await readers[source]();
			}
		};
		void Promise.all((Object.keys(readers) as (keyof typeof readers)[]).map(loop)).finally(() => {
			state.running = false;
		});
	})();
	return warming;
}

/** A worker as the board's claims show it now, over its last status. */
function withClaim(worker: WorkerRow, task: TaskRow | undefined): WorkerRow {
	if (worker.phase === "unreachable") return worker;
	if (task) {
		if (worker.taskId === task.id) return worker;
		return { ...worker, phase: "working", taskId: task.id, claimedAt: null, asked: null, idleSince: null };
	}
	if (!worker.taskId) return worker;
	// Its status says it holds a task the board no longer shows it holding: it has settled since.
	return { ...worker, phase: "claiming", taskId: null, claimedAt: null, asked: null };
}

/** The latest of everything. A request while the collectors are stopped waits for their first reads. */
export async function snapshot(): Promise<Snapshot> {
	state.lastRequest = Date.now();
	await start();

	const podNode = new Map<string, string>();
	for (const node of state.cluster.nodes) for (const pod of node.pods) podNode.set(pod.name, node.name);
	// Statuses are up to a minute old; the board's claims are seconds old, so they decide who holds what.
	const claims = new Map<string, TaskRow>();
	for (const task of state.tasks) if (task.claim) claims.set(task.claim.worker, task);
	const workers = [...state.workers.values()]
		.map((worker) => withClaim(worker, claims.get(worker.name)))
		.map((worker) => ({ ...worker, node: worker.pod ? (podNode.get(worker.pod) ?? null) : null }))
		.sort((a, b) => a.name.localeCompare(b.name));

	const counts = Object.fromEntries(TASK_STATES.map((name) => [name, 0])) as Record<TaskState, number>;
	for (const task of state.tasks) counts[task.state] += 1;

	return {
		at: Date.now(),
		sources: state.sources,
		tasks: state.tasks,
		counts,
		pool: state.pool,
		workers,
		rivetNodes: state.rivetNodes,
		cluster: state.cluster,
	};
}
