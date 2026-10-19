import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const PRAGMA_NAME = /^[a-z_]+$/;
const BUSY = /database is locked|database table is locked|busy/i;

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Some statements (the first switch to WAL on a new file, for one) fail at once with "database is locked" when another process is
// opening the same file at the same moment, without waiting for the busy timeout. Those are tried again for a few seconds.
function execWhenFree(db, sql, timeoutMs = 5000) {
  const until = Date.now() + timeoutMs;
  for (let wait = 5; ; wait = Math.min(wait * 2, 100)) {
    try {
      db.exec(sql);
      return;
    } catch (error) {
      if (!BUSY.test(String(error?.message)) || Date.now() >= until) throw error;
      sleep(wait);
    }
  }
}
const PRAGMA_VALUE = /^[A-Za-z0-9_]+$/;

/**
 * Opens a database with safe defaults (write-ahead log, foreign keys on, a 5 second busy timeout) and applies migrations.
 * Pass `readonly: true` for a connection that never writes.
 */
export function openDatabase(path, { migrations = [], pragmas = {}, readonly = false } = {}) {
  if (typeof path !== "string" || path === "") throw new TypeError("openDatabase: path must be a file path or ':memory:'");
  const db = new DatabaseSync(path, { readOnly: readonly });
  try {
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA busy_timeout = 5000");
    if (!readonly && path !== ":memory:") {
      execWhenFree(db, "PRAGMA journal_mode = WAL");
      db.exec("PRAGMA synchronous = NORMAL");
    }
    for (const [name, value] of Object.entries(pragmas)) {
      if (!PRAGMA_NAME.test(name)) throw new TypeError(`openDatabase: invalid pragma name "${name}"`);
      const text = String(value);
      const ok = typeof value === "number" ? Number.isInteger(value) : PRAGMA_VALUE.test(text);
      if (!ok) throw new TypeError(`openDatabase: invalid value for pragma ${name}`);
      db.exec(`PRAGMA ${name} = ${text}`);
    }
    if (migrations.length > 0) {
      if (readonly) throw new Error("openDatabase: migrations cannot run on a read-only connection");
      migrate(db, migrations);
    }
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

const checksum = (sql) => createHash("sha256").update(sql.replace(/\r\n/g, "\n").trim()).digest("hex");

/**
 * Applies the migrations that have not run yet, each in its own transaction, in the order of the list.
 * Refuses to continue when the database does not match the code: a migration that was changed after it ran,
 * one that is missing from the list, or a new one inserted before an applied one. Returns the ids it applied.
 */
export function migrate(db, migrations) {
  const seen = new Set();
  for (const m of migrations) {
    if (typeof m?.id !== "string" || m.id === "" || typeof m.sql !== "string") throw new TypeError("migrate: every migration needs a string id and a string sql");
    if (seen.has(m.id)) throw new Error(`migrate: duplicate migration id "${m.id}"`);
    seen.add(m.id);
  }
  db.exec("CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)");
  const applied = new Map(db.prepare("SELECT id, checksum FROM _migrations").all().map((r) => [r.id, r.checksum]));
  for (const id of applied.keys()) {
    if (!seen.has(id)) throw new Error(`migrate: the database has migration "${id}" that the code does not know (is the database newer than this version?)`);
  }
  let pending = false;
  const done = [];
  for (const m of migrations) {
    const sum = checksum(m.sql);
    if (applied.has(m.id)) {
      if (pending) throw new Error(`migrate: migration "${m.id}" was already applied but sits after a new one; add new migrations at the end`);
      if (applied.get(m.id) !== sum) throw new Error(`migrate: migration "${m.id}" was changed after it was applied; write a new migration instead`);
      continue;
    }
    pending = true;
    const ran = transaction(db, () => {
      // Look again now that we hold the write lock: another process that started at the same moment may have applied it just now.
      const row = db.prepare("SELECT checksum FROM _migrations WHERE id = ?").get(m.id);
      if (row) {
        if (row.checksum !== sum) throw new Error(`migrate: migration "${m.id}" was changed after it was applied; write a new migration instead`);
        return false;
      }
      db.exec(m.sql);
      db.prepare("INSERT INTO _migrations (id, checksum, applied_at) VALUES (?, ?, ?)").run(m.id, sum, new Date().toISOString());
      return true;
    });
    if (ran) done.push(m.id);
  }
  return done;
}

let savepoints = 0;

/**
 * Runs `fn` in a transaction (BEGIN IMMEDIATE, so a writer fails early instead of halfway) and returns its result.
 * It rolls back when `fn` throws. Inside another transaction it uses a savepoint. `fn` must be synchronous.
 */
export function transaction(db, fn) {
  const nested = db.isTransaction;
  const name = `sk_${++savepoints}`;
  db.exec(nested ? `SAVEPOINT ${name}` : "BEGIN IMMEDIATE");
  let result;
  try {
    result = fn();
    if (result && typeof result.then === "function") throw new TypeError("transaction: the callback must be synchronous; an async callback would leave the transaction open");
  } catch (error) {
    try {
      db.exec(nested ? `ROLLBACK TO ${name}; RELEASE ${name}` : "ROLLBACK");
    } catch {
      // The original error matters more than a failed rollback.
    }
    throw error;
  }
  try {
    db.exec(nested ? `RELEASE ${name}` : "COMMIT");
  } catch (error) {
    // A commit can fail (a deferred foreign key, a busy database). The transaction is then still open, and everything after it
    // would silently run inside it and never be saved, so it is rolled back here.
    try {
      db.exec(nested ? `ROLLBACK TO ${name}; RELEASE ${name}` : "ROLLBACK");
    } catch {
      // The original error matters more than a failed rollback.
    }
    throw error;
  }
  return result;
}

/** Problems found by SQLite's integrity check; an empty list means the file is sound. */
export function integrityCheck(db) {
  const rows = db.prepare("PRAGMA integrity_check").all().map((r) => String(Object.values(r)[0]));
  return rows.length === 1 && rows[0] === "ok" ? [] : rows;
}

/** Rows that break a foreign key: `{ table, rowid, parent, fkid }`. Empty means fine. */
export function foreignKeyCheck(db) {
  return db.prepare("PRAGMA foreign_key_check").all().map((r) => ({ ...r }));
}

/**
 * Writes a consistent copy of a live database (VACUUM INTO) and checks the copy, so a backup that is broken is noticed now
 * and not on the day you need it. Refuses to overwrite a file. Returns the path of the copy.
 */
export function backup(db, destination, { verify = true } = {}) {
  if (typeof destination !== "string" || destination === "" || destination === ":memory:") throw new TypeError("backup: destination must be a file path");
  if (existsSync(destination)) throw new Error(`backup: ${destination} already exists; choose a new file name`);
  db.prepare("VACUUM INTO ?").run(destination);
  if (verify) {
    const copy = new DatabaseSync(destination, { readOnly: true });
    try {
      const problems = integrityCheck(copy);
      if (problems.length > 0) throw new Error(`backup: the copy failed the integrity check: ${problems.slice(0, 3).join("; ")}`);
    } finally {
      copy.close();
    }
  }
  return destination;
}
