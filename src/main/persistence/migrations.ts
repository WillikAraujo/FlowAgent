import type { DatabaseSync } from "node:sqlite";

export const CURRENT_SCHEMA_VERSION = 2;
interface Migration { version: number; up: string; down: string }
const initialSchema = [
  "CREATE TABLE projects (id TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(revision>=1), data_json TEXT NOT NULL CHECK(json_valid(data_json)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
  "CREATE TABLE entities (project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, entity_type TEXT NOT NULL CHECK(entity_type IN ('agent','agentProfile','task','session','execution','note','decision','approval','evidence')), entity_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>=1), data_json TEXT NOT NULL CHECK(json_valid(data_json)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(project_id,entity_type,entity_id))",
  "CREATE TABLE project_sequences (project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE, sequence INTEGER NOT NULL CHECK(sequence>=0))",
  "CREATE TABLE aggregate_revisions (project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>=1), PRIMARY KEY(project_id,entity_type,entity_id))",
  "CREATE TABLE domain_events (event_id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, sequence INTEGER NOT NULL CHECK(sequence>=1), entity_id TEXT NOT NULL, entity_type TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>=1), occurred_at TEXT NOT NULL, origin TEXT NOT NULL CHECK(origin IN ('main','renderer','adapter','system')), type TEXT NOT NULL, payload_json TEXT NOT NULL CHECK(json_valid(payload_json)), correlation_id TEXT, UNIQUE(project_id,sequence))",
  "CREATE INDEX domain_events_project_cursor ON domain_events(project_id,sequence)",
  "CREATE INDEX domain_events_aggregate ON domain_events(project_id,entity_type,entity_id,revision)",
  "CREATE INDEX entities_project_type ON entities(project_id,entity_type)",
].join(";\n");
const entitiesV1 = initialSchema.split(';\n')[1];
const entitiesV2 = entitiesV1.replace("'approval','evidence'", "'approval','evidence','message','memory'");
const collaborationIndexes = [
  "CREATE INDEX entities_collaboration_scope ON entities(project_id,entity_type,json_extract(data_json,'$.scope'),json_extract(data_json,'$.ownerAgentId'))",
  "CREATE INDEX entities_message_inbox ON entities(project_id,entity_type,json_extract(data_json,'$.toAgentId'),json_extract(data_json,'$.state'))",
];
function replaceEntities(ddl: string): string {
  return [
    'ALTER TABLE entities RENAME TO entities_previous', ddl,
    'INSERT INTO entities SELECT * FROM entities_previous',
    'DROP TABLE entities_previous',
    'CREATE INDEX entities_project_type ON entities(project_id,entity_type)',
  ].join(';\n');
}
const migrations: Migration[] = [{
  version: 1,
  up: initialSchema,
  down: [
    "DROP TABLE IF EXISTS domain_events", "DROP TABLE IF EXISTS aggregate_revisions",
    "DROP TABLE IF EXISTS project_sequences",
    "DROP TABLE IF EXISTS entities", "DROP TABLE IF EXISTS projects",
  ].join(";\n"),
}, { version: 2, up: [replaceEntities(entitiesV2), ...collaborationIndexes].join(';\n'), down: replaceEntities(entitiesV1) }];

/** Full supported DDL for restore validation; changes require a schema version bump. */
export function supportedSchemaObjects(version = CURRENT_SCHEMA_VERSION): { type: string; name: string; sql: string }[] {
  const objects = [{
    type: "table",
    name: "schema_migrations",
    sql: "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
  }];
  const schema = initialSchema.split(';\n').map(sql => version >= 2 && sql === entitiesV1 ? entitiesV2 : sql);
  if (version >= 2) schema.push(...collaborationIndexes);
  for (const sql of schema) {
    const match = /^CREATE (TABLE|INDEX) ([A-Za-z_][A-Za-z0-9_]*)/.exec(sql);
    if (!match) throw new Error("Migration contains an unsupported schema statement.");
    objects.push({ type: match[1].toLowerCase(), name: match[2], sql });
  }
  return objects;
}

export function migrateDatabase(db: DatabaseSync, targetVersion = CURRENT_SCHEMA_VERSION): number {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const applied = db.prepare("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1").get() as { version: number } | undefined;
  let current = applied?.version ?? 0;
  if (current > CURRENT_SCHEMA_VERSION) throw new Error('Unsupported future database schema.');
  if (targetVersion > (migrations.at(-1)?.version ?? 0) || targetVersion < 0) throw new Error("Unsupported migration target.");
  while (current < targetVersion) {
    const migration = migrations.find((item) => item.version === current + 1);
    if (!migration) throw new Error("Missing migration " + (current + 1) + ".");
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(migration.up);
      db.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES (?,?)").run(migration.version, new Date().toISOString());
      db.exec("COMMIT");
      current = migration.version;
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  while (current > targetVersion) {
    if (current === 2 && db.prepare("SELECT 1 FROM entities WHERE entity_type IN ('message','memory') LIMIT 1").get()) {
      throw new Error('Cannot downgrade a database containing collaboration records.');
    }
    const migration = migrations.find((item) => item.version === current);
    if (!migration) throw new Error("Missing down migration " + current + ".");
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(migration.down);
      db.prepare("DELETE FROM schema_migrations WHERE version=?").run(migration.version);
      db.exec("COMMIT");
      current -= 1;
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  return current;
}

