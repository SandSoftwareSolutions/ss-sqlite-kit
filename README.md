# @sandsoftwaresolutions/sqlite-kit

[![CI](https://github.com/SandSoftwareSolutions/ss-sqlite-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/SandSoftwareSolutions/ss-sqlite-kit/actions/workflows/ci.yml)

The things you set up in every project that uses SQLite, in one small package on top of the built-in `node:sqlite`: safe defaults, migrations, transactions, and backups that are checked. No dependencies. Needs Node.js 22.16 or newer.

## Install

```bash
npm install @sandsoftwaresolutions/sqlite-kit
```

## Usage

```js
import { openDatabase, transaction, backup } from "@sandsoftwaresolutions/sqlite-kit";

const db = openDatabase("data/app.sqlite", {
  migrations: [
    { id: "001-users", sql: "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);" },
    { id: "002-posts", sql: "CREATE TABLE posts (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id));" }
  ]
});

transaction(db, () => {
  db.prepare("INSERT INTO users (name) VALUES (?)").run("Kaj");
  // throw here and nothing is written
});

backup(db, `backups/app-${Date.now()}.sqlite`); // a consistent copy of the live database, checked
```

`db` is a normal `DatabaseSync`; this package does not wrap it.

## What `openDatabase` sets

Write-ahead log, `foreign_keys = ON` (SQLite has it off by default!), `busy_timeout = 5000`, `synchronous = NORMAL`. Add your own with `pragmas: { cache_size: -20000 }`. `readonly: true` opens a connection that never writes.

## Migrations

- Each migration runs in its own transaction; if one fails, nothing of it is kept and you can fix it and start again.
- Applied migrations are remembered in a table `_migrations` with a checksum.
- It refuses to start when the database does not match the code: a migration that was **changed** after it ran (write a new one), a migration in the database that the code **does not know** (the database is newer than your code), or a new migration placed **before** one that already ran.
- Line endings and trailing whitespace do not count as a change.

## Transactions

`transaction(db, fn)` uses `BEGIN IMMEDIATE`, so a second writer waits (or fails after the timeout) at the start and not halfway. Inside another transaction it uses a savepoint, so you can nest. `fn` must be synchronous: an async function would leave the transaction open, so it is refused.

## Backups and checks

- `backup(db, file)` writes a consistent copy with `VACUUM INTO`, opens the copy and runs the integrity check, so a broken backup is noticed now and not on the day you need it. It never overwrites a file.
- `integrityCheck(db)` and `foreignKeyCheck(db)` return a list of problems; empty is fine.
