import { Dot, PHASE_COLORS, PHASE_LABELS, TaskStateBadge } from "@/components/bits";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { WorkerGrid } from "@/components/worker-grid";
import { ago, compact, firstLine } from "@/lib/format";
import type { Snapshot, WorkerPhase, WorkerRow } from "@/lib/types";

function Stat({ label, value, hint, dot }: { label: string; value: string | number; hint?: string; dot?: string }) {
	return (
		<Card className="gap-1 py-4">
			<CardContent className="px-4">
				<div className="flex items-center gap-1.5 text-xs text-muted-foreground">
					{dot && <Dot className={dot} />}
					{label}
				</div>
				<div className="mt-1 text-2xl font-semibold tracking-tight tabular-nums">{value}</div>
				{hint && <div className="mt-0.5 text-xs leading-snug text-muted-foreground">{hint}</div>}
			</CardContent>
		</Card>
	);
}

/** Workers grouped by the pod they report, in pod order, with unknown pods last. */
export function byPod(workers: WorkerRow[]): [string, WorkerRow[]][] {
	const groups = new Map<string, WorkerRow[]>();
	for (const worker of workers) {
		const key = worker.pod ?? "";
		groups.set(key, [...(groups.get(key) ?? []), worker]);
	}
	return [...groups.entries()].sort(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)));
}

export function OverviewView({
	snapshot,
	now,
	onTask,
	onTab,
}: {
	snapshot: Snapshot;
	now: number;
	onTask: (id: string) => void;
	onTab: (tab: string) => void;
}) {
	const { workers, counts, pool, tasks } = snapshot;
	const phases = Object.fromEntries(
		(Object.keys(PHASE_LABELS) as WorkerPhase[]).map((phase) => [
			phase,
			workers.filter((worker) => worker.phase === phase).length,
		]),
	) as Record<WorkerPhase, number>;
	const tokens = workers.reduce((total, worker) => total + worker.tokens, 0);
	const completed = workers.reduce((total, worker) => total + worker.completed, 0);
	const failed = workers.reduce((total, worker) => total + worker.failed, 0);
	const recent = tasks.slice(0, 8);

	return (
		<div className="space-y-6">
			<div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
				<Stat
					label="Workers"
					value={workers.length}
					hint={pool ? `${pool.permanent} + ${pool.extras} extra · max ${pool.max}` : "pool unreachable"}
				/>
				<Stat
					label="Working"
					value={phases.working + phases.asking}
					dot={PHASE_COLORS.working}
					hint={`${phases.asking} asking`}
				/>
				<Stat
					label="Idle · claiming"
					value={phases.claiming}
					dot={PHASE_COLORS.claiming}
					hint={phases.unread ? `${phases.unread} not read yet` : undefined}
				/>
				<Stat
					label="Unhealthy"
					value={phases.backoff + phases.unreachable}
					dot={phases.backoff + phases.unreachable ? PHASE_COLORS.unreachable : "bg-emerald-500"}
					hint={`${phases.backoff} backing off · ${phases.unreachable} unreachable`}
				/>
				<Stat
					label="Queue"
					value={counts.ready + counts.waiting}
					dot="bg-sky-400"
					hint={`${counts.ready} ready · ${counts.waiting} waiting`}
				/>
				<Stat label="Blocked" value={counts.blocked} dot="bg-amber-400" hint="waiting on a person" />
				<Stat label="Done by workers" value={compact(completed)} dot="bg-emerald-500" hint={`${failed} failed`} />
				<Stat label="Tokens" value={compact(tokens)} hint="across every worker" />
			</div>

			<div className="grid items-start gap-6 lg:grid-cols-[1fr_380px]">
				<Card>
					<CardHeader className="flex flex-row items-center justify-between">
						<CardTitle className="text-sm">Workers by pod</CardTitle>
						<div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
							{(Object.keys(PHASE_LABELS) as WorkerPhase[]).map((phase) => (
								<span key={phase} className="inline-flex items-center gap-1.5">
									<span className={`size-2.5 rounded-[3px] ${PHASE_COLORS[phase]}`} />
									{PHASE_LABELS[phase]}
								</span>
							))}
							<span className="inline-flex items-center gap-1.5">
								<span className="size-2.5 rounded-[3px] bg-neutral-700 ring-1 ring-sky-400/70" />
								Extra
							</span>
						</div>
					</CardHeader>
					<CardContent className="space-y-5">
						{byPod(workers).map(([pod, group]) => (
							<div key={pod || "unknown"}>
								<div className="mb-2 flex items-baseline gap-2 text-xs">
									<span className="font-mono text-foreground/90">{pod || "pod not reported"}</span>
									<span className="text-muted-foreground">
										{group[0]?.node ?? (pod ? "" : "not read yet, older build, or unreachable")}
									</span>
									<span className="ml-auto text-muted-foreground tabular-nums">
										{group.filter((worker) => worker.taskId).length} busy / {group.length}
									</span>
								</div>
								<WorkerGrid workers={group} now={now} onTask={onTask} />
							</div>
						))}
						{workers.length === 0 && <p className="text-sm text-muted-foreground">No worker actors found in Rivet.</p>}
					</CardContent>
				</Card>

				<div className="space-y-6">
					<Card>
						<CardHeader>
							<CardTitle className="text-sm">Pool</CardTitle>
						</CardHeader>
						<CardContent className="grid grid-cols-2 gap-y-3 text-sm">
							<span className="text-muted-foreground">Permanent</span>
							<span className="text-right tabular-nums">{pool?.permanent ?? "—"}</span>
							<span className="text-muted-foreground">Extras</span>
							<span className="text-right tabular-nums">
								{pool
									? `${pool.extras}${pool.extraIndexes.length ? ` (${pool.extraIndexes.slice(0, 3).join(", ")}${pool.extraIndexes.length > 3 ? "…" : ""})` : ""}`
									: "—"}
							</span>
							<span className="text-muted-foreground">Ceiling</span>
							<span className="text-right tabular-nums">{pool?.max ?? "—"}</span>
							<span className="text-muted-foreground">Ready at last check</span>
							<span className="text-right tabular-nums">
								{pool ? `${pool.ready}${pool.backlogSeen ? " · backlog seen" : ""}` : "—"}
							</span>
							<span className="text-muted-foreground">Pool actor on</span>
							<span className="truncate text-right font-mono text-xs">{pool?.pod ?? "—"}</span>
						</CardContent>
					</Card>

					<Card>
						<CardHeader className="flex flex-row items-center justify-between">
							<CardTitle className="text-sm">Recent tasks</CardTitle>
							<button
								type="button"
								className="text-xs text-muted-foreground hover:text-foreground"
								onClick={() => onTab("board")}
							>
								View all →
							</button>
						</CardHeader>
						<CardContent className="space-y-1 px-2">
							{recent.map((task) => (
								<button
									key={task.id}
									type="button"
									onClick={() => onTask(task.id)}
									className="flex w-full flex-col gap-1 rounded-md px-2 py-2 text-left hover:bg-muted/50"
								>
									<div className="flex items-center gap-2">
										<TaskStateBadge state={task.state} />
										<span className="ml-auto text-xs text-muted-foreground">{ago(task.lastAt, now)} ago</span>
									</div>
									<span className="line-clamp-1 text-sm">{firstLine(task.text)}</span>
									{task.claim && <span className="font-mono text-xs text-blue-400">{task.claim.worker}</span>}
								</button>
							))}
							{recent.length === 0 && <p className="px-2 text-sm text-muted-foreground">No tasks on the board yet.</p>}
						</CardContent>
					</Card>
				</div>
			</div>
		</div>
	);
}
