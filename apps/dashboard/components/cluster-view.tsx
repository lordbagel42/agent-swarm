import { Dot, Meter } from "@/components/bits";
import { byPod } from "@/components/overview-view";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { WorkerGrid } from "@/components/worker-grid";
import { ago, bytes, cores, percent } from "@/lib/format";
import type { PodRow, Snapshot, Usage, WorkerRow } from "@/lib/types";

function UsageLine({
	label,
	used,
	total,
	request,
	format,
}: {
	label: string;
	used: number | null;
	total: number | null;
	request?: number | null;
	format: (value: number | null) => string;
}) {
	return (
		<div className="space-y-1">
			<div className="flex items-baseline justify-between text-xs">
				<span className="text-muted-foreground">{label}</span>
				<span className="tabular-nums">
					{format(used)}
					<span className="text-muted-foreground"> / {format(total)}</span>
				</span>
			</div>
			<Meter value={percent(used, total)} request={request === undefined ? undefined : percent(request, total)} />
		</div>
	);
}

function PodCard({
	pod,
	workers,
	now,
	onTask,
}: {
	pod: PodRow;
	workers: WorkerRow[];
	now: number;
	onTask: (id: string) => void;
}) {
	const limit = (key: keyof Usage) => pod.limits[key];
	return (
		<div className="rounded-lg border border-border bg-background/40 p-3">
			<div className="mb-3 flex items-center gap-2">
				<Dot className={pod.ready ? "bg-emerald-500" : pod.phase === "Pending" ? "bg-amber-400" : "bg-red-500"} />
				<span className="truncate font-mono text-xs">{pod.name}</span>
				<Badge variant="outline" className="ml-auto font-normal text-muted-foreground">
					{pod.namespace}
				</Badge>
			</div>
			<div className="grid grid-cols-2 gap-3">
				<UsageLine label="CPU" used={pod.usage.cpu} total={limit("cpu")} request={pod.requests.cpu} format={cores} />
				<UsageLine
					label="Memory"
					used={pod.usage.memory}
					total={limit("memory")}
					request={pod.requests.memory}
					format={bytes}
				/>
			</div>
			<div className="mt-2 flex gap-3 text-xs text-muted-foreground">
				<span>{pod.phase}</span>
				<span>up {ago(pod.startedAt, now)}</span>
				<span className={pod.restarts ? "text-amber-400" : undefined}>
					{pod.restarts} restart{pod.restarts === 1 ? "" : "s"}
				</span>
				{workers.length > 0 && (
					<span className="ml-auto tabular-nums">
						{workers.filter((worker) => worker.taskId).length} busy / {workers.length} actors
					</span>
				)}
			</div>
			{workers.length > 0 && (
				<div className="mt-3">
					<WorkerGrid workers={workers} now={now} onTask={onTask} size="sm" />
				</div>
			)}
		</div>
	);
}

export function ClusterView({
	snapshot,
	now,
	onTask,
}: {
	snapshot: Snapshot;
	now: number;
	onTask: (id: string) => void;
}) {
	const { cluster, workers, rivetNodes, sources, pool } = snapshot;
	const workersByPod = new Map(byPod(workers));
	const known = new Set(cluster.nodes.flatMap((node) => node.pods.map((pod) => pod.name)));
	const orphans = byPod(workers).filter(([pod]) => !known.has(pod));

	return (
		<div className="space-y-6">
			{!sources.kube.ok && (
				<div className="rounded-lg border border-amber-400/30 bg-amber-400/5 p-4 text-sm text-amber-200">
					Kubernetes: {sources.kube.error ?? "not read yet"}. Workers below are grouped by the pod they report instead.
				</div>
			)}

			<div className="grid gap-4 xl:grid-cols-2">
				{cluster.nodes.map((node) => {
					const podCount = node.pods.length;
					return (
						<Card key={node.name}>
							<CardHeader className="flex flex-row items-center gap-2">
								<Dot className={node.ready ? "bg-emerald-500" : "bg-red-500"} />
								<CardTitle className="font-mono text-sm">{node.name}</CardTitle>
								{node.roles.map((role) => (
									<Badge key={role} variant="secondary" className="font-normal">
										{role}
									</Badge>
								))}
								<span className="ml-auto text-xs text-muted-foreground">
									{node.arch} · {node.kubelet}
								</span>
							</CardHeader>
							<CardContent className="space-y-4">
								<div className="grid grid-cols-2 gap-4">
									<UsageLine label="Node CPU" used={node.usage.cpu} total={node.allocatable.cpu} format={cores} />
									<UsageLine
										label="Node memory"
										used={node.usage.memory}
										total={node.allocatable.memory}
										format={bytes}
									/>
								</div>
								{node.pods.map((pod) => (
									<PodCard
										key={pod.name}
										pod={pod}
										workers={workersByPod.get(pod.name) ?? []}
										now={now}
										onTask={onTask}
									/>
								))}
								{podCount === 0 && (
									<p className="text-xs text-muted-foreground">No swarm or Rivet pods on this node.</p>
								)}
							</CardContent>
						</Card>
					);
				})}
			</div>

			{orphans.length > 0 && (
				<Card>
					<CardHeader>
						<CardTitle className="text-sm">
							{sources.kube.ok ? "Actors on pods Kubernetes doesn't list" : "Actors by pod"}
						</CardTitle>
					</CardHeader>
					<CardContent className="space-y-4">
						{orphans.map(([pod, group]) => (
							<div key={pod || "unknown"}>
								<div className="mb-2 flex text-xs">
									<span className="font-mono">
										{pod || "pod not reported (not read yet, older build, or unreachable)"}
									</span>
									<span className="ml-auto text-muted-foreground tabular-nums">{group.length} actors</span>
								</div>
								<WorkerGrid workers={group} now={now} onTask={onTask} size="sm" />
							</div>
						))}
					</CardContent>
				</Card>
			)}

			<Card className="pb-0">
				<CardHeader className="flex flex-row items-center">
					<CardTitle className="text-sm">Rivet nodes · namespace agent-swarm, pool default</CardTitle>
					<span className="ml-auto text-xs text-muted-foreground">pool actor on {pool?.pod ?? "?"}</span>
				</CardHeader>
				<Table>
					<TableHeader>
						<TableRow className="hover:bg-transparent">
							<TableHead className="pl-6">Node key</TableHead>
							<TableHead>Version</TableHead>
							<TableHead>State</TableHead>
							<TableHead className="text-right">Connected for</TableHead>
							<TableHead className="pr-6 text-right">Last ping</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{rivetNodes.map((node) => (
							<TableRow key={node.key}>
								<TableCell className="pl-6 font-mono text-xs">{node.key}</TableCell>
								<TableCell className="tabular-nums">v{node.version}</TableCell>
								<TableCell>
									<span className="inline-flex items-center gap-1.5 text-xs">
										<Dot
											className={node.stopping ? "bg-amber-400" : node.connected ? "bg-emerald-500" : "bg-red-500"}
										/>
										{node.stopping ? "Draining" : node.connected ? "Connected" : "Disconnected"}
									</span>
								</TableCell>
								<TableCell className="text-right text-xs text-muted-foreground">{ago(node.createdAt, now)}</TableCell>
								<TableCell className="pr-6 text-right text-xs text-muted-foreground">
									{ago(node.lastPingAt, now)} ago
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			</Card>
		</div>
	);
}
