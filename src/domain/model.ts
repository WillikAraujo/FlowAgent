export const ENTITY_TYPES = [
  "project", "agent", "agentProfile", "task", "session", "execution",
  "note", "decision", "approval", "evidence",
] as const;

export type EntityType = (typeof ENTITY_TYPES)[number];
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface EntityRecord<T extends JsonObject = JsonObject> {
  projectId: string; entityId: string; entityType: EntityType; revision: number;
  data: T; createdAt: string; updatedAt: string;
}
export interface DomainEvent<T extends JsonObject = JsonObject> {
  eventId: string; projectId: string; entityId: string; entityType: EntityType;
  sequence: number; revision: number; occurredAt: string;
  origin: "main" | "renderer" | "adapter" | "system";
  type: string; payload: T; correlationId?: string;
}
export interface CommitChange<T extends JsonObject = JsonObject> {
  eventId?: string; projectId: string; entityId: string; entityType: EntityType;
  occurredAt?: string; origin: DomainEvent["origin"]; type: string; payload: T;
  entityData: JsonObject; correlationId?: string; expectedRevision?: number;
}
export type ReplayResult =
  | { kind: "events"; events: DomainEvent[]; nextSequence: number; latestSequence: number }
  | { kind: "resync"; reason: "invalid-cursor" | "sequence-gap"; snapshotSequence: number };

export interface ProjectSnapshot {
  projectId: string;
  sequence: number;
  project: EntityRecord | undefined;
  entities: EntityRecord[];
}
