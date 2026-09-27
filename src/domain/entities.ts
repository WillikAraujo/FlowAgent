import type { EntityType, JsonObject } from "./model.ts";

export interface ProjectData extends JsonObject {
  displayName: string;
  rootPath: string;
}
export interface AgentData extends JsonObject {
  adapterId: string;
  displayName: string;
  detected: boolean;
  capabilities: JsonObject;
}
export interface AgentProfileData extends JsonObject {
  adapterId: string;
  profileId: string;
  displayName: string;
  settings: JsonObject;
}
export interface TaskData extends JsonObject {
  title: string;
  description: string;
  status: string;
  priority: number;
}
export interface SessionData extends JsonObject {
  agentId: string;
  status: string;
  resumable: boolean;
  providerSessionId: string | null;
}
export interface ExecutionData extends JsonObject {
  taskId: string;
  sessionId: string;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  summary: string | null;
}
export interface NoteData extends JsonObject {
  title: string;
  body: string;
}
export interface DecisionData extends JsonObject {
  title: string;
  context: string;
  outcome: string;
}
export interface ApprovalData extends JsonObject {
  action: string;
  scope: string;
  status: string;
}
export interface EvidenceMetadata extends JsonObject {
  artifactType: "file" | "patch" | "report" | "image" | "other";
  displayName: string;
  mediaType: string | null;
  sha256: string | null;
  sizeBytes: number | null;
  sourceLabel: string | null;
  uri: string | null;
}
export interface EntityPayloadMap {
  project: ProjectData;
  agent: AgentData;
  agentProfile: AgentProfileData;
  task: TaskData;
  session: SessionData;
  execution: ExecutionData;
  note: NoteData;
  decision: DecisionData;
  approval: ApprovalData;
  evidence: EvidenceMetadata;
}
export type EntityOfType<K extends EntityType> = EntityPayloadMap[K];

export class DomainRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DomainRuleError";
  }
}

/** Pure optimistic-concurrency rule shared by repository callers. */
export function nextRevision(currentRevision: number, expectedRevision?: number): number {
  if (!Number.isSafeInteger(currentRevision) || currentRevision < 0) {
    throw new DomainRuleError("Current revision must be a non-negative integer.");
  }
  if (expectedRevision !== undefined && expectedRevision !== currentRevision) {
    throw new DomainRuleError("Expected revision does not match current revision.");
  }
  return currentRevision + 1;
}

export function entityKey(projectId: string, entityType: EntityType, entityId: string): string {
  if (!projectId || !entityId) throw new DomainRuleError("Entity keys require project and entity IDs.");
  return JSON.stringify([projectId, entityType, entityId]) as string;
}

