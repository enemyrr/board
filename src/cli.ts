#!/usr/bin/env node
import { byHandle, current } from "./agents.ts";
import { openDb, row, run } from "./db.ts";
import { hook } from "./hooks.ts";
import { install } from "./install.ts";
import { history, render, send, takeChannel, takeDms, wake } from "./messages.ts";
import { portHolders, roster } from "./who.ts";

const USAGE = `Usage:
  board who [--all]             List the live sessions. --all includes closed sessions.
  board who --port <n>          Find the session that holds a TCP port.
  board status [<text>]         Set or clear what you are working on.
  board dm <handle> <text>      Send a direct message. A direct message wakes its recipient.
  board post <text>             Write to the channel of your project. Nobody is woken.
  board inbox                   Read your unread messages.
  board log [-n <count>] [--all]  Show recent messages of your project, or of every project.
  board claim <kind> <value>    Claim a resource, for example: board claim port 3000
  board release <kind> <value>  Release a claim.
  board install [--project]     Add the hooks to Claude Code.
  board uninstall [--project]   Remove the hooks.`;

class UsageError extends Error {}

function option(args: string[], name: string): string | undefined {
	const at = args.indexOf(name);
	return at === -1 ? undefined : args[at + 1];
}

async function main(): Promise<void> {
	const [command, ...args] = process.argv.slice(2);
	if (!command || command === "help" || command === "--help") return console.log(USAGE);
	if (command === "hook") return hook(args[0] ?? "");
	if (command === "install" || command === "uninstall") return console.log(install(args, command === "uninstall"));

	const db = openDb();
	const me = current(db);
	const text = (from: number) => args.slice(from).join(" ").trim();

	switch (command) {
		case "who": {
			const port = option(args, "--port");
			if (port === undefined) return console.log(roster(db, args.includes("--all")));
			if (!/^\d+$/.test(port)) throw new UsageError("--port needs a port number");
			return console.log(portHolders(db, Number(port)));
		}
		case "status":
			run(db, "update agents set status = ?, status_at = ? where id = ?", text(0) || null, Date.now(), me.id);
			return console.log(text(0) ? `${me.handle} status: ${text(0)}` : `${me.handle} status cleared`);
		case "dm": {
			const to = byHandle(db, args[0] ?? "");
			if (!to) throw new UsageError(`no session has the handle "${args[0] ?? ""}". Run \`board who --all\`.`);
			if (!text(1)) throw new UsageError("the message is empty");
			if (to.id === me.id) throw new UsageError("a session cannot message itself");
			send(db, me, text(1), to);
			return console.log(`sent to ${to.handle}${wake(db, to, me) ? ", which was closed and is now starting headless" : ""}`);
		}
		case "post":
			if (!text(0)) throw new UsageError("the message is empty");
			send(db, me, text(0));
			return console.log("posted");
		case "inbox": {
			const unread = [...takeDms(db, me.id, "pull"), ...takeChannel(db, me)].sort((a, b) => a.id - b.id);
			return console.log(unread.length ? unread.map(render).join("\n") : "No unread messages.");
		}
		case "log": {
			const messages = history(db, me, Number(option(args, "-n") ?? 20), args.includes("--all"));
			return console.log(messages.length ? messages.map(render).join("\n") : "No messages.");
		}
		case "claim":
		case "release": {
			const [kind, value] = args;
			if (!kind || !value) throw new UsageError(`usage: board ${command} <kind> <value>`);
			if (command === "release") {
				run(db, "delete from claims where kind = ? and value = ? and agent = ?", kind, value, me.id);
				return console.log(`released ${kind} ${value}`);
			}
			// A claim of a closed session is free to take.
			run(
				db,
				"delete from claims where kind = ? and value = ? and agent in (select id from agents where closed_at is not null)",
				kind, value,
			);
			run(db, "insert or ignore into claims (kind, value, agent, at) values (?, ?, ?, ?)", kind, value, me.id, Date.now());
			const holder = row<{ handle: string }>(
				db,
				"select a.handle from claims c join agents a on a.id = c.agent where c.kind = ? and c.value = ?",
				kind, value,
			);
			if (holder?.handle !== me.handle) throw new UsageError(`${kind} ${value} is already claimed by ${holder?.handle}`);
			return console.log(`claimed ${kind} ${value}`);
		}
		default:
			throw new UsageError(`unknown command "${command}"\n${USAGE}`);
	}

}

main().catch((error: unknown) => {
	if (!(error instanceof UsageError)) throw error;
	console.error(`board: ${error.message}`);
	process.exitCode = 1;
});
