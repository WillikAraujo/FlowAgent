import { randomUUID } from 'node:crypto';
import type { CommitChange, EntityRecord } from '../../domain/model.ts';
import { allRecords, jsonData, type CollaborationStore, type ContextReference, type KnowledgeInput, type KnowledgeRecord } from '../../domain/collaboration.ts';
import { AgentAccessPolicy, type AgentPrincipal } from './agent-access-policy.ts';

export function isAdministrator(p: AgentPrincipal): boolean { return p.kind === 'user' || (p.kind === 'agent' && p.role === 'maestro'); }
export function validateReferences(store: CollaborationStore, projectId: string, refs: ContextReference[]): void {
  if (!Array.isArray(refs) || refs.length > 32) throw new Error('At most 32 context references are allowed.');
  for (const ref of refs) {
    if (!ref || typeof ref.id !== 'string' || !ref.id || ref.id.length > 256) throw new Error('Invalid context reference.');
    if (ref.type === 'file' || ref.type === 'commit') {
      if (!ref.worktreeId || !allRecords(store, projectId, 'agent').some(a => a.data.worktreeId === ref.worktreeId)) throw new Error('Reference worktree is not registered in this project.');
      if (ref.type === 'file' && (/^(?:[\\/]|[A-Za-z]:)/.test(ref.id) || ref.id.split(/[\\/]/).includes('..') || /[\0\r\n]/.test(ref.id))) throw new Error('File references must be relative to their worktree.');
      if (ref.type === 'commit' && !/^[a-f0-9]{7,64}$/i.test(ref.id)) throw new Error('Invalid commit reference.');
    } else {
      const type = ref.type === 'artifact' ? 'evidence' : ref.type;
      if (!['agent','task','execution','decision','note','message','evidence'].includes(type) || !store.getEntity(projectId, type as 'agent', ref.id)) throw new Error('Context reference was not found in this project.');
    }
  }
}

export function knowledgeFromEntity(entity: EntityRecord): KnowledgeRecord {
  const d = entity.data;
  const strings = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  const permissions = d.permissions as { readers?: string[]; writers?: string[] } | undefined;
  const targets = strings(d.targetAgentIds ?? d.linkedAgentIds);
  return {
    id: entity.entityId, projectId: entity.projectId, kind: entity.entityType as KnowledgeRecord['kind'], revision: entity.revision,
    title: String(d.title ?? ''), body: String(d.body ?? d.outcome ?? ''), authorId: String(d.authorId ?? 'legacy/unknown'),
    scope: d.scope === 'agent' || targets.length ? 'agent' : 'project', ownerAgentId: typeof d.ownerAgentId === 'string' ? d.ownerAgentId : null,
    targetAgentIds: targets, category: (d.category ?? 'context') as KnowledgeRecord['category'], tags: strings(d.tags), priority: Number(d.priority ?? 0),
    status: (d.status ?? (entity.entityType === 'decision' ? 'proposed' : 'ACTIVE')) as KnowledgeRecord['status'],
    readers: strings(d.readers ?? permissions?.readers), writers: strings(d.writers ?? permissions?.writers),
    relations: (d.relations ?? []) as unknown as ContextReference[], acknowledgedBy: strings(d.acknowledgedBy), resolvedBy: strings(d.resolvedBy),
    validatedBy: strings(d.validatedBy), acceptedBy: typeof d.acceptedBy === 'string' ? d.acceptedBy : null,
    supersedesId: typeof d.supersedesId === 'string' ? d.supersedesId : null, validUntil: typeof d.validUntil === 'string' ? d.validUntil : null,
    operationId: typeof d.operationId === 'string' ? d.operationId : null, createdAt: String(d.createdAt ?? entity.createdAt), updatedAt: entity.updatedAt,
  };
}

/** Shared knowledge policy. Notes, memory and decisions remain distinct aggregates. */
export class KnowledgeService {
  readonly store: CollaborationStore;
  private readonly policy: AgentAccessPolicy;
  private readonly now: () => Date;
  constructor(store: CollaborationStore, policy = new AgentAccessPolicy(), now = () => new Date()) { this.store=store;this.policy=policy;this.now=now; }
  canRead(p: AgentPrincipal, item: KnowledgeRecord): boolean {
    return isAdministrator(p) || item.authorId === p.id || item.ownerAgentId === p.id || item.targetAgentIds.includes(p.id) || item.readers.includes(p.id) ||
      (item.scope === 'project' && item.authorId !== 'legacy/unknown');
  }
  list(p: AgentPrincipal, kind: KnowledgeRecord['kind']): KnowledgeRecord[] {
    this.policy.authorize(p, kind === 'decision' ? 'decision.read' : kind === 'memory' ? 'memory.read' : 'note.read');
    return allRecords(this.store, p.projectId, kind).map(knowledgeFromEntity).filter(item => this.canRead(p, item));
  }
  read(p: AgentPrincipal, kind: KnowledgeRecord['kind'], id: string): KnowledgeRecord {
    const item = this.list(p, kind).find(item => item.id === id);
    if (!item) throw new Error('Knowledge was not found or is not shared with this principal.');
    return item;
  }
  create(p: AgentPrincipal, kind: KnowledgeRecord['kind'], input: KnowledgeInput): KnowledgeRecord {
    this.policy.authorize(p, kind === 'decision' ? 'decision.propose' : kind === 'memory' ? 'memory.write' : 'note.write');
    this.validateInput(input);
    const targets = [...new Set(input.targetAgentIds ?? [])];
    for (const id of targets) if (!this.store.getEntity(p.projectId, 'agent', id)) throw new Error('Target agent must belong to this project.');
    const scope = kind === 'decision' ? 'project' : input.scope ?? (targets.length || p.kind === 'agent' ? 'agent' : 'project');
    const owner = kind === 'memory' && scope === 'agent' ? input.ownerAgentId ?? p.id : null;
    if (owner && (!this.store.getEntity(p.projectId, 'agent', owner) || (!isAdministrator(p) && owner !== p.id))) throw new Error('An agent can only create its own individual memory.');
    if (kind !== 'decision' && scope === 'project' && !isAdministrator(p)) throw new Error('Only the user or Maestro can create global rules and memory.');
    const relations = [...(input.relations ?? [])];
    if (p.kind === 'agent') {
      const agent = this.store.getEntity(p.projectId, 'agent', p.id);
      if (typeof agent?.data.taskId === 'string' && !relations.some(ref => ref.type === 'task' && ref.id === agent.data.taskId)) relations.push({type:'task',id:agent.data.taskId});
      const session = typeof agent?.data.activeSessionId === 'string' ? this.store.getEntity(p.projectId,'session',agent.data.activeSessionId) : undefined;
      if (typeof session?.data.executionId === 'string') relations.push({type:'execution',id:session.data.executionId});
    }
    validateReferences(this.store, p.projectId, relations);
    const prior = this.listForDedup(p, kind).find(item => item.authorId === p.id &&
      ((input.operationId && item.operationId === input.operationId) ||
      (['ACTIVE','ACKNOWLEDGED','proposed'].includes(item.status) && item.title.toLowerCase() === input.title.trim().toLowerCase() && item.body.trim() === input.body.trim() && item.scope === scope && item.ownerAgentId === owner && JSON.stringify([...item.targetAgentIds].sort()) === JSON.stringify([...targets].sort()))));
    if (prior) {
      if (prior.title !== input.title.trim() || prior.body !== input.body.trim() || prior.scope !== scope || prior.ownerAgentId !== owner || JSON.stringify([...prior.targetAgentIds].sort()) !== JSON.stringify([...targets].sort())) throw new Error('Operation ID is already associated with different knowledge.');
      const merged = [...new Map([...prior.relations,...relations].map(ref=>[`${ref.type}:${ref.worktreeId ?? ''}:${ref.id}`,ref])).values()];
      if (!input.operationId && merged.length !== prior.relations.length) {
        validateReferences(this.store,p.projectId,merged);
        this.store.commit(this.change(p,{...prior,relations:merged},`${kind}.references.linked`,prior.revision));
        return this.read(p,kind,prior.id);
      }
      return prior;
    }
    const timestamp = this.now().toISOString();
    const record: KnowledgeRecord = {
      id: randomUUID(), projectId: p.projectId, kind, revision: 0, title: input.title.trim(), body: input.body.trim(), authorId: p.id,
      scope, ownerAgentId: owner, targetAgentIds: targets, category: input.category ?? 'context', tags: input.tags ?? [], priority: input.priority ?? 0,
      status: kind === 'decision' ? 'proposed' : 'ACTIVE', readers: [p.id, ...targets], writers: [p.id], relations,
      acknowledgedBy: [], resolvedBy: [], validatedBy: [], acceptedBy: null, supersedesId: null, validUntil: input.validUntil ?? null,
      operationId: input.operationId ?? null, createdAt: timestamp, updatedAt: timestamp,
    };
    this.store.commit(this.change(p, record, kind === 'decision' ? 'decision.proposed' : `${kind}.created`, 0));
    return this.read(p, kind, record.id);
  }
  update(p: AgentPrincipal, kind: KnowledgeRecord['kind'], id: string, revision: number, patch: { title?: string; body?: string; tags?: string[]; relations?: ContextReference[] }): KnowledgeRecord {
    this.writeGrant(p, kind);
    const item = this.read(p, kind, id);
    if (!isAdministrator(p) && item.authorId !== p.id && item.ownerAgentId !== p.id && !item.writers.includes(p.id)) throw new Error('Knowledge is not writable by this principal.');
    if (kind === 'decision' && item.status !== 'proposed') throw new Error('Consolidated decisions cannot be edited; create a replacement proposal.');
    if (['SUPERSEDED','ARCHIVED','superseded','archived'].includes(item.status)) throw new Error('Inactive knowledge cannot be edited.');
    this.validateInput({ title: patch.title ?? item.title, body: patch.body ?? item.body, tags: patch.tags });
    if (patch.relations) validateReferences(this.store, p.projectId, patch.relations);
    this.store.commit(this.change(p, { ...item, ...patch, validatedBy: kind === 'decision' ? [] : item.validatedBy }, `${kind}.updated`, revision));
    return this.read(p, kind, id);
  }
  share(p: AgentPrincipal, kind: KnowledgeRecord['kind'], id: string, revision: number, readers: string[], writers: string[]): KnowledgeRecord {
    this.writeGrant(p, kind);
    if (!isAdministrator(p)) throw new Error('Only the user or Maestro can administer sharing.');
    for (const agentId of [...readers, ...writers]) if (!this.store.getEntity(p.projectId, 'agent', agentId)) throw new Error('Shared agent must belong to this project.');
    const item = this.read(p, kind, id);
    this.store.commit(this.change(p, { ...item, readers: [...new Set([...readers, ...writers])], writers }, `${kind}.shared`, revision));
    return this.read(p, kind, id);
  }
  transition(p: AgentPrincipal, kind: KnowledgeRecord['kind'], id: string, revision: number, action: 'acknowledge' | 'resolve' | 'archive' | 'validate' | 'accept' | 'reject' | 'supersede', options: { replacementId?: string; justification?: string } = {}): KnowledgeRecord {
    this.writeGrant(p, kind);
    const item = this.read(p, kind, id);
    const next = { ...item };
    let event: string;
    if (kind === 'decision') {
      if (action === 'validate') {
        if (p.kind !== 'agent' || p.role !== 'reviewer' || p.id === item.authorId || item.status !== 'proposed') throw new Error('A different Reviewer must validate a proposed decision.');
        next.validatedBy = [...new Set([...item.validatedBy, p.id])]; event = 'decision.validated';
      } else if (action === 'accept' || action === 'reject') {
        this.policy.authorize(p, 'decision.accept');
        if (!isAdministrator(p) || item.status !== 'proposed') throw new Error('Only the user or Maestro can consolidate a proposal.');
        if (action === 'accept' && p.kind === 'agent' && !item.validatedBy.length) throw new Error('Maestro acceptance requires independent Reviewer validation.');
        if (action === 'accept' && p.kind === 'user' && !options.justification?.trim()) throw new Error('User acceptance requires a justification.');
        next.status = action === 'accept' ? 'accepted' : 'rejected'; next.acceptedBy = p.id; event = `decision.${next.status}`;
      } else if (action === 'archive') {
        if (!isAdministrator(p)) throw new Error('Only the user or Maestro can archive decisions.');
        next.status = 'archived'; event = 'decision.archived';
      } else throw new Error('Invalid decision transition.');
    } else if (action === 'acknowledge' || action === 'resolve') {
      if (!item.targetAgentIds.includes(p.id) || !['ACTIVE','ACKNOWLEDGED'].includes(item.status)) throw new Error('Only an active note recipient can acknowledge or resolve it.');
      if (action === 'resolve' && !item.acknowledgedBy.includes(p.id)) throw new Error('Acknowledge the note before resolving it.');
      if (action === 'acknowledge') next.acknowledgedBy = [...new Set([...item.acknowledgedBy, p.id])];
      else next.resolvedBy = [...new Set([...item.resolvedBy, p.id])];
      next.status = item.targetAgentIds.every(a => next.resolvedBy.includes(a)) ? 'RESOLVED' : item.targetAgentIds.every(a => next.acknowledgedBy.includes(a)) ? 'ACKNOWLEDGED' : 'ACTIVE';
      event = `note.${action === 'resolve' ? 'resolved' : 'acknowledged'}`;
    } else if (action === 'archive') {
      if (!isAdministrator(p)) throw new Error('Only the user or Maestro can archive knowledge.');
      next.status = 'ARCHIVED'; event = `${kind}.archived`;
    } else if (action === 'supersede') {
      if (!isAdministrator(p) && item.authorId !== p.id) throw new Error('Only the author or administrator can supersede knowledge.');
      const replacement = this.read(p, kind, options.replacementId ?? '');
      if (replacement.id === id || !['ACTIVE','ACKNOWLEDGED'].includes(item.status) || !['ACTIVE','ACKNOWLEDGED'].includes(replacement.status) || replacement.scope !== item.scope || replacement.ownerAgentId !== item.ownerAgentId || JSON.stringify([...replacement.targetAgentIds].sort()) !== JSON.stringify([...item.targetAgentIds].sort())) throw new Error('Replacement must have the same active scope and recipients.');
      next.status = 'SUPERSEDED'; event = `${kind}.superseded`;
      this.store.commitBatch([this.change(p, next, event, revision), this.change(p, { ...replacement, supersedesId: id }, `${kind}.replacement.linked`, replacement.revision)]);
      return this.read(p, kind, id);
    } else throw new Error('Invalid knowledge transition.');
    if (kind === 'decision' && action === 'accept' && options.replacementId) {
      const old = this.read(p, 'decision', options.replacementId);
      if (old.id === id || old.status !== 'accepted') throw new Error('Only an accepted decision may be replaced.');
      next.supersedesId = old.id;
      this.store.commitBatch([this.change(p, next, event, revision, options.justification), this.change(p, { ...old, status: 'superseded' }, 'decision.superseded', old.revision)]);
    } else this.store.commit(this.change(p, next, event, revision, options.justification));
    return this.read(p, kind, id);
  }
  private listForDedup(p: AgentPrincipal, kind: KnowledgeRecord['kind']): KnowledgeRecord[] {
    return allRecords(this.store, p.projectId, kind).map(knowledgeFromEntity).filter(item => this.canRead(p, item));
  }
  private writeGrant(p: AgentPrincipal, kind: KnowledgeRecord['kind']): void {
    this.policy.authorize(p, kind === 'decision' ? 'decision.propose' : kind === 'memory' ? 'memory.write' : 'note.write');
  }
  private validateInput(input: KnowledgeInput): void {
    if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 120 || typeof input.body !== 'string' || input.body.length > 1500) throw new Error('Knowledge exceeds title/body limits.');
    if (input.tags && (input.tags.length > 16 || input.tags.some(tag => typeof tag !== 'string' || !tag.trim() || tag.length > 40))) throw new Error('Invalid knowledge tags.');
    if (input.targetAgentIds && input.targetAgentIds.length > 10) throw new Error('At most 10 recipients are allowed.');
    if (input.category && !['rule','finding','context'].includes(input.category)) throw new Error('Invalid knowledge category.');
    if (input.priority !== undefined && (!Number.isInteger(input.priority) || input.priority < 0 || input.priority > 3)) throw new Error('Priority must be between 0 and 3.');
    if (input.validUntil && (!Number.isFinite(Date.parse(input.validUntil)) || Date.parse(input.validUntil) <= this.now().getTime())) throw new Error('Knowledge expiry must be in the future.');
    if (input.operationId && (!/^[A-Za-z0-9._:-]{1,128}$/.test(input.operationId))) throw new Error('Invalid operation ID.');
  }
  private change(p: AgentPrincipal, item: KnowledgeRecord, type: string, revision: number, justification?: string): CommitChange {
    if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('An expected revision is required.');
    const { revision: _revision, ...data } = item;
    const previous = this.store.getEntity(p.projectId, item.kind, item.id);
    return { projectId: p.projectId, entityId: item.id, entityType: item.kind, origin: p.kind === 'user' ? 'renderer' : 'system', type, expectedRevision: revision,
      payload: jsonData({ authorId: p.id, fromAgentId: p.id, targetAgentIds: item.targetAgentIds, title: item.title, status: item.status, relations: item.relations,
        record:data, previous:previous?.data ?? null, ...(justification ? { justification } : {}) }),
      entityData: { ...previous?.data, ...jsonData({ ...data, updatedAt: this.now().toISOString(), linkedAgentIds: item.targetAgentIds, permissions: { readers: item.readers, writers: item.writers } }) } };
  }
}
