import { randomUUID } from 'node:crypto';
import { LocalSqliteEventStore } from './persistence/sqlite-store';
import type { WorkspaceExecution, WorkspaceNote, WorkspaceProject, WorkspaceTask } from '../shared/contracts/ipc';
import type { AgentExecutionRecord, AgentRecord, AgentRuntimeEvent, AgentSessionRecord } from '../domain/agent-provider.ts';
import type { AgentRuntimePersistence } from './runtime/agent-runtime.ts';
import type { ResponsibilityRecord, ResponsibilityRepository } from './runtime/responsibility-manager.ts';

const checklistLabels = ['Analisar estrutura atual do projeto', 'Implementar funcionalidade', 'Adicionar testes automatizados', 'Atualizar documentação', 'Revisar e criar pull request'];
export { checklistLabels };

export class WorkspaceCatalog implements AgentRuntimePersistence, ResponsibilityRepository {
  private readonly store: LocalSqliteEventStore;
  get collaborationStore(): LocalSqliteEventStore { return this.store; }
  constructor(databasePath: string) {
    this.store = new LocalSqliteEventStore(databasePath);
    for (const project of this.listProjects()) for (const task of this.listTasks(project.projectId)) {
      if (task.status === 'running' || task.status === 'queued') this.patchTask(project.projectId, task.taskId, { status: 'interrupted' });
    }
    for (const project of this.listProjects()) this.reconcileRuntime(project.projectId);
  }
  close() { this.store.close(); }
  listProjects(): WorkspaceProject[] {
    return this.store.listProjects().map(record => ({ projectId: record.projectId, displayName: String(record.data.displayName), rootPath: String(record.data.rootPath) }));
  }
  saveProject(project: WorkspaceProject): void {
    const current = this.store.getEntity(project.projectId, 'project', project.projectId);
    if (current && current.data.rootPath === project.rootPath) return;
    this.store.commit({ projectId: project.projectId, entityId: project.projectId, entityType: 'project', origin: 'main', type: 'project.opened', payload: {}, entityData: { displayName: project.displayName, rootPath: project.rootPath } });
  }
  listTasks(projectId: string): WorkspaceTask[] {
    return this.store.listEntities(projectId, 'task').map(record => ({ ...record.data, taskId: record.entityId, projectId, updatedAt: record.updatedAt } as WorkspaceTask)).sort((a,b) => b.createdAt.localeCompare(a.createdAt));
  }
  listExecutions(projectId: string): WorkspaceExecution[] {
    return this.store.listEntities(projectId, 'execution').map(record => ({ ...record.data, executionId: record.entityId, projectId } as WorkspaceExecution)).sort((a, b) => (b.startedAt ?? b.finishedAt ?? '').localeCompare(a.startedAt ?? a.finishedAt ?? '')).slice(0, 500);
  }
  saveTask(task: WorkspaceTask): WorkspaceTask {
    const { taskId, projectId, updatedAt: _updatedAt, ...data } = task;
    this.store.commit({ projectId, entityId: taskId, entityType: 'task', origin: 'main', type: 'task.saved', payload: { status: task.status }, entityData: data });
    return this.getTask(projectId, taskId);
  }

  saveAgent(agent: AgentRecord): void {
    const current = this.store.getEntity(agent.projectId, 'agent', agent.agentId);
    this.store.commit({
      projectId: agent.projectId, entityId: agent.agentId, entityType: 'agent', origin: 'system',
      type: current ? 'agent.status.changed' : 'agent.created',
      payload: { providerId: agent.providerId, role: agent.role, status: agent.status },
      entityData: {
        providerId: agent.providerId, role: agent.role, displayName: agent.displayName,
        status: agent.status, worktreeId: agent.worktreeId, taskId: agent.taskId ?? null,
        activeSessionId: agent.activeSessionId, createdAt: agent.createdAt, updatedAt: agent.updatedAt,
        specialties: agent.specialties ?? [],
      },
    });
    if (agent.taskId && this.hasTask(agent.projectId, agent.taskId)) {
      const task = this.getTask(agent.projectId, agent.taskId);
      const agents = this.listAgents(agent.projectId).filter(item => item.taskId === agent.taskId);
      const status = agents.some(item => ['created','starting','ready','running','waiting'].includes(item.status)) ? 'running'
        : agents.some(item => ['failed','blocked','unresponsive'].includes(item.status)) ? 'failed'
        : agents.every(item => item.status === 'completed') ? 'succeeded' : 'cancelled';
      if (task.status !== status) this.patchTask(agent.projectId, agent.taskId, { status });
    }
  }

  loadAgents(): AgentRecord[] {
    return this.listProjects().flatMap(project => this.listAgents(project.projectId));
  }

  saveSession(session: AgentSessionRecord, resumable: boolean): void {
    const current = this.store.getEntity(session.projectId, 'session', session.sessionId);
    this.store.commit({
      projectId: session.projectId, entityId: session.sessionId, entityType: 'session', origin: 'system',
      type: current ? 'session.status.changed' : 'session.created',
      payload: { status: session.status, agentId: session.agentId },
      entityData: {
        agentId: session.agentId, providerId: session.providerId, worktreeId: session.worktreeId,
        status: session.status, resumable, providerSessionId: session.providerSessionId,
        createdAt: session.createdAt, startedAt: session.startedAt ?? null, finishedAt: session.finishedAt ?? null,
        executionId: session.executionId ?? session.sessionId, taskId: session.taskId ?? null,
      },
    });
  }

  loadSessions(): Omit<AgentSessionRecord, 'capabilities'>[] {
    return this.listProjects().flatMap(project => this.store.listEntities(project.projectId, 'session').map(record => ({
      sessionId: record.entityId,
      executionId: typeof record.data.executionId === 'string' ? record.data.executionId : record.entityId,
      ...(typeof record.data.taskId === 'string' ? { taskId: record.data.taskId } : {}),
      providerId: String(record.data.providerId ?? ''),
      status: String(record.data.status ?? 'unresponsive') as AgentSessionRecord['status'],
      createdAt: String(record.data.createdAt ?? record.createdAt),
      ...(typeof record.data.startedAt === 'string' ? { startedAt: record.data.startedAt } : {}),
      ...(typeof record.data.finishedAt === 'string' ? { finishedAt: record.data.finishedAt } : {}),
      agentId: String(record.data.agentId ?? ''),
      projectId: project.projectId,
      worktreeId: String(record.data.worktreeId ?? ''),
      resumable: record.data.resumable === true,
      providerSessionId: typeof record.data.providerSessionId === 'string' ? record.data.providerSessionId : null,
    })));
  }

  loadRuntimeEvents(agentId: string): AgentRuntimeEvent[] {
    const project = this.store.listProjects().find(item => this.store.getEntity(item.projectId, 'agent', agentId));
    if (!project) return [];
    const sessions = this.store.listEntities(project.projectId, 'session').filter(item => item.data.agentId === agentId);
    const records = [
      ...this.store.listAggregateEvents(project.projectId, 'agent', agentId),
      ...sessions.flatMap(session => this.store.listAggregateEvents(project.projectId, 'session', session.entityId)),
    ].sort((left, right) => left.sequence - right.sequence);
    const knownTypes = new Set([
      'agent.created', 'agent.starting', 'session.created', 'session.resumed', 'agent.started',
      'agent.action.started', 'agent.action.completed', 'agent.turn.completed', 'agent.waiting',
      'agent.completed', 'agent.failed', 'agent.stopped', 'provider.protocolError',
      'agent.message.sent', 'agent.message.received', 'agent.response',
    ]);
    return records.flatMap(event => {
      const payload = event.payload;
      if (!knownTypes.has(event.type) || typeof payload.agentId !== 'string' || !payload.data || typeof payload.data !== 'object' || Array.isArray(payload.data)) return [];
      const sequence = payload.sequence;
      if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence)) return [];
      const data: AgentRuntimeEvent['data'] = {};
      for (const [key, value] of Object.entries(payload.data)) {
        if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') data[key] = value;
      }
      return [{
        order: event.sequence,
        agentId: payload.agentId, projectId: project.projectId,
        worktreeId: typeof payload.worktreeId === 'string' ? payload.worktreeId : String(this.store.getEntity(project.projectId, 'agent', agentId)?.data.worktreeId ?? ''),
        ...(typeof payload.sessionId === 'string' ? { sessionId: payload.sessionId } : {}),
        sequence, type: event.type as AgentRuntimeEvent['type'], occurredAt: event.occurredAt, data,
      }];
    }).slice(-256);
  }

  saveExecution(execution: AgentExecutionRecord): void {
    const current = this.store.getEntity(execution.projectId, 'execution', execution.executionId);
    this.store.commit({
      projectId: execution.projectId, entityId: execution.executionId, entityType: 'execution', origin: 'system',
      type: current ? 'execution.status.changed' : 'execution.created',
      payload: { status: execution.status, taskId: execution.taskId },
      entityData: {
        taskId: execution.taskId, agentId: execution.agentId, sessionId: execution.sessionId,
        worktreeId: execution.worktreeId ?? null,
        status: execution.status, startedAt: execution.startedAt, finishedAt: execution.finishedAt,
        exitCode: execution.exitCode, summary: execution.summary,
      },
    });
  }

  saveRuntimeEvent(event: AgentRuntimeEvent): number | undefined {
    const entityType = event.sessionId ? 'session' : 'agent';
    const entityId = event.sessionId ?? event.agentId;
    const record = this.store.getEntity(event.projectId, entityType, entityId);
    if (!record) return;
    const committed = this.store.commit({
      projectId: event.projectId, entityId, entityType, origin: 'adapter', type: event.type,
      occurredAt: event.occurredAt,
      payload: { authorId:event.agentId, agentId: event.agentId, worktreeId:event.worktreeId, taskId:record.data.taskId ?? null, ...(event.sessionId ? { sessionId: event.sessionId } : {}), sequence: event.sequence, data: event.data },
      entityData: record.data,
    });
    return committed.sequence;
  }

  hasTask(projectId: string, taskId: string): boolean {
    return this.store.getEntity(projectId, 'task', taskId) !== undefined;
  }

  saveResponsibility(responsibility: ResponsibilityRecord, eventType: 'responsibility.assigned' | 'responsibility.transferred' | 'responsibility.status.changed', authorId = 'legacy/unknown'): void {
    const task = this.store.getEntity(responsibility.projectId, 'task', responsibility.taskId);
    if (!task) throw new Error('Task was not found in this project.');
    this.store.commit({
      projectId: responsibility.projectId, entityId: responsibility.taskId, entityType: 'task',
      origin: 'system', type: eventType, correlationId: responsibility.responsibilityId,
      payload: { authorId, taskId:responsibility.taskId, responsibilityId: responsibility.responsibilityId, title: responsibility.title, assignedTo: responsibility.assignedTo,
        dependsOn: responsibility.dependsOn, status: responsibility.status, createdAt: responsibility.createdAt, updatedAt: responsibility.updatedAt },
      entityData: task.data,
    });
  }

  listResponsibilities(projectId: string): ResponsibilityRecord[] {
    const latest = new Map<string, ResponsibilityRecord>();
    let cursor = 0;
    while (cursor < this.store.latestSequence(projectId)) {
      const page = this.store.readAfter(projectId, cursor, 500);
      if (page.kind !== 'events') break;
      for (const event of page.events) {
        if (!event.type.startsWith('responsibility.') || !event.correlationId || !event.payload) continue;
        const data = event.payload as Record<string, unknown>;
        if (typeof data.title !== 'string' || typeof data.status !== 'string' || !Array.isArray(data.dependsOn)) continue;
        latest.set(event.correlationId, {
          responsibilityId: event.correlationId, projectId, taskId: event.entityId, title: data.title,
          assignedTo: typeof data.assignedTo === 'string' ? data.assignedTo : null,
          dependsOn: data.dependsOn.filter((id): id is string => typeof id === 'string'),
          status: data.status as ResponsibilityRecord['status'],
          createdAt: String(data.createdAt ?? event.occurredAt), updatedAt: String(data.updatedAt ?? event.occurredAt),
        });
      }
      cursor = page.nextSequence;
    }
    return [...latest.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  getTask(projectId: string, taskId: string): WorkspaceTask {
    const record = this.store.getEntity(projectId, 'task', taskId);
    if (!record) throw new Error('Task not found.');
    return { ...record.data, taskId, projectId, updatedAt: record.updatedAt } as WorkspaceTask;
  }
  patchTask(projectId: string, taskId: string, patch: Partial<WorkspaceTask>): WorkspaceTask {
    return this.saveTask({ ...this.getTask(projectId, taskId), ...patch });
  }
  setChecklist(projectId: string, taskId: string, index: number, checked: boolean): WorkspaceTask {
    const task = this.getTask(projectId, taskId);
    const checklist = [...task.checklist]; checklist[index] = checked;
    return this.patchTask(projectId, taskId, { checklist });
  }
  listNotes(projectId: string): WorkspaceNote[] {
    return this.store.listEntities(projectId, 'note').map(record => ({
      noteId: record.entityId, projectId, title: String(record.data.title), body: String(record.data.body), createdAt: String(record.data.createdAt),
      linkedAgentIds: Array.isArray(record.data.linkedAgentIds) ? record.data.linkedAgentIds.filter((id): id is string => typeof id === 'string') : [],
      permissions: {
        readers: Array.isArray((record.data.permissions as Record<string, unknown> | undefined)?.readers) ? ((record.data.permissions as Record<string, unknown>).readers as unknown[]).filter((id): id is string => typeof id === 'string') : [],
        writers: Array.isArray((record.data.permissions as Record<string, unknown> | undefined)?.writers) ? ((record.data.permissions as Record<string, unknown>).writers as unknown[]).filter((id): id is string => typeof id === 'string') : [],
      },
    })).sort((a,b) => b.createdAt.localeCompare(a.createdAt));
  }
  saveNote(projectId: string, title: string, body: string): WorkspaceNote {
    const note: WorkspaceNote = { noteId: randomUUID(), projectId, title: title.trim(), body: body.trim(), createdAt: new Date().toISOString() };
    note.linkedAgentIds = [];
    note.permissions = { readers: [], writers: [] };
    this.store.commit({ projectId, entityId: note.noteId, entityType: 'note', origin: 'renderer', type: 'note.created', payload: {}, entityData: { title: note.title, body: note.body, createdAt: note.createdAt, linkedAgentIds: [], permissions: note.permissions } });
    return note;
  }

  linkNote(projectId: string, noteId: string, agentId: string): WorkspaceNote {
    const note = this.listNotes(projectId).find(item => item.noteId === noteId);
    const agent = this.store.getEntity(projectId, 'agent', agentId);
    if (!note || !agent) throw new Error('Note and agent must belong to the same project.');
    const linkedAgentIds = [...(note.linkedAgentIds ?? [])];
    if (!linkedAgentIds.includes(agentId)) linkedAgentIds.push(agentId);
    const current = this.store.getEntity(projectId, 'note', noteId)!;
    this.store.commit({ projectId, entityId: noteId, entityType: 'note', origin: 'system', type: 'note.agent.linked', payload: { agentId }, entityData: { ...current.data, linkedAgentIds } });
    note.linkedAgentIds = linkedAgentIds;
    return note;
  }

  updateNote(projectId: string, noteId: string, patch: { title?: string; body?: string }): WorkspaceNote {
    const current = this.store.getEntity(projectId, 'note', noteId);
    if (!current) throw new Error('Note was not found.');
    const title = (patch.title ?? String(current.data.title)).trim();
    const body = (patch.body ?? String(current.data.body)).trim();
    if (!title || title.length > 120 || body.length > 1500) throw new Error('Note is outside the allowed size limits.');
    this.store.commit({ projectId, entityId: noteId, entityType: 'note', origin: 'system', type: 'note.updated', payload: {}, entityData: { ...current.data, title, body } });
    return this.listNotes(projectId).find(note => note.noteId === noteId)!;
  }

  listAgents(projectId: string): AgentRecord[] {
    return this.store.listEntities(projectId, 'agent').map(record => ({
      agentId: record.entityId,
      projectId,
      worktreeId: String(record.data.worktreeId ?? ''),
      ...(typeof record.data.taskId === 'string' ? { taskId: record.data.taskId } : {}),
      providerId: String(record.data.providerId ?? ''),
      role: String(record.data.role ?? ''),
      displayName: String(record.data.displayName ?? ''),
      status: String(record.data.status ?? 'unresponsive') as AgentRecord['status'],
      createdAt: String(record.data.createdAt ?? record.createdAt),
      updatedAt: record.updatedAt,
      activeSessionId: typeof record.data.activeSessionId === 'string' ? record.data.activeSessionId : null,
      specialties: Array.isArray(record.data.specialties) ? record.data.specialties.filter((s): s is string => typeof s === 'string') : [],
    }));
  }

  private reconcileRuntime(projectId: string): void {
    const active = new Set(['created', 'starting', 'ready', 'running', 'waiting', 'blocked']);
    for (const record of this.store.listEntities(projectId, 'agent')) {
      if (!active.has(String(record.data.status))) continue;
      const data = record.data;
      this.store.commit({
        projectId, entityId: record.entityId, entityType: 'agent', origin: 'system', type: 'agent.unresponsive',
        payload: { previousStatus: String(data.status), reason: 'application-restarted' },
        entityData: { ...data, status: 'unresponsive', updatedAt: new Date().toISOString() },
      });
    }
    for (const record of this.store.listEntities(projectId, 'session')) {
      if (!active.has(String(record.data.status))) continue;
      const data = record.data;
      this.store.commit({
        projectId, entityId: record.entityId, entityType: 'session', origin: 'system', type: 'session.unresponsive',
        payload: { previousStatus: String(data.status), reason: 'application-restarted' },
        entityData: { ...data, status: 'unresponsive', finishedAt: new Date().toISOString() },
      });
    }
    for (const record of this.store.listEntities(projectId, 'execution')) {
      if (!active.has(String(record.data.status))) continue;
      const data = record.data;
      this.store.commit({
        projectId, entityId: record.entityId, entityType: 'execution', origin: 'system', type: 'execution.interrupted',
        payload: { previousStatus: String(data.status), reason: 'application-restarted' },
        entityData: { ...data, status: 'interrupted', finishedAt: new Date().toISOString() },
      });
    }
  }
}
