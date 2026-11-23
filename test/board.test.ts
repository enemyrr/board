import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

const CLI = join(import.meta.dirname, "..", "src", "cli.ts");

let root: string;
let env: NodeJS.ProcessEnv;

function repo(name: string): string {
	const dir = join(root, name);
	mkdirSync(dir);
	execFileSync("git", ["-C", dir, "init", "-q"]);
	return dir;
}

type Session = { id: string; cwd: string };

function sessionEnv(session: Session): NodeJS.ProcessEnv {
	return { ...env, BOARD_AGENT_ID: session.id, CLAUDE_PID: String(process.pid) };
}

function board(session: Session, ...args: string[]): string {
	const result = spawnSync(process.execPath, [CLI, ...args], { cwd: session.cwd, env: sessionEnv(session), encoding: "utf8" });
	return result.stdout + result.stderr;
}

function hook(session: Session, event: string, input: Record<string, unknown> = {}, extraEnv: NodeJS.ProcessEnv = {}): string {
	const result = spawnSync(process.execPath, [CLI, "hook", event], {
		cwd: session.cwd,
		env: { ...sessionEnv(session), ...extraEnv },
		input: JSON.stringify({ session_id: session.id, cwd: session.cwd, ...input }),
		encoding: "utf8",
	});
	return result.stdout;
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "board-test-"));
	env = { PATH: process.env.PATH, HOME: root, BOARD_DB: join(root, "board.db"), BOARD_NO_WAKE: "1", BOARD_MAX_HOPS: "2" };
});

test("a channel post reaches the sessions of the same project only", () => {
	const alpha = repo("alpha");
	execFileSync("git", ["-C", alpha, "commit", "-q", "--allow-empty", "-m", "init"], {
		env: { ...env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
	});
	execFileSync("git", ["-C", alpha, "worktree", "add", "-q", join(root, "alpha-worktree"), "-b", "feature"]);
	const a = { id: "a", cwd: alpha };
	const worktree = { id: "w", cwd: join(root, "alpha-worktree") };
	const b = { id: "b", cwd: repo("beta") };
	for (const session of [a, worktree, b]) board(session, "who");

	board(a, "post", "who changed the migrations?");

	assert.match(board(worktree, "inbox"), /alpha-1 -> #alpha: who changed the migrations\?/);
	assert.match(board(b, "inbox"), /No unread messages/);
	assert.match(board(a, "inbox"), /No unread messages/);
});

test("a direct message crosses projects and is delivered once", () => {
	const a = { id: "a", cwd: repo("alpha") };
	const b = { id: "b", cwd: repo("beta") };
	board(a, "who");
	board(b, "dm", "alpha-1", "can you free port 3000?");

	const injected = hook(a, "post-tool-use");
	assert.match(JSON.parse(injected).hookSpecificOutput.additionalContext, /from beta-1: can you free port 3000\?/);
	assert.equal(hook(a, "post-tool-use"), "");
	assert.match(board(a, "inbox"), /No unread messages/);
});

test("the stop hook blocks only while a direct message is unread", () => {
	const a = { id: "a", cwd: repo("alpha") };
	const b = { id: "b", cwd: repo("beta") };
	board(a, "who");
	assert.equal(hook(a, "stop"), "");

	board(b, "dm", "alpha-1", "ping");
	const blocked = JSON.parse(hook(a, "stop"));
	assert.equal(blocked.decision, "block");
	assert.match(blocked.reason, /from beta-1: ping/);
	assert.equal(hook(a, "stop"), "");
});

test("a reply chain stops waking sessions at the hop limit until a user prompts", () => {
	const a = { id: "a", cwd: repo("alpha") };
	const b = { id: "b", cwd: repo("beta") };
	board(a, "who");
	board(b, "who");

	board(a, "dm", "beta-1", "hop 0");
	assert.notEqual(hook(b, "stop"), "");
	board(b, "dm", "alpha-1", "hop 1");
	assert.notEqual(hook(a, "stop"), "");
	board(a, "dm", "beta-1", "hop 2");
	assert.equal(hook(b, "stop"), "", "a message at the limit must not block the stop");

	const prompted = JSON.parse(hook(b, "user-prompt-submit")).hookSpecificOutput.additionalContext;
	assert.match(prompted, /from alpha-1: hop 2/);
	board(b, "dm", "alpha-1", "fresh chain");
	assert.notEqual(hook(a, "stop"), "");
});

test("a hook that fires inside a subagent delivers nothing", () => {
	const a = { id: "a", cwd: repo("alpha") };
	const b = { id: "b", cwd: repo("beta") };
	board(a, "who");
	board(b, "dm", "alpha-1", "for the main thread");

	assert.equal(hook(a, "post-tool-use", { agent_id: "sub-1" }), "");
	assert.notEqual(hook(a, "post-tool-use"), "");
});

test("the waiter exits 2 with the message when an idle session gets a direct message", async () => {
	const a = { id: "a", cwd: repo("alpha") };
	const b = { id: "b", cwd: repo("beta") };
	board(a, "who");

	const waiter = spawn(process.execPath, [CLI, "hook", "wait"], { cwd: a.cwd, env: sessionEnv(a) });
	waiter.stdin.end(JSON.stringify({ session_id: a.id, cwd: a.cwd }));
	let stderr = "";
	waiter.stderr.on("data", (chunk: Buffer) => (stderr += chunk));
	const exited = new Promise<number | null>((resolve) => waiter.on("exit", resolve));

	board(b, "dm", "alpha-1", "wake up");
	assert.equal(await exited, 2);
	assert.match(stderr, /from beta-1: wake up/);
	assert.equal(hook(a, "stop"), "", "the waiter already delivered the message");
});

test("a message at the hop limit does not start a closed session", async () => {
	const started = join(root, "started");
	mkdirSync(join(root, "bin"));
	writeFileSync(join(root, "bin", "claude"), `#!/bin/sh\necho "$@" >> "${started}"\n`);
	chmodSync(join(root, "bin", "claude"), 0o755);
	const wakeEnv = { PATH: `${join(root, "bin")}:${env.PATH}`, BOARD_NO_WAKE: undefined };

	const closed = { id: "closed", cwd: repo("alpha") };
	const exited = spawnSync("true").pid;
	hook(closed, "session-start", {}, { CLAUDE_PID: String(exited) });
	const b = { id: "b", cwd: repo("beta") };
	const dm = (text: string, extra: NodeJS.ProcessEnv) =>
		spawnSync(process.execPath, [CLI, "dm", "alpha-1", text], { cwd: b.cwd, env: { ...sessionEnv(b), ...wakeEnv, ...extra }, encoding: "utf8" });

	dm("over the limit", { BOARD_MAX_HOPS: "0" });
	dm("under the limit", {});
	for (let i = 0; i < 40 && !existsSync(started); i++) await sleep(50);
	await sleep(200);

	assert.equal(readFileSync(started, "utf8").trim().split("\n").length, 1, "only the second message starts the session");
});

test("install keeps the hooks of other tools and uninstall removes only its own", () => {
	const project = { id: "a", cwd: repo("alpha") };
	const settingsPath = join(project.cwd, ".claude", "settings.json");
	const foreign = { hooks: { Stop: [{ hooks: [{ type: "command", command: "other-tool notify" }] }] }, model: "x" };
	mkdirSync(join(project.cwd, ".claude"));
	writeFileSync(settingsPath, JSON.stringify(foreign));

	board(project, "install", "--project");
	board(project, "install", "--project");
	const installed = JSON.parse(readFileSync(settingsPath, "utf8"));
	const stopCommands = installed.hooks.Stop.flatMap((group: { hooks: { command: string }[] }) => group.hooks.map((h) => h.command));
	assert.equal(stopCommands.length, 3, "one foreign hook, one stop hook, and one waiter");
	assert.equal(stopCommands[0], "other-tool notify");
	assert.deepEqual(installed.permissions.allow, ["Bash(board:*)"]);

	board(project, "uninstall", "--project");
	const removed = JSON.parse(readFileSync(settingsPath, "utf8"));
	assert.deepEqual(removed.hooks, foreign.hooks);
	assert.equal(removed.model, "x");
});
