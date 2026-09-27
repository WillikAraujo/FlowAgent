import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const databaseKeys = new WeakMap<DatabaseSync, string>();
const exportLocks = new Set<string>();

export class PersistenceBusyError extends Error {
  constructor() {
    super("The database is being exported; retry this write after the export completes.");
    this.name = "PersistenceBusyError";
  }
}

/** Resolve path aliases and symlinks so separate handles for one database share its export gate. */
export function databaseKeyForPath(path: string | Buffer | URL): string {
  const rawPath = path instanceof URL ? fileURLToPath(path) : Buffer.isBuffer(path) ? path.toString() : path;
  if (rawPath === ":memory:" || rawPath === "") return "memory:" + randomUUID();
  if (rawPath.startsWith("file:") && rawPath.includes("mode=memory")) return "memory-uri:" + rawPath;
  const absolutePath = resolve(rawPath);
  const canonicalPath = existsSync(absolutePath)
    ? realpathSync.native(absolutePath)
    : join(realpathSync.native(dirname(absolutePath)), basename(absolutePath));
  return "file:" + (process.platform === "win32" ? canonicalPath.toLocaleLowerCase("en-US") : canonicalPath);
}

export function assertDatabasePathWritable(key: string): void {
  if (exportLocks.has(key)) throw new PersistenceBusyError();
}

export function registerDatabaseHandle(db: DatabaseSync, key: string): void {
  assertDatabasePathWritable(key);
  databaseKeys.set(db, key);
}

export function acquireExportLock(db: DatabaseSync): () => void {
  const key = databaseKeys.get(db);
  if (!key) throw new Error("Database handle is not registered with the ADE event store.");
  assertDatabasePathWritable(key);
  exportLocks.add(key);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    exportLocks.delete(key);
  };
}

export function assertDatabaseWritable(db: DatabaseSync): void {
  const key = databaseKeys.get(db);
  if (key) assertDatabasePathWritable(key);
}
