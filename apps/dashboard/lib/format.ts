/** `3s`, `4m`, `2h`, `5d`: how long ago, or how long, in the largest unit that fits. */
export function ago(from: number | string | null | undefined, now: number): string {
	if (from === null || from === undefined) return "—";
	const ms = now - (typeof from === "string" ? Date.parse(from) : from);
	return span(Math.max(0, ms));
}

export function span(ms: number): string {
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	if (h < 48) return `${h}h ${m % 60}m`;
	return `${Math.floor(h / 24)}d`;
}

export function compact(value: number): string {
	return Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

export function bytes(value: number | null): string {
	if (value === null) return "—";
	if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GiB`;
	return `${Math.round(value / 1024 ** 2)} MiB`;
}

export function cores(value: number | null): string {
	if (value === null) return "—";
	return value >= 1 ? `${value.toFixed(2)} cores` : `${Math.round(value * 1000)}m`;
}

export function percent(part: number | null, whole: number | null): number | null {
	if (part === null || !whole) return null;
	return Math.min(100, (part / whole) * 100);
}

/** The first line of a task, for one-line lists. */
export function firstLine(text: string, max = 140): string {
	const line = text.split("\n").find((part) => part.trim()) ?? "";
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
