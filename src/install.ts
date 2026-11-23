import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type Hook = { type: "command"; command: string; timeout?: number; asyncRewake?: boolean };
type Group = { matcher?: string; hooks: Hook[] };
type Settings = {
	hooks?: Record<string, Group[]>;
	permissions?: { allow?: string[]; [key: string]: unknown };
	[key: string]: unknown;
};

// Marks the hooks that this installer owns, so that a second install replaces them.
const MARKER = "# board";
const PERMISSION = "Bash(board:*)";
const CLI = join(dirname(fileURLToPath(import.meta.url)), "cli.ts");
const LINK = join(homedir(), ".local", "bin", "board");

const EVENTS: Record<string, string> = {
	SessionStart: "session-start",
	UserPromptSubmit: "user-prompt-submit",
	PostToolUse: "post-tool-use",
	Stop: "stop",
	SessionEnd: "session-end",
};

// Claude Code runs a hook command through a shell, so each path is single-quoted.
function quote(path: string): string {
	return `'${path.replaceAll("'", "'\\''")}'`;
}

function command(event: string): string {
	return `${quote(process.execPath)} ${quote(CLI)} hook ${event} ${MARKER}`;
}

function withoutBoard(settings: Settings): Settings {
	const hooks: Record<string, Group[]> = {};
	for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
		const kept = groups.filter((group) => !group.hooks.some((hook) => hook.command?.endsWith(MARKER)));
		if (kept.length) hooks[event] = kept;
	}
	const allow = settings.permissions?.allow?.filter((rule) => rule !== PERMISSION);
	return { ...settings, hooks, permissions: { ...settings.permissions, ...(allow ? { allow } : {}) } };
}

function withBoard(settings: Settings): Settings {
	const next = withoutBoard(settings);
	const hooks = next.hooks ?? {};
	for (const [event, name] of Object.entries(EVENTS)) {
		const group: Group = { hooks: [{ type: "command", command: command(name), timeout: 10 }] };
		// The waiter runs for as long as the session is idle, so it needs a long timeout.
		if (event === "Stop") group.hooks.push({ type: "command", command: command("wait"), timeout: 86400, asyncRewake: true });
		hooks[event] = [...(hooks[event] ?? []), group];
	}
	const allow = [...(next.permissions?.allow ?? []), PERMISSION];
	return { ...next, hooks, permissions: { ...next.permissions, allow } };
}

// Writes the hooks to the user settings, or to the settings of the current project with `--project`.
export function install(args: string[], remove: boolean): string {
	const project = args.includes("--project");
	const path = join(project ? process.cwd() : homedir(), ".claude", "settings.json");
	const settings = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Settings) : {};
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(remove ? withoutBoard(settings) : withBoard(settings), null, 2)}\n`);

	// A file named `board` that is not a symlink belongs to something else, so it stays.
	const link = lstatSync(LINK, { throwIfNoEntry: false });
	if (!project && (!link || link.isSymbolicLink())) {
		if (link) unlinkSync(LINK);
		if (!remove) {
			mkdirSync(dirname(LINK), { recursive: true });
			symlinkSync(CLI, LINK);
		}
	}
	return `${remove ? "Removed the board hooks from" : "Wrote the board hooks to"} ${path}`;
}
