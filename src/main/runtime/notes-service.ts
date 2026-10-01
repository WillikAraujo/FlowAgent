import type { WorkspaceNote } from '../../shared/contracts/ipc.ts';
import { AgentAccessPolicy, type AgentPrincipal } from './agent-access-policy.ts';
import { KnowledgeService } from './knowledge-service.ts';
import type { CollaborationStore, KnowledgeInput, KnowledgeRecord, NoteStatus } from '../../domain/collaboration.ts';

export interface NotesRepository {
  collaborationStore?: CollaborationStore;
  listNotes(projectId: string): WorkspaceNote[];
  saveNote(projectId: string, title: string, body: string): WorkspaceNote;
  linkNote(projectId: string, noteId: string, agentId: string): WorkspaceNote;
  updateNote(projectId: string, noteId: string, patch: { title?: string; body?: string }): WorkspaceNote;
}

export class NotesService {
  private readonly repository: NotesRepository;
  private readonly policy: AgentAccessPolicy;
  readonly knowledge?: KnowledgeService;

  constructor(repository: NotesRepository, policy = new AgentAccessPolicy()) {
    this.repository = repository;
    this.policy = policy;
    if (repository.collaborationStore) this.knowledge = new KnowledgeService(repository.collaborationStore, policy);
  }

  list(principal: AgentPrincipal): WorkspaceNote[] {
    if (this.knowledge) return this.knowledge.list(principal, 'note').map(item => this.view(item));
    this.policy.authorize(principal, 'note.read');
    return this.repository.listNotes(principal.projectId).filter(note => this.canRead(principal, note));
  }

  read(principal: AgentPrincipal, noteId: string): WorkspaceNote {
    if (this.knowledge) return this.view(this.knowledge.read(principal, 'note', noteId));
    this.policy.authorize(principal, 'note.read');
    const note = this.repository.listNotes(principal.projectId).find(item => item.noteId === noteId);
    if (!note || !this.canRead(principal, note)) throw new Error('Note was not found or is not shared with this principal.');
    return note;
  }

  create(principal: AgentPrincipal, title: string, body: string, options: Omit<KnowledgeInput, 'title' | 'body'> = {}): WorkspaceNote {
    if (this.knowledge) return this.view(this.knowledge.create(principal, 'note', { title, body, ...options }));
    this.policy.authorize(principal, 'note.write');
    if (title.trim().length < 1 || title.length > 120 || body.length > 1500) throw new Error('Note is outside the allowed size limits.');
    return this.repository.saveNote(principal.projectId, title, body);
  }

  link(principal: AgentPrincipal, noteId: string, agentId: string): WorkspaceNote {
    if (this.knowledge) {
      this.policy.authorize(principal, 'note.write');
      const note = this.knowledge.read(principal, 'note', noteId);
      if (principal.kind !== 'user' && principal.role !== 'maestro') throw new Error('Only the user or Maestro can link shared notes.');
      if (!this.knowledge.store.getEntity(principal.projectId, 'agent', agentId)) throw new Error('Agent belongs to another project.');
      if (!['ACTIVE','ACKNOWLEDGED'].includes(note.status)) throw new Error('Only active notes can receive new recipients.');
      if (note.targetAgentIds.includes(agentId)) return this.view(note);
      const record = this.knowledge.store.getEntity(principal.projectId, 'note', noteId)!;
      const targets = [...note.targetAgentIds, agentId];
      const data = { ...record.data, scope:'agent', status:'ACTIVE', targetAgentIds:targets, linkedAgentIds:targets };
      this.knowledge.store.commit({ projectId: principal.projectId, entityId: noteId, entityType: 'note', origin: 'system', type: 'note.agent.linked', expectedRevision: record.revision,
        payload: { authorId: principal.id, agentId, targetAgentIds:targets, relations:record.data.relations ?? [], previous:record.data, record:data }, entityData:data });
      return this.read(principal, noteId);
    }
    this.policy.authorize(principal, 'note.write');
    if (principal.kind === 'agent' && principal.role !== 'maestro') throw new Error('Only the user or Maestro can link shared notes.');
    return this.repository.linkNote(principal.projectId, noteId, agentId);
  }

  update(principal: AgentPrincipal, noteId: string, patch: { title?: string; body?: string; expectedRevision?: number }): WorkspaceNote {
    if (this.knowledge) {
      if (patch.expectedRevision === undefined) throw new Error('An expected revision is required.');
      return this.view(this.knowledge.update(principal, 'note', noteId, patch.expectedRevision, { ...(patch.title === undefined ? {} : { title: patch.title }), ...(patch.body === undefined ? {} : { body: patch.body }) }));
    }
    this.policy.authorize(principal, 'note.write');
    const note = this.read(principal, noteId);
    if (principal.kind === 'agent' && principal.role !== 'maestro' && note.permissions?.writers.includes(principal.id) !== true) {
      throw new Error('This note is not writable by the current agent.');
    }
    return this.repository.updateNote(principal.projectId, noteId, patch);
  }

  private canRead(principal: AgentPrincipal, note: WorkspaceNote): boolean {
    if (principal.kind === 'user' || principal.role === 'maestro') return true;
    return note.linkedAgentIds?.includes(principal.id) === true || note.permissions?.readers.includes(principal.id) === true;
  }
  transition(principal: AgentPrincipal, id: string, revision: number, action: 'acknowledge' | 'resolve' | 'archive' | 'supersede', replacementId?: string): WorkspaceNote {
    if (!this.knowledge) throw new Error('Persistent collaboration storage is unavailable.');
    return this.view(this.knowledge.transition(principal, 'note', id, revision, action, { replacementId }));
  }
  private view(item: KnowledgeRecord): WorkspaceNote {
    return { noteId: item.id, projectId: item.projectId, title: item.title, body: item.body, createdAt: item.createdAt,
      linkedAgentIds: item.targetAgentIds, permissions: { readers: item.readers, writers: item.writers }, revision: item.revision,
      authorId: item.authorId, status: item.status as NoteStatus, relations: item.relations };
  }
}
