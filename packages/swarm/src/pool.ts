import { hostname } from "node:os";
import { actor, type Registry } from "rivetkit";
import { boardAsSelf } from "./board.js";
import { config, sleep, workerName } from "./config.js";
import type { worker } from "./worker.js";

const START_BATCH = 25;

/**
 * Keeps the permanent workers running, and spawns extra workers while tasks sit ready. Every idle worker holds a
 * claim open on the board, so a task that stays ready across two checks means every worker is busy.
 */
export const pool = actor({
	state: { extras: [] as number[], backlogSeen: false, lastReady: 0 },
	options: { noSleep: true },
	actions: {
		/** Wakes the pool. The server calls it on boot. */
		ensure: () => true,
		/** Called by a spawned worker as it retires. */
		retired: (c, index: number) => {
			c.state.extras = c.state.extras.filter((extra) => extra !== index);
		},
		/** Read-only: the pool's size, for the dashboard. */
		status: (c) => ({
			permanent: config.idleWorkers,
			extras: c.state.extras.length,
			extraIndexes: c.state.extras,
			max: config.maxWorkers,
			ready: c.state.lastReady,
			backlogSeen: c.state.backlogSeen,
			pod: hostname(),
		}),
	},
	run: async (c) => {
		const signal = c.abortSignal;
		const client = c.client<Registry<{ worker: typeof worker }>>();
		const start = async (indexes: number[]) => {
			for (let i = 0; i < indexes.length && !signal.aborted; i += START_BATCH) {
				await Promise.all(
					indexes.slice(i, i + START_BATCH).map((index) =>
						client.worker
							.getOrCreate([workerName(index)])
							.start()
							.catch((error: unknown) => console.warn(`[pool] could not start ${workerName(index)}`, error)),
					),
				);
			}
		};

		// Every boot: make sure the permanent workers and any live extras are running.
		const permanent = Array.from({ length: config.idleWorkers }, (_, i) => i + 1);
		await start([...permanent, ...c.state.extras]);
		console.log(`[pool] ${config.idleWorkers} permanent workers running, ${c.state.extras.length} extras`);

		const team = boardAsSelf();
		while (!signal.aborted) {
			await sleep(config.poolIntervalMs, signal);
			if (signal.aborted) return;
			try {
				const { tasks } = await team.tasks.list({ channel: `${config.channel}/`, state: "ready", limit: 200 });
				const ready = tasks.length;
				c.state.lastReady = ready;
				// Ready tasks that survive two checks have no idle worker to take them.
				if (ready === 0 || !c.state.backlogSeen) {
					c.state.backlogSeen = ready > 0;
					continue;
				}
				const room = config.maxWorkers - config.idleWorkers - c.state.extras.length;
				const count = Math.min(ready, room);
				if (count <= 0) continue;
				const taken = new Set(c.state.extras);
				const fresh: number[] = [];
				for (let index = config.idleWorkers + 1; fresh.length < count; index++) {
					if (!taken.has(index)) fresh.push(index);
				}
				c.state.extras.push(...fresh);
				console.log(`[pool] ${ready} tasks waiting, spawning ${fresh.length} workers`);
				await start(fresh);
				c.state.backlogSeen = false;
			} catch (error) {
				console.warn("[pool] backlog check failed", error instanceof Error ? error.message : error);
			}
		}
	},
});
