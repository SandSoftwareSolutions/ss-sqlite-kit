import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { backup, foreignKeyCheck, integrityCheck, migrate, openDatabase, transaction } from "./src/index.js";

const dir = mkdtempSync(join(tmpdir(), "sqlite-kit-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const M = [
  { id: "001-users", sql: "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);" },
  { id: "002-posts", sql: "CREATE TABLE posts (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), title TEXT);" }
];

test("opens with safe defaults and applies migrations once", () => {
  const file = join(dir, "a.sqlite");
  const db = openDatabase(file, { migrations: M });
  assert.equal(db.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
  assert.equal(db.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
  assert.deepEqual(db.prepare("SELECT id FROM _migrations ORDER BY id").all().map((r) => r.id), ["001-users", "002-posts"]);
  assert.deepEqual(migrate(db, M), []);
  db.close();
  const again = openDatabase(file, { migrations: M });
  assert.equal(again.prepare("SELECT count(*) AS n FROM _migrations").get().n, 2);
  again.close();
});

test("a new migration is applied at the end", () => {
  const db = openDatabase(":memory:", { migrations: M });
  assert.deepEqual(migrate(db, [...M, { id: "003-x", sql: "CREATE TABLE x (a)" }]), ["003-x"]);
  db.close();
});

test("a failing migration rolls back completely and can be fixed", () => {
  const db = openDatabase(":memory:");
  const bad = { id: "001", sql: "CREATE TABLE t (a); INSERT INTO nope VALUES (1);" };
  assert.throws(() => migrate(db, [bad]));
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 't'").get().n, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM _migrations").get().n, 0);
  assert.deepEqual(migrate(db, [{ id: "001", sql: "CREATE TABLE t (a);" }]), ["001"]);
  db.close();
});

test("refuses a database that does not match the code", () => {
  const db = openDatabase(":memory:", { migrations: M });
  assert.throws(() => migrate(db, [{ ...M[0], sql: "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);" }, M[1]]), /was changed after it was applied/);
  assert.throws(() => migrate(db, [M[0]]), /does not know/);
  assert.throws(() => migrate(db, [M[0], { id: "001b", sql: "SELECT 1" }, M[1]]), /sits after a new one/);
  assert.throws(() => migrate(db, [M[0], M[0]]), /duplicate/);
  assert.throws(() => migrate(db, [{ id: "", sql: "x" }]), TypeError);
  db.close();
});

test("line endings and trailing space do not count as a changed migration", () => {
  const db = openDatabase(":memory:", { migrations: [{ id: "1", sql: "CREATE TABLE t (\n a\n);\n" }] });
  assert.deepEqual(migrate(db, [{ id: "1", sql: "CREATE TABLE t (\r\n a\r\n);  " }]), []);
  db.close();
});

test("transaction commits, rolls back, nests and refuses async callbacks", () => {
  const db = openDatabase(":memory:", { migrations: M });
  const count = () => db.prepare("SELECT count(*) AS n FROM users").get().n;
  assert.equal(transaction(db, () => db.prepare("INSERT INTO users (name) VALUES ('a')").run().lastInsertRowid), 1);
  assert.throws(() => transaction(db, () => { db.prepare("INSERT INTO users (name) VALUES ('b')").run(); throw new Error("boom"); }), /boom/);
  assert.equal(count(), 1);
  transaction(db, () => {
    db.prepare("INSERT INTO users (name) VALUES ('c')").run();
    assert.throws(() => transaction(db, () => { db.prepare("INSERT INTO users (name) VALUES ('d')").run(); throw new Error("inner"); }), /inner/);
  });
  assert.deepEqual(db.prepare("SELECT name FROM users ORDER BY id").all().map((r) => r.name), ["a", "c"]);
  assert.throws(() => transaction(db, async () => 1), /synchronous/);
  assert.equal(db.isTransaction, false);
  db.close();
});

test("foreign keys are enforced and can be audited", () => {
  const db = openDatabase(":memory:", { migrations: M });
  assert.throws(() => db.prepare("INSERT INTO posts (user_id, title) VALUES (99, 't')").run(), /FOREIGN KEY/);
  assert.deepEqual(foreignKeyCheck(db), []);
  assert.deepEqual(integrityCheck(db), []);
  db.close();
});

test("backup writes a verified copy and never overwrites", () => {
  const db = openDatabase(join(dir, "live.sqlite"), { migrations: M });
  db.prepare("INSERT INTO users (name) VALUES ('kaj')").run();
  const copy = backup(db, join(dir, "copy.sqlite"));
  assert.ok(existsSync(copy));
  assert.throws(() => backup(db, copy), /already exists/);
  const restored = openDatabase(copy, { readonly: true });
  assert.equal(restored.prepare("SELECT name FROM users").get().name, "kaj");
  restored.close();
  assert.throws(() => backup(db, ""), TypeError);
  db.close();
});

test("pragmas are checked and read-only connections cannot migrate", () => {
  assert.throws(() => openDatabase(":memory:", { pragmas: { "cache_size; DROP TABLE x": 1 } }), TypeError);
  assert.throws(() => openDatabase(":memory:", { pragmas: { cache_size: "1; DROP" } }), TypeError);
  const db = openDatabase(":memory:", { pragmas: { cache_size: -2000 } });
  assert.equal(db.prepare("PRAGMA cache_size").get().cache_size, -2000);
  db.close();
  assert.throws(() => openDatabase(join(dir, "ro.sqlite"), { readonly: true }));
  openDatabase(join(dir, "ro2.sqlite")).close();
  assert.throws(() => openDatabase(join(dir, "ro2.sqlite"), { readonly: true, migrations: M }), /read-only/);
});
