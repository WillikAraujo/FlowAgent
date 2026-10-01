import { constants as fsConstants, copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import type { EntityType, JsonObject } from "../../domain/model.ts";
import { validateCommitChange, validateDomainEvent, validateJsonObject } from "../../shared/contracts/domain.ts";
import { CURRENT_SCHEMA_VERSION, supportedSchemaObjects, migrateDatabase } from "./migrations.ts";
import type { LocalSqliteEventStore } from "./sqlite-store.ts";

const requiredTables = [
  { name: "schema_migrations", pragma: "PRAGMA table_info(schema_migrations)", columns: ["version", "applied_at"], primaryKey: ["version"] },
  { name: "projects", pragma: "PRAGMA table_info(projects)", columns: ["id", "revision", "data_json", "created_at", "updated_at"], primaryKey: ["id"] },
  { name: "entities", pragma: "PRAGMA table_info(entities)", columns: ["project_id", "entity_type", "entity_id", "revision", "data_json", "created_at", "updated_at"], primaryKey: ["project_id", "entity_type", "entity_id"] },
  { name: "project_sequences", pragma: "PRAGMA table_info(project_sequences)", columns: ["project_id", "sequence"], primaryKey: ["project_id"] },
  { name: "aggregate_revisions", pragma: "PRAGMA table_info(aggregate_revisions)", columns: ["project_id", "entity_type", "entity_id", "revision"], primaryKey: ["project_id", "entity_type", "entity_id"] },
  { name: "domain_events", pragma: "PRAGMA table_info(domain_events)", columns: ["event_id", "request_hash", "project_id", "sequence", "entity_id", "entity_type", "revision", "occurred_at", "origin", "type", "payload_json", "correlation_id"], primaryKey: ["event_id"] },
] as const;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => JSON.stringify(key) + ":" + canonical(item)).join(",") + "}";
  return JSON.stringify(value) ?? "null";
}

function assertIntegrity(db: DatabaseSync): void {
  const result = db.prepare("PRAGMA integrity_check").all() as { integrity_check: string }[];
  if (result.length !== 1 || result[0].integrity_check !== "ok") throw new Error("SQLite integrity check failed.");
  if (db.prepare("PRAGMA foreign_key_check").all().length !== 0) throw new Error("SQLite foreign-key check failed.");
  const versions = db.prepare("SELECT version FROM schema_migrations ORDER BY version ASC").all() as { version: number }[];
  if (versions.length < 1 || versions.length > CURRENT_SCHEMA_VERSION || versions.some((item, index) => item.version !== index + 1)) {
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
  const expectedObjects = supportedSchemaObjects(versions.length).sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
  const normalizeDdl = (sql: string): string => sql.replace(/\s+/g, " ").trim();
  const normalizedActual = actualObjects.map((object) => ({ ...object, sql: normalizeDdl(object.sql) }));
  const normalizedExpected = expectedObjects.map((object) => ({ ...object, sql: normalizeDdl(object.sql) }));
  if (JSON.stringify(normalizedActual) !== JSON.stringify(normalizedExpected)) {
    throw new Error("Database DDL differs from the supported ADE schema.");
  }
  assertDomainContent(db);
}

function parsePersistedObject(serialized: string): JsonObject {
  let parsed: unknown;
  try { parsed = JSON.parse(serialized); }
  catch { throw new Error("Database contains invalid domain JSON."); }
  const validated = validateJsonObject(parsed);
  // Validators redact known token formats on new writes. A restore must reject
  // such legacy/tampered values instead of silently normalizing imported data.
  if (JSON.stringify(validated) !== JSON.stringify(parsed)) {
    throw new Error("Database contains prohibited or unredacted domain content.");
  }
  return validated;
}

function assertDomainContent(db: DatabaseSync): void {
  const projects = db.prepare("SELECT id,revision,data_json,created_at,updated_at FROM projects").all() as {
    id: string; revision: number; data_json: string; created_at: string; updated_at: string;
  }[];
  for (const row of projects) {
    const entityData = parsePersistedObject(row.data_json);
    validateCommitChange({ projectId: row.id, entityId: row.id, entityType: "project", entityData,
      origin: "system", type: "restore.validation", payload: {} });
    if (!Number.isSafeInteger(row.revision) || row.revision < 1 || !Number.isFinite(Date.parse(row.created_at)) || !Number.isFinite(Date.parse(row.updated_at))) {
      throw new Error("Database contains invalid project metadata.");
    }
  }
  const entities = db.prepare("SELECT project_id,entity_type,entity_id,revision,data_json,created_at,updated_at FROM entities").all() as {
    project_id: string; entity_type: string; entity_id: string; revision: number; data_json: string; created_at: string; updated_at: string;
  }[];
  const projectRows = new Map(projects.map((row) => [row.id, row]));
  const entityRows = new Map(entities.map((row) => [JSON.stringify([row.project_id, row.entity_type, row.entity_id]), row]));
  for (const row of entities) {
    const entityData = parsePersistedObject(row.data_json);
    validateCommitChange({ projectId: row.project_id, entityId: row.entity_id, entityType: row.entity_type as EntityType,
      entityData, origin: "system", type: "restore.validation", payload: {} });
    if (!Number.isSafeInteger(row.revision) || row.revision < 1 || !Number.isFinite(Date.parse(row.created_at)) || !Number.isFinite(Date.parse(row.updated_at))) {
      throw new Error("Database contains invalid entity metadata.");
    }
  }
  const events = db.prepare("SELECT event_id,request_hash,project_id,sequence,entity_id,entity_type,revision,occurred_at,origin,type,payload_json,correlation_id FROM domain_events ORDER BY project_id,sequence").all() as {
    event_id: string; request_hash: string; project_id: string; sequence: number; entity_id: string; entity_type: string; revision: number;
    occurred_at: string; origin: string; type: string; payload_json: string; correlation_id: string | null;
  }[];
  const nextProjectSequence = new Map<string, number>();
  const aggregateRevisions = new Map<string, number>();
  const latestEvents = new Map<string, { row: (typeof events)[number]; payload: JsonObject }>();
  for (const row of events) {
    const payload = parsePersistedObject(row.payload_json);
    validateDomainEvent({ eventId: row.event_id, projectId: row.project_id, sequence: row.sequence, entityId: row.entity_id,
      entityType: row.entity_type, revision: row.revision, occurredAt: row.occurred_at, origin: row.origin,
      type: row.type, payload, ...(row.correlation_id === null ? {} : { correlationId: row.correlation_id }) });
    if (!/^[a-f0-9]{64}$/i.test(row.request_hash)) throw new Error("Database contains an invalid event idempotency hash.");
    const expectedSequence = (nextProjectSequence.get(row.project_id) ?? 0) + 1;
    if (row.sequence !== expectedSequence) throw new Error("Database event sequence is inconsistent.");
    nextProjectSequence.set(row.project_id, expectedSequence);
    const aggregateKey = JSON.stringify([row.project_id, row.entity_type, row.entity_id]);
    const expectedRevision = (aggregateRevisions.get(aggregateKey) ?? 0) + 1;
    if (row.revision !== expectedRevision) throw new Error("Database event revision is inconsistent.");
    aggregateRevisions.set(aggregateKey, expectedRevision);
    latestEvents.set(aggregateKey, { row, payload });
  }
  const sequences = db.prepare("SELECT project_id,sequence FROM project_sequences").all() as { project_id: string; sequence: number }[];
  if (sequences.length !== nextProjectSequence.size || sequences.some((row) => row.sequence !== nextProjectSequence.get(row.project_id))) {
    throw new Error("Database project sequence counter is inconsistent with its event log.");
  }
  const revisions = db.prepare("SELECT project_id,entity_type,entity_id,revision FROM aggregate_revisions").all() as {
    project_id: string; entity_type: string; entity_id: string; revision: number;
  }[];
  if (revisions.length !== aggregateRevisions.size || revisions.some((row) => row.revision !== aggregateRevisions.get(JSON.stringify([row.project_id, row.entity_type, row.entity_id])))) {
    throw new Error("Database aggregate revisions are inconsistent with its event log.");
  }
  if (projects.some((row) => row.revision !== aggregateRevisions.get(JSON.stringify([row.id, "project", row.id])))) {
    throw new Error("Database project revision is inconsistent with its event log.");
  }
  if (entities.some((row) => row.revision !== aggregateRevisions.get(JSON.stringify([row.project_id, row.entity_type, row.entity_id])))) {
    throw new Error("Database entity revision is inconsistent with its event log.");
  }
  for (const [aggregateKey, revision] of aggregateRevisions) {
    const [projectId, entityType, entityId] = JSON.parse(aggregateKey) as [string, string, string];
    const current = entityType === "project" ? projectRows.get(projectId) : entityRows.get(aggregateKey);
    if (!current || current.revision !== revision) throw new Error("Database event aggregate has no matching current entity.");
    const latest = latestEvents.get(aggregateKey)!;
    const entityData = parsePersistedObject(current.data_json);
    const hashInput = {
      projectId, entityId, entityType, origin: latest.row.origin, type: latest.row.type,
      payload: latest.payload, entityData, correlationId: latest.row.correlation_id ?? null,
    };
    const candidates = [null, latest.row.occurred_at].map((occurredAt) => createHash("sha256")
      .update(canonical({ ...hashInput, occurredAt })).digest("hex"));
    if (!candidates.includes(latest.row.request_hash.toLowerCase())) {
      throw new Error("Latest event idempotency hash does not match its current aggregate snapshot.");
    }
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
    let predicate = "";
    let params: string[] = [];
    if (unique.length === 0) {
      db.prepare("DELETE FROM entities WHERE entity_type='evidence'").run();
      db.prepare("DELETE FROM domain_events WHERE entity_type='evidence'").run();
      db.prepare("DELETE FROM aggregate_revisions WHERE entity_type='evidence'").run();
    }
    else {
      predicate = unique.map(() => "(project_id=? AND entity_id=?)").join(" OR ");
      params = unique.flatMap((item) => [item.projectId, item.evidenceId]);
      db.prepare("DELETE FROM entities WHERE entity_type='evidence' AND NOT (" + predicate + ")").run(...params);
      db.prepare("DELETE FROM domain_events WHERE entity_type='evidence' AND NOT (" + predicate + ")").run(...params);
      db.prepare("DELETE FROM aggregate_revisions WHERE entity_type='evidence' AND NOT (" + predicate + ")").run(...params);
    }

    // The export is a filtered event-log projection. Re-number retained durable
    // events so every project still replays from cursor 0 without gaps.
    const rows = db.prepare("SELECT project_id,event_id,sequence FROM domain_events ORDER BY project_id,sequence").all() as {
      project_id: string; event_id: string; sequence: number;
    }[];
    const groups = new Map<string, typeof rows>();
    for (const row of rows) {
      const group = groups.get(row.project_id);
      if (group) group.push(row); else groups.set(row.project_id, [row]);
    }
    const shift = db.prepare("UPDATE domain_events SET sequence=sequence+? WHERE project_id=?");
    const renumber = db.prepare("UPDATE domain_events SET sequence=? WHERE event_id=?");
    const setProjectSequence = db.prepare("UPDATE project_sequences SET sequence=? WHERE project_id=?");
    for (const [projectId, events] of groups) {
      const maximum = events.at(-1)?.sequence ?? 0;
      if (!Number.isSafeInteger(maximum) || maximum >= Number.MAX_SAFE_INTEGER / 2) throw new Error("Export event sequence exceeds the supported range.");
      if (maximum > 0) shift.run(maximum + 1, projectId);
      events.forEach((event, index) => renumber.run(index + 1, event.event_id));
      setProjectSequence.run(events.length, projectId);
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
    const restored = new DatabaseSync(stagedPath);
    try { migrateDatabase(restored); assertIntegrity(restored); } finally { restored.close(); }
    copyFileSync(stagedPath, destinationPath, fsConstants.COPYFILE_EXCL);
  } finally { rmSync(workDir, { recursive: true, force: true }); }
}


