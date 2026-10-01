import { randomUUID } from 'node:crypto';
import type { AgentRuntimeOutput, Unsubscribe } from '../../domain/agent-provider.ts';
import { ProviderOperationError } from '../../domain/agent-provider.ts';
import { allRecords, jsonData, type CollaborationMessage, type CollaborationStore, type ContextReference } from '../../domain/collaboration.ts';
import type { AgentRuntime } from './agent-runtime.ts';
import { AgentAccessPolicy, type AgentPrincipal } from './agent-access-policy.ts';
import { isAdministrator, validateReferences } from './knowledge-service.ts';

export type AgentMessage = CollaborationMessage;
export interface AskAgentInput {
  principal: AgentPrincipal; from: string; to: string; message: string; timeoutMs?: number; signal?: AbortSignal;
  contextRefs?: ContextReference[]; parentMessageId?: string; operationId?: string;
}
export interface UserAgentMessageInput { principal: AgentPrincipal; projectId: string; to: string; message: string; signal?: AbortSignal }
const OPEN = new Set(['queued','delivered','delivery_uncertain']);
const pending = (m:AgentMessage) => OPEN.has(m.state) && (m.kind === 'ask' || m.state !== 'delivered');

/** ADE request/reply protocol. Provider output is never interpreted as a reply. */
export class CommunicationBroker {
  private readonly transient = new Map<string, AgentMessage>();
  private readonly subscriptions = new Map<string, Unsubscribe>();
  private readonly dispatching = new Set<string>();
  private readonly drainRequested = new Set<string>();
  private closed = false;
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly projects = new Set<string>();
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly runtime: AgentRuntime;
  private readonly policy: AgentAccessPolicy;
  private readonly now: () => Date;
  private readonly store?: CollaborationStore;
  constructor(runtime: AgentRuntime, policy = new AgentAccessPolicy(), now = () => new Date(), store?: CollaborationStore) {
    this.runtime=runtime;this.policy=policy;this.now=now;this.store=store;
    for (const projectId of runtime.projectIds()) for (const message of this.records(projectId).filter(pending)) {
      this.save({ ...message, state: message.state === 'queued' ? 'failed' : 'delivery_uncertain', failure: 'runtime-restarted' }, 'agent.ask.interrupted');
    }
    this.timer = setInterval(() => { try { this.expirePending(); } catch { /* persistence failure prevents further delivery */ } }, 1000);
    this.timer.unref();
  }
  async ask(input: AskAgentInput): Promise<AgentMessage> { return this.enqueue(input, 'ask'); }
  async sendMessage(input: AskAgentInput): Promise<AgentMessage> { return this.enqueue(input, 'send'); }
  async sendUserMessage(input: UserAgentMessageInput): Promise<AgentMessage> {
    if (input.principal.kind !== 'user' || input.projectId !== input.principal.projectId) throw new Error('Invalid user principal.');
    const result = await this.enqueue({ ...input, from: 'user' }, 'send');
    if (result.state === 'failed') throw new ProviderOperationError('unsupported', result.failure ?? 'Delivery failed.');
    return result;
  }
  async askAgent(input: AskAgentInput): Promise<AgentMessage> {
    const message = await this.ask(input);
    if (message.state === 'failed') throw new ProviderOperationError('unsupported', message.failure ?? 'Delivery failed.');
    return this.waitForReply(input.principal, message.messageId, { signal: input.signal, timeoutMs: input.timeoutMs });
  }
  reply(p: AgentPrincipal, id: string, response: string): AgentMessage {
    this.policy.authorize(p, 'agent.communicate'); this.validateText(response);
    const item = this.require(p.projectId, id);
    if (p.kind !== 'agent' || p.id !== item.toAgentId) throw new Error('Only the addressed agent can reply.');
    if (item.kind !== 'ask') throw new Error('This message does not request a reply.');
    if (item.targetExecutionId && this.runtime.executionId(p.id) !== item.targetExecutionId) throw new Error('Reply belongs to a different execution.');
    if (item.state === 'responded' && item.response === response) return item;
    if (!OPEN.has(item.state) || item.failure || Date.parse(item.deadline) <= this.now().getTime()) {
      if (OPEN.has(item.state) && !item.failure) this.save({ ...item, state: 'timed_out' }, 'agent.ask.timed_out');
      this.save(this.require(p.projectId,id), 'agent.reply.rejected', { authorId: p.id, reason: 'question-closed' });
      throw new Error('The question is closed; late replies cannot complete another execution.');
    }
    return this.save({ ...item, targetExecutionId: item.targetExecutionId ?? this.runtime.executionId(p.id), state: 'responded', response, respondedAt: this.now().toISOString() }, 'agent.reply.created', { authorId: p.id, fromAgentId:p.id, toAgentId:item.fromAgentId });
  }
  cancel(p: AgentPrincipal, id: string): AgentMessage {
    const item = this.getInteraction(p,id);
    if (!isAdministrator(p) && item.fromAgentId !== p.id) throw new Error('Only the requester may cancel a question.');
    if (!OPEN.has(item.state)) throw new Error('Question is already closed.');
    return this.save({ ...item, state: 'cancelled' }, 'agent.ask.cancelled', { authorId: p.id });
  }
  getInteraction(p: AgentPrincipal, id: string): AgentMessage {
    this.policy.authorize(p,'agent.communicate');
    const item = this.require(p.projectId,id);
    if (!isAdministrator(p) && item.fromAgentId !== p.id && item.toAgentId !== p.id) throw new Error('Interaction is not shared with this agent.');
    return item;
  }
  listInbox(p: AgentPrincipal, afterId = '', limit = 100): AgentMessage[] {
    this.policy.authorize(p,'agent.communicate'); this.expirePending();
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Inbox limit must be between 1 and 100.');
    const records = this.records(p.projectId).filter(m => m.toAgentId === p.id || (m.fromAgentId === p.id && m.state === 'responded')).sort((a,b) => a.sentAt.localeCompare(b.sentAt) || a.messageId.localeCompare(b.messageId));
    const after = afterId ? records.findIndex(m=>m.messageId===afterId) : -1;
    if (afterId && after < 0) throw new Error('Inbox cursor was not found for this identity.');
    return records.slice(after+1,after+1+limit);
  }
  waitForReply(p: AgentPrincipal, id: string, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<AgentMessage> {
    const message = this.getInteraction(p,id);
    if (!isAdministrator(p) && message.fromAgentId !== p.id) throw new Error('Only the requester may wait for a reply.');
    if (p.kind === 'agent' && message.sourceExecutionId && this.runtime.executionId(p.id) !== message.sourceExecutionId) throw new Error('Question belongs to a previous execution.');
    return new Promise((resolve,reject) => {
      const listeners = this.waiters.get(id) ?? new Set<() => void>(); this.waiters.set(id,listeners);
      let timer: ReturnType<typeof setTimeout>;
      const cleanup = () => { clearTimeout(timer); listeners.delete(check); if (!listeners.size) this.waiters.delete(id); options.signal?.removeEventListener('abort',abort); };
      const check = () => {
        const current = this.require(p.projectId,id);
        if (current.state === 'responded') { cleanup(); resolve(current); }
        else if (!OPEN.has(current.state) || current.failure) { cleanup(); reject(new ProviderOperationError(current.state === 'timed_out' ? 'timeout' : current.state === 'cancelled' ? 'cancelled' : 'failed', current.failure ?? `Question ${current.state}.`)); }
      };
      const abort = () => { try { this.cancel(p,id); } catch (error) { cleanup(); reject(error); } };
      const wait = Math.max(1,Math.min(options.timeoutMs ?? 120000,600000,Date.parse(message.deadline)-this.now().getTime()));
      timer = setTimeout(() => { cleanup(); try { this.expirePending(); } catch (error) { reject(error); return; } reject(new ProviderOperationError('timeout','Timed out waiting for a correlated reply.')); },wait);
      listeners.add(check); options.signal?.addEventListener('abort',abort,{once:true});
      if (options.signal?.aborted) abort(); else check();
    });
  }
  async broadcast(input: Omit<AskAgentInput,'to'> & { to: string[] }): Promise<AgentMessage[]> {
    if (!input.to.length || input.to.length > 10 || new Set(input.to).size !== input.to.length) throw new Error('Broadcast requires 1 to 10 distinct recipients.');
    return Promise.all(input.to.map(to => this.sendMessage({ ...input,to })));
  }
  waitForResponse(agentId: string, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<AgentRuntimeOutput> {
    if (!this.runtime.getAgent(agentId)) throw new ProviderOperationError('not-found','Agent was not found.');
    return new Promise((resolve,reject) => {
      let stop: Unsubscribe = () => undefined;
      const finish = (error?: Error, output?: AgentRuntimeOutput) => { clearTimeout(timer); stop(); options.signal?.removeEventListener('abort',abort); if (error) reject(error); else resolve(output!); };
      const abort = () => finish(new ProviderOperationError('cancelled','Waiting for output was cancelled.'));
      const timer = setTimeout(() => finish(new ProviderOperationError('timeout','Timed out waiting for output.')),options.timeoutMs ?? 120000);
      if (options.signal?.aborted) { abort(); return; }
      options.signal?.addEventListener('abort',abort,{once:true}); stop = this.runtime.subscribeOutput(agentId,output => finish(undefined,output));
    });
  }
  expirePending(): void {
    for (const project of this.projects) for (const item of this.records(project)) if (pending(item) && !item.failure && Date.parse(item.deadline) <= this.now().getTime()) this.save({ ...item,state:'timed_out' },'agent.ask.timed_out');
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    for (const project of this.projects) for (const item of this.records(project).filter(m => pending(m) && !m.failure)) this.save({ ...item,state:'cancelled',failure:'runtime-shutdown' },'agent.ask.cancelled');
    for (const stop of this.subscriptions.values()) stop(); this.subscriptions.clear();
  }
  private async enqueue(input: AskAgentInput, kind: 'ask' | 'send'): Promise<AgentMessage> {
    if (this.closed) throw new ProviderOperationError('cancelled','Communication runtime has shut down.');
    this.policy.authorize(input.principal,'agent.communicate'); this.validateText(input.message);
    if (input.signal?.aborted) throw new ProviderOperationError('cancelled','Communication was cancelled.');
    const source = input.from === 'user' && input.principal.kind === 'user' ? undefined : this.runtime.getAgent(input.from);
    const target = this.runtime.getAgent(input.to);
    if (!target || (!source && !(input.from === 'user' && input.principal.kind === 'user')) || target.projectId !== input.principal.projectId || (source && source.projectId !== input.principal.projectId) || (input.principal.kind !== 'user' && input.from !== input.principal.id)) throw new ProviderOperationError('failed','Communication is limited to the authenticated identity and project.');
    if (source?.agentId === target.agentId) throw new Error('An agent cannot ask itself.');
    this.projects.add(target.projectId);
    if (this.store) validateReferences(this.store,target.projectId,input.contextRefs ?? []);
    const activeIncoming = this.records(target.projectId).find(m => m.toAgentId === input.from && m.kind === 'ask' && pending(m) && m.targetExecutionId === this.runtime.executionId(input.from));
    const parent = input.parentMessageId ? this.getInteraction(input.principal,input.parentMessageId) : activeIncoming;
    if (parent && (!OPEN.has(parent.state) || parent.toAgentId !== input.from)) throw new Error('Parent question must be open and addressed to this agent.');
    const depth = parent ? parent.depth+1 : 0;
    if (depth > 4) throw new Error('Communication maximum depth exceeded.');
    const records = this.records(target.projectId);
    if (input.operationId) {
      if (!/^[A-Za-z0-9._:-]{1,128}$/.test(input.operationId)) throw new Error('Invalid operation ID.');
      const previous = records.find(m => m.fromAgentId === input.from && m.operationId === input.operationId);
      if (previous) {
        if (previous.sourceExecutionId !== (source ? this.runtime.executionId(source.agentId) : null)) throw new Error('Operation ID belongs to a previous execution.');
        if (previous.message !== input.message || previous.toAgentId !== input.to || previous.kind !== kind || JSON.stringify(previous.contextRefs) !== JSON.stringify(input.contextRefs ?? [])) throw new Error('Operation ID is associated with a different message.');
        return previous;
      }
    }
    if (kind === 'ask') {
      const open = records.filter(m => m.kind === 'ask' && OPEN.has(m.state) && !m.failure);
      if (open.filter(m => m.fromAgentId === input.from).length >= 10) throw new Error('Agent has too many open questions.');
      if (records.filter(m => m.kind === 'ask' && m.fromAgentId === input.from && m.sourceExecutionId === this.runtime.executionId(input.from)).length >= 50) throw new Error('Execution question budget exceeded.');
      const visited = new Set<string>();
      const reachesSource = (id: string): boolean => { if (id === input.from) return true; if (visited.has(id)) return false; visited.add(id); return open.filter(m => m.fromAgentId === id).some(m => reachesSource(m.toAgentId)); };
      if (reachesSource(target.agentId)) throw new Error('Communication cycle is denied.');
    }
    const timeout = Math.max(1000,Math.min(input.timeoutMs ?? 120000,600000));
    const message: AgentMessage = { messageId:randomUUID(),projectId:target.projectId,correlationId:parent?.correlationId ?? randomUUID(),fromAgentId:input.from,toAgentId:target.agentId,
      worktreeId:target.worktreeId,kind,message:input.message,state:'queued',sourceExecutionId:source ? this.runtime.executionId(source.agentId) : null,targetExecutionId:null,taskId:source?.taskId ?? target.taskId ?? null,
      parentMessageId:parent?.messageId ?? null,depth,contextRefs:input.contextRefs ?? [],sentAt:this.now().toISOString(),deadline:new Date(this.now().getTime()+timeout).toISOString(),deliveredAt:null,respondedAt:null,response:null,failure:null,operationId:input.operationId ?? null,revision:0 };
    this.save(message,kind === 'ask' ? 'agent.ask.created' : 'agent.message.created');
    if (source && !this.subscriptions.has(`source:${source.agentId}`)) this.subscriptions.set(`source:${source.agentId}`,this.runtime.subscribeLive(source.agentId,event=>{
      if (['agent.failed','agent.stopped','agent.completed'].includes(event.type)) for (const outgoing of this.records(source.projectId).filter(m=>m.fromAgentId===source.agentId && pending(m) && !m.failure)) this.save({...outgoing,state:'cancelled',failure:'source-session-ended'},'agent.ask.cancelled');
    }));
    if (!this.subscriptions.has(target.agentId)) this.subscriptions.set(target.agentId,this.runtime.subscribeLive(target.agentId,event => {
      if (event.type === 'agent.turn.completed' || event.type === 'agent.waiting') void this.drain(target.agentId).catch(() => undefined);
      if (['agent.failed','agent.stopped','agent.completed'].includes(event.type)) for (const item of this.records(target.projectId).filter(m => m.toAgentId === target.agentId && pending(m) && !m.failure)) this.save({ ...item,state:'failed',failure:'recipient-session-ended' },'agent.ask.failed');
    }));
    await this.drain(target.agentId);
    return this.require(target.projectId,message.messageId);
  }
  private async drain(agentId: string): Promise<void> {
    if (this.closed) return;
    if (this.dispatching.has(agentId)) { this.drainRequested.add(agentId); return; }
    const target = this.runtime.getAgent(agentId); if (!target) return;
    this.dispatching.add(agentId);
    try {
      this.expirePending();
      const inspection = await this.runtime.inspectAgent(agentId);
      if (this.closed) return;
      const pending = this.records(target.projectId).filter(m => m.toAgentId === agentId && m.state === 'queued').sort((a,b) => a.sentAt.localeCompare(b.sentAt));
      if (inspection.capabilities.sendMessage.support === 'unsupported') { for (const m of pending) this.save({ ...m,state:'failed',failure:inspection.capabilities.sendMessage.reason ?? 'Provider does not support follow-up.' },'agent.ask.failed'); return; }
      if (inspection.capabilities.sendMessage.support !== 'supported') return;
      const queued = pending[0]; if (!queued) return;
      const started = this.save({ ...queued,state:'delivery_uncertain',targetExecutionId:this.runtime.executionId(agentId) },'agent.message.delivery.started');
      this.runtime.setConversationTarget(agentId,queued.fromAgentId);
      try {
        const prompt = queued.kind === 'ask' ? `ADE question ${queued.messageId} from ${queued.fromAgentId}. Reply using reply_agent(messageId, response); output alone is not a reply.\nContext references: ${JSON.stringify(queued.contextRefs)}\n${queued.message}` : queued.message;
        await this.runtime.sendMessage(agentId,prompt,{timeoutMs:Math.max(1000,Date.parse(queued.deadline)-this.now().getTime()),contextRefs:queued.contextRefs});
      } catch (error) {
        const current = this.require(target.projectId,started.messageId);
        if (current.state === 'delivery_uncertain') this.save({ ...current,state:'failed',failure:error instanceof Error ? error.message.slice(0,240) : 'Delivery failed.' },'agent.ask.failed');
        this.runtime.setConversationTarget(agentId,null); return;
      }
      const latest = this.require(target.projectId,started.messageId);
      if (latest.state === 'delivery_uncertain') this.save({ ...latest,state:'delivered',deliveredAt:this.now().toISOString() },queued.kind === 'ask' ? 'agent.ask.delivered' : 'agent.message.delivered');
    } finally {
      this.dispatching.delete(agentId);
      if (this.drainRequested.delete(agentId) && !this.closed) void this.drain(agentId).catch(() => undefined);
    }
  }
  private validateText(text: string): void { if (typeof text !== 'string' || !text.trim() || text.length > 8000) throw new Error('Messages must contain 1 to 8000 characters.'); }
  private records(projectId: string): AgentMessage[] { return this.store ? allRecords(this.store,projectId,'message').map(r => ({ ...r.data,messageId:r.entityId,revision:r.revision }) as unknown as AgentMessage) : [...this.transient.values()].filter(m => m.projectId === projectId); }
  private require(projectId: string, id: string): AgentMessage {
    const record = this.store?.getEntity(projectId,'message',id);
    const item = record ? ({ ...record.data,messageId:id,revision:record.revision } as unknown as AgentMessage) : this.transient.get(id);
    if (!item || item.projectId !== projectId) throw new Error('Message was not found in this project.'); return item;
  }
  private save(item: AgentMessage, type: string, extra: Record<string,unknown> = {}): AgentMessage {
    this.projects.add(item.projectId);
    const { revision,...data } = item;
    if (this.store) this.store.commit({projectId:item.projectId,entityId:item.messageId,entityType:'message',origin:'system',type,correlationId:item.correlationId,expectedRevision:revision,
      payload:jsonData({authorId:item.fromAgentId,fromAgentId:item.fromAgentId,toAgentId:item.toAgentId,messageId:item.messageId,taskId:item.taskId,sourceExecutionId:item.sourceExecutionId,targetExecutionId:item.targetExecutionId,state:item.state,...extra}),entityData:jsonData(data)});
    else this.transient.set(item.messageId,{...item,revision:revision+1});
    for (const listener of this.waiters.get(item.messageId) ?? []) listener();
    return this.require(item.projectId,item.messageId);
  }
}
