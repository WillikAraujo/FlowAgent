import { timingSafeEqual, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import * as z from 'zod/v4';
import type { AgentRuntime } from '../runtime/agent-runtime.ts';
import { AgentAccessPolicy, type AgentPrincipal } from '../runtime/agent-access-policy.ts';
import { CommunicationBroker } from '../runtime/communication-broker.ts';
import { NotesService } from '../runtime/notes-service.ts';
import { ResponsibilityManager } from '../runtime/responsibility-manager.ts';
import type { KnowledgeService } from '../runtime/knowledge-service.ts';
import type { ContextEngine } from '../runtime/context-engine.ts';
import type { DecisionsService } from '../runtime/decisions-service.ts';

export interface AdeMcpDependencies {
  knowledge?: KnowledgeService;
  context?: ContextEngine;
  decisions?: DecisionsService;
  isAuthorized?: () => boolean;
  launchAgent?: (input: { provider: string; role: string; worktreeId: string; taskId?: string; task: string; agentId?: string; displayName?: string; specialties?: string[] }) => Promise<unknown>;
  runtime: AgentRuntime;
  broker: CommunicationBroker;
  notes: NotesService;
  responsibilities: ResponsibilityManager;
  policy: AgentAccessPolicy;
  principal: AgentPrincipal;
  resolveWorktree(projectId: string, worktreeId: string): Promise<string>;
}

const MAX_REQUEST_BYTES = 64 * 1024;

function toolResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

function toolError(error: unknown) {
  const message = error instanceof Error ? error.message : 'ADE runtime operation failed.';
  return { isError: true, content: [{ type: 'text' as const, text: message.slice(0, 240) }] };
}

function createMcpServer(deps: AdeMcpDependencies): McpServer {
  const server = new McpServer({ name: 'ade-agent-runtime', version: '1.0.0' }, { capabilities: { tools: {} } });
  const principal = deps.principal;

  server.registerTool('list_agents', {
    description: 'Lista os agentes do projeto autorizado e seus estados observados.',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => {
    try {
      deps.policy.authorize(principal, 'agent.inspect');
      const agents = await Promise.all(deps.runtime.listAgents(principal.projectId).map(agent => deps.runtime.inspectAgent(agent.agentId)));
      return toolResult(agents);
    } catch (error) { return toolError(error); }
  });

  server.registerTool('inspect_agent', {
    description: 'Consulta identidade, sessão atual e capabilities de um agente do projeto.',
    inputSchema: { agentId: z.string().min(1).max(128) },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ agentId }) => {
    try {
      const agent = deps.runtime.getAgent(agentId);
      if (!agent) throw new Error('Agent was not found.');
      deps.policy.authorize(principal, 'agent.inspect', agent);
      return toolResult(await deps.runtime.inspectAgent(agentId));
    } catch (error) { return toolError(error); }
  });

  server.registerTool('check_agent', {
    description: 'Atualiza e retorna o estado observado do agente.',
    inputSchema: { agentId: z.string().min(1).max(128) },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ agentId }) => {
    try {
      const agent = deps.runtime.getAgent(agentId);
      if (!agent) throw new Error('Agent was not found.');
      deps.policy.authorize(principal, 'agent.inspect', agent);
      return toolResult(await deps.runtime.getStatus(agentId));
    } catch (error) { return toolError(error); }
  });

  server.registerTool('create_agent', {
    description: 'Cria e inicia um agente em uma worktree validada pelo ADE Runtime.',
    inputSchema: {
      provider: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
      role: z.enum(['planner', 'developer', 'reviewer', 'tester']),
      worktreeId: z.string().min(1).max(256),
      taskId: z.string().max(128).optional(),
      task: z.string().min(1).max(7000),
      agentId: z.string().max(128).optional(), displayName: z.string().min(1).max(120).optional(), specialties: z.array(z.string().min(1).max(60)).max(16).optional(),
    },
    annotations: { destructiveHint: false, openWorldHint: false },
  }, async ({ provider, role, worktreeId, taskId, task, agentId, displayName, specialties }) => {
    try {
      deps.policy.authorize(principal, 'agent.create');
      if (deps.launchAgent) return toolResult(await deps.launchAgent({ provider, role, worktreeId, taskId, task, agentId, displayName, specialties }));
      const workingDirectory = await deps.resolveWorktree(principal.projectId, worktreeId);
      const agent = deps.runtime.createAgent({ projectId: principal.projectId, worktreeId, taskId, workingDirectory, providerId: provider, role });
      const session = await deps.runtime.createSession(agent.agentId);
      await deps.runtime.startSession(agent.agentId, session.sessionId, task);
      return toolResult(await deps.runtime.inspectAgent(agent.agentId));
    } catch (error) { return toolError(error); }
  });

  server.registerTool('send_message', {
    description: 'Envia uma mensagem a um agente se o provider suportar follow-up.',
    inputSchema: { to: z.string().min(1).max(128), message: z.string().min(1).max(8000), timeoutMs: z.number().int().min(1000).max(600000).optional(), contextRefs: references.optional(), parentMessageId: z.string().max(128).optional(), operationId: z.string().max(128).optional() },
    annotations: { openWorldHint: false },
  }, async ({ to, message, timeoutMs, contextRefs, parentMessageId, operationId }) => {
    try {
      return toolResult(await deps.broker.sendMessage({ principal, from: principal.id, to, message, timeoutMs, contextRefs, parentMessageId, operationId }));
    } catch (error) { return toolError(error); }
  });

  server.registerTool('ask_agent', {
    description: 'Envia uma pergunta a outro agente e aguarda a primeira resposta observável.',
    inputSchema: { to: z.string().min(1).max(128), message: z.string().min(1).max(8000), timeoutMs: z.number().int().min(1000).max(600000).optional(), contextRefs: references.optional(), parentMessageId: z.string().max(128).optional(), operationId: z.string().max(128).optional() },
    annotations: { openWorldHint: false },
  }, async ({ to, message, timeoutMs, contextRefs, parentMessageId, operationId }) => {
    try {
      return toolResult(await deps.broker.askAgent({ principal, from: principal.id, to, message, timeoutMs, contextRefs, parentMessageId, operationId }));
    } catch (error) { return toolError(error); }
  });

  server.registerTool('broadcast', {
    description: 'Envia a mesma instrução para até 10 agentes do projeto.',
    inputSchema: { to: z.array(z.string().min(1).max(128)).min(1).max(10), message: z.string().min(1).max(8000) },
    annotations: { openWorldHint: false },
  }, async ({ to, message }) => {
    try { return toolResult(await deps.broker.broadcast({ principal, from: principal.id, to, message })); }
    catch (error) { return toolError(error); }
  });

  server.registerTool('wait_agent', {
    description: 'Aguarda output observável de um agente até o limite informado.',
    inputSchema: { agentId: z.string().min(1).max(128), timeoutMs: z.number().int().min(1000).max(600000).optional() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ agentId, timeoutMs }) => {
    try {
      const agent = deps.runtime.getAgent(agentId);
      if (!agent) throw new Error('Agent was not found.');
      deps.policy.authorize(principal, 'agent.communicate', agent);
      return toolResult(await deps.broker.waitForResponse(agentId, { timeoutMs }));
    } catch (error) { return toolError(error); }
  });

  server.registerTool('create_note', {
    description: 'Cria nota no contexto compartilhado do runtime.',
    inputSchema: { title: z.string().min(1).max(120), body: z.string().max(1500), targetAgentIds: z.array(z.string().min(1).max(128)).max(10).optional(), tags: z.array(z.string().max(40)).max(16).optional(), priority: z.number().int().min(0).max(3).optional(), relations: references.optional(), operationId: z.string().max(128).optional() },
    annotations: { openWorldHint: false },
  }, async ({ title, body, ...options }) => {
    try { return toolResult(deps.notes.create(principal, title, body, options)); }
    catch (error) { return toolError(error); }
  });

  server.registerTool('read_note', {
    description: 'Lê uma nota compartilhada com o principal autenticado.',
    inputSchema: { noteId: z.string().min(1).max(128) },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ noteId }) => {
    try { return toolResult(deps.notes.read(principal, noteId)); }
    catch (error) { return toolError(error); }
  });

  server.registerTool('update_note', {
    description: 'Atualiza uma nota que o principal pode editar.',
    inputSchema: { noteId: z.string().min(1).max(128), expectedRevision: z.number().int().min(1), title: z.string().min(1).max(120).optional(), body: z.string().max(1500).optional() },
    annotations: { openWorldHint: false },
  }, async ({ noteId, title, body, expectedRevision }) => {
    try { return toolResult(deps.notes.update(principal, noteId, { title, body, expectedRevision })); }
    catch (error) { return toolError(error); }
  });

  server.registerTool('link_note', {
    description: 'Compartilha uma nota com um agente do mesmo projeto.',
    inputSchema: { noteId: z.string().min(1).max(128), agentId: z.string().min(1).max(128) },
    annotations: { openWorldHint: false },
  }, async ({ noteId, agentId }) => {
    try { return toolResult(deps.notes.link(principal, noteId, agentId)); }
    catch (error) { return toolError(error); }
  });

  server.registerTool('assign_responsibility', {
    description: 'Cria uma responsabilidade dependente de outras no DAG da tarefa.',
    inputSchema: { taskId: z.string().min(1).max(128), title: z.string().min(1).max(200), assignedTo: z.string().max(128).optional(), dependsOn: z.array(z.string().max(128)).max(32).optional() },
    annotations: { openWorldHint: false },
  }, async ({ taskId, title, assignedTo, dependsOn }) => {
    try { return toolResult(deps.responsibilities.assign(principal, { taskId, title, assignedTo, dependsOn })); }
    catch (error) { return toolError(error); }
  });

  server.registerTool('transfer_responsibility', {
    description: 'Transfere uma responsabilidade a outro agente do projeto.',
    inputSchema: { responsibilityId: z.string().min(1).max(128), agentId: z.string().min(1).max(128) },
    annotations: { openWorldHint: false },
  }, async ({ responsibilityId, agentId }) => {
    try { return toolResult(deps.responsibilities.transfer(principal, responsibilityId, agentId)); }
    catch (error) { return toolError(error); }
  });

  server.registerTool('list_responsibilities', {
    description: 'Lista responsabilidades persistentes do projeto autorizado.',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => {
    try { return toolResult(deps.responsibilities.list(principal)); }
    catch (error) { return toolError(error); }
  });

  server.registerTool('update_responsibility', {
    description: 'Atualiza o estado de uma responsabilidade atribuída ao agente ou ao usuário.',
    inputSchema: { responsibilityId: z.string().min(1).max(128), status: z.enum(['pending', 'ready', 'assigned', 'in_progress', 'blocked', 'completed', 'failed']) },
    annotations: { openWorldHint: false },
  }, async ({ responsibilityId, status }) => {
    try { return toolResult(deps.responsibilities.setStatus(principal, responsibilityId, status)); }
    catch (error) { return toolError(error); }
  });

  server.registerTool('inspect_session', {
    description: 'Consulta o estado e as capabilities da sessão atual de um agente.',
    inputSchema: { agentId: z.string().min(1).max(128) },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ agentId }) => {
    try {
      const agent = deps.runtime.getAgent(agentId);
      if (!agent) throw new Error('Agent was not found.');
      deps.policy.authorize(principal, 'agent.inspect', agent);
      return toolResult(await deps.runtime.inspectAgent(agentId));
    } catch (error) { return toolError(error); }
  });

  const register = (name: string, description: string, inputSchema: Record<string, z.ZodType>, handler: (input: any) => unknown | Promise<unknown>, readOnly = false) => {
    server.registerTool(name, { description, inputSchema, annotations: { readOnlyHint: readOnly, openWorldHint: false } }, async input => {
      try { return toolResult(await handler(input)); } catch (error) { return toolError(error); }
    });
  };
  const question = { to: z.string().min(1).max(128), message: z.string().min(1).max(7000), timeoutMs: z.number().int().min(1000).max(600000).optional(), contextRefs: references.optional(), parentMessageId: z.string().max(128).optional(), operationId: z.string().max(128).optional() };
  register('ask_agent_async', 'Create a durable question and return a receipt without blocking your turn.', question, input => deps.broker.ask({ ...input, principal, from: principal.id }));
  register('reply_agent', 'Answer a specific ADE question; provider output alone is not a reply.', { messageId: z.string().max(128), response: z.string().min(1).max(8000) }, input => deps.broker.reply(principal, input.messageId, input.response));
  register('list_inbox', 'Read addressed questions and replies to your questions.', { afterId: z.string().max(128).optional(), limit: z.number().int().min(1).max(100).optional() }, input => deps.broker.listInbox(principal, input.afterId, input.limit), true);
  register('get_interaction', 'Read an authorized correlated interaction.', { messageId: z.string().max(128) }, input => deps.broker.getInteraction(principal,input.messageId), true);
  register('wait_reply', 'Wait for an explicit answer to your question with a bounded deadline.', { messageId: z.string().max(128), timeoutMs: z.number().int().min(1000).max(600000).optional() }, input => deps.broker.waitForReply(principal,input.messageId,{timeoutMs:input.timeoutMs}), true);
  register('cancel_question', 'Cancel an open question you requested.', { messageId: z.string().max(128) }, input => deps.broker.cancel(principal,input.messageId));
  register('list_notes', 'Read notes shared with your identity.', {}, () => deps.notes.list(principal), true);
  register('transition_note', 'Acknowledge, resolve, supersede or archive a note with revision checking.', { noteId: z.string().max(128), expectedRevision: z.number().int().min(1), action: z.enum(['acknowledge','resolve','archive','supersede']), replacementId: z.string().max(128).optional() }, input => deps.notes.transition(principal,input.noteId,input.expectedRevision,input.action,input.replacementId));
  if (deps.knowledge) {
    const knowledge = deps.knowledge;
    const knowledgeInput = { title: z.string().min(1).max(120), body: z.string().max(1500), scope: z.enum(['agent','project']).optional(), category: z.enum(['rule','finding','context']).optional(), tags: z.array(z.string().max(40)).max(16).optional(), relations: references.optional(), operationId: z.string().max(128).optional(), validUntil: z.string().optional(), priority: z.number().int().min(0).max(3).optional() };
    register('create_memory', 'Store explicit relevant knowledge for your identity; conversations are not automatically memory.', knowledgeInput, input => knowledge.create(principal,'memory',input));
    register('list_memory', 'Read authorized individual and project memory.', {}, () => knowledge.list(principal,'memory'), true);
    register('update_memory', 'Update writable memory with optimistic concurrency.', { id:z.string().max(128), expectedRevision:z.number().int().min(1), title:z.string().max(120).optional(), body:z.string().max(1500).optional() }, input => knowledge.update(principal,'memory',input.id,input.expectedRevision,{...(input.title === undefined ? {} : {title:input.title}),...(input.body === undefined ? {} : {body:input.body})}));
    register('transition_memory', 'Archive or supersede persistent memory.', { id:z.string().max(128), expectedRevision:z.number().int().min(1), action:z.enum(['archive','supersede']), replacementId:z.string().max(128).optional() }, input => knowledge.transition(principal,'memory',input.id,input.expectedRevision,input.action,{replacementId:input.replacementId}));
    register('share_knowledge', 'User or Maestro explicitly grants readers and writers.', { kind:z.enum(['note','memory','decision']), id:z.string().max(128), expectedRevision:z.number().int().min(1), readers:z.array(z.string().max(128)).max(10), writers:z.array(z.string().max(128)).max(10) }, input => knowledge.share(principal,input.kind,input.id,input.expectedRevision,input.readers,input.writers));
    register('propose_decision', 'Propose a project decision; acceptance is a separate authorized operation.', knowledgeInput, input => knowledge.create(principal,'decision',input));
    register('update_decision', 'Edit a writable proposal with revision checking; accepted decisions are immutable.', { id:z.string().max(128), expectedRevision:z.number().int().min(1), title:z.string().max(120).optional(), body:z.string().max(1500).optional() }, input => knowledge.update(principal,'decision',input.id,input.expectedRevision,{...(input.title === undefined ? {} : {title:input.title}),...(input.body === undefined ? {} : {body:input.body})}));
    register('list_decisions', 'Read decision proposals and their audited status.', {}, () => knowledge.list(principal,'decision'), true);
    register('transition_decision', 'Validate as Reviewer or consolidate as authorized Maestro.', { id:z.string().max(128), expectedRevision:z.number().int().min(1), action:z.enum(['validate','accept','reject','archive']), replacementId:z.string().max(128).optional(), justification:z.string().max(1500).optional() }, input => knowledge.transition(principal,'decision',input.id,input.expectedRevision,input.action,{replacementId:input.replacementId,justification:input.justification}));
  }
  if (deps.context) register('retrieve_context', 'Select only authorized relevant current knowledge within the context budget.', { task:z.string().min(1).max(7000), taskId:z.string().max(128).optional(), files:references.optional(), tags:z.array(z.string().max(40)).max(16).optional() }, input => deps.context!.select(principal,input), true);
  return server;
}

const references = z.array(z.object({ type: z.enum(['execution','task','agent','file','commit','artifact','decision','note','message']), id:z.string().min(1).max(256), worktreeId:z.string().max(256).optional() })).max(32);

export class AdeMcpHttpServer {
  private server?: HttpServer;
  private readonly dependencies: AdeMcpDependencies;
  private token?: string;

  constructor(dependencies: AdeMcpDependencies) { this.dependencies = dependencies; }

  async start(): Promise<{ endpoint: string; token: string }> {
    if (this.server?.listening && this.token) {
      const address = this.server.address();
      if (address && typeof address !== 'string') return { endpoint: `http://127.0.0.1:${address.port}/mcp`, token: this.token };
    }
    this.token = randomBytes(32).toString('base64url');
    this.server = createServer((request, response) => { void this.handle(request, response); });
    this.server.requestTimeout = 120000;
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(0, '127.0.0.1', () => { this.server!.removeListener('error', reject); resolve(); });
    });
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('ADE MCP server did not bind a local port.');
    return { endpoint: `http://127.0.0.1:${address.port}/mcp`, token: this.token };
  }

  async close(): Promise<void> {
    this.token = undefined;
    if (!this.server) return;
    const server = this.server;
    this.server = undefined;
    await new Promise<void>(resolve => server.close(() => resolve()));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== 'POST' || request.url !== '/mcp') { response.writeHead(404).end(); return; }
    const expected = Buffer.from(`Bearer ${this.token ?? ''}`);
    const received = Buffer.from(request.headers.authorization ?? '');
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) { response.writeHead(401).end(); return; }
    if (this.dependencies.isAuthorized && !this.dependencies.isAuthorized()) { response.writeHead(403).end(); return; }
    try {
      const body = await this.readBody(request);
      const server = createMcpServer(this.dependencies);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await server.connect(transport);
      response.once('close', () => { void transport.close(); void server.close(); });
      await transport.handleRequest(request, response, body);
    } catch (error) {
      if (!response.headersSent) response.writeHead(error instanceof RangeError ? 413 : 400, { 'content-type': 'application/json' });
      if (!response.writableEnded) response.end(JSON.stringify({ error: 'Invalid MCP request.' }));
    }
  }

  private async readBody(request: IncomingMessage): Promise<unknown> {
    const declared = Number(request.headers['content-length'] ?? 0);
    if (declared > MAX_REQUEST_BYTES) throw new RangeError('MCP request is too large.');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > MAX_REQUEST_BYTES) throw new RangeError('MCP request is too large.');
      chunks.push(buffer);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
}
