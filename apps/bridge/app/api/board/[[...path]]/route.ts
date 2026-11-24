import { board } from "@vercel/board";
import { channels, slack } from "@vercel/board/sync-slack";

// Mirrors the swarm's board channel into one Slack channel, both ways. Task roots, questions, and results
// sync; workers post step-by-step progress with noSync, so Slack only sees what a person needs.
// Vercel Connect holds the Slack credentials: SLACK_CONNECTOR is the connector's UID, such as "slack/agent-swarm".
const team = board({
	...(process.env.BOARD_NAME ? { name: process.env.BOARD_NAME } : {}),
	sync: {
		slack: slack(
			process.env.SLACK_CONNECTOR ?? "slack/agent-swarm",
			channels({ [process.env.SLACK_CHANNEL ?? "C0CL9MTTQNP"]: process.env.SWARM_CHANNEL ?? "work" }),
		),
	},
});

export const GET = team.fetch;
export const POST = team.fetch;
