import { execFile } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join, normalize, parse, relative, resolve, sep } from 'node:path';
import {
  isFlowAgentEvent,
  MAX_FLOW_AGENT_EVENT_PAYLOAD_BYTES,
  type FlowAgentEvent,
  type FlowAgentOpenProjectResult,
  type FlowAgentProfile,
  type FlowAgentRunReference,
  type FlowAgentRunResult,
  type FlowAgentRunSnapshot,
  type FlowAgentStartRequest,
  type WorkspaceWorktree,
  type WorkspaceAgentEvent,
} from '../../shared/contracts/ipc.ts';
import { CodexProviderAdapter, type CodexProviderAdapterOptions } from '../adapters/codex/codex-provider-adapter.ts';
import { OpenCodeProviderAdapter } from '../adapters/opencode/opencode-provider-adapter.ts';
import { ProviderOperationError, type AgentProviderAdapter, type AgentRecord, type AgentRuntimeEvent, type Unsubscribe } from '../../domain/agent-provider.ts';
import { AgentRuntime, type AgentRuntimePersistence } from '../runtime/agent-runtime.ts';
import { ProviderRegistry } from '../runtime/provider-registry.ts';
import { AgentAccessPolicy, type AgentAction } from '../runtime/agent-access-policy.ts';
import { CommunicationBroker } from '../runtime/communication-broker.ts';
import { NotesService } from '../runtime/notes-service.ts';
import { ResponsibilityManager, type ResponsibilityRepository } from '../runtime/responsibility-manager.ts';
import type { CollaborationStore, KnowledgeInput, ContextReference } from '../../domain/collaboration.ts';
import { ContextEngine } from '../runtime/context-engine.ts';
import { DecisionsService } from '../runtime/decisions-service.ts';
import type { AgentPrincipal } from '../runtime/agent-access-policy.ts';
import type { CollaborationCommand, CollaborationQuery, CollaborationPage } from '../../shared/contracts/collaboration.ts';
import type { DomainEvent } from '../../domain/model.ts';
import { AdeMcpHttpServer } from '../mcp/ade-mcp-server.ts';
import type { WorkspaceNote } from '../../shared/contracts/ipc.ts';

const MAX_HISTORY = 256;
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);

export class FlowAgentError extends Error {
  readonly category: 'unsupported-operation' | 'forbidden' | 'invalid-payload' | 'payload-too-large';
  constructor(category: 'unsupported-operation' | 'forbidden' | 'invalid-payload' | 'payload-too-large', message: string) {
    super(message);
    this.name = 'FlowAgentError';
    this.category = category;
  }
}

type InternalRun = FlowAgentRunSnapshot & {
  root: string;
  requestId: string;
  seq: number;
  listeners: Set<(event: FlowAgentEvent) => void>;
  history: FlowAgentEvent[];
  unsubscribeProvider: Unsubscribe[];
  agentId: string;
  protocolError?: 'malformed-jsonl' | 'truncated-jsonl';
};

export interface FlowAgentOptions extends CodexProviderAdapterOptions {
  chooseDirectory: () => Promise<string | null>;
  now?: () => Date;
  onFinished?: (projectId: string, requestId: string, status: FlowAgentRunResult['status']) => void;
  providers?: AgentProviderAdapter[];
  persistence?: AgentRuntimePersistence & ResponsibilityRepository & {
    collaborationStore?: CollaborationStore;
    listNotes(projectId: string): WorkspaceNote[];
    saveNote(projectId: string, title: string, body: string): WorkspaceNote;
    linkNote(projectId: string, noteId: string, agentId: string): WorkspaceNote;
    updateNote(projectId: string, noteId: string, patch: { title?: string; body?: string }): WorkspaceNote;
  };
}

function key(path: string): string {
  const normalized = normalize(resolve(path));
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function localPath(path: string): boolean {
  return parse(path).root !== path && !(process.platform === 'win32' && /^(?:\\\\|\/\/)/.test(path));
}

function minimalEnvironment(): NodeJS.ProcessEnv {
  const names = process.platform === 'win32'
    ? ['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH']
    : ['PATH', 'HOME', 'TMPDIR'];
  return Object.fromEntries(names.flatMap(name => process.env[name] === undefined ? [] : [[name, process.env[name]!]]));
}

function execText(file: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number }): Promise<string> {
  return new Promise((resolveText, reject) => execFile(file, args, {
    cwd: options.cwd, env: options.env, timeout: options.timeout ?? 5000,
    maxBuffer: 65536, encoding: 'utf8', windowsHide: true,
  }, (error, output) => error ? reject(error) : resolveText(output)));
}

async function safePath(path: string): Promise<boolean> {
  try {
    let current = parse(resolve(path)).root;
    for (const part of resolve(path).slice(current.length).split(sep).filter(Boolean)) {
      current = join(current, part);
      if ((await lstat(current)).isSymbolicLink()) return false;
    }
    return true;
  } catch { return false; }
}

export class FlowAgentService {
  private readonly projects = new Map<string, { projectId: string; root: string; displayName: string }>();
  private readonly projectIds = new Map<string, { projectId: string; root: string; displayName: string }>();
  private readonly runs = new Map<string, InternalRun>();
  private readonly activeRoots = new Map<string, string>();
  private readonly setups = new Set<Promise<unknown>>();
  private readonly now: () => Date;
  private readonly runtime: AgentRuntime;
  private readonly policy = new AgentAccessPolicy();
  private readonly broker: CommunicationBroker;
  private readonly notes?: NotesService;
  private readonly context?: ContextEngine;
  private readonly decisions?: DecisionsService;
  private readonly responsibilities?: ResponsibilityManager;
  private readonly mcpServers = new Map<string, AdeMcpHttpServer>();
  private readonly options: FlowAgentOptions;
  private closing = false;

  constructor(options: FlowAgentOptions) {
    this.options = options;
    this.now = options.now ?? (() => new Date());
    const providers = new ProviderRegistry();
    providers.register(new CodexProviderAdapter(options));
    providers.register(new OpenCodeProviderAdapter());
    for (const provider of options.providers ?? []) providers.register(provider);
    this.runtime = new AgentRuntime(providers, this.now, options.persistence, agent => this.resolveAgentWorktree(agent));
    this.broker = new CommunicationBroker(this.runtime, this.policy, this.now, options.persistence?.collaborationStore);
    if (options.persistence) {
      this.notes = new NotesService(options.persistence, this.policy);
      this.responsibilities = new ResponsibilityManager(options.persistence, this.runtime, this.policy, this.now);
      if (this.notes.knowledge) {
        this.context = new ContextEngine(this.notes.knowledge, this.now);
        this.decisions = new DecisionsService(this.notes.knowledge);
        this.runtime.setContextBuilder((agent, session, task, limit, refs) => {
          const record = session.taskId ? options.persistence?.collaborationStore?.getEntity(agent.projectId,'task',session.taskId) : undefined;
          const files = refs ?? (Array.isArray(record?.data.references) ? record.data.references.filter((r):r is string=>typeof r==='string').map(id=>({type:'file' as const,id,worktreeId:agent.worktreeId})) : []);
          return this.context!.build(this.principal(agent.agentId), { task, taskId: session.taskId, executionId: session.executionId ?? session.sessionId, files }, limit);
        });
      }
    }
  }

  registerProject(projectId: string, root: string, displayName: string): void {
    const project = { projectId, root, displayName };
    this.projects.set(key(root), project);
    this.projectIds.set(projectId, project);
  }

  getProject(projectId: string): { projectId: string; root: string; displayName: string } | undefined {
    return this.projectIds.get(projectId);
  }
  private principal(agentId: string): AgentPrincipal {
    const agent = this.runtime.getAgent(agentId);
    if (!agent) throw new Error('Agent was not found.');
    const grants: AgentAction[] = ['agent.inspect','agent.communicate','note.read','note.write','memory.read','memory.write','decision.read','decision.propose','responsibility.read','responsibility.update'];
    if (agent.role === 'maestro') grants.push('agent.create','responsibility.assign','decision.accept');
    return { id:agentId,kind:'agent',projectId:agent.projectId,role:agent.role,grants };
  }
  userPrincipal(projectId: string): AgentPrincipal {
    if (!this.projectIds.has(projectId)) throw new FlowAgentError('forbidden','Project is not open.');
    return { id:'local-user',kind:'user',projectId,role:'user',grants:['agent.inspect','agent.communicate','note.read','note.write','memory.read','memory.write','decision.read','decision.propose','decision.accept','responsibility.read','responsibility.update'] };
  }
  listNotes(projectId: string): WorkspaceNote[] {
    if (!this.notes) throw new Error('Notes storage is unavailable.');
    return this.notes.list(this.userPrincipal(projectId));
  }
  saveNote(projectId: string, title: string, body: string): WorkspaceNote {
    if (!this.notes) throw new Error('Notes storage is unavailable.');
    return this.notes.create(this.userPrincipal(projectId),title,body);
  }
  async collaborationCommand(command: CollaborationCommand) {
    const p = this.userPrincipal(command.projectId);
    const knowledge = this.notes?.knowledge;
    if (!knowledge) throw new Error('Persistent collaboration storage is unavailable.');
    if (command.action === 'create') return knowledge.create(p,command.kind,command.input);
    if (command.action === 'update') return knowledge.update(p,command.kind,command.id,command.expectedRevision,command.patch);
    if (command.action === 'transition') return knowledge.transition(p,command.kind,command.id,command.expectedRevision,command.transition,{replacementId:command.replacementId,justification:command.justification});
    if (command.action === 'cancel') return this.broker.cancel(p,command.messageId);
    return this.broker.ask({principal:p,from:'user',to:command.to,message:command.message,timeoutMs:command.timeoutMs});
  }
  collaborationQuery(query: CollaborationQuery): CollaborationPage {
    const p = this.userPrincipal(query.projectId);
    const knowledge = this.notes?.knowledge;
    if (!knowledge) throw new Error('Persistent collaboration storage is unavailable.');
    const empty: CollaborationPage = {events:[],knowledge:[],messages:[],nextCursor:query.cursor ?? 0,latestSequence:0,nextId:null,resync:false};
    if (query.kind === 'interaction') return {...empty,messages:[this.broker.getInteraction(p,query.messageId!)]};
    if (query.kind === 'knowledge') {
      const items = (['note','memory','decision'] as const).flatMap(kind => knowledge.list(p,kind))
        .filter(item => (!query.agentId || item.ownerAgentId === query.agentId || item.targetAgentIds.includes(query.agentId) || item.scope === 'project') &&
          (!query.taskId || item.relations.some(ref => ref.type === 'task' && ref.id === query.taskId) || item.scope === 'project'))
        .sort((a,b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`)).filter(item => !query.afterId || `${item.kind}:${item.id}` > query.afterId);
      const page = items.slice(0,query.limit ?? 50);
      return {...empty,knowledge:page,nextId:items.length > page.length ? `${page.at(-1)!.kind}:${page.at(-1)!.id}` : null};
    }
    const page = knowledge.store.readAfter(query.projectId,query.cursor ?? 0,query.limit ?? 100);
    if (page.kind === 'resync') return {...empty,resync:true,latestSequence:page.snapshotSequence,nextCursor:page.snapshotSequence};
    const events = page.events.filter(event => {
      if (!['message','note','memory','decision'].includes(event.entityType) && event.type !== 'context.selected' && !event.type.startsWith('responsibility.') && !['agent.started','agent.completed','agent.failed','agent.stopped','agent.waiting','agent.turn.completed'].includes(event.type)) return false;
      const data = event.payload;
      const refs = Array.isArray(data.relations) ? data.relations as unknown as ContextReference[] : [];
      const taskMatch = !query.taskId || data.taskId === query.taskId || (event.entityType === 'task' && event.entityId === query.taskId) || refs.some(ref => ref.type === 'task' && ref.id === query.taskId);
      const executionMatch = !query.executionId || event.entityId === query.executionId || data.sourceExecutionId === query.executionId || data.targetExecutionId === query.executionId || data.executionId === query.executionId;
      const agentMatch = !query.agentId || event.entityId === query.agentId || data.agentId === query.agentId || data.fromAgentId === query.agentId || data.toAgentId === query.agentId || (Array.isArray(data.targetAgentIds) && data.targetAgentIds.includes(query.agentId));
      return taskMatch && executionMatch && agentMatch;
    });
    return {...empty,events,nextCursor:page.nextSequence,latestSequence:page.latestSequence};
  }

  subscribeProject(projectId: string, listener: (event: AgentRuntimeEvent | DomainEvent) => void): Unsubscribe {
    if (!this.projectIds.has(projectId)) throw new FlowAgentError('invalid-payload', 'Project is not open.');
    const runtimeStop = this.runtime.subscribeProject(projectId, listener);
    const durableStop = this.options.persistence?.collaborationStore?.subscribe(event => {
      if (event.projectId !== projectId) return;
      listener(event);
    });
    return () => { runtimeStop(); durableStop?.(); };
  }

  async listAgents(projectId: string): Promise<AgentRecord[]> {
    if (!this.projectIds.has(projectId)) throw new FlowAgentError('invalid-payload', 'Project is not open.');
    return Promise.all(this.runtime.listAgents(projectId).map(async agent => { const inspection = await this.runtime.inspectAgent(agent.agentId); return { ...inspection.agent, capabilities: inspection.capabilities }; }));
  }

  listAgentEvents(projectId: string, worktreeId: string): WorkspaceAgentEvent[] {
    if (!this.projectIds.has(projectId)) throw new FlowAgentError('invalid-payload', 'Project is not open.');
    return this.runtime.listAgents(projectId)
      .flatMap(agent => this.runtime.listEvents(agent.agentId).filter(event=>event.worktreeId===worktreeId).slice(-200).map(event => ({
        ...event,
        data: Object.fromEntries(Object.entries(event.data).map(([key, value]) => [key, typeof value === 'string' ? value.slice(0, 8000) : value])),
        agentName: agent.displayName, role: agent.role, providerId: agent.providerId,
      })))
      .sort((left, right) => (left.order ?? 0) - (right.order ?? 0) || left.agentId.localeCompare(right.agentId) || left.sequence - right.sequence).slice(-200);
  }

  async launchRuntimeAgent(input: { projectId: string; worktreeId: string; providerId: string; role: string; task: string; taskId?: string; agentId?: string; displayName?: string; specialties?: string[] }): Promise<AgentRecord> {
    const project = this.projectIds.get(input.projectId);
    if (!project) throw new FlowAgentError('invalid-payload', 'Project is not open.');
    const principal = { id: 'local-user', kind: 'user' as const, projectId: input.projectId, role: 'user', grants: ['agent.create'] as AgentAction[] };
    this.policy.authorize(principal, 'agent.create');
    if (!['maestro', 'planner', 'developer', 'reviewer', 'tester'].includes(input.role)) throw new FlowAgentError('invalid-payload', 'Agent role is not supported.');
    if (input.providerId === 'codex' && !['developer','reviewer'].includes(input.role)) throw new FlowAgentError('unsupported-operation', 'Codex currently supports developer and reviewer roles.');
    if (input.role === 'maestro' && input.providerId !== 'opencode') throw new FlowAgentError('unsupported-operation', 'Maestro requires a persistent provider session; OpenCode ACP is currently the supported provider.');
    const worktree = (await this.listWorktrees(input.projectId)).find(item => item.branch === input.worktreeId);
    if (!worktree) throw new FlowAgentError('forbidden', 'Selected worktree is unavailable.');
    if (input.taskId && !this.options.persistence?.hasTask(input.projectId, input.taskId)) throw new FlowAgentError('invalid-payload', 'Task is unavailable.');
    const root = await realpath(worktree.path);
    if (key(root) !== key(worktree.path) || !await safePath(root)) throw new FlowAgentError('forbidden', 'Selected worktree changed.');
    if (!input.task.trim() || input.task.length > 7000) throw new FlowAgentError('invalid-payload', 'Task must contain 1 to 7000 characters.');
    let agent;
    try {
      const identity = {
        projectId: input.projectId, worktreeId: input.worktreeId, workingDirectory: root,
        providerId: input.providerId, role: input.role, taskId: input.taskId, displayName: input.displayName, specialties: input.specialties,
      };
      agent = input.agentId ? this.runtime.reuseAgent(input.agentId, identity) : this.runtime.createAgent(identity);
      const mcp = input.providerId === 'opencode' ? await this.startMcpServer(input.projectId, agent.agentId, true) : undefined;
      const session = await this.runtime.createSession(agent.agentId, mcp ? {
        mcpServers: [{ name: 'ade-runtime', url: mcp.endpoint, headers: [{ name: 'Authorization', value: `Bearer ${mcp.token}` }] }],
      } : undefined);
      const task = mcp ? `You are ${agent.displayName} (${agent.role}) in ADE. Discover teammates with list_agents. Read list_inbox for directed questions and list_notes for guidance. Answer ADE questions using reply_agent with their messageId. Use ask_agent_async and wait_reply when coordinating; never infer replies from output. Create explicit notes/findings for persistent knowledge.\n\n${input.task}` : input.task;
      await this.runtime.startSession(agent.agentId, session.sessionId, task);
      const created = this.runtime.getAgent(agent.agentId);
      if (!created) throw new FlowAgentError('unsupported-operation', 'Agent was created but its runtime record is unavailable.');
      return created;
    } catch (error) {
      if (agent?.activeSessionId || (agent && this.runtime.getAgent(agent.agentId)?.activeSessionId)) await this.runtime.stopAgent(agent!.agentId).catch(() => undefined);
      if (agent) this.runtime.markSetupFailed(agent.agentId);
      if (agent) {
        const serverKey = `${input.projectId}:${agent.agentId}`;
        await this.mcpServers.get(serverKey)?.close().catch(() => undefined);
        this.mcpServers.delete(serverKey);
      }
      throw this.fromProviderError(error);
    }
  }

  async startMcpServer(projectId: string, agentId: string, initializing = false): Promise<{ endpoint: string; token: string }> {
    const project = this.projectIds.get(projectId);
    if (!project || !this.options.persistence || !this.notes || !this.responsibilities) throw new FlowAgentError('invalid-payload', 'Project runtime storage is unavailable.');
    const agent = this.runtime.getAgent(agentId);
    if (!agent || agent.projectId !== projectId) throw new FlowAgentError('forbidden', 'MCP principal must be an agent in the selected project.');
    if (!initializing) {
      const observed = await this.runtime.getStatus(agentId);
      if (!['ready', 'running', 'waiting'].includes(observed.status)) throw new FlowAgentError('forbidden', 'MCP can only be enabled for a live agent session.');
    }
    const serverKey = `${projectId}:${agentId}`;
    let server = this.mcpServers.get(serverKey);
    if (!server) {
      const principal = this.principal(agentId);
      let boundSession: string | null = null;
      server = new AdeMcpHttpServer({
        runtime: this.runtime, broker: this.broker, notes: this.notes, responsibilities: this.responsibilities,
        policy: this.policy,
        principal, knowledge: this.notes.knowledge, context: this.context, decisions: this.decisions,
        isAuthorized: () => {
          const current = this.runtime.getAgent(agentId);
          if (!current?.activeSessionId || !['ready','running','waiting'].includes(current.status)) return false;
          boundSession ??= current.activeSessionId;
          return current.activeSessionId === boundSession;
        },
        launchAgent: async input => this.launchRuntimeAgent({ ...input, projectId, providerId: input.provider }),
        resolveWorktree: async (requestedProjectId, worktreeId) => {
          if (requestedProjectId !== projectId) throw new FlowAgentError('forbidden', 'MCP worktree is outside this project.');
          const worktree = (await this.listWorktrees(projectId)).find(item => item.branch === worktreeId);
          if (!worktree) throw new FlowAgentError('forbidden', 'MCP worktree is unavailable.');
          const root = await realpath(worktree.path);
          if (key(root) !== key(worktree.path) || !await safePath(root)) throw new FlowAgentError('forbidden', 'MCP worktree changed.');
          return root;
        },
      });
      this.mcpServers.set(serverKey, server);
      const stop = this.runtime.subscribeLive(agentId, event => {
        if (['agent.completed','agent.failed','agent.stopped'].includes(event.type)) {
          stop(); this.mcpServers.delete(serverKey); void server!.close();
        }
      });
    }
    return server.start();
  }

  async sendRuntimeMessage(projectId: string, agentIds: string[], message: string): Promise<{ sent: number; results: { agentId: string; sent: boolean; error?: string }[] }> {
    if (!this.projectIds.has(projectId)) throw new FlowAgentError('invalid-payload', 'Project is not open.');
    if (!Array.isArray(agentIds) || !agentIds.length || agentIds.length > 10 || new Set(agentIds).size !== agentIds.length) throw new FlowAgentError('invalid-payload', 'Choose between 1 and 10 distinct agents.');
    const principal = { id: 'local-user', kind: 'user' as const, projectId, role: 'user', grants: ['agent.communicate'] as AgentAction[] };
    const results: { agentId: string; sent: boolean; error?: string }[] = [];
    for (const agentId of agentIds) {
      try { await this.broker.sendUserMessage({ principal, projectId, to: agentId, message }); results.push({ agentId, sent: true }); }
      catch (error) { results.push({ agentId, sent: false, error: this.fromProviderError(error).message.slice(0, 240) }); }
    }
    return { sent: results.filter(result => result.sent).length, results };
  }

  async controlAgent(projectId: string, agentId: string, action: 'interrupt' | 'stop' | 'resume'): Promise<AgentRecord> {
    const agent = this.runtime.getAgent(agentId);
    if (!agent || agent.projectId !== projectId) throw new FlowAgentError('forbidden', 'Agent is outside this project.');
    try {
      if (action === 'interrupt') await this.runtime.interruptAgent(agentId);
      else if (action === 'stop') await this.runtime.stopAgent(agentId);
      else await this.runtime.resumeAgent(agentId);
      return await this.runtime.getStatus(agentId);
    } catch (error) { throw this.fromProviderError(error); }
  }

  async listWorktrees(projectId: string): Promise<WorkspaceWorktree[]> {
    const project = this.projectIds.get(projectId);
    if (!project) throw new FlowAgentError('invalid-payload', 'Project is not open.');
    const root = await realpath(project.root);
    if (key(root) !== key(project.root) || !await safePath(root)) throw new FlowAgentError('forbidden', 'Project root changed.');
    const output = await (this.options.exec ?? execText)('git', ['-C', root, 'worktree', 'list', '--porcelain'], { cwd: root, env: minimalEnvironment() });
    return output.split(/\r?\n\r?\n/).map(block => {
      const path = /^worktree (.+)$/m.exec(block)?.[1];
      const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1] ?? (block.includes('detached') ? 'detached HEAD' : 'sem branch');
      return path ? { path, branch, isMain: key(path) === key(root) } : null;
    }).filter((entry): entry is WorkspaceWorktree => entry !== null);
  }

  async openProject(): Promise<FlowAgentOpenProjectResult> {
    let selected: string | null;
    try { selected = await this.options.chooseDirectory(); }
    catch { return { outcome: 'invalid', reason: 'access-denied' }; }
    if (selected === null) return { outcome: 'cancelled' };
    try {
      if (!localPath(selected) || !await safePath(selected)) return { outcome: 'invalid', reason: 'invalid-root' };
      const root = await realpath(selected);
      const git = (await (this.options.exec ?? execText)('git', ['-C', root, 'rev-parse', '--show-toplevel'], { cwd: root, env: minimalEnvironment() })).trim();
      if (!git || key(await realpath(git)) !== key(root)) return { outcome: 'invalid', reason: 'not-git' };
      const rootKey = key(root);
      let project = this.projects.get(rootKey);
      if (!project) {
        project = { projectId: randomUUID(), root, displayName: root.split(/[\\/]/).filter(Boolean).at(-1) || root };
        this.registerProject(project.projectId, root, project.displayName);
      }
      return { outcome: 'opened', project: { projectId: project.projectId, displayName: project.displayName } };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return { outcome: 'invalid', reason: code === 'EACCES' || code === 'EPERM' ? 'access-denied' : 'not-git' };
    }
  }

  async start(request: FlowAgentStartRequest): Promise<{ requestId: string; projectId: string; runId: string; state: 'queued' }> {
    if (this.closing) throw new FlowAgentError('unsupported-operation', 'FlowAgent is shutting down.');
    const project = this.projectIds.get(request.projectId);
    if (!project) throw new FlowAgentError('invalid-payload', 'Project is not open.');
    const worktrees = await this.listWorktrees(request.projectId);
    const selected = worktrees.find(item => key(item.path) === key(request.worktreePath ?? project.root));
    if (!selected || selected.branch === 'sem branch') throw new FlowAgentError('forbidden', 'Selected worktree is unavailable.');
    const root = await realpath(selected.path);
    if (key(root) !== key(selected.path) || !await safePath(root)) throw new FlowAgentError('forbidden', 'Selected worktree changed.');

    const references: string[] = [];
    for (const reference of request.references ?? []) {
      if (isAbsolute(reference) || reference.split(/[\\/]/).includes('..')) throw new FlowAgentError('forbidden', 'Reference is outside the worktree.');
      const candidate = resolve(root, reference);
      const rel = relative(root, candidate);
      if (rel.startsWith('..') || isAbsolute(rel) || !await safePath(candidate)) throw new FlowAgentError('forbidden', 'Reference is outside the worktree.');
      const actual = await realpath(candidate);
      const actualRelative = relative(root, actual);
      if (actualRelative.startsWith('..') || isAbsolute(actualRelative)) throw new FlowAgentError('forbidden', 'Reference is outside the worktree.');
      references.push(rel);
    }

    const rootKey = key(root);
    if (this.activeRoots.has(rootKey)) throw new FlowAgentError('forbidden', 'This worktree already has an active run.');
    let agent;
    try {
      agent = this.runtime.createAgent({
        projectId: request.projectId,
        worktreeId: selected.branch,
        taskId: request.requestId,
        workingDirectory: root,
        providerId: 'codex',
        role: request.profile,
      });
    } catch (error) { throw this.fromProviderError(error); }

    const createdSession = await this.runtime.createSession(agent.agentId).catch(error => { throw this.fromProviderError(error); });
    const run = this.makeRun({ projectId: request.projectId, root }, request.profile, request.requestId, createdSession.sessionId, agent.agentId);
    this.runs.set(run.runId, run);
    this.activeRoots.set(rootKey, run.runId);
    run.unsubscribeProvider.push(
      this.runtime.subscribe(agent.agentId, event => this.onProviderEvent(run, event)),
      this.runtime.subscribeOutput(agent.agentId, chunk => this.output(run, chunk.text)),
    );

    const task = references.length ? `${request.task}\n\nArquivos de referência no projeto: ${references.join(', ')}` : request.task;
    const setup = this.runtime.startSession(agent.agentId, run.runId, task);
    this.setups.add(setup);
    try { await setup; }
    catch (error) { throw this.fromProviderError(error); }
    finally { this.setups.delete(setup); }

    if (run.state === 'cancelled') throw new FlowAgentError('forbidden', 'Run was cancelled before process start.');
    return { requestId: request.requestId, projectId: request.projectId, runId: run.runId, state: 'queued' };
  }

  getRun(reference: FlowAgentRunReference): FlowAgentRunSnapshot | undefined {
    const run = this.runs.get(reference.runId);
    return run?.projectId === reference.projectId ? this.snapshot(run) : undefined;
  }

  subscribe(reference: FlowAgentRunReference, listener: (event: FlowAgentEvent) => void): boolean {
    const run = this.runs.get(reference.runId);
    if (!run || run.projectId !== reference.projectId) return false;
    run.listeners.add(listener);
    for (const event of run.history) listener(event);
    return true;
  }

  unsubscribe(reference: FlowAgentRunReference, listener: (event: FlowAgentEvent) => void): boolean {
    const run = this.runs.get(reference.runId);
    if (!run || run.projectId !== reference.projectId) return false;
    run.listeners.delete(listener);
    return true;
  }

  async cancel(reference: FlowAgentRunReference): Promise<'cancel-requested' | 'already-terminal' | 'not-found'> {
    const run = this.runs.get(reference.runId);
    if (!run || run.projectId !== reference.projectId) return 'not-found';
    if (TERMINAL.has(run.state)) return 'already-terminal';
    if (run.state !== 'cancel_requested') {
      run.state = 'cancel_requested';
      this.emit(run, 'run.cancel_requested', {});
      void this.runtime.stopAgent(run.agentId).catch(() => undefined);
    }
    return 'cancel-requested';
  }

  async shutdown(): Promise<void> {
    this.broker.close();
    if (this.closing) return;
    this.closing = true;
    await Promise.all([...this.runs.values()].filter(run => !TERMINAL.has(run.state)).map(run => this.runtime.stopAgent(run.agentId).catch(() => undefined)));
    await Promise.all([...this.setups].map(setup => setup.catch(() => undefined)));
    await Promise.all([...this.mcpServers.values()].map(server => server.close().catch(() => undefined)));
    await this.runtime.shutdown();
    for (const run of this.runs.values()) this.cleanup(run);
  }

  removeRendererListeners(): void {
    for (const run of this.runs.values()) run.listeners.clear();
  }

  private makeRun(project: { projectId: string; root: string }, profile: FlowAgentProfile, requestId: string, runId: string, agentId: string): InternalRun {
    return {
      projectId: project.projectId, runId, root: project.root, requestId, profile,
      state: 'running', startedAt: this.now().toISOString(), seq: 0,
      listeners: new Set(), history: [], unsubscribeProvider: [], agentId,
    };
  }

  private async resolveAgentWorktree(agent: import('../../domain/agent-provider.ts').AgentRecord): Promise<string> {
    const project = this.projectIds.get(agent.projectId);
    if (!project) throw new FlowAgentError('forbidden', 'Agent project must be reopened before creating a new provider session.');
    const worktree = (await this.listWorktrees(agent.projectId)).find(item => item.branch === agent.worktreeId);
    if (!worktree) throw new FlowAgentError('forbidden', 'Agent worktree is no longer available.');
    const root = await realpath(worktree.path);
    if (key(root) !== key(worktree.path) || !await safePath(root)) throw new FlowAgentError('forbidden', 'Agent worktree changed.');
    return root;
  }

  private onProviderEvent(run: InternalRun, event: AgentRuntimeEvent): void {
    if (TERMINAL.has(run.state) && event.type !== 'provider.protocolError') return;
    if (event.type === 'agent.started') {
      run.state = 'running';
      this.emit(run, 'run.started', { profile: run.profile });
    } else if (event.type === 'agent.action.started') {
      this.emit(run, 'run.progress', { message: String(event.data.action ?? 'Codex iniciou uma ação.') });
    } else if (event.type === 'provider.protocolError') {
      if (event.data.reason === 'malformed-jsonl' || event.data.reason === 'truncated-jsonl') run.protocolError = event.data.reason;
      this.emit(run, 'run.protocol_error', { reason: run.protocolError ?? 'malformed-jsonl' });
    } else if (event.type === 'agent.completed') {
      this.finish(run, { status: 'succeeded', exitCode: typeof event.data.exitCode === 'number' ? event.data.exitCode : null });
    } else if (event.type === 'agent.failed') {
      const reason = run.protocolError ?? 'process-error';
      this.finish(run, { status: 'failed', exitCode: typeof event.data.exitCode === 'number' ? event.data.exitCode : null, reason });
    } else if (event.type === 'agent.stopped') {
      this.finish(run, { status: 'cancelled', exitCode: typeof event.data.exitCode === 'number' ? event.data.exitCode : null, reason: 'cancelled' });
    }
  }

  private output(run: InternalRun, text: string): void {
    this.emit(run, 'run.output', { text });
  }

  private emit(run: InternalRun, type: FlowAgentEvent['type'], payload: object): void {
    const event = { projectId: run.projectId, runId: run.runId, seq: ++run.seq, type, payload } as FlowAgentEvent;
    if (!isFlowAgentEvent(event)) return;
    if (Buffer.byteLength(JSON.stringify(event.payload), 'utf8') > MAX_FLOW_AGENT_EVENT_PAYLOAD_BYTES) return;
    run.history.push(event);
    if (run.history.length > MAX_HISTORY) run.history.shift();
    for (const listener of run.listeners) listener(event);
  }

  private finish(run: InternalRun, result: FlowAgentRunResult): void {
    if (TERMINAL.has(run.state)) return;
    run.result = result;
    run.finishedAt = this.now().toISOString();
    run.state = result.status;
    try { this.options.onFinished?.(run.projectId, run.requestId, result.status); }
    catch { /* persistence errors do not interfere with provider cleanup */ }
    this.emit(run, result.status === 'succeeded' ? 'run.completed' : result.status === 'cancelled' ? 'run.cancelled' : 'run.failed', result);
    this.cleanup(run);
    this.prune();
  }

  private snapshot(run: InternalRun): FlowAgentRunSnapshot {
    return {
      projectId: run.projectId, runId: run.runId, state: run.state, profile: run.profile,
      ...(run.startedAt ? { startedAt: run.startedAt } : {}),
      ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
      ...(run.result ? { result: run.result } : {}),
    };
  }

  private cleanup(run: InternalRun): void {
    for (const unsubscribe of run.unsubscribeProvider.splice(0)) unsubscribe();
    if (this.activeRoots.get(key(run.root)) === run.runId && TERMINAL.has(run.state)) this.activeRoots.delete(key(run.root));
  }

  private prune(): void {
    const done = [...this.runs.values()].filter(run => TERMINAL.has(run.state));
    while (done.length > 100) {
      const run = done.shift();
      if (run) this.runs.delete(run.runId);
    }
  }

  private fromProviderError(error: unknown): FlowAgentError {
    if (error instanceof FlowAgentError) return error;
    if (error instanceof ProviderOperationError) {
      const category = error.code === 'unsupported' || error.code === 'timeout'
        ? 'unsupported-operation'
        : error.code === 'not-found' ? 'invalid-payload' : 'forbidden';
      return new FlowAgentError(category, error.message);
    }
    return new FlowAgentError('unsupported-operation', error instanceof Error ? error.message : 'Codex provider failed safely.');
  }
}
