import Link from "next/link";
import type { TaskState, WorkerPhase } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Geist-ish status colors: blue for in progress, amber for waiting on a person, green done, red failed. */
export const TASK_COLORS: Record<TaskState, string> = {
	ready: "bg-sky-400",
	waiting: "bg-neutral-500",
	claimed: "bg-blue-500",
	blocked: "bg-amber-400",
	completed: "bg-emerald-500",
	failed: "bg-red-500",
	canceled: "bg-neutral-600",
};

export const PHASE_COLORS: Record<WorkerPhase, string> = {
	working: "bg-blue-500",
	asking: "bg-amber-400",
	claiming: "bg-neutral-700",
	backoff: "bg-orange-500",
	unreachable: "bg-red-500",
	unread: "bg-neutral-900 outline outline-1 -outline-offset-1 outline-dashed outline-neutral-600",
};

export const PHASE_LABELS: Record<WorkerPhase, string> = {
	working: "Working",
	asking: "Asking",
	claiming: "Idle · claiming",
	backoff: "Backing off",
	unreachable: "Unreachable",
	unread: "Not read yet",
};

export function Dot({ className }: { className?: string }) {
	return <span className={cn("inline-block size-2 shrink-0 rounded-full", className)} />;
}

export function TaskStateBadge({ state }: { state: TaskState }) {
	return (
		<span className="inline-flex items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-xs text-foreground/90 capitalize">
			<Dot className={TASK_COLORS[state]} />
			{state}
		</span>
	);
}

export function PhaseBadge({ phase }: { phase: WorkerPhase }) {
	return (
		<span className="inline-flex items-center gap-1.5 text-xs whitespace-nowrap text-foreground/90">
			<Dot className={cn(PHASE_COLORS[phase], phase === "working" && "animate-pulse")} />
			{PHASE_LABELS[phase]}
		</span>
	);
}

/** A thin usage bar: `value` against `limit`, with `request` marked when given. */
export function Meter({
	value,
	request,
	className,
}: {
	value: number | null;
	request?: number | null;
	className?: string;
}) {
	const tone =
		value === null ? "bg-neutral-700" : value > 85 ? "bg-red-500" : value > 65 ? "bg-amber-400" : "bg-foreground/80";
	return (
		<div className={cn("relative h-1.5 w-full overflow-hidden rounded-full bg-neutral-800", className)}>
			<div className={cn("h-full rounded-full transition-all", tone)} style={{ width: `${value ?? 0}%` }} />
			{request !== undefined && request !== null && (
				<div className="absolute top-0 h-full w-px bg-sky-400" style={{ left: `${request}%` }} />
			)}
		</div>
	);
}

/** A worker's name, linking to its page. Stops the click so a row's own click doesn't fire too. */
export function WorkerLink({ name, href = name, className }: { name: string; href?: string; className?: string }) {
	return (
		<Link
			href={`/workers/${encodeURIComponent(href)}`}
			onClick={(event) => event.stopPropagation()}
			className={cn("hover:underline", className)}
		>
			{name}
		</Link>
	);
}
