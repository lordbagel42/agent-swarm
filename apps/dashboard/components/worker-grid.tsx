import Link from "next/link";
import { PHASE_COLORS, PHASE_LABELS } from "@/components/bits";
import { ago } from "@/lib/format";
import type { WorkerRow } from "@/lib/types";
import { cn } from "@/lib/utils";

/** One square per worker, colored by what it's doing. Each square opens the worker's page. */
export function WorkerGrid({ workers, now, size = "md" }: { workers: WorkerRow[]; now: number; size?: "sm" | "md" }) {
	return (
		<div className="flex flex-wrap gap-1">
			{workers.map((worker) => {
				const detail = worker.taskId
					? `${worker.name} · ${PHASE_LABELS[worker.phase]} on ${worker.taskId} for ${ago(worker.claimedAt, now)}`
					: `${worker.name} · ${PHASE_LABELS[worker.phase]}${worker.idleSince ? ` for ${ago(worker.idleSince, now)}` : ""}`;
				return (
					<Link
						key={worker.name}
						href={`/workers/${encodeURIComponent(worker.name)}`}
						aria-label={worker.name}
						title={`${detail}\n${worker.pod ?? "pod unknown"}${worker.node ? ` · ${worker.node}` : ""}\n${worker.completed} completed · ${worker.failed} failed · ${worker.blocked} blocked`}
						className={cn(
							"block rounded-[3px] transition-transform hover:scale-125",
							size === "sm" ? "size-2.5" : "size-3.5",
							PHASE_COLORS[worker.phase],
							!worker.permanent && "ring-1 ring-sky-400/70 ring-offset-1 ring-offset-card",
						)}
					/>
				);
			})}
		</div>
	);
}
