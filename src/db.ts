import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

const schema = `
create table if not exists agents (
	id text primary key,
	handle text not null unique,
	harness text not null,
	cwd text not null,
	project text not null,
	branch text,
	pid integer,
	status text,
	status_at integer,
	busy integer not null default 0,
	hop integer not null default 0,
	dm_cursor integer not null default 0,
	channel_cursor integer not null default 0,
	waiter_pid integer,
	closed_at integer
);
create table if not exists messages (
	id integer primary key autoincrement,
	at integer not null,
	sender text not null,
	recipient text,
	project text,
	body text not null,
	hops integer not null default 0
);
create index if not exists messages_recipient on messages (recipient, id);
create table if not exists claims (
	kind text not null,
	value text not null,
	agent text not null,
	at integer not null,
	primary key (kind, value)
);
`;

export type Db = DatabaseSync;

export function openDb(): Db {
	const path = process.env.BOARD_DB ?? join(homedir(), ".board", "board.db");
	mkdirSync(dirname(path), { recursive: true });
	const db = new DatabaseSync(path);
	db.exec("pragma busy_timeout = 5000; pragma journal_mode = wal;");
	db.exec(schema);
	return db;
}

export function rows<T>(db: Db, sql: string, ...params: SQLInputValue[]): T[] {
	return db.prepare(sql).all(...params) as unknown as T[];
}

export function row<T>(db: Db, sql: string, ...params: SQLInputValue[]): T | undefined {
	return rows<T>(db, sql, ...params)[0];
}

export function run(db: Db, sql: string, ...params: SQLInputValue[]): void {
	db.prepare(sql).run(...params);
}

// Takes the write lock up front, so two hook processes cannot both read the same cursor.
export function tx<T>(db: Db, fn: () => T): T {
	db.exec("begin immediate");
	try {
		const result = fn();
		db.exec("commit");
		return result;
	} catch (error) {
		db.exec("rollback");
		throw error;
	}
}
