"use client";

import { useEffect, useState } from "react";
import { Dot } from "@/components/bits";
import { BoardView } from "@/components/board-view";
import { ClusterView } from "@/components/cluster-view";
import { OverviewView } from "@/components/overview-view";
import { ThreadSheet } from "@/components/thread-sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { WorkersView } from "@/components/workers-view";
import { ago } from "@/lib/format";
import type { Snapshot, Source } from "@/lib/types";

const POLL_MS = 3_000;

function useSnapshot() {
	const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		let stopped = false;
		let timer: ReturnType<typeof setTimeout>;
		const poll = async () => {
			try {
				const response = await fetch("/api/snapshot", { cache: "no-store" });
				if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
				const next = (await response.json()) as Snapshot;
				if (!stopped) {
					setSnapshot(next);
					setError(null);
				}
			} catch (cause) {
				if (!stopped) setError(cause instanceof Error ? cause.message : String(cause));
			}
			if (!stopped) timer = setTimeout(poll, POLL_MS);
		};
		void poll();
		return () => {
			stopped = true;
			clearTimeout(timer);
		};
	}, []);
	return { snapshot, error };
}

/** Ticks once a second so "3s ago" stays true between polls. */
export function useNow() {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 1_000);
		return () => clearInterval(timer);
	}, []);
	return now;
}

const SOURCE_NAMES: Record<keyof Snapshot["sources"], string> = {
	board: "Vercel Board",
	rivet: "Rivet",
	workers: "Worker status",
	kube: "Kubernetes",
};

function SourcePill({ name, source, now }: { name: string; source: Source; now: number }) {
	const stale = source.at !== null && now - source.at > 60_000;
	const color = source.ok && !stale ? "bg-emerald-500" : source.at ? "bg-amber-400" : "bg-red-500";
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<span className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground">
					<Dot className={color} />
					{name}
				</span>
			</TooltipTrigger>
			<TooltipContent>
				{source.error
					? `${source.error}${source.at ? ` · last good ${ago(source.at, now)} ago` : ""}`
					: `Read ${ago(source.at, now)} ago`}
			</TooltipContent>
		</Tooltip>
	);
}

export function Dashboard() {
	const { snapshot, error } = useSnapshot();
	const now = useNow();
	const [taskId, setTaskId] = useState<string | null>(null);
	const [tab, setTab] = useState("overview");

	return (
		<div className="min-h-screen">
			<header className="sticky top-0 z-20 border-b border-border bg-background/80 backdrop-blur">
				<div className="mx-auto flex h-14 max-w-[1400px] items-center gap-3 px-6">
					<svg aria-hidden viewBox="0 0 76 65" className="size-4 fill-foreground">
						<path d="M37.59.25l36.95 64H.64l36.95-64z" />
					</svg>
					<span className="text-muted-foreground">/</span>
					<span className="text-sm font-medium">raygen</span>
					<span className="text-muted-foreground">/</span>
					<span className="text-sm font-medium">agent-swarm</span>
					<span className="ml-2 inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-400">
						<Dot className={error ? "bg-red-500" : "animate-pulse bg-emerald-500"} />
						{error ? "Disconnected" : snapshot ? `Live · ${ago(snapshot.at, now)}` : "Connecting"}
					</span>
					<div className="ml-auto hidden items-center gap-2 md:flex">
						{snapshot &&
							(Object.keys(SOURCE_NAMES) as (keyof Snapshot["sources"])[])
								.filter((key) => key !== "kube" || snapshot.kubernetes)
								.map((key) => (
									<SourcePill key={key} name={SOURCE_NAMES[key]} source={snapshot.sources[key]} now={now} />
								))}
					</div>
				</div>
				<div className="mx-auto max-w-[1400px] px-6">
					<Tabs value={tab} onValueChange={setTab}>
						<TabsList variant="line" className="h-10 gap-4 p-0">
							<TabsTrigger value="overview">Overview</TabsTrigger>
							<TabsTrigger value="board">
								Board
								{snapshot && (
									<span className="text-xs text-muted-foreground tabular-nums">{snapshot.tasks.length}</span>
								)}
							</TabsTrigger>
							<TabsTrigger value="workers">
								Workers
								{snapshot && (
									<span className="text-xs text-muted-foreground tabular-nums">{snapshot.workers.length}</span>
								)}
							</TabsTrigger>
							<TabsTrigger value="cluster">
								{/* Without Kubernetes, the tab shows Rivet's nodes and the actors on each. */}
								{snapshot && !snapshot.kubernetes ? "Nodes" : "Cluster"}
								{snapshot && (
									<span className="text-xs text-muted-foreground tabular-nums">
										{snapshot.kubernetes ? snapshot.cluster.nodes.length : snapshot.rivetNodes.length}
									</span>
								)}
							</TabsTrigger>
						</TabsList>
					</Tabs>
				</div>
			</header>

			<main className="mx-auto max-w-[1400px] px-6 py-8">
				{error && !snapshot && (
					<div className="rounded-lg border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-300">{error}</div>
				)}
				{!snapshot && !error && <div className="text-sm text-muted-foreground">Reading the board and Rivet…</div>}
				{snapshot && (
					<Tabs value={tab} onValueChange={setTab}>
						<TabsContent value="overview">
							<OverviewView snapshot={snapshot} now={now} onTask={setTaskId} onTab={setTab} />
						</TabsContent>
						<TabsContent value="board">
							<BoardView snapshot={snapshot} now={now} onTask={setTaskId} />
						</TabsContent>
						<TabsContent value="workers">
							<WorkersView snapshot={snapshot} now={now} onTask={setTaskId} />
						</TabsContent>
						<TabsContent value="cluster">
							<ClusterView snapshot={snapshot} now={now} />
						</TabsContent>
					</Tabs>
				)}
			</main>
			<ThreadSheet taskId={taskId} onClose={() => setTaskId(null)} now={now} snapshot={snapshot} />
		</div>
	);
}
