import { createHash, randomUUID } from "node:crypto";
import { backup, DatabaseSync } from "node:sqlite";
import type { CommitChange, DomainEvent, EntityRecord, EntityType, JsonObject, ProjectSnapshot, ReplayResult } from "../../domain/model.ts";
import { validateCommitChange, validateDomainEvent, validateJsonObject } from "../../shared/contracts/domain.ts";
import { migrateDatabase } from "./migrations.ts";
import { assertDatabasePathWritable, acquireExportLock, assertDatabaseWritable, databaseKeyForPath, registerDatabaseHandle, PersistenceBusyError } from "./database-gate.ts";

type EventRow = {
  event_id: string; request_hash: string; project_id: string; sequence: number;
  entity_id: string; entity_type: EntityType; revision: number; occurred_at: string;
  origin: DomainEvent["origin"]; type: string; payload_json: string; correlation_id: string | null;
};
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.entries(value).sort(([a],[b]) => a.localeCompare(b))
    .map(([key,item]) => JSON.stringify(key) + ":" + canonical(item)).join(",") + "}";
  return JSON.stringify(value) ?? "null";
}
function eventFromRow(row: EventRow): DomainEvent {
  return validateDomainEvent({
    eventId: row.event_id, projectId: row.project_id, sequence: row.sequence, entityId: row.entity_id,
    entityType: row.entity_type, revision: row.revision, occurredAt: row.occurred_at, origin: row.origin,
    type: row.type, payload: JSON.parse(row.payload_json), ...(row.correlation_id ? { correlationId: row.correlation_id } : {}),
  });
}
export class RevisionConflictError extends Error {
  readonly expected: number;
  readonly actual: number;
  constructor(expected: number, actual: number) {
    super("Entity revision conflict (expected " + expected + ", found " + actual + ").");
    this.name = "RevisionConflictError"; this.expected = expected; this.actual = actual;
  }
}
export { PersistenceBusyError };
export class EventIdConflictError extends Error {
  constructor() { super("eventId is already associated with a different change."); this.name = "EventIdConflictError"; }
}
export class EventStoreIntegrityError extends Error {
  constructor(message: string) { super(message); this.name = "EventStoreIntegrityError"; }
}

export class LocalSqliteEventStore {
  #db: DatabaseSync;
  private batching = false;
  private pendingEvents: DomainEvent[] = [];
  private readonly listeners = new Set<(event: DomainEvent) => void>();
  subscribe(listener: (event: DomainEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  private publish(event: DomainEvent): void {
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* committed writes cannot be undone by observers */ }
    }
  }
  commitBatch(changes: CommitChange[]): DomainEvent[] {
    assertDatabaseWritable(this.#db);
    if (this.batching) throw new Error('Nested commit batches are not supported.');
    this.#db.exec('BEGIN IMMEDIATE');
    this.batching = true;
    this.pendingEvents = [];
    let events: DomainEvent[];
    try {
      events = changes.map(change => this.commit(change));
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      this.pendingEvents = [];
      throw error;
    } finally { this.batching = false; }
    const committed = this.pendingEvents;
    this.pendingEvents = [];
    for (const event of committed) this.publish(event);
    return events;
  }
  constructor(path: string | Buffer | URL) {
    const databaseKey = databaseKeyForPath(path);
    assertDatabasePathWritable(databaseKey);
    this.#db = new DatabaseSync(path);
    registerDatabaseHandle(this.#db, databaseKey);
    this.#db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
    migrateDatabase(this.#db);
  }
  close(): void { assertDatabaseWritable(this.#db); this.#db.close(); }

  async backupSnapshotTo(destinationPath: string): Promise<void> {
    const release = acquireExportLock(this.#db);
    try { await backup(this.#db, destinationPath); }
    finally { release(); }
  }

  commit(input: CommitChange): DomainEvent {
    assertDatabaseWritable(this.#db);
    const change = validateCommitChange(input);
    const eventId = change.eventId ?? randomUUID();
    const occurredAt = change.occurredAt ?? new Date().toISOString();
    const payloadJson = canonical(change.payload);
    const entityJson = canonical(change.entityData);
    const requestHash = createHash("sha256").update(canonical({
      projectId: change.projectId, entityId: change.entityId, entityType: change.entityType,
      occurredAt: change.occurredAt ?? null, origin: change.origin, type: change.type, payload: change.payload,
      entityData: change.entityData, correlationId: change.correlationId ?? null,
    })).digest("hex");

    if (!this.batching) this.#db.exec("BEGIN IMMEDIATE");
    try {
      const duplicate = this.#db.prepare("SELECT * FROM domain_events WHERE event_id=?").get(eventId) as EventRow | undefined;
      if (duplicate) {
        if (duplicate.request_hash !== requestHash) throw new EventIdConflictError();
        const prior = eventFromRow(duplicate);
        if (!this.batching) this.#db.exec("COMMIT");
        return prior;
      }
      const project = this.#db.prepare("SELECT id FROM projects WHERE id=?").get(change.projectId);
      if (!project && change.entityType !== "project") throw new Error("Project must be created before its entities.");
      if (change.entityType === "project" && !project) {
        this.#db.prepare("INSERT INTO projects(id,revision,data_json,created_at,updated_at) VALUES (?,1,?,?,?)")
          .run(change.projectId, entityJson, occurredAt, occurredAt);
      }
      const aggregate = this.#db.prepare("SELECT revision FROM aggregate_revisions WHERE project_id=? AND entity_type=? AND entity_id=?")
        .get(change.projectId, change.entityType, change.entityId) as { revision: number } | undefined;
      const actualRevision = aggregate?.revision ?? 0;
      if (change.expectedRevision !== undefined && change.expectedRevision !== actualRevision) {
        throw new RevisionConflictError(change.expectedRevision, actualRevision);
      }
      const sequence = this.#db.prepare(
        "INSERT INTO project_sequences(project_id,sequence) VALUES (?,1) ON CONFLICT(project_id) DO UPDATE SET sequence=sequence+1 RETURNING sequence"
      ).get(change.projectId) as { sequence: number };
      const revision = this.#db.prepare(
        "INSERT INTO aggregate_revisions(project_id,entity_type,entity_id,revision) VALUES (?,?,?,1) ON CONFLICT(project_id,entity_type,entity_id) DO UPDATE SET revision=revision+1 RETURNING revision"
      ).get(change.projectId, change.entityType, change.entityId) as { revision: number };

      if (change.entityType === "project") {
        this.#db.prepare("UPDATE projects SET revision=?,data_json=?,updated_at=? WHERE id=?").run(revision.revision, entityJson, occurredAt, change.projectId);
      } else {
        this.#db.prepare(
          "INSERT INTO entities(project_id,entity_type,entity_id,revision,data_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(project_id,entity_type,entity_id) DO UPDATE SET revision=excluded.revision,data_json=excluded.data_json,updated_at=excluded.updated_at"
        ).run(change.projectId, change.entityType, change.entityId, revision.revision, entityJson, occurredAt, occurredAt);
      }
      this.#db.prepare(
        "INSERT INTO domain_events(event_id,request_hash,project_id,sequence,entity_id,entity_type,revision,occurred_at,origin,type,payload_json,correlation_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)"
      ).run(eventId, requestHash, change.projectId, sequence.sequence, change.entityId, change.entityType, revision.revision,
        occurredAt, change.origin, change.type, payloadJson, change.correlationId ?? null);
      const event = validateDomainEvent({
        eventId, projectId: change.projectId, sequence: sequence.sequence, entityId: change.entityId,
        entityType: change.entityType, revision: revision.revision, occurredAt, origin: change.origin,
        type: change.type, payload: change.payload, ...(change.correlationId ? { correlationId: change.correlationId } : {}),
      });
      if (this.batching) this.pendingEvents.push(event);
      else { this.#db.exec("COMMIT"); this.publish(event); }
      return event;
    } catch (error) { if (!this.batching) this.#db.exec("ROLLBACK"); throw error; }
  }

  getEntity<T extends JsonObject = JsonObject>(projectId: string, entityType: EntityType, entityId: string): EntityRecord<T> | undefined {
    const row = entityType === "project"
      ? this.#db.prepare("SELECT revision,data_json,created_at,updated_at FROM projects WHERE id=?").get(projectId)
      : this.#db.prepare("SELECT revision,data_json,created_at,updated_at FROM entities WHERE project_id=? AND entity_type=? AND entity_id=?").get(projectId, entityType, entityId);
    const record = row as { revision:number; data_json:string; created_at:string; updated_at:string } | undefined;
    if (!record) return undefined;
    return {
      projectId, entityId: entityType === "project" ? projectId : entityId, entityType, revision: record.revision,
      data: validateJsonObject(JSON.parse(record.data_json)) as T, createdAt: record.created_at, updatedAt: record.updated_at,
    };
  }

  listEntities<T extends JsonObject = JsonObject>(projectId: string, entityType: EntityType, afterEntityId = "", limit = 500): EntityRecord<T>[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5000) throw new RangeError("Entity list limit must be between 1 and 5000.");
    if (entityType === "project") {
      const project = this.getEntity<T>(projectId, "project", projectId);
      return project && project.entityId > afterEntityId ? [project] : [];
    }
    const rows = this.#db.prepare("SELECT entity_id FROM entities WHERE project_id=? AND entity_type=? AND entity_id>? ORDER BY entity_id ASC LIMIT ?")
      .all(projectId, entityType, afterEntityId, limit) as unknown as { entity_id: string }[];
    return rows.flatMap((row) => {
      const entity = this.getEntity<T>(projectId, entityType, row.entity_id);
      return entity ? [entity] : [];
    });
  }
  listAggregateEvents(projectId: string, entityType: EntityType, entityId: string, limit = 500): DomainEvent[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5000) throw new RangeError("Aggregate event limit must be between 1 and 5000.");
    const rows = this.#db.prepare("SELECT * FROM domain_events WHERE project_id=? AND entity_type=? AND entity_id=? ORDER BY revision DESC LIMIT ?")
      .all(projectId, entityType, entityId, limit) as unknown as EventRow[];
    return rows.reverse().map(eventFromRow);
  }

  listProjects(afterProjectId = "", limit = 500): EntityRecord[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5000) throw new RangeError("Project list limit must be between 1 and 5000.");
    const rows = this.#db.prepare("SELECT id FROM projects WHERE id>? ORDER BY id ASC LIMIT ?")
      .all(afterProjectId, limit) as unknown as { id: string }[];
    return rows.flatMap((row) => {
      const entity = this.getEntity(row.id, "project", row.id);
      return entity ? [entity] : [];
    });
  }
  readSnapshot(projectId: string): ProjectSnapshot {
    this.#db.exec("BEGIN");
    try {
      const project = this.getEntity(projectId, "project", projectId);
      const rows = this.#db.prepare("SELECT entity_type,entity_id FROM entities WHERE project_id=? ORDER BY entity_type ASC,entity_id ASC")
        .all(projectId) as unknown as { entity_type: EntityType; entity_id: string }[];
      const entities = rows.flatMap((row) => {
        const entity = this.getEntity(projectId, row.entity_type, row.entity_id);
        return entity ? [entity] : [];
      });
      const sequence = this.latestSequence(projectId);
      this.#db.exec("COMMIT");
      return { projectId, sequence, project, entities };
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }
  latestSequence(projectId: string): number {
    const row = this.#db.prepare("SELECT sequence FROM project_sequences WHERE project_id=?").get(projectId) as { sequence:number } | undefined;
    return row?.sequence ?? 0;
  }
  readAfter(projectId: string, cursor: number, limit = 500): ReplayResult {
    if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 5000) throw new RangeError("Cursor and limit must be valid bounded integers.");
    const latestSequence = this.latestSequence(projectId);
    if (cursor > latestSequence) return { kind:"resync", reason:"invalid-cursor", snapshotSequence:latestSequence };
    if (cursor === latestSequence) return { kind:"events", events:[], nextSequence:cursor, latestSequence };
    const rows = this.#db.prepare("SELECT * FROM domain_events WHERE project_id=? AND sequence>? ORDER BY sequence ASC LIMIT ?")
      .all(projectId,cursor,limit) as unknown as EventRow[];
    const events = rows.map(eventFromRow);
    let expected = cursor + 1;
    for (const event of events) {
      if (event.sequence !== expected) return { kind:"resync", reason:"sequence-gap", snapshotSequence:latestSequence };
      expected += 1;
    }
    if (events.length === 0) return { kind:"resync", reason:"sequence-gap", snapshotSequence:latestSequence };
    return { kind:"events", events, nextSequence:events[events.length - 1].sequence, latestSequence };
  }
}









