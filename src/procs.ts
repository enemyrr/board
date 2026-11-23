import { execFileSync } from "node:child_process";
import { basename } from "node:path";

export type Proc = { ppid: number; comm: string };

// Returns "" when the command fails. `lsof` exits 1 when it finds nothing.
export function sh(cmd: string, args: string[]): string {
	try {
		return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return "";
	}
}

export function processTable(): Map<number, Proc> {
	const table = new Map<number, Proc>();
	for (const line of sh("ps", ["-axo", "pid=,ppid=,comm="]).split("\n")) {
		const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
		if (match) table.set(Number(match[1]), { ppid: Number(match[2]), comm: match[3] });
	}
	return table;
}

export function ancestors(pid: number, table: Map<number, Proc>): number[] {
	const chain: number[] = [];
	for (let at = table.get(pid)?.ppid ?? 0; at > 1 && !chain.includes(at); at = table.get(at)?.ppid ?? 0) {
		chain.push(at);
	}
	return chain;
}

export function pidAlive(pid: number | null): boolean {
	if (!pid) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

// The pid of the harness process that owns this CLI call.
export function harnessPid(): number {
	const fromEnv = Number(process.env.CLAUDE_PID);
	if (fromEnv) return fromEnv;
	const table = processTable();
	const harness = ancestors(process.pid, table).find((pid) =>
		/^(claude|codex)$/.test(basename(table.get(pid)?.comm ?? "")),
	);
	return harness ?? process.ppid;
}

// A one-shot `claude -p` run ends after one turn. A streaming run stays open for more input.
export function isOneShot(pid: number): boolean {
	const argv = sh("ps", ["-o", "command=", "-p", String(pid)]);
	return /\s(-p|--print)(\s|$)/.test(argv) && !/--input-format[ =]stream-json/.test(argv);
}
