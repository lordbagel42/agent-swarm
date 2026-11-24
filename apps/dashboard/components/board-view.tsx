import { useState } from "react";
import { Dot, TASK_COLORS, TaskStateBadge, WorkerLink } from "@/components/bits";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { ago, firstLine } from "@/lib/format";
import { type Snapshot, TASK_STATES, type TaskState } from "@/lib/types";

export function BoardView({
	snapshot,
	now,
	onTask,
}: {
	snapshot: Snapshot;
	now: number;
	onTask: (id: string) => void;
}) {
	const [state, setState] = useState<TaskState | "all">("all");
	const [query, setQuery] = useState("");
	const needle = query.trim().toLowerCase();
	const tasks = snapshot.tasks.filter(
		(task) =>
			(state === "all" || task.state === state) &&
			(!needle ||
				task.text.toLowerCase().includes(needle) ||
				task.id.toLowerCase().includes(needle) ||
				task.claim?.worker.toLowerCase().includes(needle) ||
				task.lastWorker?.toLowerCase().includes(needle)),
	);

	return (
		<div className="space-y-4">
			<div className="flex flex-wrap items-center gap-3">
				<ToggleGroup
					type="single"
					variant="outline"
					size="sm"
					value={state}
					onValueChange={(value) => value && setState(value as TaskState | "all")}
				>
					<ToggleGroupItem value="all" className="gap-1.5 px-3">
						All <span className="text-muted-foreground tabular-nums">{snapshot.tasks.length}</span>
					</ToggleGroupItem>
					{TASK_STATES.map((name) => (
						<ToggleGroupItem key={name} value={name} className="gap-1.5 px-3 capitalize">
							<Dot className={TASK_COLORS[name]} />
							{name}
							<span className="text-muted-foreground tabular-nums">{snapshot.counts[name]}</span>
						</ToggleGroupItem>
					))}
				</ToggleGroup>
				<Input
					placeholder="Search tasks, IDs, workers…"
					value={query}
					onChange={(event) => setQuery(event.target.value)}
					className="ml-auto h-8 w-72"
				/>
			</div>
			<p className="text-xs text-muted-foreground">
				Every open task, plus the 200 most recently active. Finished counts cover those recent ones only.
			</p>
			<Card className="py-0">
				<Table>
					<TableHeader>
						<TableRow className="hover:bg-transparent">
							<TableHead className="w-28">State</TableHead>
							<TableHead>Task</TableHead>
							<TableHead className="w-32">Worker</TableHead>
							<TableHead className="w-36">From</TableHead>
							<TableHead className="w-20 text-right">Replies</TableHead>
							<TableHead className="w-24 text-right">Active</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{tasks.map((task) => (
							<TableRow key={task.id} className="cursor-pointer" onClick={() => onTask(task.id)}>
								<TableCell>
									<TaskStateBadge state={task.state} />
								</TableCell>
								<TableCell className="max-w-0">
									<div className="truncate">{firstLine(task.text, 200)}</div>
									<div className="truncate text-xs text-muted-foreground">
										{task.blocked
											? `Blocked: ${firstLine(task.blocked.reason, 160)}`
											: task.reason
												? firstLine(task.reason, 160)
												: task.result
													? firstLine(task.result, 160)
													: task.needs.length
														? `Needs ${task.needs.join(", ")}`
														: Object.entries(task.labels)
																.map(([key, value]) => `${key}=${value}`)
																.join(" ")}
									</div>
								</TableCell>
								<TableCell className="font-mono text-xs">
									{task.claim ? (
										<WorkerLink name={task.claim.worker} className="text-blue-400" />
									) : task.lastWorker ? (
										<WorkerLink name={task.lastWorker} className="text-muted-foreground" />
									) : null}
								</TableCell>
								<TableCell className="truncate text-xs text-muted-foreground">{task.author}</TableCell>
								<TableCell className="text-right tabular-nums">{task.replies}</TableCell>
								<TableCell className="text-right text-xs text-muted-foreground">{ago(task.lastAt, now)}</TableCell>
							</TableRow>
						))}
						{tasks.length === 0 && (
							<TableRow>
								<TableCell colSpan={6} className="py-10 text-center text-muted-foreground">
									No tasks match.
								</TableCell>
							</TableRow>
						)}
					</TableBody>
				</Table>
			</Card>
		</div>
	);
}
