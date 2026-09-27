import { constants as fsConstants, copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { CURRENT_SCHEMA_VERSION, supportedSchemaObjects } from "./migrations.ts";
import type { LocalSqliteEventStore } from "./sqlite-store.ts";

const requiredTables = [
  { name: "schema_migrations", pragma: "PRAGMA table_info(schema_migrations)", columns: ["version", "applied_at"], primaryKey: ["version"] },
  { name: "projects", pragma: "PRAGMA table_info(projects)", columns: ["id", "revision", "data_json", "created_at", "updated_at"], primaryKey: ["id"] },
  { name: "entities", pragma: "PRAGMA table_info(entities)", columns: ["project_id", "entity_type", "entity_id", "revision", "data_json", "created_at", "updated_at"], primaryKey: ["project_id", "entity_type", "entity_id"] },
  { name: "project_sequences", pragma: "PRAGMA table_info(project_sequences)", columns: ["project_id", "sequence"], primaryKey: ["project_id"] },
  { name: "aggregate_revisions", pragma: "PRAGMA table_info(aggregate_revisions)", columns: ["project_id", "entity_type", "entity_id", "revision"], primaryKey: ["project_id", "entity_type", "entity_id"] },
  { name: "domain_events", pragma: "PRAGMA table_info(domain_events)", columns: ["event_id", "request_hash", "project_id", "sequence", "entity_id", "entity_type", "revision", "occurred_at", "origin", "type", "payload_json", "correlation_id"], primaryKey: ["event_id"] },
] as const;

function assertIntegrity(db: DatabaseSync): void {
  const result = db.prepare("PRAGMA integrity_check").all() as { integrity_check: string }[];
  if (result.length !== 1 || result[0].integrity_check !== "ok") throw new Error("SQLite integrity check failed.");
  if (db.prepare("PRAGMA foreign_key_check").all().length !== 0) throw new Error("SQLite foreign-key check failed.");
  const versions = db.prepare("SELECT version FROM schema_migrations ORDER BY version ASC").all() as { version: number }[];
  if (versions.length !== CURRENT_SCHEMA_VERSION || versions.some((item, index) => item.version !== index + 1)) {
    throw new Error("Database schema version is unsupported or incomplete.");
  }
  for (const table of requiredTables) {
    const actual = db.prepare(table.pragma).all() as { name: string; pk: number }[];
    const actualPrimaryKey = actual.filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk).map((column) => column.name);
    if (table.columns.some((column) => !actual.some((item) => item.name === column)) ||
        JSON.stringify(actualPrimaryKey) !== JSON.stringify(table.primaryKey)) {
      throw new Error("Database schema is missing required structure: " + table.name + ".");
    }
  }
  const expectedIndexes = [
    { query: "PRAGMA index_list(domain_events)", index: "domain_events_project_cursor", columns: ["project_id", "sequence"] },
    { query: "PRAGMA index_list(domain_events)", index: "domain_events_aggregate", columns: ["project_id", "entity_type", "entity_id", "revision"] },
    { query: "PRAGMA index_list(entities)", index: "entities_project_type", columns: ["project_id", "entity_type"] },
  ] as const;
  for (const expected of expectedIndexes) {
    const indexes = db.prepare(expected.query).all() as { name: string }[];
    if (!indexes.some((index) => index.name === expected.index)) throw new Error("Database schema is missing required index: " + expected.index + ".");
    const columns = db.prepare("SELECT name FROM pragma_index_info(?) ORDER BY seqno").all(expected.index) as { name: string }[];
    if (JSON.stringify(columns.map((column) => column.name)) !== JSON.stringify(expected.columns)) {
      throw new Error("Database schema has an incompatible required index: " + expected.index + ".");
    }
  }
  const eventIndexes = db.prepare("PRAGMA index_list(domain_events)").all() as { name: string; unique: number }[];
  const eventSequenceUnique = eventIndexes.filter((index) => index.unique === 1).some((index) => {
    const columns = db.prepare("SELECT name FROM pragma_index_info(?) ORDER BY seqno").all(index.name) as { name: string }[];
    return JSON.stringify(columns.map((column) => column.name)) === JSON.stringify(["project_id", "sequence"]);
  });
  if (!eventSequenceUnique) throw new Error("Database schema is missing the unique event sequence constraint.");
  const requiredForeignKeys = [
    { query: "PRAGMA foreign_key_list(entities)", from: "project_id" },
    { query: "PRAGMA foreign_key_list(project_sequences)", from: "project_id" },
    { query: "PRAGMA foreign_key_list(aggregate_revisions)", from: "project_id" },
    { query: "PRAGMA foreign_key_list(domain_events)", from: "project_id" },
  ] as const;
  for (const expected of requiredForeignKeys) {
    const foreignKeys = db.prepare(expected.query).all() as { table: string; from: string; to: string }[];
    if (!foreignKeys.some((key) => key.table === "projects" && key.from === expected.from && key.to === "id")) {
      throw new Error("Database schema is missing a required project foreign key.");
    }
  }
  const actualObjects = db.prepare(
    "SELECT type, name, sql FROM sqlite_master WHERE type IN ('table','index','view','trigger') AND substr(name,1,7)<>'sqlite_' ORDER BY type,name"
  ).all() as { type: string; name: string; sql: string }[];
  const expectedObjects = supportedSchemaObjects().sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
  const normalizeDdl = (sql: string): string => sql.replace(/\s+/g, " ").trim();
  const normalizedActual = actualObjects.map((object) => ({ ...object, sql: normalizeDdl(object.sql) }));
  const normalizedExpected = expectedObjects.map((object) => ({ ...object, sql: normalizeDdl(object.sql) }));
  if (JSON.stringify(normalizedActual) !== JSON.stringify(normalizedExpected)) {
    throw new Error("Database DDL differs from the supported ADE schema.");
  }
}
async function backupStableSnapshot(source: LocalSqliteEventStore, destinationPath: string): Promise<void> {
  await source.backupSnapshotTo(destinationPath);
}
function deleteUnselectedEvidence(db: DatabaseSync, selections: readonly { projectId: string; evidenceId: string }[]): void {
  const unique = [...new Map<string, { projectId: string; evidenceId: string }>(selections.map((item) => [JSON.stringify([item.projectId, item.evidenceId]), item] as const)).values()];
  if (unique.some((item) => !item.projectId || !item.evidenceId || item.projectId.length > 200 || item.evidenceId.length > 200)) throw new TypeError("Evidence selection contains an invalid project/entity key.");
  db.exec("BEGIN IMMEDIATE");
  try {
    if (unique.length === 0) db.prepare("DELETE FROM entities WHERE entity_type='evidence'").run();
    else {
      const predicate = unique.map(() => "(project_id=? AND entity_id=?)").join(" OR ");
      const params = unique.flatMap((item) => [item.projectId, item.evidenceId]);
      db.prepare("DELETE FROM entities WHERE entity_type='evidence' AND NOT (" + predicate + ")").run(...params);
    }
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

/** SQLite online backup includes committed WAL content. A pre-existing destination is never overwritten. */
export async function exportConsistentDatabase(source: LocalSqliteEventStore, destinationPath: string, selectedEvidence: readonly { projectId: string; evidenceId: string }[]): Promise<void> {
  if (existsSync(destinationPath)) throw new Error("Export destination already exists.");
  const workDir = mkdtempSync(join(tmpdir(), "ade-export-"));
  const fullCopy = join(workDir, "full.sqlite"), selectedCopy = join(workDir, "selected.sqlite");
  try {
    await backupStableSnapshot(source, fullCopy);
    const staged = new DatabaseSync(fullCopy);
    try {
      staged.exec("PRAGMA foreign_keys=ON;");
      deleteUnselectedEvidence(staged, selectedEvidence);
      assertIntegrity(staged);
      await backup(staged, selectedCopy);
    } finally { staged.close(); }
    const verified = new DatabaseSync(selectedCopy, { readOnly: true });
    try { assertIntegrity(verified); } finally { verified.close(); }
    copyFileSync(selectedCopy, destinationPath, fsConstants.COPYFILE_EXCL);
  } finally { rmSync(workDir, { recursive: true, force: true }); }
}

/** Restore only creates a new destination after validating a fresh online-backup copy. */
export async function restoreVerifiedDatabase(sourcePath: string, destinationPath: string): Promise<void> {
  if (existsSync(destinationPath)) throw new Error("Restore destination already exists; refusing to overwrite it.");
  const workDir = mkdtempSync(join(tmpdir(), "ade-restore-"));
  const stagedPath = join(workDir, "restored.sqlite");
  try {
    const source = new DatabaseSync(sourcePath, { readOnly: true });
    try { assertIntegrity(source); await backup(source, stagedPath); }
    finally { source.close(); }
    const restored = new DatabaseSync(stagedPath, { readOnly: true });
    try { assertIntegrity(restored); } finally { restored.close(); }
    copyFileSync(stagedPath, destinationPath, fsConstants.COPYFILE_EXCL);
  } finally { rmSync(workDir, { recursive: true, force: true }); }
}


