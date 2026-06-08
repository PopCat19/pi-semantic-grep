import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import initSqlJs, {
	type Database as SqlJsDb,
	type Statement as SqlJsStmt,
} from "sql.js";

let SQL: Awaited<ReturnType<typeof initSqlJs>> | null = null;

async function ensureSQL() {
	if (!SQL) SQL = await initSqlJs();
	return SQL;
}

export interface ChunkRow {
	id: number;
	file: string;
	start_line: number;
	end_line: number;
	text: string;
	vector: string;
}

export interface FileRow {
	file: string;
	hash: string;
	size: number;
	mtime_ms: number;
	indexed_at: string;
}

export class Statement {
	private stmt: SqlJsStmt;

	constructor(stmt: SqlJsStmt) {
		this.stmt = stmt;
	}

	run(...params: unknown[]): void {
		this.stmt.reset();
		if (params.length > 0) this.stmt.bind(this.#normalizeBind(params));
		this.stmt.step();
	}

	get(...params: unknown[]): Record<string, unknown> | undefined {
		this.stmt.reset();
		if (params.length > 0) this.stmt.bind(this.#normalizeBind(params));
		const row = this.stmt.step() ? this.stmt.getAsObject() : undefined;
		return row;
	}

	all(...params: unknown[]): Record<string, unknown>[] {
		this.stmt.reset();
		if (params.length > 0) this.stmt.bind(this.#normalizeBind(params));
		const rows: Record<string, unknown>[] = [];
		while (this.stmt.step()) rows.push(this.stmt.getAsObject());
		return rows;
	}

	#normalizeBind(params: unknown[]): any {
		if (params.length === 1) {
			const p = params[0];
			if (Array.isArray(p)) return p;
			if (p !== null && typeof p === "object") return p;
			return [p];
		}
		return params;
	}
}

export class Database {
	private db: SqlJsDb;
	private filePath: string;

	private constructor(db: SqlJsDb, filePath: string) {
		this.db = db;
		this.filePath = filePath;
	}

	static async open(filePath: string): Promise<Database> {
		const sql = await ensureSQL();
		mkdirSync(path.dirname(filePath), { recursive: true });
		let db: SqlJsDb;
		if (existsSync(filePath)) {
			const buf = readFileSync(filePath);
			db = new sql.Database(buf);
		} else {
			db = new sql.Database();
		}
		return new Database(db, filePath);
	}

	pragma(sql: string): void {
		this.db.run(`PRAGMA ${sql}`);
	}

	exec(sql: string): void {
		this.db.run(sql);
	}

	prepare(sql: string): Statement {
		return new Statement(this.db.prepare(sql));
	}

	getRowsModified(): number {
		return this.db.getRowsModified();
	}

	save(): void {
		const data = this.db.export();
		writeFileSync(this.filePath, Buffer.from(data));
	}

	close(): void {
		this.save();
		this.db.close();
	}
}

export function dbPathFor(root: string): string {
	return path.join(root, ".pi", "semantic-grep.sqlite");
}

export async function openDb(root: string): Promise<Database> {
	const db = await Database.open(dbPathFor(root));
	db.pragma("journal_mode = WAL");
	db.exec(`
    create table if not exists meta (key text primary key, value text not null);
    create table if not exists files (
      file text primary key,
      hash text not null,
      size integer not null,
      mtime_ms real not null,
      indexed_at text not null
    );
    create table if not exists chunks (
      id integer primary key,
      file text not null,
      start_line integer not null,
      end_line integer not null,
      text text not null,
      hash text not null,
      vector text not null,
      foreign key(file) references files(file) on delete cascade
    );
    create index if not exists chunks_file_idx on chunks(file);
  `);
	db.save();
	return db;
}

export function resetDb(db: Database): void {
	db.exec("delete from chunks; delete from files; delete from meta;");
}

export function getMeta(
	db: Database,
	key: string,
): string | undefined {
	return db.prepare("select value from meta where key = ?").get(key)
		?.value as string | undefined;
}

export function setMeta(db: Database, key: string, value: string): void {
	db.prepare(
		"insert into meta (key, value) values (?, ?) on conflict(key) do update set value = excluded.value",
	).run(key, value);
}
