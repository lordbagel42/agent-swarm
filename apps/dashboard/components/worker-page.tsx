"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Dot, PhaseBadge, TaskStateBadge } from "@/components/bits";
import { useNow } from "@/components/dashboard";
import { ThreadSheet } from "@/components/thread-sheet";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ago, compact, firstLine } from "@/lib/format";
import type { ActivityEntry, Outcome, Tokens, WorkerDetail } from "@/lib/types";
import { cn } from "@/lib/utils";

/** The page polls this often; the server reads the worker's activity at most every 3s however many pages are open. */
const POLL_MS = 4_000;

const OUTCOME_COLORS: Record<Outcome["outcome"], string> = {
	completed: "bg-emerald-500",
	blocked: "bg-amber-400",
	failed: "bg-red-500",
	lost: "bg-orange-500",
};

function useWorker(name: string, task: string | null) {
	const [detail, setDetail] = useState<WorkerDetail | null>(null);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		let stopped = false;
		let timer: ReturnType<typeof setTimeout>;
		const poll = async () => {
			try {
				const query = task ? `?task=${encodeURIComponent(task)}` : "";
				const response = await fetch(`/api/workers/${encodeURIComponent(name)}${query}`, { cache: "no-store" });
				if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
				const next = (await response.json()) as WorkerDetail;
				if (!stopped) {
					setDetail(next);
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
	}, [name, task]);
	return { detail, error };
}

export function WorkerPage({ name: asked }: { name: string }) {
	const now = useNow();
	// The task whose conversation is shown: `?task=` when picked from the history, else the current or latest.
	const [task, setTask] = useState<string | null>(null);
	const [threadId, setThreadId] = useState<string | null>(null);
	useEffect(() => setTask(new URLSearchParams(window.location.search).get("task")), []);
	const pick = (id: string | null) => {
		setTask(id);
		const url = new URL(window.location.href);
		if (id) url.searchParams.set("task", id);
		else url.searchParams.delete("task");
		window.history.replaceState(null, "", url);
	};
	const { detail, error } = useWorker(asked, task);
	const worker = detail?.worker ?? null;
	// Board profiles are lowercase: /workers/ada shows Ada.
	const name = worker?.name ?? asked;
	const activity = detail?.activity ?? null;
	const taskText = new Map(detail?.tasks.map((row) => [row.id, row.text]));
	const shown = activity?.taskId ?? null;

	return (
		<div className="min-h-screen">
			<header className="sticky top-0 z-20 border-b border-border bg-background/80 backdrop-blur">
				<div className="mx-auto flex h-14 max-w-[1400px] items-center gap-3 px-6 text-sm">
					<svg aria-hidden viewBox="0 0 76 65" className="size-4 fill-foreground">
						<path d="M37.59.25l36.95 64H.64l36.95-64z" />
					</svg>
					<span className="text-muted-foreground">/</span>
					<span className="font-medium">raygen</span>
					<span className="text-muted-foreground">/</span>
					<Link href="/" className="font-medium hover:underline">
						agent-swarm
					</Link>
					<span className="text-muted-foreground">/</span>
					<span className="text-muted-foreground">workers</span>
					<span className="text-muted-foreground">/</span>
					<span className="font-mono font-medium">{name}</span>
					<span className="ml-2 inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-400">
						<Dot className={error ? "bg-red-500" : "animate-pulse bg-emerald-500"} />
						{error ? "Disconnected" : detail ? "Live" : "Connecting"}
					</span>
				</div>
			</header>

			<main className="mx-auto max-w-[1400px] space-y-6 px-6 py-8">
				{error && (
					<div className="rounded-lg border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-300">{error}</div>
				)}
				{!detail && !error && <div className="text-sm text-muted-foreground">Reading {name}…</div>}
				{detail && !worker && (
					<div className="rounded-lg border border-amber-400/30 bg-amber-400/5 p-4 text-sm text-amber-200">
						Rivet has no worker actor named {name}.
					</div>
				)}

				{worker && (
					<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
						<Stat label="State">
							<PhaseBadge phase={worker.phase} />
							{!worker.permanent && <span className="ml-2 text-xs text-sky-400">extra</span>}
						</Stat>
						<Stat label={worker.taskId ? "Working for" : "Idle for"}>
							<span className="tabular-nums">{ago(worker.taskId ? worker.claimedAt : worker.idleSince, now)}</span>
						</Stat>
						<Stat label="Host · node">
							<span className="font-mono text-xs">
								{worker.pod ?? "—"}
								{worker.node ? ` · ${worker.node}` : ""}
							</span>
						</Stat>
						<Stat label="Done / failed / blocked">
							<span className="tabular-nums">
								<span className="text-emerald-400">{worker.completed}</span>
								<span className="text-muted-foreground"> / </span>
								<span className={worker.failed ? "text-red-400" : "text-muted-foreground"}>{worker.failed}</span>
								<span className="text-muted-foreground"> / </span>
								<span className={worker.blocked ? "text-amber-400" : "text-muted-foreground"}>{worker.blocked}</span>
							</span>
						</Stat>
						<Stat label="Tokens, all tasks">
							<span className="tabular-nums">{compact(worker.tokens)}</span>
						</Stat>
						<div className="sm:col-span-2 lg:col-span-5">
							<Card className="gap-2 py-4">
								<CardContent className="space-y-1 px-4 text-sm">
									<div className="text-xs text-muted-foreground">Current task</div>
									{worker.taskId ? (
										<button
											type="button"
											className="text-left hover:underline"
											onClick={() => setThreadId(worker.taskId)}
										>
											{firstLine(taskText.get(worker.taskId) ?? worker.taskId, 200)}
										</button>
									) : (
										<span className="text-muted-foreground">None · holding a claim open on the board</span>
									)}
									{worker.asked && <div className="text-xs text-amber-400">Asked: {worker.asked}</div>}
									{worker.error && (
										<div className="text-xs text-orange-400">
											{worker.error.message} · {ago(worker.error.at, now)} ago
										</div>
									)}
								</CardContent>
							</Card>
						</div>
					</div>
				)}

				{detail && (
					<div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
						<Card className="gap-0 pb-0">
							<CardHeader className="flex flex-row flex-wrap items-center gap-2 border-b border-border pb-4">
								<CardTitle className="text-sm">Conversation</CardTitle>
								{activity?.live && (
									<span className="inline-flex items-center gap-1.5 rounded-full bg-blue-500/10 px-2 py-0.5 text-xs text-blue-300">
										<Dot className="animate-pulse bg-blue-500" />
										live
									</span>
								)}
								{shown && (
									<button
										type="button"
										onClick={() => setThreadId(shown)}
										className="min-w-0 truncate text-left text-xs text-muted-foreground hover:underline"
									>
										{firstLine(taskText.get(shown) ?? shown, 90)}
									</button>
								)}
								{activity?.conversation && <TokenLine tokens={activity.conversation.tokens} className="ml-auto" />}
							</CardHeader>
							<CardContent className="space-y-4 p-4">
								{detail.activityError && (
									<p className="text-sm text-amber-300">
										Couldn't read {name}'s activity: {detail.activityError}. Workers built before the activity action
										can't show it.
									</p>
								)}
								{activity && !activity.conversation && (
									<p className="text-sm text-muted-foreground">
										{activity.taskId
											? "No conversation recorded for this task."
											: `${name} hasn't worked on a task since it started keeping history.`}
									</p>
								)}
								{activity?.conversation && (
									<Conversation entries={activity.conversation.entries} more={activity.conversation.more} />
								)}
							</CardContent>
						</Card>

						<Card className="gap-0 self-start pb-2">
							<CardHeader className="border-b border-border pb-4">
								<CardTitle className="text-sm">History</CardTitle>
							</CardHeader>
							<CardContent className="space-y-1 p-2">
								{worker?.taskId && (
									<HistoryRow
										selected={shown === worker.taskId}
										onClick={() => pick(null)}
										dot="animate-pulse bg-blue-500"
										label="working"
										text={taskText.get(worker.taskId) ?? worker.taskId}
										when={`for ${ago(worker.claimedAt, now)}`}
									/>
								)}
								{activity?.history.map((outcome) => (
									<HistoryRow
										key={`${outcome.taskId}-${outcome.at}`}
										selected={shown === outcome.taskId && !activity.live}
										onClick={() => pick(outcome.taskId)}
										dot={OUTCOME_COLORS[outcome.outcome]}
										label={outcome.outcome}
										text={taskText.get(outcome.taskId) ?? outcome.taskId}
										when={`${ago(outcome.at, now)} ago · ${compact(outcome.tokens)} tokens`}
									/>
								))}
								{activity && activity.history.length === 0 && !worker?.taskId && (
									<p className="px-2 py-2 text-sm text-muted-foreground">No settled tasks yet.</p>
								)}
								{detail.tasks.length > 0 && (
									<div className="border-t border-border px-2 pt-3 pb-1">
										<div className="mb-2 text-xs text-muted-foreground">On the board</div>
										{detail.tasks.slice(0, 10).map((row) => (
											<button
												key={row.id}
												type="button"
												onClick={() => setThreadId(row.id)}
												className="flex w-full items-center gap-2 rounded-md py-1.5 text-left hover:bg-muted/50"
											>
												<TaskStateBadge state={row.state} />
												<span className="min-w-0 flex-1 truncate text-xs">{firstLine(row.text)}</span>
											</button>
										))}
									</div>
								)}
							</CardContent>
						</Card>
					</div>
				)}
			</main>
			<ThreadSheet taskId={threadId} onClose={() => setThreadId(null)} now={now} snapshot={null} />
		</div>
	);
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<Card className="gap-2 py-4">
			<CardContent className="space-y-1 px-4">
				<div className="text-xs text-muted-foreground">{label}</div>
				<div className="text-sm">{children}</div>
			</CardContent>
		</Card>
	);
}

function HistoryRow({
	selected,
	onClick,
	dot,
	label,
	text,
	when,
}: {
	selected: boolean;
	onClick: () => void;
	dot: string;
	label: string;
	text: string;
	when: string;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={cn(
				"flex w-full flex-col gap-1 rounded-md px-2 py-2 text-left hover:bg-muted/50",
				selected && "bg-muted/70",
			)}
		>
			<span className="flex items-center gap-1.5 text-xs">
				<Dot className={dot} />
				<span className="capitalize">{label}</span>
				<span className="ml-auto text-muted-foreground tabular-nums">{when}</span>
			</span>
			<span className="line-clamp-2 text-sm">{firstLine(text, 200)}</span>
		</button>
	);
}

function TokenLine({ tokens, className }: { tokens: Tokens; className?: string }) {
	return (
		<span className={cn("text-xs text-muted-foreground tabular-nums", className)}>
			{compact(tokens.total)} tokens · {compact(tokens.input)} in · {compact(tokens.output)} out ·{" "}
			{compact(tokens.cacheRead)} cached
		</span>
	);
}

function Conversation({ entries: all, more }: { entries: ActivityEntry[]; more: boolean }) {
	// Pi's own bookkeeping entries, such as pi.system, say nothing about the task.
	const entries = all.filter((entry) => entry.kind !== "other");
	return (
		<div className="space-y-4">
			{entries.map((entry, index) => (
				<div key={entry.id}>
					{more && index === 1 && (
						<div className="mb-4 text-center text-xs text-muted-foreground">Earlier entries left out</div>
					)}
					<Entry entry={entry} brief={index === 0} />
				</div>
			))}
		</div>
	);
}

function Entry({ entry, brief }: { entry: ActivityEntry; brief: boolean }) {
	switch (entry.kind) {
		case "user":
			return (
				<Bubble who={brief ? "Brief" : "User"} tone="neutral">
					<Text>{entry.text}</Text>
				</Bubble>
			);
		case "assistant":
			return (
				<Bubble
					who="Assistant"
					tone="blue"
					aside={
						<span className="text-muted-foreground tabular-nums">
							{compact(entry.tokens.input + entry.tokens.cacheRead)} in · {compact(entry.tokens.output)} out
							{entry.stopReason !== "toolUse" && entry.stopReason !== "stop" && ` · ${entry.stopReason}`}
						</span>
					}
				>
					{entry.thinking && (
						<details className="group rounded-md border border-border bg-background/40 px-3 py-2">
							<summary className="cursor-pointer text-xs text-muted-foreground select-none">Thinking</summary>
							<Text className="mt-2 text-xs text-muted-foreground">{entry.thinking}</Text>
						</details>
					)}
					{entry.text && <Text>{entry.text}</Text>}
					{entry.toolCalls.map((call) => (
						<div key={call.id} className="rounded-md border border-border bg-background/40 px-3 py-2">
							<div className="font-mono text-xs text-sky-300">{call.name}</div>
							<pre className="mt-1 font-mono text-xs break-all whitespace-pre-wrap text-foreground/80">{call.args}</pre>
						</div>
					))}
					{entry.error && <Text className="text-red-400">{entry.error}</Text>}
				</Bubble>
			);
		case "tool":
			return (
				<div className="ml-9 rounded-md border border-border bg-neutral-900/60 px-3 py-2">
					<div className="flex items-center gap-2 text-xs">
						<Dot className={entry.isError ? "bg-red-500" : "bg-emerald-500"} />
						<span className="font-mono text-foreground/90">{entry.name}</span>
						<span className="text-muted-foreground">result</span>
						{entry.durationMs !== null && (
							<span className="ml-auto text-muted-foreground tabular-nums">
								{(entry.durationMs / 1000).toFixed(1)}s
							</span>
						)}
					</div>
					<pre
						className={cn(
							"mt-1 max-h-60 overflow-auto font-mono text-xs break-all whitespace-pre-wrap",
							entry.isError ? "text-red-300" : "text-muted-foreground",
						)}
					>
						{entry.text || "(empty)"}
					</pre>
				</div>
			);
		default:
			return null;
	}
}

function Bubble({
	who,
	tone,
	aside,
	children,
}: {
	who: string;
	tone: "neutral" | "blue";
	aside?: React.ReactNode;
	children: React.ReactNode;
}) {
	return (
		<div className="flex gap-3">
			<div
				className={cn(
					"mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full text-[10px] font-medium",
					tone === "blue" ? "bg-blue-500/20 text-blue-300" : "bg-neutral-800 text-neutral-300",
				)}
			>
				{who.slice(0, 2)}
			</div>
			<div className="min-w-0 flex-1 space-y-2">
				<div className="flex items-baseline gap-2 text-xs">
					<span className="font-medium">{who}</span>
					<span className="ml-auto">{aside}</span>
				</div>
				{children}
			</div>
		</div>
	);
}

function Text({ children, className }: { children: string; className?: string }) {
	return <p className={cn("text-sm break-words whitespace-pre-wrap text-foreground/90", className)}>{children}</p>;
}
