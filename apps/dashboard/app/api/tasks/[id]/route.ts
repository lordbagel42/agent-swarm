import { readThread } from "@/lib/board";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	try {
		const thread = await readThread(id);
		if (!thread) return Response.json({ error: "not a task" }, { status: 404 });
		return Response.json(thread, { headers: { "cache-control": "no-store" } });
	} catch (error) {
		return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 502 });
	}
}
