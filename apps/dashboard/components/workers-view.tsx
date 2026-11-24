import { useState } from "react";
import { Dot, PHASE_COLORS, PHASE_LABELS, PhaseBadge } from "@/components/bits";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { ago, compact, firstLine } from "@/lib/format";
import type { Snapshot, WorkerPhase } from "@/lib/types";

const OUTCOME_COLORS = {
	completed: "text-emerald-400",
	blocked: "text-amber-400",
	failed: "text-red-400",
	lost: "text-orange-400",
};

export function WorkersView({
	snapshot,
	now,
	onTask,
}: {
	snapshot: Snapshot;
	now: number;
	onTask: (id: string) => void;
}) {
	const [phase, setPhase] = useState<WorkerPhase | "all">("all");
	const [query, setQuery] = useState("");
	const needle = query.trim().toLowerCase();
	const taskText = new Map(snapshot.tasks.map((task) => [task.id, task.text]));
	const phases = Object.keys(PHASE_LABELS) as WorkerPhase[];
	const workers = snapshot.workers.filter(
		(worker) =>
			(phase === "all" || worker.phase === phase) &&
			(!needle ||
				worker.name.includes(needle) ||
				worker.pod?.includes(needle) ||
				worker.node?.includes(needle) ||
				worker.taskId?.toLowerCase().includes(needle)),
	);
	// Busy workers first, then by name.
	workers.sort((a, b) => Number(Boolean(b.taskId)) - Number(Boolean(a.taskId)) || a.name.localeCompare(b.name));

	return (
		<div className="space-y-4">
			<div className="flex flex-wrap items-center gap-3">
				<ToggleGroup
					type="single"
					variant="outline"
					size="sm"
					value={phase}
					onValueChange={(value) => value && setPhase(value as WorkerPhase | "all")}
				>
					<ToggleGroupItem value="all" className="gap-1.5 px-3">
						All <span className="text-muted-foreground tabular-nums">{snapshot.workers.length}</span>
					</ToggleGroupItem>
					{phases.map((name) => (
						<ToggleGroupItem key={name} value={name} className="gap-1.5 px-3">
							<Dot className={PHASE_COLORS[name]} />
							{PHASE_LABELS[name]}
							<span className="text-muted-foreground tabular-nums">
								{snapshot.workers.filter((worker) => worker.phase === name).length}
							</span>
						</ToggleGroupItem>
					))}
				</ToggleGroup>
				<Input
					placeholder="Search workers, pods, nodes, tasks…"
					value={query}
					onChange={(event) => setQuery(event.target.value)}
					className="ml-auto h-8 w-72"
				/>
			</div>
			<Card className="py-0">
				<Table>
					<TableHeader>
						<TableRow className="hover:bg-transparent">
							<TableHead className="w-32">Worker</TableHead>
							<TableHead className="w-36">State</TableHead>
							<TableHead>Task</TableHead>
							<TableHead className="w-56">Pod · node</TableHead>
							<TableHead className="w-20 text-right">For</TableHead>
							<TableHead className="w-28 text-right">Done / fail / blk</TableHead>
							<TableHead className="w-20 text-right">Tokens</TableHead>
							<TableHead className="w-40">Last task</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{workers.map((worker) => (
							<TableRow
								key={worker.name}
								className={worker.taskId ? "cursor-pointer" : undefined}
								onClick={() => worker.taskId && onTask(worker.taskId)}
							>
								<TableCell className="font-mono text-xs">
									{worker.name}
									{!worker.permanent && <span className="ml-1.5 text-sky-400">extra</span>}
								</TableCell>
								<TableCell>
									<PhaseBadge phase={worker.phase} />
								</TableCell>
								<TableCell className="max-w-0">
									{worker.taskId ? (
										<div className="truncate">{firstLine(taskText.get(worker.taskId) ?? worker.taskId, 160)}</div>
									) : worker.error ? (
										<div className="truncate text-xs text-orange-400">{worker.error.message}</div>
									) : (
										<span className="text-xs text-muted-foreground">Holding a claim open on the board</span>
									)}
									{worker.asked && <div className="truncate text-xs text-amber-400">Asked: {worker.asked}</div>}
								</TableCell>
								<TableCell className="max-w-0 truncate font-mono text-xs text-muted-foreground">
									{worker.pod ? `${worker.pod.replace(/^swarm-/, "")} · ${worker.node ?? "?"}` : "—"}
								</TableCell>
								<TableCell className="text-right text-xs text-muted-foreground tabular-nums">
									{ago(worker.taskId ? worker.claimedAt : worker.idleSince, now)}
								</TableCell>
								<TableCell className="text-right text-xs tabular-nums">
									<span className="text-emerald-400">{worker.completed}</span>
									<span className="text-muted-foreground"> / </span>
									<span className={worker.failed ? "text-red-400" : "text-muted-foreground"}>{worker.failed}</span>
									<span className="text-muted-foreground"> / </span>
									<span className={worker.blocked ? "text-amber-400" : "text-muted-foreground"}>{worker.blocked}</span>
								</TableCell>
								<TableCell className="text-right text-xs tabular-nums">{compact(worker.tokens)}</TableCell>
								<TableCell className="text-xs">
									{worker.last ? (
										<button
											type="button"
											className="hover:underline"
											onClick={(event) => {
												event.stopPropagation();
												if (worker.last) onTask(worker.last.taskId);
											}}
										>
											<span className={OUTCOME_COLORS[worker.last.outcome]}>{worker.last.outcome}</span>
											<span className="text-muted-foreground"> · {ago(worker.last.at, now)} ago</span>
										</button>
									) : (
										<span className="text-muted-foreground">—</span>
									)}
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			</Card>
		</div>
	);
}
