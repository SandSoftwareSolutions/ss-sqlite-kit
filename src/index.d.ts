import type { DatabaseSync } from "node:sqlite";

export interface Migration {
  /** Unique and stable, for example "001-create-users". Applied in list order. */
  id: string;
  sql: string;
}

export interface OpenOptions {
  migrations?: readonly Migration[];
  /** Extra pragmas, for example `{ cache_size: -20000 }`. Names and values are checked. */
  pragmas?: Record<string, string | number>;
  readonly?: boolean;
}

export function openDatabase(path: string, options?: OpenOptions): DatabaseSync;
export function migrate(db: DatabaseSync, migrations: readonly Migration[]): string[];
export function transaction<T>(db: DatabaseSync, fn: () => T): T;
export function integrityCheck(db: DatabaseSync): string[];
export function foreignKeyCheck(db: DatabaseSync): { table: string; rowid: number | null; parent: string; fkid: number }[];
export function backup(db: DatabaseSync, destination: string, options?: { verify?: boolean }): string;
