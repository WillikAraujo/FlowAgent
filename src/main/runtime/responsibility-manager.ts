import { randomUUID } from 'node:crypto';
import type { AgentRecord } from '../../domain/agent-provider.ts';
import { AgentAccessPolicy, type AgentPrincipal } from './agent-access-policy.ts';

export type ResponsibilityStatus = 'pending' | 'ready' | 'assigned' | 'in_progress' | 'blocked' | 'completed' | 'failed';

export interface ResponsibilityRecord {
  responsibilityId: string;
  projectId: string;
  taskId: string;
  title: string;
  assignedTo: string | null;
  dependsOn: string[];
  status: ResponsibilityStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ResponsibilityRepository {
  saveResponsibility(responsibility: ResponsibilityRecord, event: 'responsibility.assigned' | 'responsibility.transferred' | 'responsibility.status.changed', authorId?:string): void;
  listResponsibilities(projectId: string): ResponsibilityRecord[];
  hasTask(projectId: string, taskId: string): boolean;
}

export interface ResponsibilityRuntime {
  getAgent(agentId: string): AgentRecord | undefined;
}

export class ResponsibilityManager {
  private readonly repository: ResponsibilityRepository;
  private readonly runtime: ResponsibilityRuntime;
  private readonly policy: AgentAccessPolicy;
  private readonly now: () => Date;

  constructor(repository: ResponsibilityRepository, runtime: ResponsibilityRuntime, policy = new AgentAccessPolicy(), now: () => Date = () => new Date()) {
    this.repository = repository;
    this.runtime = runtime;
    this.policy = policy;
    this.now = now;
  }

  list(principal: AgentPrincipal): ResponsibilityRecord[] {
    this.policy.authorize(principal, 'responsibility.read');
    return this.repository.listResponsibilities(principal.projectId);
  }

  assign(principal: AgentPrincipal, input: { taskId: string; title: string; assignedTo?: string | null; dependsOn?: string[] }): ResponsibilityRecord {
    this.policy.authorize(principal, 'responsibility.assign');
    if (!this.repository.hasTask(principal.projectId, input.taskId)) throw new Error('Task was not found in this project.');
    const responsibilities = this.repository.listResponsibilities(principal.projectId);
    const assignedTo = input.assignedTo ?? null;
    if (assignedTo) this.assertProjectAgent(principal.projectId, assignedTo);
    if (input.dependsOn?.some(id => !responsibilities.some(item => item.responsibilityId === id))) throw new Error('Every dependency must refer to an existing responsibility in this project.');
    const timestamp = this.now().toISOString();
    const responsibility: ResponsibilityRecord = {
      responsibilityId: randomUUID(), projectId: principal.projectId, taskId: input.taskId,
      title: input.title.trim(), assignedTo, dependsOn: [...new Set(input.dependsOn ?? [])],
      status: assignedTo ? 'assigned' : 'pending', createdAt: timestamp, updatedAt: timestamp,
    };
    if (!responsibility.title || responsibility.title.length > 200) throw new Error('Responsibility title must contain 1 to 200 characters.');
    this.assertAcyclic([...responsibilities, responsibility]);
    this.repository.saveResponsibility(responsibility, 'responsibility.assigned',principal.id);
    return responsibility;
  }

  transfer(principal: AgentPrincipal, responsibilityId: string, agentId: string): ResponsibilityRecord {
    this.policy.authorize(principal, 'responsibility.assign');
    const responsibility = this.require(principal.projectId, responsibilityId);
    this.assertProjectAgent(principal.projectId, agentId);
    const updated = { ...responsibility, assignedTo: agentId, status: 'assigned' as const, updatedAt: this.now().toISOString() };
    this.repository.saveResponsibility(updated, 'responsibility.transferred',principal.id);
    return updated;
  }

  setStatus(principal: AgentPrincipal, responsibilityId: string, status: ResponsibilityStatus): ResponsibilityRecord {
    const responsibility = this.require(principal.projectId, responsibilityId);
    if (principal.kind === 'agent') {
      this.policy.authorize(principal, 'responsibility.update');
      if (responsibility.assignedTo !== principal.id) throw new Error('An agent can only update responsibilities assigned to itself.');
    } else this.policy.authorize(principal, 'responsibility.update');
    const updated = { ...responsibility, status, updatedAt: this.now().toISOString() };
    this.repository.saveResponsibility(updated, 'responsibility.status.changed',principal.id);
    return updated;
  }

  private require(projectId: string, responsibilityId: string): ResponsibilityRecord {
    const responsibility = this.repository.listResponsibilities(projectId).find(item => item.responsibilityId === responsibilityId);
    if (!responsibility) throw new Error('Responsibility was not found.');
    return responsibility;
  }

  private assertProjectAgent(projectId: string, agentId: string): void {
    if (this.runtime.getAgent(agentId)?.projectId !== projectId) throw new Error('Assigned agent must belong to this project.');
  }

  private assertAcyclic(items: ResponsibilityRecord[]): void {
    const byId = new Map(items.map(item => [item.responsibilityId, item]));
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (id: string): void => {
      if (visiting.has(id)) throw new Error('Responsibility dependencies cannot contain a cycle.');
      if (visited.has(id)) return;
      visiting.add(id);
      for (const dependency of byId.get(id)?.dependsOn ?? []) visit(dependency);
      visiting.delete(id); visited.add(id);
    };
    for (const id of byId.keys()) visit(id);
  }
}
