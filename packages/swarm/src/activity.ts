import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import { type ConversationId, type EntryRecord, type Harness, UsageDoc } from "@earendil-works/pi-durable";

/** Newest entries returned, plus the brief. A long run shows its tail; `more` says entries were left out. */
const ENTRIES = 40;
/** Per-field caps, and a budget for the whole reply, so one `activity` call stays small. */
const CAP = { text: 2_000, thinking: 1_500, args: 800, result: 800 };
const BUDGET = 60_000;

const ctx = BACKGROUND_CONTEXT;

export type ActivityEntry =
	| { id: string; kind: "user"; text: string }
	| {
			id: string;
			kind: "assistant";
			text: string;
			thinking: string;
			toolCalls: { id: string; name: string; args: string }[];
			stopReason: string;
			error: string | null;
			tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
	  }
	| {
			id: string;
			kind: "tool";
			name: string;
			toolCallId: string;
			text: string;
			isError: boolean;
			durationMs: number | null;
	  }
	| { id: string; kind: "other"; entryKind: string };

export type ConversationActivity = {
	conversationId: number;
	entries: ActivityEntry[];
	/** Entries between the brief and the first one returned that were left out. */
	more: boolean;
	tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
};

function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}…[${text.length - max} more]` : text;
}

function textOf(content: string | readonly { type: string; text?: string }[]): string {
	if (typeof content === "string") return content;
	return content.map((block) => (block.type === "text" ? (block.text ?? "") : `[${block.type}]`)).join("");
}

function toEntry(record: EntryRecord): ActivityEntry {
	const id = String(record.id);
	const message = record.model?.[0] as Message | undefined;
	if (!message) return { id, kind: "other", entryKind: record.kind };
	switch (message.role) {
		case "user":
			return { id, kind: "user", text: clip(textOf(message.content), CAP.text) };
		case "assistant": {
			let text = "";
			let thinking = "";
			const toolCalls: { id: string; name: string; args: string }[] = [];
			for (const block of message.content) {
				if (block.type === "text") text += block.text;
				else if (block.type === "thinking") thinking += block.redacted ? "[redacted]" : block.thinking;
				else toolCalls.push({ id: block.id, name: block.name, args: clip(JSON.stringify(block.arguments), CAP.args) });
			}
			const usage = message.usage;
			return {
				id,
				kind: "assistant",
				text: clip(text, CAP.text),
				thinking: clip(thinking, CAP.thinking),
				toolCalls,
				stopReason: message.stopReason,
				error: message.errorMessage ?? null,
				tokens: {
					input: usage.input,
					output: usage.output,
					cacheRead: usage.cacheRead,
					cacheWrite: usage.cacheWrite,
					total: usage.totalTokens,
				},
			};
		}
		case "toolResult":
			return {
				id,
				kind: "tool",
				name: message.toolName,
				toolCallId: message.toolCallId,
				text: clip(textOf(message.content), CAP.result),
				isError: message.isError,
				durationMs: message.durationMs ?? null,
			};
		default:
			return { id, kind: "other", entryKind: record.kind };
	}
}

/** One conversation's brief and newest entries, capped, and its token use so far. Reads only; starts nothing. */
export async function readActivity(harness: Harness, conversationId: number): Promise<ConversationActivity | null> {
	const id = conversationId as unknown as ConversationId;
	const conversation = await harness.conversation(id, ctx);
	if (!conversation) return null;
	const [first, newest, usage] = await Promise.all([
		conversation.entries({ order: "ascending" }, 1, undefined, ctx),
		conversation.entries({ order: "descending" }, ENTRIES, undefined, ctx),
		harness.snapshot(UsageDoc, id, ctx),
	]);
	const brief = first.items[0];
	const tail = [...newest.items].reverse().filter((record) => record.id !== brief?.id);

	// Keep the newest entries that fit the budget; the brief always goes first.
	const entries: ActivityEntry[] = [];
	let size = 0;
	for (let i = tail.length - 1; i >= 0; i--) {
		const entry = toEntry(tail[i]);
		size += JSON.stringify(entry).length;
		if (size > BUDGET) break;
		entries.unshift(entry);
	}
	const more = Boolean(newest.next) || entries.length < tail.length;
	if (brief) entries.unshift(toEntry(brief));

	const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
	for (const model of Object.values(usage?.models ?? {})) {
		tokens.input += model.input ?? 0;
		tokens.output += model.output ?? 0;
		tokens.cacheRead += model.cacheRead ?? 0;
		tokens.cacheWrite += model.cacheWrite ?? 0;
		tokens.total += model.totalTokens ?? 0;
	}
	return { conversationId, entries, more, tokens };
}
