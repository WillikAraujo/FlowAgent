import { randomUUID } from 'node:crypto';
import type {
  AgentCapabilities, AgentExecutionRecord, AgentRecord, AgentRuntimeEvent, AgentRuntimeOutput,
  AgentSessionRecord, AgentStatus, ProviderEventHandler, ProviderOutputHandler,
  ProviderSessionInput, ProviderSessionStatus, Unsubscribe,
} from '../../domain/agent-provider.ts';
import { ProviderOperationError } from '../../domain/agent-provider.ts';
import { ProviderRegistry } from './provider-registry.ts';

const HISTORY_LIMIT = 256;
const TERMINAL = new Set<AgentStatus>(['completed', 'failed', 'stopped', 'unresponsive']);

const unknownCapabilities = (): AgentCapabilities => ({
  terminal: { support: 'unknown' }, shellExecute: { support: 'unknown' }, testExecute: { support: 'unknown' }, streaming: { support: 'unknown' },
  mcpClient: { support: 'unknown' }, mcpServer: { support: 'unknown' },
  fileEditing: { support: 'unknown' }, toolCalling: { support: 'unknown' },
  sessionResume: { support: 'unknown' }, structuredOutput: { support: 'unknown' },
  structuredEvents: { support: 'unknown' }, sendMessage: { support: 'unknown' },
  interrupt: { support: 'unknown' }, stop: { support: 'unknown' }, subagents: { support: 'unknown' },
});

export interface CreateAgentInput {
  specialties?: string[];
  projectId: string;
  worktreeId: string;
  taskId?: string;
  workingDirectory: string;
  providerId: string;
  role: string;
  displayName?: string;
}

export interface AgentInspection {
  agent: AgentRecord;
  session?: AgentSessionRecord;
  capabilities: AgentCapabilities;
}

export interface AgentRuntimePersistence {
  loadAgents(): AgentRecord[];
  loadSessions(): Omit<AgentSessionRecord, 'capabilities'>[];
  loadRuntimeEvents?(agentId: string): AgentRuntimeEvent[];
  saveAgent(agent: AgentRecord): void;
  saveSession(session: AgentSessionRecord, resumable: boolean): void;
  saveExecution(execution: AgentExecutionRecord): void;
  saveRuntimeEvent(event: AgentRuntimeEvent): void | number;
}

export type AgentWorkingDirectoryResolver = (agent: AgentRecord) => Promise<string>;

export class AgentRuntime {
  private contextBuilder?: (agent: AgentRecord, session: AgentSessionRecord, task: string, limit: number, refs?: import('../../domain/collaboration.ts').ContextReference[]) => string;
  private readonly conversationTargets = new Map<string, string>();
  setContextBuilder(builder: NonNullable<AgentRuntime['contextBuilder']>): void { this.contextBuilder = builder; }
  setConversationTarget(agentId: string, target: string | null): void { if (target) this.conversationTargets.set(agentId, target); else this.conversationTargets.delete(agentId); }
  projectIds(): string[] { return [...new Set([...this.agents.values()].map(a => a.projectId))]; }
  executionId(agentId: string): string | null { const agent = this.agents.get(agentId); const session = agent?.activeSessionId ? this.sessions.get(agent.activeSessionId) : undefined; return session ? session.executionId ?? session.sessionId : null; }
  reuseAgent(agentId: string, input: CreateAgentInput): AgentRecord {
    const agent = this.requireAgent(agentId);
    if (agent.projectId !== input.projectId || agent.role !== input.role || agent.providerId !== input.providerId) throw new ProviderOperationError('failed', 'Existing agent identity, role and provider must match.');
    const current = agent.activeSessionId ? this.sessions.get(agent.activeSessionId) : undefined;
    if (current && !TERMINAL.has(current.status)) throw new ProviderOperationError('invalid-state', 'Agent already has an active execution. Stop it before starting a new task.');
    if (agent.role === 'developer' && [...this.agents.values()].some(a => a.agentId !== agentId && a.projectId === input.projectId && a.worktreeId === input.worktreeId && a.role === 'developer' && !TERMINAL.has(a.status))) throw new ProviderOperationError('invalid-state', 'A developer already owns this worktree.');
    agent.worktreeId = input.worktreeId; agent.taskId = input.taskId; agent.activeSessionId = null; agent.status = 'created'; this.touch(agent);
    this.persistence?.saveAgent(agent); this.directories.set(agentId, input.workingDirectory);
    return { ...agent };
  }
  private readonly agents = new Map<string, AgentRecord>();
  private readonly sessions = new Map<string, AgentSessionRecord>();
  private readonly eventHistory = new Map<string, AgentRuntimeEvent[]>();
  private readonly eventSequence = new Map<string, number>();
  private readonly projectOrder = new Map<string, number>();
  private readonly eventListeners = new Map<string, Set<(event: AgentRuntimeEvent) => void>>();
  private readonly outputListeners = new Map<string, Set<(output: AgentRuntimeOutput) => void>>();
  private readonly providerSubscriptions = new Map<string, Unsubscribe[]>();
  private readonly executionExitCodes = new Map<string, number | null>();
  private readonly providers: ProviderRegistry;
  private readonly projectListeners = new Set<(event: AgentRuntimeEvent) => void>();
  private readonly turnOutput = new Map<string, string>();
  private readonly now: () => Date;
  private readonly persistence?: AgentRuntimePersistence;
  private readonly resolveWorkingDirectory?: AgentWorkingDirectoryResolver;

  constructor(providers: ProviderRegistry, now: () => Date = () => new Date(), persistence?: AgentRuntimePersistence, resolveWorkingDirectory?: AgentWorkingDirectoryResolver) {
    this.providers = providers;
    this.now = now;
    this.persistence = persistence;
    this.resolveWorkingDirectory = resolveWorkingDirectory;
    for (const agent of persistence?.loadAgents() ?? []) {
      this.agents.set(agent.agentId, agent);
      this.eventHistory.set(agent.agentId, []);
      this.eventListeners.set(agent.agentId, new Set());
      this.outputListeners.set(agent.agentId, new Set());
    }
    for (const session of persistence?.loadSessions() ?? []) {
      if (!this.agents.has(session.agentId)) continue;
      this.sessions.set(session.sessionId, { ...session, capabilities: unknownCapabilities() });
      this.executionExitCodes.set(session.sessionId, null);
    }
    for (const agent of this.agents.values()) {
      const events = (persistence?.loadRuntimeEvents?.(agent.agentId) ?? []).slice(-HISTORY_LIMIT);
      this.eventHistory.set(agent.agentId, events);
      this.eventSequence.set(agent.agentId, events.at(-1)?.sequence ?? 0);
      this.projectOrder.set(agent.projectId, Math.max(this.projectOrder.get(agent.projectId) ?? 0, ...events.map(event => event.order ?? 0)));
    }
  }

  createAgent(input: CreateAgentInput): AgentRecord {
    if (!input.projectId || !input.worktreeId || !input.workingDirectory || !input.role || !this.providers.has(input.providerId)) {
      throw new ProviderOperationError('failed', 'Agent requires a registered provider, role, project, and worktree.');
    }
    if (input.role === 'developer' && [...this.agents.values()].some(agent => agent.projectId === input.projectId && agent.worktreeId === input.worktreeId && agent.role === 'developer' && !TERMINAL.has(agent.status))) {
      throw new ProviderOperationError('invalid-state', 'A developer already owns this worktree. Stop it or use a separate worktree.');
    }
    const timestamp = this.now().toISOString();
    const agent: AgentRecord = {
      agentId: randomUUID(), projectId: input.projectId, worktreeId: input.worktreeId,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      providerId: input.providerId, role: input.role, displayName: input.displayName?.trim() || input.role,
      status: 'created', createdAt: timestamp, updatedAt: timestamp, activeSessionId: null,
      specialties: input.specialties ?? [],
    };
    this.persistence?.saveAgent(agent);
    this.agents.set(agent.agentId, agent);
    this.directories.set(agent.agentId, input.workingDirectory);
    this.eventHistory.set(agent.agentId, []);
    this.eventListeners.set(agent.agentId, new Set());
    this.outputListeners.set(agent.agentId, new Set());
    this.emit(agent, undefined, 'agent.created', {});
    return { ...agent };
  }

  async createSession(agentId: string, options: { mcpServers?: ProviderSessionInput['mcpServers'] } = {}): Promise<AgentSessionRecord> {
    const agent = this.requireAgent(agentId);
    if (agent.activeSessionId) {
      const active = this.sessions.get(agent.activeSessionId);
      if (active && !TERMINAL.has(active.status)) throw new ProviderOperationError('invalid-state', 'Agent already has an active session.');
    }
    const adapter = this.providers.get(agent.providerId);
    let providerSession: Awaited<ReturnType<typeof adapter.create>> | undefined;
    try {
      providerSession = await adapter.create({
        agentId: agent.agentId,
        projectId: agent.projectId,
        worktreeId: agent.worktreeId,
        workingDirectory: await this.workingDirectory(agent),
        role: agent.role,
        ...(options.mcpServers ? { mcpServers: options.mcpServers } : {}),
      });
      const capabilities = await adapter.getCapabilities(providerSession.sessionId);
      const session: AgentSessionRecord = {
        ...providerSession,
        agentId: agent.agentId,
        projectId: agent.projectId,
        worktreeId: agent.worktreeId,
        resumable: capabilities.sessionResume.support === 'supported',
        capabilities,
        providerSessionId: providerSession.providerSessionId ?? null,
        executionId: randomUUID(), taskId: agent.taskId,
      };
      agent.activeSessionId = session.sessionId;
      agent.status = 'ready';
      agent.updatedAt = this.now().toISOString();
      this.persistence?.saveSession(session, session.resumable);
      this.persistExecution(agent, session);
      this.persistence?.saveAgent(agent);
      this.sessions.set(session.sessionId, session);
      this.executionExitCodes.set(session.sessionId, null);
      const unsubscribers = [
        adapter.subscribeEvents(session.sessionId, event => this.onProviderEvent(agent, session, event)),
        adapter.subscribeOutput(session.sessionId, chunk => {
          this.turnOutput.set(agent.agentId, ((this.turnOutput.get(agent.agentId) ?? '') + chunk.text).slice(-8000));
          const output: AgentRuntimeOutput = { ...chunk, agentId: agent.agentId, projectId: agent.projectId, worktreeId: agent.worktreeId };
          for (const listener of this.outputListeners.get(agent.agentId) ?? []) listener(output);
        }),
      ];
      this.providerSubscriptions.set(session.sessionId, unsubscribers);
      this.emit(agent, session.sessionId, 'session.created', { providerId: agent.providerId });
      return { ...session };
    } catch (error) {
      if (providerSession) await adapter.stop(providerSession.sessionId).catch(() => undefined);
      agent.activeSessionId = null;
      this.markSetupFailed(agentId);
      throw error;
    }
  }

  async startSession(agentId: string, sessionId: string, task: string, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<AgentSessionRecord> {
    const agent = this.requireAgent(agentId);
    const session = this.requireSession(agentId, sessionId);
    if (!['created', 'ready'].includes(session.status) || session.startedAt) throw new ProviderOperationError('invalid-state', 'Agent session has already been started.');
    try {
      agent.status = 'starting';
      session.status = 'starting';
      this.touch(agent);
      this.persistSessionAndExecution(agent, session);
      this.persistence?.saveAgent(agent);
      this.emit(agent, sessionId, 'agent.starting', {});
      const prepared = this.contextBuilder?.(agent, session, task, 16000) ?? task;
      const started = await this.providers.get(agent.providerId).start(sessionId, { task: prepared, ...options });
      this.mergeSession(session, started);
      this.syncAgentStatus(agent, session.status);
      this.persistSessionAndExecution(agent, session);
      return { ...session };
    } catch (error) {
      const cancelled = session.status === 'stopped' || options.signal?.aborted || (error instanceof ProviderOperationError && error.code === 'cancelled');
      if (!cancelled && session.status !== 'failed') {
        session.status = 'failed';
        session.finishedAt = this.now().toISOString();
        this.syncAgentStatus(agent, 'failed');
        try { this.persistSessionAndExecution(agent, session); } catch { /* retain original error; cleanup still runs */ }
        this.emit(agent, sessionId, 'agent.failed', { reason: 'start-failed' });
      }
      for (const unsubscribe of this.providerSubscriptions.get(sessionId) ?? []) unsubscribe();
      this.providerSubscriptions.delete(sessionId);
      await this.providers.get(agent.providerId).stop(sessionId).catch(() => undefined);
      throw error;
    }
  }

  async sendMessage(agentId: string, message: string, options: { signal?: AbortSignal; timeoutMs?: number; contextRefs?: import('../../domain/collaboration.ts').ContextReference[] } = {}): Promise<void> {
    const { agent, session } = this.current(agentId);
    const prepared = this.contextBuilder?.(agent, session, message, 8000, options.contextRefs) ?? message;
    await this.providers.get(agent.providerId).send(session.sessionId, prepared, options);
  }

  async interruptAgent(agentId: string, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<void> {
    const { agent, session } = this.current(agentId);
    await this.providers.get(agent.providerId).interrupt(session.sessionId, options);
  }

  async stopAgent(agentId: string, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<void> {
    const { agent, session } = this.current(agentId);
    await this.providers.get(agent.providerId).stop(session.sessionId, options);
  }

  async resumeAgent(agentId: string, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<AgentSessionRecord> {
    const { agent, session } = this.current(agentId);
    const resumed = await this.providers.get(agent.providerId).resume(session.sessionId, options);
    this.mergeSession(session, resumed);
    this.syncAgentStatus(agent, session.status);
    this.persistSessionAndExecution(agent, session);
    this.emit(agent, session.sessionId, 'session.resumed', {});
    return { ...session };
  }

  async getStatus(agentId: string): Promise<AgentRecord> {
    const agent = this.requireAgent(agentId);
    if (agent.activeSessionId) {
      const session = this.sessions.get(agent.activeSessionId);
      if (session) {
        const observed = await this.providers.get(agent.providerId).getStatus(session.sessionId);
        if (observed) {
          this.mergeSession(session, observed);
          this.syncAgentStatus(agent, observed.status);
        } else if (!TERMINAL.has(session.status)) {
          session.status = 'unresponsive';
          this.syncAgentStatus(agent, 'unresponsive');
          this.persistSessionAndExecution(agent, session);
        }
      }
    }
    return { ...agent };
  }

  async inspectAgent(agentId: string): Promise<AgentInspection> {
    const agent = await this.getStatus(agentId);
    const session = agent.activeSessionId ? this.sessions.get(agent.activeSessionId) : undefined;
    const capabilities = await this.providers.get(agent.providerId).getCapabilities(session?.sessionId);
    return { agent, ...(session ? { session: { ...session } } : {}), capabilities };
  }

  getAgent(agentId: string): AgentRecord | undefined {
    const agent = this.agents.get(agentId);
    return agent ? { ...agent } : undefined;
  }

  listAgents(projectId: string): AgentRecord[] {
    return [...this.agents.values()].filter(agent => agent.projectId === projectId).map(agent => ({ ...agent }));
  }

  listEvents(agentId: string): AgentRuntimeEvent[] {
    if (!this.agents.has(agentId)) throw new ProviderOperationError('not-found', 'Agent was not found.');
    return (this.eventHistory.get(agentId) ?? []).map(event => ({ ...event, data: { ...event.data } }));
  }

  subscribe(agentId: string, listener: (event: AgentRuntimeEvent) => void): Unsubscribe {
    const listeners = this.eventListeners.get(agentId);
    if (!listeners) return () => undefined;
    listeners.add(listener);
    for (const event of this.eventHistory.get(agentId) ?? []) listener(event);
    return () => listeners.delete(listener);
  }

  subscribeLive(agentId: string, listener: (event: AgentRuntimeEvent) => void): Unsubscribe {
    const listeners = this.eventListeners.get(agentId);
    if (!listeners) return () => undefined;
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  subscribeProject(projectId: string, listener: (event: AgentRuntimeEvent) => void): Unsubscribe {
    const scoped = (event: AgentRuntimeEvent) => { if (event.projectId === projectId) listener(event); };
    this.projectListeners.add(scoped);
    return () => { this.projectListeners.delete(scoped); };
  }

  subscribeOutput(agentId: string, listener: (output: AgentRuntimeOutput) => void): Unsubscribe {
    const listeners = this.outputListeners.get(agentId);
    if (!listeners) return () => undefined;
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  recordEvent(agentId: string, type: AgentRuntimeEvent['type'], data: AgentRuntimeEvent['data'], sessionId?: string): void {
    this.emit(this.requireAgent(agentId), sessionId, type, data);
  }

  markSetupFailed(agentId: string): void {
    const agent = this.requireAgent(agentId);
    this.syncAgentStatus(agent, 'failed');
    this.emit(agent, agent.activeSessionId ?? undefined, 'agent.failed', { reason: 'setup-failed' });
  }

  async shutdown(): Promise<void> {
    const active = [...this.agents.values()].filter(agent => agent.activeSessionId && !TERMINAL.has(agent.status));
    await Promise.all(active.map(agent => this.providers.get(agent.providerId).stop(agent.activeSessionId!).catch(() => undefined)));
    await Promise.all(this.providers.list().map(providerId => this.providers.get(providerId).shutdown?.() ?? Promise.resolve()));
  }

  private async workingDirectory(agent: AgentRecord): Promise<string> {
    let directory = this.directories.get(agent.agentId);
    if (!directory && this.resolveWorkingDirectory) {
      directory = await this.resolveWorkingDirectory(agent);
      if (directory) this.directories.set(agent.agentId, directory);
    }
    if (!directory) throw new ProviderOperationError('invalid-state', 'Agent worktree is unavailable or no longer registered.');
    return directory;
  }

  private readonly directories = new Map<string, string>();

  private requireAgent(agentId: string): AgentRecord {
    const agent = this.agents.get(agentId);
    if (!agent) throw new ProviderOperationError('not-found', 'Agent was not found.');
    return agent;
  }

  private requireSession(agentId: string, sessionId: string): AgentSessionRecord {
    const session = this.sessions.get(sessionId);
    if (!session || session.agentId !== agentId) throw new ProviderOperationError('not-found', 'Provider session was not found for this agent.');
    return session;
  }

  private current(agentId: string): { agent: AgentRecord; session: AgentSessionRecord } {
    const agent = this.requireAgent(agentId);
    if (!agent.activeSessionId) throw new ProviderOperationError('invalid-state', 'Agent has no provider session.');
    return { agent, session: this.requireSession(agentId, agent.activeSessionId) };
  }

  private onProviderEvent(agent: AgentRecord, session: AgentSessionRecord, event: Parameters<ProviderEventHandler>[0]): void {
    if (event.type === 'agent.turn.completed' || event.type === 'agent.completed' || event.type === 'agent.failed') {
      const message = this.turnOutput.get(agent.agentId);
      if (message) this.emit(agent, session.sessionId, 'agent.response', { message, fromAgentId: agent.agentId, toAgentId: this.conversationTargets.get(agent.agentId) ?? 'user' });
      this.conversationTargets.delete(agent.agentId);
      this.turnOutput.delete(agent.agentId);
    }
    session.status = this.statusForEvent(event.type, session.status);
    if (TERMINAL.has(session.status)) session.finishedAt = event.occurredAt;
    if (typeof event.data.exitCode === 'number' || event.data.exitCode === null) this.executionExitCodes.set(session.sessionId, event.data.exitCode);
    this.syncAgentStatus(agent, session.status);
    try { this.persistSessionAndExecution(agent, session); } catch { /* provider cleanup must finish if local persistence is temporarily unavailable */ }
    this.emit(agent, session.sessionId, event.type, event.data, event.occurredAt);
    if (TERMINAL.has(session.status)) {
      for (const unsubscribe of this.providerSubscriptions.get(session.sessionId) ?? []) unsubscribe();
      this.providerSubscriptions.delete(session.sessionId);
    }
  }

  private statusForEvent(type: string, previous: ProviderSessionStatus): ProviderSessionStatus {
    if (type === 'agent.started' || type === 'agent.action.started' || type === 'agent.action.completed') return 'running';
    if (type === 'agent.turn.completed') return 'waiting';
    if (type === 'agent.waiting') return 'waiting';
    if (type === 'agent.completed') return 'completed';
    if (type === 'agent.failed') return 'failed';
    if (type === 'agent.stopped') return 'stopped';
    return previous;
  }

  private mergeSession(target: AgentSessionRecord, source: Pick<AgentSessionRecord, 'status' | 'startedAt' | 'finishedAt'>): void {
    target.status = source.status;
    if (source.startedAt) target.startedAt = source.startedAt;
    if (source.finishedAt) target.finishedAt = source.finishedAt;
  }

  private syncAgentStatus(agent: AgentRecord, status: AgentStatus): void {
    if (agent.status === status) return;
    agent.status = status;
    this.touch(agent);
    try { this.persistence?.saveAgent(agent); } catch { /* runtime state remains observable even if an update cannot be persisted */ }
  }

  private touch(agent: AgentRecord): void {
    agent.updatedAt = this.now().toISOString();
  }

  private emit(agent: AgentRecord, sessionId: string | undefined, type: AgentRuntimeEvent['type'], data: AgentRuntimeEvent['data'], occurredAt = this.now().toISOString()): void {
    const sequence = (this.eventSequence.get(agent.agentId) ?? 0) + 1;
    this.eventSequence.set(agent.agentId, sequence);
    const event: AgentRuntimeEvent = {
      order: (this.projectOrder.get(agent.projectId) ?? 0) + 1,
      agentId: agent.agentId, projectId: agent.projectId, worktreeId: agent.worktreeId,
      ...(sessionId ? { sessionId } : {}), sequence, type, occurredAt, data,
    };
    this.projectOrder.set(agent.projectId, event.order!);
    if (this.persistence && this.isDurableEvent(type)) {
      try {
        const committedOrder = this.persistence.saveRuntimeEvent(event);
        if (typeof committedOrder === 'number') { event.order = committedOrder; this.projectOrder.set(agent.projectId,committedOrder); }
      } catch { /* raw and transient events are not required for process cleanup */ }
    }
    const history = this.eventHistory.get(agent.agentId) ?? [];
    history.push(event);
    if (history.length > HISTORY_LIMIT) history.shift();
    this.eventHistory.set(agent.agentId, history);
    for (const listener of this.eventListeners.get(agent.agentId) ?? []) listener(event);
    for (const listener of this.projectListeners) listener(event);
  }

  private persistExecution(agent: AgentRecord, session: AgentSessionRecord): void {
    const execution: AgentExecutionRecord = {
      worktreeId: session.worktreeId,
      executionId: session.executionId ?? session.sessionId,
      projectId: agent.projectId,
      taskId: session.taskId ?? agent.taskId ?? null,
      agentId: agent.agentId,
      sessionId: session.sessionId,
      status: session.status,
      startedAt: session.startedAt ?? null,
      finishedAt: session.finishedAt ?? null,
      exitCode: this.executionExitCodes.get(session.sessionId) ?? null,
      summary: null,
    };
    this.persistence?.saveExecution(execution);
  }

  private persistSessionAndExecution(agent: AgentRecord, session: AgentSessionRecord): void {
    this.persistence?.saveSession(session, session.resumable);
    this.persistExecution(agent, session);
  }

  private isDurableEvent(type: AgentRuntimeEvent['type']): boolean {
    return type === 'agent.created' || type === 'session.created' || type === 'agent.starting' ||
      type === 'agent.started' || type === 'agent.waiting' ||
      type === 'agent.completed' || type === 'agent.failed' || type === 'agent.stopped' ||
      type === 'provider.protocolError' || type === 'session.resumed' ||
      type === 'agent.action.started' || type === 'agent.action.completed' || type === 'agent.turn.completed' ||
      type === 'agent.message.sent' || type === 'agent.message.received' || type === 'agent.response';
  }
}
