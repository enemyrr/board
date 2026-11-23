import { appendFileSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { type Agent, getAgent, register } from "./agents.ts";
import { type Db, openDb, run } from "./db.ts";
import { channelUnread, delivery, takeDms } from "./messages.ts";
import { harnessPid, isOneShot, pidAlive } from "./procs.ts";

type HookInput = {
	session_id?: string;
	cwd?: string;
	// Set when the hook fires inside a subagent.
	agent_id?: string;
};

function context(hookEventName: string, parts: string[]): void {
	const additionalContext = parts.filter(Boolean).join("\n\n");
	if (additionalContext) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext } }));
}

function brief(agent: Agent): string {
	return [
		`[board] You are \`${agent.handle}\` on the local agent board, in project ${basename(agent.project)}. Other sessions on this machine can message you.`,
		'Commands: `board who` lists sessions. `board who --port <n>` finds the session that holds a port. `board dm <handle> "<text>"` sends a direct message. `board post "<text>"` writes to the project channel. `board inbox` reads unread messages. `board status "<text>"` sets what you are working on.',
		"Set your status when you start a task. Answer the messages of other sessions as you would answer a colleague.",
	].join("\n");
}

// Blocks until a direct message arrives for an idle session, then exits 2.
// Claude Code runs this hook with `asyncRewake`, so exit code 2 wakes the session with stderr as the message.
async function wait(db: Db, id: string): Promise<void> {
	// Claude Code does not exit a one-shot run while this hook runs, so such a run gets no waiter.
	if (isOneShot(harnessPid())) return;
	run(db, "update agents set waiter_pid = ? where id = ?", process.pid, id);
	for (;;) {
		await sleep(1000);
		const agent = getAgent(db, id);
		// A newer waiter replaces this one. A closed or dead session needs none.
		if (!agent || agent.closed_at !== null || agent.waiter_pid !== process.pid || !pidAlive(agent.pid)) return;
		const dms = takeDms(db, id, "push");
		if (dms.length === 0) continue;
		run(db, "update agents set busy = 1 where id = ?", id);
		console.error(delivery(dms));
		process.exitCode = 2;
		return;
	}
}

export async function hook(event: string): Promise<void> {
	const input = JSON.parse(readFileSync(0, "utf8") || "{}") as HookInput;
	// A message injected into a subagent never reaches the main thread, so subagents get none.
	if (!input.session_id || input.agent_id) return;
	const id = input.session_id;
	const db = openDb();
	const me = { id, harness: "claude", cwd: input.cwd ?? process.cwd(), pid: harnessPid() };
	const agent = event === "session-start" ? register(db, me) : (getAgent(db, id) ?? register(db, me));

	switch (event) {
		case "session-start": {
			if (process.env.CLAUDE_ENV_FILE) appendFileSync(process.env.CLAUDE_ENV_FILE, `export BOARD_AGENT_ID=${id}\n`);
			const dms = takeDms(db, id, "push");
			context("SessionStart", [brief(agent), dms.length ? delivery(dms) : ""]);
			return;
		}
		case "user-prompt-submit": {
			// A prompt from the user ends the reply chain. A prompt from `wake` continues it.
			const woken = process.env.BOARD_WAKE === "1";
			run(db, `update agents set busy = 1${woken ? "" : ", hop = 0"} where id = ?`, id);
			const dms = takeDms(db, id, woken ? "push" : "pull");
			const unread = channelUnread(db, agent);
			context("UserPromptSubmit", [
				dms.length ? delivery(dms) : "",
				unread ? `[board] ${unread} unread in #${basename(agent.project)}. Run \`board inbox\` to read them.` : "",
			]);
			return;
		}
		case "post-tool-use": {
			const dms = takeDms(db, id, "push");
			context("PostToolUse", [dms.length ? delivery(dms) : ""]);
			return;
		}
		case "stop": {
			const dms = takeDms(db, id, "push");
			if (dms.length) console.log(JSON.stringify({ decision: "block", reason: delivery(dms) }));
			else run(db, "update agents set busy = 0 where id = ?", id);
			return;
		}
		case "wait":
			return wait(db, id);
		case "session-end":
			run(db, "update agents set closed_at = ?, busy = 0, waiter_pid = null where id = ?", Date.now(), id);
			return;
		default:
			throw new Error(`unknown hook event: ${event}`);
	}
}
