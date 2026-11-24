import { workerActivity } from "@/lib/rivet";
import { snapshot } from "@/lib/snapshot";
import type { WorkerActivity, WorkerDetail } from "@/lib/types";

export const dynamic = "force-dynamic";

/** A worker's activity is read at most this often, however many people have its page open. */
const ACTIVITY_MAX_AGE_MS = 3_000;
const cache = new Map<string, { at: number; read: Promise<WorkerActivity> }>();

function activity(name: string, taskId: string | undefined): Promise<WorkerActivity> {
	const key = `${name}\n${taskId ?? ""}`;
	const hit = cache.get(key);
	if (hit && Date.now() - hit.at < ACTIVITY_MAX_AGE_MS) return hit.read;
	const read = workerActivity(name, taskId);
	cache.set(key, { at: Date.now(), read });
	// Drop failures at once so the next request tries again, and old entries so the map stays small.
	read.catch(() => cache.delete(key));
	for (const [other, entry] of cache) if (Date.now() - entry.at > 60_000) cache.delete(other);
	return read;
}

/** The worker's settled results end with `_Ada · 1,234 tokens_`, and failures with `(Ada, 1234 tokens)`. */
function settledBy(name: string, text: string | null): boolean {
	return Boolean(text && (text.includes(`_${name} · `) || text.includes(`(${name}, `)));
}

export async function GET(request: Request, { params }: { params: Promise<{ name: string }> }) {
	const { name: asked } = await params;
	const taskId = new URL(request.url).searchParams.get("task") ?? undefined;
	const snap = await snapshot();
	// Board profiles are lowercase, so /workers/ada is Ada.
	const worker = snap.workers.find((row) => row.name.toLowerCase() === asked.toLowerCase()) ?? null;
	const name = worker?.name ?? asked;
	const read = await activity(name, taskId).then(
		(value) => ({ value, error: null }),
		(error: unknown) => ({ value: null, error: error instanceof Error ? error.message : String(error) }),
	);
	const tasks = snap.tasks
		.filter(
			(task) =>
				task.claim?.worker === name ||
				task.lastWorker === name ||
				settledBy(name, task.result) ||
				settledBy(name, task.reason),
		)
		.sort((a, b) => b.lastAt.localeCompare(a.lastAt));
	const body: WorkerDetail = {
		worker,
		activity: read.value,
		activityError: read.error,
		tasks,
	};
	return Response.json(body, { headers: { "cache-control": "no-store" } });
}
