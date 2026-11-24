import { setup } from "rivetkit";
import { createClient } from "rivetkit/client";
import { pool } from "./pool.js";
import { worker } from "./worker.js";

export const registry = setup({ use: { worker, pool } });

registry.start();

// Wake the pool, which wakes every worker. Every pod does this on boot; it's idempotent.
const client = createClient<typeof registry>();
for (let attempt = 1; ; attempt++) {
	try {
		await client.pool.getOrCreate(["main"]).ensure();
		console.log("[swarm] pool is running");
		break;
	} catch (error) {
		if (attempt >= 30) throw error;
		await new Promise((resolve) => setTimeout(resolve, 2_000));
	}
}
