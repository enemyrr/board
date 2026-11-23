import { basename } from "node:path";
import { type Agent, HUMAN, isLive } from "./agents.ts";
import { type Db, row, rows } from "./db.ts";
import { ancestors, processTable, sh } from "./procs.ts";

export function age(since: number): string {
	const seconds = Math.max(0, Math.round((Date.now() - since) / 1000));
	if (seconds < 60) return `${seconds}s`;
	if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
	if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
	return `${Math.round(seconds / 86400)}d`;
}

function state(agent: Agent): string {
	if (!isLive(agent)) return "closed";
	return agent.busy ? "working" : "idle";
}

function describe(agent: Agent): string {
	const status = agent.status && agent.status_at ? `, "${agent.status}" ${age(agent.status_at)} ago` : "";
	return `${agent.handle} (${agent.harness}, ${state(agent)}${status})`;
}

export function roster(db: Db, includeClosed: boolean): string {
	const agents = rows<Agent>(db, "select * from agents where id != ? order by project, handle", HUMAN).filter(
		(agent) => includeClosed || isLive(agent),
	);
	if (agents.length === 0) return "No sessions are registered.";
	const claims = rows<{ agent: string; kind: string; value: string }>(db, "select agent, kind, value from claims");
	return agents
		.map((agent) => {
			const held = claims.filter((c) => c.agent === agent.id).map((c) => `${c.kind} ${c.value}`);
			return [
				describe(agent),
				`  project ${basename(agent.project)}${agent.branch ? ` on ${agent.branch}` : ""}, ${agent.cwd}`,
				...(held.length ? [`  claims: ${held.join(", ")}`] : []),
			].join("\n");
		})
		.join("\n");
}

// Finds the session that holds a TCP port. A listener belongs to the session that is its ancestor.
// A detached listener has no such ancestor, so it belongs to the session whose folder contains its working folder.
export function portHolders(db: Db, port: number): string {
	const lines: string[] = [];
	const live = rows<Agent>(db, "select * from agents where id != ?", HUMAN).filter(isLive);
	const table = processTable();
	const listeners = sh("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"]).match(/^p\d+/gm) ?? [];

	for (const pid of new Set(listeners.map((entry) => Number(entry.slice(1))))) {
		const chain = ancestors(pid, table);
		const cwd = sh("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]).match(/^n(.*)$/m)?.[1] ?? "";
		const owner =
			live.find((agent) => agent.pid !== null && chain.includes(agent.pid)) ??
			live
				.filter((agent) => cwd === agent.cwd || cwd.startsWith(`${agent.cwd}/`))
				.sort((a, b) => b.cwd.length - a.cwd.length)[0];
		const name = `${basename(table.get(pid)?.comm ?? "process")} (pid ${pid}${cwd ? `, ${cwd}` : ""})`;
		lines.push(`port ${port}: ${name} ${owner ? `belongs to ${describe(owner)}` : "belongs to no registered session"}`);
	}
	if (lines.length === 0) lines.push(`port ${port}: nothing is listening`);

	const claim = row<Agent>(
		db,
		"select a.* from claims c join agents a on a.id = c.agent where c.kind = 'port' and c.value = ?",
		String(port),
	);
	if (claim) lines.push(`port ${port}: claimed by ${describe(claim)}`);
	return lines.join("\n");
}
