"use client";

import { useEffect, useState } from "react";
import { TaskStateBadge } from "@/components/bits";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ago } from "@/lib/format";
import type { Snapshot, ThreadDetail } from "@/lib/types";
import { cn } from "@/lib/utils";

/** One task's thread, refreshed while open. */
export function ThreadSheet({
	taskId,
	onClose,
	now,
	snapshot,
}: {
	taskId: string | null;
	onClose: () => void;
	now: number;
	snapshot: Snapshot | null;
}) {
	const [thread, setThread] = useState<ThreadDetail | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		setThread(null);
		setError(null);
		if (!taskId) return;
		let stopped = false;
		let timer: ReturnType<typeof setTimeout>;
		const load = async () => {
			try {
				const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}`, { cache: "no-store" });
				const body = await response.json();
				if (!response.ok) throw new Error(body.error ?? response.statusText);
				if (!stopped) setThread(body as ThreadDetail);
			} catch (cause) {
				if (!stopped) setError(cause instanceof Error ? cause.message : String(cause));
			}
			if (!stopped) timer = setTimeout(load, 5_000);
		};
		void load();
		return () => {
			stopped = true;
			clearTimeout(timer);
		};
	}, [taskId]);

	const task = thread?.task;
	const worker = task?.claim ? snapshot?.workers.find((row) => row.name === task.claim?.worker) : undefined;

	return (
		<Sheet open={taskId !== null} onOpenChange={(open) => !open && onClose()}>
			<SheetContent className="w-full gap-0 sm:max-w-xl">
				<SheetHeader className="border-b border-border">
					<div className="flex items-center gap-2 pr-8">
						{task && <TaskStateBadge state={task.state} />}
						<span className="truncate font-mono text-xs text-muted-foreground">{taskId}</span>
					</div>
					<SheetTitle className="line-clamp-3 text-base leading-snug">
						{task?.text.split("\n")[0] ?? "Loading…"}
					</SheetTitle>
					<SheetDescription className="text-xs">
						{task
							? [
									`from ${task.author}`,
									`created ${ago(task.createdAt, now)} ago`,
									task.claim
										? `held by ${task.claim.worker} until ${new Date(task.claim.until).toLocaleTimeString()}`
										: null,
									worker?.pod ? `on ${worker.pod}${worker.node ? ` · ${worker.node}` : ""}` : null,
								]
									.filter(Boolean)
									.join(" · ")
							: error}
					</SheetDescription>
				</SheetHeader>
				<ScrollArea className="min-h-0 flex-1">
					<div className="space-y-4 p-4">
						{task?.blocked && (
							<Box
								tone="amber"
								title={`Blocked${task.blocked.kind ? ` · ${task.blocked.kind}` : ""}`}
								text={task.blocked.reason}
							/>
						)}
						{task?.result && <Box tone="green" title="Result" text={task.result} />}
						{task?.reason && (
							<Box tone="red" title={task.state === "canceled" ? "Canceled" : "Failed"} text={task.reason} />
						)}
						{thread?.messages.map((message, index) => (
							<div key={message.id} className="flex gap-3">
								<div
									className={cn(
										"mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full text-[10px] font-medium",
										message.kind === "agent" ? "bg-blue-500/20 text-blue-300" : "bg-neutral-800 text-neutral-300",
									)}
								>
									{message.author.slice(0, 3)}
								</div>
								<div className="min-w-0 flex-1">
									<div className="flex items-baseline gap-2 text-xs">
										<span className="font-medium">{message.author}</span>
										<span className="text-muted-foreground">{ago(message.createdAt, now)} ago</span>
										{index === 0 && <span className="text-muted-foreground">· brief</span>}
									</div>
									<p className="mt-1 text-sm break-words whitespace-pre-wrap text-foreground/90">{message.text}</p>
								</div>
							</div>
						))}
						{error && !thread && <p className="text-sm text-red-400">{error}</p>}
					</div>
				</ScrollArea>
			</SheetContent>
		</Sheet>
	);
}

function Box({ tone, title, text }: { tone: "green" | "amber" | "red"; title: string; text: string }) {
	const tones = {
		green: "border-emerald-500/30 bg-emerald-500/5 text-emerald-300",
		amber: "border-amber-400/30 bg-amber-400/5 text-amber-200",
		red: "border-red-500/30 bg-red-500/5 text-red-300",
	};
	return (
		<div className={cn("rounded-lg border p-3", tones[tone])}>
			<div className="mb-1 text-xs font-medium">{title}</div>
			<p className="text-sm break-words whitespace-pre-wrap text-foreground/90">{text}</p>
		</div>
	);
}
