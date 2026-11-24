/** What the page reads from /api/snapshot. Shared by the server collectors and the client. */

export type TaskState = "waiting" | "ready" | "claimed" | "blocked" | "completed" | "failed" | "canceled";

export const TASK_STATES: TaskState[] = ["ready", "waiting", "claimed", "blocked", "completed", "failed", "canceled"];

export type Source = { ok: boolean; at: number | null; error: string | null };

export type TaskRow = {
	id: string;
	channel: string;
	text: string;
	state: TaskState;
	author: string;
	createdAt: string;
	lastAt: string;
	replies: number;
	labels: Record<string, string>;
	needs: string[];
	/** The worker holding it (its board profile), and until when. */
	claim: { worker: string; until: string } | null;
	/** The worker that wrote the latest reply, which for a finished task is the one that settled it. */
	lastWorker: string | null;
	blocked: { kind: string | null; reason: string } | null;
	result: string | null;
	reason: string | null;
};

/** What a worker is doing now, derived from its status action. */
/** `unread` is a worker whose status hasn't been read yet: reads are staggered over a minute. */
export type WorkerPhase = "working" | "asking" | "claiming" | "backoff" | "unreachable" | "unread";

export type Outcome = {
	taskId: string;
	outcome: "completed" | "blocked" | "failed" | "lost";
	at: number;
	tokens: number;
	conversationId?: number;
};

export type WorkerRow = {
	name: string;
	actorId: string;
	phase: WorkerPhase;
	permanent: boolean;
	pod: string | null;
	node: string | null;
	taskId: string | null;
	claimedAt: number | null;
	asked: string | null;
	idleSince: number | null;
	completed: number;
	failed: number;
	blocked: number;
	tokens: number;
	last: Outcome | null;
	error: { message: string; at: number } | null;
	/** When this status was read. */
	seenAt: number | null;
};

export type PoolStatus = {
	permanent: number;
	extras: number;
	extraIndexes: number[];
	max: number;
	ready: number;
	backlogSeen: boolean | null;
	pod: string | null;
};

export type RivetNode = {
	key: string;
	version: number;
	connected: boolean;
	stopping: boolean;
	createdAt: number;
	lastPingAt: number | null;
};

export type Usage = { cpu: number | null; memory: number | null };

export type PodRow = {
	name: string;
	namespace: string;
	app: string;
	node: string | null;
	phase: string;
	ready: boolean;
	restarts: number;
	startedAt: string | null;
	usage: Usage;
	requests: Usage;
	limits: Usage;
};

export type NodeRow = {
	name: string;
	roles: string[];
	ready: boolean;
	arch: string;
	kubelet: string;
	capacity: Usage;
	allocatable: Usage;
	usage: Usage;
	pods: PodRow[];
};

export type Snapshot = {
	at: number;
	/** Whether a Kubernetes API is configured: in-cluster, or KUBE_API_URL. Without it there's no cluster view. */
	kubernetes: boolean;
	sources: { board: Source; rivet: Source; workers: Source; kube: Source };
	tasks: TaskRow[];
	/** Exact counts for open states; finished states count only the recent tasks listed. */
	counts: Record<TaskState, number>;
	pool: PoolStatus | null;
	workers: WorkerRow[];
	rivetNodes: RivetNode[];
	cluster: { nodes: NodeRow[]; unscheduled: PodRow[] };
};

export type ThreadMessage = {
	id: string;
	author: string;
	kind: string;
	/** The worker's board profile, which is its name, when an agent wrote it. */
	worker: string | null;
	text: string;
	createdAt: string;
};

export type ThreadDetail = {
	task: TaskRow;
	messages: ThreadMessage[];
};

/** What a worker's `activity` action returns (packages/swarm/src/activity.ts), already capped by the worker. */
export type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };

export type ActivityEntry =
	| { id: string; kind: "user"; text: string }
	| {
			id: string;
			kind: "assistant";
			text: string;
			thinking: string;
			toolCalls: { id: string; name: string; args: string }[];
			stopReason: string;
			error: string | null;
			tokens: Tokens;
	  }
	| {
			id: string;
			kind: "tool";
			name: string;
			toolCallId: string;
			text: string;
			isError: boolean;
			durationMs: number | null;
	  }
	| { id: string; kind: "other"; entryKind: string };

export type WorkerActivity = {
	name: string;
	taskId: string | null;
	/** The conversation is the task the worker holds now. */
	live: boolean;
	conversation: { conversationId: number; entries: ActivityEntry[]; more: boolean; tokens: Tokens } | null;
	/** Newest first. */
	history: Outcome[];
};

/** What /api/workers/[name] returns. */
export type WorkerDetail = {
	worker: WorkerRow | null;
	activity: WorkerActivity | null;
	/** Why the activity couldn't be read, such as a worker built before the action. */
	activityError: string | null;
	/** Board tasks this worker holds or settled, newest first, from the board's recent tasks. */
	tasks: TaskRow[];
};
