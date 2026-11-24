import { type Board, board } from "@vercel/board";

let team: Board | undefined;
const profiles = new Map<string, Board>();

/**
 * The board as one worker's profile. Credentials come from BOARD_TOKEN and the team from
 * VERCEL_ORG_ID (or BOARD_URL for a local `vb serve` board); BOARD_NAME picks a named board.
 */
export function boardAs(profile: string): Board {
	team ??= board(process.env.BOARD_NAME ? { name: process.env.BOARD_NAME } : {});
	let handle = profiles.get(profile);
	if (!handle) {
		handle = team.as(profile);
		profiles.set(profile, handle);
	}
	return handle;
}

/** The board as the token's own identity, for the pool's backlog checks. */
export function boardAsSelf(): Board {
	team ??= board(process.env.BOARD_NAME ? { name: process.env.BOARD_NAME } : {});
	return team;
}
