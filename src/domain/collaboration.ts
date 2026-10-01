import type { DomainEvent, EntityRecord, JsonObject, CommitChange, ReplayResult } from './model.ts';

export interface CollaborationStore {
  commit(change: CommitChange): DomainEvent;
  commitBatch(changes: CommitChange[]): DomainEvent[];
  getEntity(projectId: string, type: 'agent' | 'task' | 'execution' | 'session' | 'note' | 'decision' | 'message' | 'memory' | 'evidence', id: string): EntityRecord | undefined;
  listEntities(projectId: string, type: 'agent' | 'note' | 'decision' | 'message' | 'memory', cursor?: string, limit?: number): EntityRecord[];
  readAfter(projectId: string, cursor: number, limit?: number): ReplayResult;
  subscribe(listener: (event: DomainEvent) => void): () => void;
}

export interface ContextReference {
  type: 'execution' | 'task' | 'agent' | 'file' | 'commit' | 'artifact' | 'decision' | 'note' | 'message';
  id: string;
  worktreeId?: string;
}
export type NoteStatus = 'ACTIVE' | 'ACKNOWLEDGED' | 'RESOLVED' | 'SUPERSEDED' | 'ARCHIVED';
export interface KnowledgeRecord {
  id: string; projectId: string; kind: 'note' | 'memory' | 'decision'; revision: number;
  title: string; body: string; authorId: string; scope: 'agent' | 'project';
  ownerAgentId: string | null; targetAgentIds: string[];
  category: 'rule' | 'finding' | 'context'; tags: string[]; priority: number;
  status: NoteStatus | 'proposed' | 'accepted' | 'rejected' | 'superseded' | 'archived';
  readers: string[]; writers: string[]; relations: ContextReference[];
  acknowledgedBy: string[]; resolvedBy: string[]; validatedBy: string[];
  acceptedBy: string | null; supersedesId: string | null; validUntil: string | null;
  operationId: string | null; createdAt: string; updatedAt: string;
}
export interface KnowledgeInput {
  title: string; body: string; scope?: 'agent' | 'project'; ownerAgentId?: string;
  targetAgentIds?: string[]; category?: KnowledgeRecord['category']; tags?: string[];
  priority?: number; relations?: ContextReference[]; validUntil?: string; operationId?: string;
}
export interface CollaborationMessage {
  messageId: string; projectId: string; correlationId: string; fromAgentId: string; toAgentId: string;
  worktreeId: string; kind: 'ask' | 'send'; message: string;
  state: 'queued' | 'delivered' | 'responded' | 'timed_out' | 'cancelled' | 'failed' | 'delivery_uncertain';
  sourceExecutionId: string | null; targetExecutionId: string | null; taskId: string | null;
  parentMessageId: string | null; depth: number; contextRefs: ContextReference[];
  sentAt: string; deadline: string; deliveredAt: string | null; respondedAt: string | null;
  response: string | null; failure: string | null; operationId: string | null; revision: number;
}
export function jsonData(value: unknown): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}
export function allRecords(store: CollaborationStore, projectId: string, type: 'agent' | 'note' | 'decision' | 'message' | 'memory'): EntityRecord[] {
  const result: EntityRecord[] = [];
  let cursor = '';
  for (;;) {
    const page = store.listEntities(projectId, type, cursor, 500);
    result.push(...page);
    if (page.length < 500) return result;
    cursor = page.at(-1)!.entityId;
  }
}
