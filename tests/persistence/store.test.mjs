import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { LocalSqliteEventStore, EventIdConflictError } from "../../src/main/persistence/sqlite-store.ts";
import { migrateDatabase, CURRENT_SCHEMA_VERSION } from "../../src/main/persistence/migrations.ts";
import { exportConsistentDatabase, restoreVerifiedDatabase } from "../../src/main/persistence/backup.ts";

function temp(t, fn) {
  const dir = mkdtempSync(join(tmpdir(), "ade-102-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return fn(dir);
}
function change(projectId, entityType, entityId, entityData, extra = {}) {
  return { eventId: randomUUID(), projectId, entityType, entityId, entityData, origin: "main",
    type: entityType + ".saved", payload: { state: "saved" }, ...extra };
}
const project = (id, extra = {}) => change(id, "project", id, { displayName: "Test", rootPath: "C:/test" }, extra);
function inspectDatabase(path, options = { readOnly: true }) { return new DatabaseSync(path, options); }

test("migrations create from scratch, are repeatable, and roll back", () => {
  const db = new DatabaseSync(":memory:");
  assert.equal(migrateDatabase(db), CURRENT_SCHEMA_VERSION);
  assert.equal(migrateDatabase(db), CURRENT_SCHEMA_VERSION);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='entity_relations'").get().n, 0);
  assert.equal(migrateDatabase(db, 0), 0);
  assert.equal(migrateDatabase(db), CURRENT_SCHEMA_VERSION);
  db.close();
});

test("a failed event insert rolls back entity, revision and sequence", (t) => temp(t, (dir) => {
  const path = join(dir, "db.sqlite"), store = new LocalSqliteEventStore(path);
  store.commit(project("rollback"));
  const setup = inspectDatabase(path, { readOnly: false });
  setup.exec("CREATE TRIGGER reject_event BEFORE INSERT ON domain_events BEGIN SELECT RAISE(ABORT,'forced failure'); END;");
  setup.close();
  assert.throws(() => store.commit(change("rollback", "task", "t1", { title: "T", status: "planned" })), /forced failure/);
  assert.equal(store.latestSequence("rollback"), 1);
  assert.equal(store.getEntity("rollback", "task", "t1"), undefined);
  store.close();
}));

test("commits survive restart and eventId duplicates are idempotent", (t) => temp(t, (dir) => {
  const path = join(dir, "db.sqlite"), store = new LocalSqliteEventStore(path);
  assert.equal("db" in store, false);
  store.commit(project("restart"));
  const task = change("restart", "task", "t1", { title: "First", status: "planned" });
  const first = store.commit(task);
  assert.equal(store.commit(task).eventId, first.eventId);
  assert.equal(store.latestSequence("restart"), 2);
  const note = change("restart", "note", "n1", { title: "Safe note", body: "Bearer abc123secret" }, { payload: { summary: "Bearer abc123secret" } });
  const redacted = store.commit(note);
  assert.equal(redacted.payload.summary, "[REDACTED]");
  const rawDb = inspectDatabase(path);
  assert.equal(rawDb.prepare("SELECT payload_json FROM domain_events WHERE event_id=?").get(redacted.eventId).payload_json.includes("abc123secret"), false);
  rawDb.close();
  assert.throws(() => store.commit({ ...task, entityData: { title: "Different", status: "planned" } }), EventIdConflictError);
  store.close();
  const reopened = new LocalSqliteEventStore(path);
  const replay = reopened.readAfter("restart", 0);
  assert.equal(replay.kind, "events");
  assert.deepEqual(replay.events.map((e) => e.sequence), [1, 2, 3]);
  assert.equal(reopened.getEntity("restart", "task", "t1").data.title, "First");
  assert.deepEqual(reopened.listEntities("restart", "task").map((entity) => entity.entityId), ["t1"]);
  assert.deepEqual(reopened.listProjects().map((entity) => entity.entityId), ["restart"]);
  assert.equal(reopened.getEntity("restart", "note", "n1").data.body, "[REDACTED]");
  reopened.close();
}));

test("token assignments are redacted before note and Evidence data reach SQLite or export", async (t) => temp(t, async (dir) => {
  const path = join(dir, "source.sqlite"), store = new LocalSqliteEventStore(path);
  store.commit(project("redact-export"));
  store.commit(change("redact-export", "note", "n-secret", { title: "N", body: "token=bare-secret; access_token=access-secret" }, { payload: { summary: "refresh_token=refresh-secret" } }));
  store.commit(change("redact-export", "evidence", "ev-secret", { artifactType: "report", displayName: "Review", uri: "file:///report?token=uri-secret&access_token=uri-access-secret" }, { payload: { sourceLabel: "refresh_token=label-secret" } }));
  const rawDb = inspectDatabase(path);
  const raw = rawDb.prepare("SELECT data_json FROM entities WHERE entity_type IN ('note','evidence') UNION ALL SELECT payload_json FROM domain_events WHERE entity_type IN ('note','evidence')").all();
  rawDb.close();
  const serialized = JSON.stringify(raw);
  for (const secret of ["bare-secret", "access-secret", "refresh-secret", "uri-secret", "uri-access-secret", "label-secret"]) assert.equal(serialized.includes(secret), false);
  const archive = join(dir, "export.sqlite");
  await exportConsistentDatabase(store, archive, [{ projectId: "redact-export", evidenceId: "ev-secret" }]);
  const exported = new DatabaseSync(archive, { readOnly: true });
  const exportedText = JSON.stringify(exported.prepare("SELECT data_json FROM entities UNION ALL SELECT payload_json FROM domain_events").all());
  for (const secret of ["bare-secret", "access-secret", "refresh-secret", "uri-secret", "uri-access-secret", "label-secret"]) assert.equal(exportedText.includes(secret), false);
  exported.close(); store.close();
}));

test("restore rejects future schema versions and incompatible structure before creating destination", async (t) => temp(t, async (dir) => {
  const future = join(dir, "future.sqlite"), incompatible = join(dir, "incompatible.sqlite");
  for (const path of [future, incompatible]) {
    const db = new DatabaseSync(path); migrateDatabase(db); db.close();
  }
  const futureDb = new DatabaseSync(future);
  futureDb.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES (?,?)").run(CURRENT_SCHEMA_VERSION + 1, new Date().toISOString());
  futureDb.close();
  const incompatibleDb = new DatabaseSync(incompatible);
  const originalEventsDdl = incompatibleDb.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='domain_events'").get().sql;
  incompatibleDb.exec("DROP TABLE domain_events");
  const changedEventsDdl = originalEventsDdl.replace("CHECK(sequence>=1)", "CHECK(sequence>=0)");
  assert.notEqual(changedEventsDdl, originalEventsDdl);
  incompatibleDb.exec(changedEventsDdl);
  incompatibleDb.exec("CREATE INDEX domain_events_project_cursor ON domain_events(project_id,sequence); CREATE INDEX domain_events_aggregate ON domain_events(project_id,entity_type,entity_id,revision)");
  incompatibleDb.close();
  for (const source of [future, incompatible]) {
    const destination = join(dir, source === future ? "future-destination.sqlite" : "incompatible-destination.sqlite");
    await assert.rejects(restoreVerifiedDatabase(source, destination));
    assert.equal(existsSync(destination), false);
  }
}));

test("restore rejects invalid or prohibited persisted domain content before creating destination", async (t) => temp(t, async (dir) => {
  const cases = [
    { name: "forbidden-key", sql: "UPDATE entities SET data_json=? WHERE entity_type='note'", value: JSON.stringify({ title: "N", access_token: "secret-value" }) },
    { name: "unredacted-token", sql: "UPDATE entities SET data_json=? WHERE entity_type='note'", value: JSON.stringify({ title: "N", body: "refresh_token=secret-value" }) },
    { name: "terminal-event", sql: "UPDATE domain_events SET payload_json=? WHERE type='note.saved'", value: JSON.stringify({ stdout: "terminal text" }) },
  ];
  for (const scenario of cases) {
    const sourcePath = join(dir, scenario.name + ".sqlite"), destination = join(dir, scenario.name + "-restore.sqlite");
    const store = new LocalSqliteEventStore(sourcePath);
    store.commit(project("restore-content"));
    store.commit(change("restore-content", "note", "n1", { title: "N", body: "safe" }));
    store.close();
    const tamper = new DatabaseSync(sourcePath);
    tamper.prepare(scenario.sql).run(scenario.value);
    tamper.close();
    await assert.rejects(restoreVerifiedDatabase(sourcePath, destination));
    assert.equal(existsSync(destination), false, scenario.name + " must be rejected before destination creation");
  }
}));

test("restore rejects an event aggregate without a current entity", async (t) => temp(t, async (dir) => {
  const sourcePath = join(dir, "orphan-event.sqlite"), destination = join(dir, "orphan-event-restore.sqlite");
  const store = new LocalSqliteEventStore(sourcePath);
  store.commit(project("orphan-event"));
  store.commit(change("orphan-event", "note", "n1", { title: "N", body: "safe" }));
  store.close();
  const tamper = new DatabaseSync(sourcePath);
  tamper.prepare("UPDATE domain_events SET entity_id='ghost' WHERE entity_type='note'").run();
  tamper.prepare("UPDATE aggregate_revisions SET entity_id='ghost' WHERE entity_type='note'").run();
  tamper.close();
  await assert.rejects(restoreVerifiedDatabase(sourcePath, destination));
  assert.equal(existsSync(destination), false);
}));

test("restore rejects a well-formed request hash that does not match the latest entity snapshot", async (t) => temp(t, async (dir) => {
  const sourcePath = join(dir, "hash-mismatch.sqlite"), destination = join(dir, "hash-mismatch-restore.sqlite");
  const store = new LocalSqliteEventStore(sourcePath);
  store.commit(project("hash-mismatch"));
  store.commit(change("hash-mismatch", "note", "n1", { title: "N", body: "safe" }));
  store.close();
  const tamper = new DatabaseSync(sourcePath);
  tamper.prepare("UPDATE domain_events SET request_hash=? WHERE entity_type='note'").run("f".repeat(64));
  tamper.close();
  await assert.rejects(restoreVerifiedDatabase(sourcePath, destination));
  assert.equal(existsSync(destination), false);
}));

test("replay order uses committed sequence, not occurredAt", (t) => temp(t, (dir) => {
  const store = new LocalSqliteEventStore(join(dir, "db.sqlite"));
  store.commit(project("order", { occurredAt: "2026-01-01T00:00:00.000Z" }));
  store.commit(change("order", "task", "t1", { title: "T", status: "planned" }, { occurredAt: "2024-01-01T00:00:00.000Z" }));
  store.commit(change("order", "note", "n1", { title: "N", body: "safe" }, { occurredAt: "2025-01-01T00:00:00.000Z" }));
  const firstPage = store.readAfter("order", 0, 2);
  assert.deepEqual(firstPage.events.map((e) => e.sequence), [1, 2]);
  assert.deepEqual(store.readAfter("order", 2).events.map((e) => e.sequence), [3]);
  store.close();
}));

test("future cursor and durable sequence gap require resync", (t) => temp(t, (dir) => {
  const store = new LocalSqliteEventStore(join(dir, "db.sqlite"));
  store.commit(project("gap"));
  store.commit(change("gap", "task", "t1", { title: "T", status: "planned" }));
  store.commit(change("gap", "note", "n1", { title: "N", body: "safe" }));
  assert.deepEqual(store.readAfter("gap", 99), { kind: "resync", reason: "invalid-cursor", snapshotSequence: 3 });
  const repairDb = inspectDatabase(join(dir, "db.sqlite"), { readOnly: false });
  repairDb.prepare("DELETE FROM domain_events WHERE project_id=? AND sequence=2").run("gap");
  repairDb.close();
  assert.deepEqual(store.readAfter("gap", 1), { kind: "resync", reason: "sequence-gap", snapshotSequence: 3 });
  const snapshot = store.readSnapshot("gap");
  assert.equal(snapshot.sequence, 3);
  assert.equal(snapshot.project.entityId, "gap");
  assert.equal(snapshot.entities.length, 2);
  store.close();
}));

test("online export filters unselected Evidence and restores a validated copy", async (t) => temp(t, async (dir) => {
  const sourcePath = join(dir, "source.sqlite"), source = new LocalSqliteEventStore(sourcePath);
  const secondHandle = new LocalSqliteEventStore(sourcePath);
  assert.equal("setRelation" in source, false);
  assert.equal("db" in source, false);
  source.commit(project("export"));
  source.commit(project("export-other"));
  const selectedEvent = source.commit(change("export", "evidence", "keep", { artifactType: "report", displayName: "Review", uri: "file:///review.md" }, { payload: { artifactType: "report", displayName: "Review", uri: "file:///selected-only.md" } }));
  const omittedEvent = source.commit(change("export", "evidence", "drop", { artifactType: "file", displayName: "Other", uri: "file:///other.bin" }, { payload: { artifactType: "file", displayName: "Other", uri: "file:///unselected-only.bin" } }));
  source.commit(change("export-other", "evidence", "keep", { artifactType: "report", displayName: "Other project", uri: "file:///other-project.md" }, { payload: { artifactType: "report", displayName: "Other project", uri: "file:///unselected-project.md" } }));
  const archive = join(dir, "export.sqlite"), restoredPath = join(dir, "restored.sqlite");
  const cursorBeforeExport = source.latestSequence("export");
  const projectRevisionBeforeExport = source.getEntity("export", "project", "export").revision;
  const probeDb = inspectDatabase(sourcePath);
  const eventCountBeforeExport = probeDb.prepare("SELECT COUNT(*) AS n FROM domain_events WHERE project_id=?").get("export").n;
  assert.equal(probeDb.prepare("SELECT payload_json FROM domain_events WHERE event_id=?").get(omittedEvent.eventId).payload_json.includes("unselected-only.bin"), true);
  probeDb.close();
  const exportTask = exportConsistentDatabase(source, archive, [{ projectId: "export", evidenceId: "keep" }]);
  assert.throws(() => source.commit(change("export", "note", "during-export", { title: "N", body: "safe" })), /being exported/);
  assert.throws(() => secondHandle.commit(change("export", "note", "second-handle", { title: "N", body: "safe" })), /being exported/);
  assert.equal(source.latestSequence("export"), cursorBeforeExport);
  assert.equal(source.getEntity("export", "project", "export").revision, projectRevisionBeforeExport);
  const verifyDb = inspectDatabase(sourcePath);
  assert.equal(verifyDb.prepare("SELECT COUNT(*) AS n FROM domain_events WHERE project_id=?").get("export").n, eventCountBeforeExport);
  verifyDb.close();
  assert.equal(source.getEntity("export", "note", "during-export"), undefined);
  assert.equal(source.readSnapshot("export").sequence, cursorBeforeExport);
  const replay = source.readAfter("export", cursorBeforeExport - 1);
  assert.equal(replay.kind, "events");
  assert.equal(replay.events.at(-1).sequence, cursorBeforeExport);
  await exportTask;
  await restoreVerifiedDatabase(archive, restoredPath);
  const restored = new DatabaseSync(restoredPath, { readOnly: true });
  assert.equal(restored.prepare("SELECT COUNT(*) AS n FROM entities WHERE entity_type='evidence'").get().n, 1);
  assert.equal(restored.prepare("SELECT entity_id FROM entities WHERE entity_type='evidence'").get().entity_id, "keep");
  assert.equal(restored.prepare("SELECT COUNT(*) AS n FROM domain_events").get().n, 3);
  const exportedEvents = restored.prepare("SELECT event_id,sequence,entity_type,payload_json FROM domain_events WHERE project_id='export' ORDER BY sequence").all();
  assert.deepEqual(exportedEvents.map((event) => event.sequence), [1, 2]);
  assert.equal(exportedEvents.some((event) => event.event_id === omittedEvent.eventId), false);
  assert.equal(exportedEvents.some((event) => event.event_id === selectedEvent.eventId), true);
  assert.equal(JSON.stringify(exportedEvents).includes("unselected-only.bin"), false);
  assert.equal(JSON.stringify(restored.prepare("SELECT payload_json FROM domain_events").all()).includes("unselected-project.md"), false);
  assert.equal(JSON.stringify(exportedEvents).includes("selected-only.md"), true);
  assert.equal(restored.prepare("SELECT sequence FROM project_sequences WHERE project_id='export'").get().sequence, 2);
  assert.equal(restored.prepare("SELECT COUNT(*) AS n FROM aggregate_revisions WHERE entity_type='evidence'").get().n, 1);
  assert.equal(restored.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  restored.close();
  const replayStore = new LocalSqliteEventStore(restoredPath);
  const replayFromExport = replayStore.readAfter("export", 0);
  assert.equal(replayFromExport.kind, "events");
  assert.deepEqual(replayFromExport.events.map((event) => event.sequence), [1, 2]);
  assert.equal(replayStore.readSnapshot("export").sequence, 2);
  replayStore.close();
  secondHandle.close(); source.close();
}));








