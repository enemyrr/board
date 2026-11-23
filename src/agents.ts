import { basename, dirname } from "node:path";
import { type Db, row, rows, run, tx } from "./db.ts";
import { harnessPid, pidAlive, sh } from "./procs.ts";

export type Agent = {
	id: string;
	handle: string;
	harness: string;
	cwd: string;
	project: string;
	branch: string | null;
	pid: number | null;
	status: string | null;
	status_at: number | null;
	busy: number;
	hop: number;
	dm_cursor: number;
	channel_cursor: number;
	waiter_pid: number | null;
	closed_at: number | null;
};

export const HUMAN = "human";
const PRUNE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export function getAgent(db: Db, id: string): Agent | undefined {
	return row<Agent>(db, "select * from agents where id = ?", id);
}

export function byHandle(db: Db, handle: string): Agent | undefined {
	return row<Agent>(db, "select * from agents where handle = ?", handle.replace(/^@/, ""));
}

export function isLive(agent: Agent): boolean {
	return agent.closed_at === null && pidAlive(agent.pid);
}

// Worktrees of one repo share a project, because they share a git common dir.
function projectOf(cwd: string): string {
	const common = sh("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
	return basename(common) === ".git" ? dirname(common) : cwd;
}

function nextHandle(db: Db, project: string): string {
	const slug = basename(project).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
	const base = slug.slice(0, 24) || "agent";
	const taken = new Set(
		rows<{ handle: string }>(db, "select handle from agents where handle like ?", `${base}-%`).map((r) => r.handle),
	);
	let n = 1;
	while (taken.has(`${base}-${n}`)) n++;
	return `${base}-${n}`;
}

export function register(db: Db, input: { id: string; harness: string; cwd: string; pid: number | null }): Agent {
	const project = projectOf(input.cwd);
	const branch = sh("git", ["-C", input.cwd, "branch", "--show-current"]) || null;
	return tx(db, () => {
		if (getAgent(db, input.id)) {
			// A waiter of an earlier process of this session must not take messages for the new process.
			run(
				db,
				`update agents set cwd = ?, project = ?, branch = ?, closed_at = null,
				waiter_pid = case when pid is ? then waiter_pid else null end, pid = ? where id = ?`,
				input.cwd, project, branch, input.pid, input.pid, input.id,
			);
		} else {
			const stale = Date.now() - PRUNE_AFTER_MS;
			run(db, "delete from claims where agent in (select id from agents where closed_at < ?)", stale);
			run(db, "delete from agents where closed_at < ?", stale);
			const handle = input.id === HUMAN ? HUMAN : nextHandle(db, project);
			// A new agent starts at the end of the channel. It does not replay history.
			run(
				db,
				`insert into agents (id, handle, harness, cwd, project, branch, pid, channel_cursor)
				values (?, ?, ?, ?, ?, ?, ?, (select coalesce(max(id), 0) from messages))`,
				input.id, handle, input.harness, input.cwd, project, branch, input.pid,
			);
		}
		return getAgent(db, input.id) as Agent;
	});
}

// The caller of this CLI: a registered session, or the human at a plain terminal.
export function current(db: Db): Agent {
	const id = process.env.BOARD_AGENT_ID ?? process.env.CLAUDE_CODE_SESSION_ID ?? HUMAN;
	if (id === HUMAN) return register(db, { id, harness: HUMAN, cwd: process.cwd(), pid: null });
	const harness = process.env.BOARD_HARNESS ?? (process.env.CLAUDE_CODE_SESSION_ID === id ? "claude" : "agent");
	return getAgent(db, id) ?? register(db, { id, harness, cwd: process.cwd(), pid: harnessPid() });
}
