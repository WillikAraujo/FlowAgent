import * as z from 'zod/v4';
import type { CollaborationMessage, KnowledgeInput, KnowledgeRecord } from '../../domain/collaboration';
import type { DomainEvent } from '../../domain/model';
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/);
const kind = z.enum(['note','memory','decision']);
const reference = z.strictObject({ type:z.enum(['execution','task','agent','file','commit','artifact','decision','note','message']), id:z.string().min(1).max(256), worktreeId:z.string().max(256).optional() });
const knowledgeInput = z.strictObject({ title:z.string().trim().min(1).max(120), body:z.string().max(1500), scope:z.enum(['agent','project']).optional(), ownerAgentId:id.optional(), targetAgentIds:z.array(id).max(10).optional(), category:z.enum(['rule','finding','context']).optional(), tags:z.array(z.string().min(1).max(40)).max(16).optional(), priority:z.number().int().min(0).max(3).optional(), relations:z.array(reference).max(32).optional(), validUntil:z.string().max(40).optional(), operationId:id.optional() });
const revision = z.number().int().min(1);
export const collaborationCommandSchema = z.discriminatedUnion('action', [
  z.strictObject({ projectId:id, action:z.literal('create'), kind, input:knowledgeInput }),
  z.strictObject({ projectId:id, action:z.literal('update'), kind, id, expectedRevision:revision, patch:z.strictObject({title:z.string().min(1).max(120).optional(),body:z.string().max(1500).optional()}) }),
  z.strictObject({ projectId:id, action:z.literal('transition'), kind, id, expectedRevision:revision, transition:z.enum(['acknowledge','resolve','archive','validate','accept','reject','supersede']), replacementId:id.optional(), justification:z.string().max(1500).optional() }),
  z.strictObject({ projectId:id, action:z.literal('ask'), to:id, message:z.string().trim().min(1).max(7000), timeoutMs:z.number().int().min(1000).max(600000).optional() }),
  z.strictObject({ projectId:id, action:z.literal('cancel'), messageId:id }),
]);
export type CollaborationCommand = z.infer<typeof collaborationCommandSchema>;
export const collaborationQuerySchema = z.strictObject({ projectId:id, kind:z.enum(['history','knowledge','interaction']), cursor:z.number().int().min(0).optional(), limit:z.number().int().min(1).max(100).optional(), afterId:id.optional(), taskId:id.optional(), executionId:id.optional(), agentId:id.optional(), messageId:id.optional() }).refine(v => v.kind !== 'interaction' || !!v.messageId);
export type CollaborationQuery = z.infer<typeof collaborationQuerySchema>;
export interface CollaborationPage { events:DomainEvent[]; knowledge:KnowledgeRecord[]; messages:CollaborationMessage[]; nextCursor:number; latestSequence:number; nextId:string|null; resync:boolean }
export function isCollaborationQuery(v:unknown):v is CollaborationQuery { return collaborationQuerySchema.safeParse(v).success; }
export function isCollaborationCommand(v:unknown):v is CollaborationCommand { return collaborationCommandSchema.safeParse(v).success; }
const result = z.union([
  z.object({projectId:id,revision, id,kind,title:z.string().max(120),body:z.string().max(1500),status:z.string(),authorId:z.string(),targetAgentIds:z.array(id),relations:z.array(reference)}),
  z.object({projectId:id,revision,messageId:id,message:z.string().max(8000),state:z.string(),correlationId:id,fromAgentId:z.string(),toAgentId:id,contextRefs:z.array(reference)}),
]);
export function isCollaborationResult(v:unknown):boolean { return result.safeParse(v).success; }
const page = z.strictObject({ events:z.array(z.object({eventId:id,projectId:id,sequence:revision,type:z.string(),payload:z.record(z.string(),z.unknown())})).max(100),knowledge:z.array(result).max(100),messages:z.array(result).max(100),nextCursor:z.number().int().min(0),latestSequence:z.number().int().min(0),nextId:id.nullable(),resync:z.boolean() });
export function isCollaborationPage(v:unknown):v is CollaborationPage { return page.safeParse(v).success; }
