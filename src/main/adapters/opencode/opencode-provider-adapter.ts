import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { delimiter, join, normalize, parse, relative, resolve, sep } from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import type {
  AgentCapabilities, AgentProviderAdapter, ProviderCallOptions, ProviderEvent, ProviderEventHandler,
  ProviderOutputChunk, ProviderOutputHandler, ProviderSession, ProviderSessionInput, ProviderSessionStatus,
  ProviderStartInput, Unsubscribe,
} from '../../../domain/agent-provider.ts';
import { ProviderOperationError } from '../../../domain/agent-provider.ts';

const MAX_OUTPUT = 2 * 1024 * 1024;
const MAX_CHUNK = 2048;

type OpenCodeSession = {
  value: ProviderSession;
  input: ProviderSessionInput;
  child: ChildProcess;
  connection?: Promise<unknown>;
  context?: acp.ClientContext;
  closeConnection: () => void;
  active?: acp.ActiveSession;
  acpSessionId?: string;
  canLoadSession: boolean;
  outputBytes: number;
  sequence: number;
  listeners: Set<ProviderEventHandler>;
  outputListeners: Set<ProviderOutputHandler>;
  stderrBytes: number;
  stopRequested: boolean;
  promptQueue: Promise<void>;
  timeout?: NodeJS.Timeout;
};

export interface OpenCodeProviderAdapterOptions {
  spawnProcess?: typeof spawn;
  executable?: () => Promise<string>;
  now?: () => Date;
}

function pathKey(path: string): string {
  const value = normalize(resolve(path));
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function minimalEnvironment(): NodeJS.ProcessEnv {
  const names = process.platform === 'win32'
    ? ['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH']
    : ['PATH', 'HOME', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME'];
  return Object.fromEntries(names.flatMap(name => process.env[name] === undefined ? [] : [[name, process.env[name]!]]));
}

function safeText(value: string): string {
  return value
    .replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gi, '[REDACTED]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/g, '[REDACTED]');
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

export async function findOpenCode(): Promise<string> {
  const path = process.env.PATH;
  if (!path) throw new ProviderOperationError('unsupported', 'OpenCode CLI is unavailable.');
  const name = process.platform === 'win32' ? 'opencode.exe' : 'opencode';
  for (const raw of path.split(delimiter).filter(Boolean)) {
    const directory = raw.replace(/^"(.*)"$/, '$1');
    if (parse(directory).root === directory) continue;
    const candidate = join(directory, name);
    try {
      const stat = await lstat(candidate);
      if (!stat.isFile() || stat.isSymbolicLink() || !await safePath(candidate)) continue;
      const actual = await realpath(candidate);
      if (pathKey(actual) === pathKey(candidate)) return actual;
    } catch { /* continue through PATH */ }
  }
  throw new ProviderOperationError('unsupported', 'OpenCode CLI is unavailable or unsafe.');
}

const capability = (support: AgentCapabilities[keyof AgentCapabilities]['support'], reason?: string) => ({ support, ...(reason ? { reason } : {}) });

export class OpenCodeProviderAdapter implements AgentProviderAdapter {
  readonly providerId = 'opencode';
  private readonly sessions = new Map<string, OpenCodeSession>();
  private readonly spawnProcess: typeof spawn;
  private readonly executable?: () => Promise<string>;
  private readonly now: () => Date;
  private closing = false;

  constructor(options: OpenCodeProviderAdapterOptions = {}) {
    this.spawnProcess = options.spawnProcess ?? spawn;
    this.executable = options.executable;
    this.now = options.now ?? (() => new Date());
  }

  async getCapabilities(sessionId?: string): Promise<AgentCapabilities> {
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    const writable = session ? session.input.role === 'developer' : undefined;
    return {
      terminal: capability('unsupported', 'ADE does not expose an ACP terminal to this provider.'),
      shellExecute: capability('unsupported', 'Shell execution is blocked by the current OpenCode adapter.'),
      testExecute: capability('unsupported', 'The current adapter cannot execute project test commands.'),
      streaming: capability('supported', 'ACP session/update notifications stream user-visible events.'),
      mcpClient: capability(session?.input.mcpServers?.length ? 'supported' : 'conditional', session?.input.mcpServers?.length ? 'ACP receives the ADE Runtime MCP server for this agent session.' : 'MCP servers can be attached during session creation.'),
      mcpServer: capability('unsupported', 'OpenCode is an ACP agent client in this adapter.'),
      fileEditing: capability(writable === undefined ? 'conditional' : writable ? 'supported' : 'unsupported', writable
        ? 'Scoped by ADE-injected OpenCode permissions and the selected worktree.'
        : writable === false ? 'Reviewer role denies edit and shell permissions.' : 'Depends on the selected ADE role.'),
      toolCalling: capability('conditional', 'OpenCode tool calls are normalized only into activity events.'),
      sessionResume: capability('unsupported', 'ACP session loading after an ADE restart is not implemented yet.'),
      structuredOutput: capability('unknown', 'No structured output schema is configured.'),
      structuredEvents: capability('supported', 'ACP session/update notifications are structured.'),
      sendMessage: capability(session && ['waiting', 'ready'].includes(session.value.status) ? 'supported' : session ? 'conditional' : 'unknown', 'Follow-up prompts require an idle active ACP session.'),
      interrupt: capability(session && session.value.status === 'running' ? 'supported' : session ? 'conditional' : 'unknown', 'ACP session/cancel interrupts the current prompt.'),
      stop: capability('supported'),
      subagents: capability('unsupported', 'ADE orchestration is managed outside provider-native subagents.'),
    };
  }

  async create(input: ProviderSessionInput, options: ProviderCallOptions = {}): Promise<ProviderSession> {
    this.throwIfAborted(options.signal);
    if (this.closing || !input.workingDirectory || !input.role) throw new ProviderOperationError('invalid-state', 'OpenCode provider is unavailable or session input is incomplete.');
    if (!['maestro', 'planner', 'developer', 'reviewer', 'tester'].includes(input.role)) throw new ProviderOperationError('unsupported', 'OpenCode role is not supported by ADE.');
    const root = await realpath(input.workingDirectory);
    if (pathKey(root) !== pathKey(input.workingDirectory) || !await safePath(root)) throw new ProviderOperationError('failed', 'Selected worktree is unavailable or unsafe.');
    const executable = await (this.executable ?? findOpenCode)();
    if (!await safePath(executable)) throw new ProviderOperationError('unsupported', 'OpenCode executable is unsafe.');

    const value: ProviderSession = { sessionId: randomUUID(), providerId: this.providerId, status: 'starting', createdAt: this.now().toISOString() };
    let closeConnection!: () => void;
    const closePromise = new Promise<void>(resolveClose => { closeConnection = resolveClose; });
    const child = this.spawnProcess(executable, ['acp', '--cwd', root], {
      cwd: root,
      env: this.environment(input.role),
      shell: false,
      windowsHide: true,
      detached: process.platform === 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const session: OpenCodeSession = {
      value, input, child, closeConnection, canLoadSession: false, outputBytes: 0, sequence: 0,
      listeners: new Set(), outputListeners: new Set(), stderrBytes: 0, stopRequested: false,
      promptQueue: Promise.resolve(),
    };
    this.sessions.set(value.sessionId, session);
    this.attachProcess(session);
    try {
      await this.withTimeout(this.initializeSession(session, root), Math.max(1, Math.min(options.timeoutMs ?? 12000, 12000)), 'OpenCode ACP handshake timed out.', options.signal);
      value.providerSessionId = session.acpSessionId ?? null;
      value.status = 'ready';
      return { ...value };
    } catch (error) {
      session.stopRequested = true;
      session.active?.dispose();
      session.closeConnection();
      await this.killTree(session);
      this.sessions.delete(value.sessionId);
      throw error instanceof ProviderOperationError ? error : new ProviderOperationError('failed', 'OpenCode ACP session could not be initialized.');
    }
  }

  async start(sessionId: string, input: ProviderStartInput): Promise<ProviderSession> {
    const session = this.requireSession(sessionId);
    if (session.value.status !== 'ready') throw new ProviderOperationError('invalid-state', 'OpenCode session is not ready.');
    this.throwIfAborted(input.signal);
    if (!input.task.trim()) throw new ProviderOperationError('failed', 'Task instruction cannot be empty.');
    session.value.status = 'running';
    session.value.startedAt = this.now().toISOString();
    this.emit(session, 'agent.started', {});
    this.prompt(session, input.task, input);
    return { ...session.value };
  }

  async send(sessionId: string, message: string, options: ProviderCallOptions = {}): Promise<void> {
    const session = this.requireSession(sessionId);
    this.throwIfAborted(options.signal);
    if (!message.trim() || message.length > 8000) throw new ProviderOperationError('failed', 'Follow-up prompt must contain 1 to 8000 characters.');
    if (!session.active || !['waiting', 'ready'].includes(session.value.status)) throw new ProviderOperationError('invalid-state', 'OpenCode session is still processing a prompt.');
    session.value.status = 'running';
    this.prompt(session, message, options);
  }

  async interrupt(sessionId: string, options: ProviderCallOptions = {}): Promise<void> {
    const session = this.requireSession(sessionId);
    this.throwIfAborted(options.signal);
    if (session.acpSessionId && session.context) {
      await session.context.notify(acp.AGENT_METHODS.session_cancel, { sessionId: session.acpSessionId });
    }
  }

  async stop(sessionId: string, options: ProviderCallOptions = {}): Promise<void> {
    this.throwIfAborted(options.signal);
    const session = this.sessions.get(sessionId);
    if (!session || ['stopped', 'failed'].includes(session.value.status)) return;
    session.stopRequested = true;
    session.active?.dispose();
    session.closeConnection();
    await this.killTree(session);
    this.finish(session, 'stopped', 'agent.stopped', { reason: 'cancelled' });
  }

  async resume(sessionId: string, options: ProviderCallOptions = {}): Promise<ProviderSession> {
    this.throwIfAborted(options.signal);
    const session = this.requireSession(sessionId);
    if (!session.canLoadSession) throw new ProviderOperationError('unsupported', 'OpenCode ACP agent did not advertise session loading.');
    throw new ProviderOperationError('unsupported', 'ACP session loading after ADE process restart is not available yet.');
  }

  async getStatus(sessionId: string): Promise<ProviderSession | undefined> {
    const session = this.sessions.get(sessionId);
    return session ? { ...session.value } : undefined;
  }

  subscribeOutput(sessionId: string, handler: ProviderOutputHandler): Unsubscribe {
    const session = this.sessions.get(sessionId);
    if (!session) return () => undefined;
    session.outputListeners.add(handler);
    return () => session.outputListeners.delete(handler);
  }

  subscribeEvents(sessionId: string, handler: ProviderEventHandler): Unsubscribe {
    const session = this.sessions.get(sessionId);
    if (!session) return () => undefined;
    session.listeners.add(handler);
    return () => session.listeners.delete(handler);
  }

  async shutdown(): Promise<void> {
    this.closing = true;
    await Promise.all([...this.sessions.keys()].map(sessionId => this.stop(sessionId)));
  }

  private environment(role: string): NodeJS.ProcessEnv {
    const env = minimalEnvironment();
    const developer = role === 'developer';
    const permissions = {
      '*': 'deny', read: 'allow', glob: 'allow', grep: 'allow', list: 'allow',
      edit: developer ? 'allow' : 'deny', bash: 'deny', task: 'deny', external_directory: 'deny',
      webfetch: 'deny', skill: 'deny', lsp: 'deny', question: 'deny',
    };
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
      permission: permissions,
      agent: {
        build: { mode: 'primary', permission: permissions },
        plan: { mode: 'primary', permission: { ...permissions, edit: 'deny', bash: 'deny' } },
      },
    });
    return env;
  }

  private async connect(session: OpenCodeSession): Promise<{ context: acp.ClientContext; connection: Promise<unknown> }> {
    const input = session.child.stdin;
    const output = session.child.stdout;
    if (!input || !output) throw new ProviderOperationError('failed', 'OpenCode ACP pipes are unavailable.');
    const stream = acp.ndJsonStream(
      Writable.toWeb(input) as WritableStream<Uint8Array>,
      Readable.toWeb(output) as ReadableStream<Uint8Array>,
    );
    const app = acp.client({ name: 'ADE' });
    app.onNotification(acp.CLIENT_METHODS.session_update, ({ params }) => {
      if (params.sessionId !== session.acpSessionId) return;
      const update = params.update;
      if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
        this.emitOutput(session, update.content.text);
      } else if (update.sessionUpdate === 'tool_call') {
        this.emit(session, 'agent.action.started', { action: update.title ?? update.name ?? 'OpenCode tool call' });
      } else if (update.sessionUpdate === 'tool_call_update' && update.status === 'completed') {
        this.emit(session, 'agent.action.completed', { action: update.title ?? update.name ?? 'OpenCode tool call' });
      }
      // ACP thought chunks are intentionally ignored.
    });
    app.onRequest(acp.CLIENT_METHODS.session_request_permission, async () => ({ outcome: { outcome: 'cancelled' } }));

    let resolveReady!: (context: acp.ClientContext) => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<acp.ClientContext>((resolveReadyPromise, rejectReadyPromise) => { resolveReady = resolveReadyPromise; rejectReady = rejectReadyPromise; });
    const connection = app.connectWith(stream, async context => {
      resolveReady(context);
      await new Promise<void>(resolveClose => { session.closeConnection = resolveClose; });
    }).catch(error => {
      rejectReady(error instanceof Error ? error : new Error('OpenCode ACP connection closed.'));
      if (!session.stopRequested && !['completed', 'failed', 'stopped'].includes(session.value.status)) {
        this.finish(session, 'failed', 'agent.failed', { reason: 'acp-connection-closed' });
      }
    });
    const context = await ready;
    return { context, connection };
  }

  private async initializeSession(session: OpenCodeSession, root: string): Promise<void> {
    const { context, connection } = await this.connect(session);
    session.connection = connection;
    session.context = context;
    const initialized = await context.request<acp.InitializeResponse, acp.InitializeRequest>(acp.AGENT_METHODS.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientInfo: { name: 'ADE', version: '1.0.0' },
      clientCapabilities: {},
    });
    if (session.stopRequested) throw new ProviderOperationError('cancelled', 'OpenCode session initialization was cancelled.');
    session.canLoadSession = initialized.agentCapabilities?.loadSession === true;
    const active = await context.buildSession({ cwd: root, mcpServers: (session.input.mcpServers ?? []).map(server => ({ ...server, type: 'http' as const, headers: server.headers ?? [] })) }).start();
    if (session.stopRequested) { active.dispose(); throw new ProviderOperationError('cancelled', 'OpenCode session initialization was cancelled.'); }
    session.active = active;
    session.acpSessionId = active.sessionId;
  }

  private prompt(session: OpenCodeSession, text: string, options: ProviderCallOptions = {}): void {
    const active = session.active;
    if (!active) { this.finish(session, 'failed', 'agent.failed', { reason: 'acp-session-missing' }); return; }
    session.promptQueue = session.promptQueue.then(async () => {
      try {
        const result = await this.withTimeout(active.prompt(text), Math.max(1, Math.min(options.timeoutMs ?? 600000, 600000)), 'OpenCode prompt timed out.', options.signal);
        if (session.stopRequested) return;
        session.value.status = 'waiting';
        this.emit(session, 'agent.turn.completed', { stopReason: result.stopReason });
        this.emit(session, 'agent.waiting', { reason: 'prompt-completed' });
      } catch (error) {
        if (!session.stopRequested) {
          const cancelled = options.signal?.aborted;
          this.finish(session, cancelled ? 'stopped' : 'failed', cancelled ? 'agent.stopped' : 'agent.failed', { reason: error instanceof ProviderOperationError ? error.code : 'acp-prompt-failed' });
          session.stopRequested = true;
          session.active?.dispose(); session.closeConnection(); await this.killTree(session);
        }
      }
    }).catch(() => undefined);
  }

  private attachProcess(session: OpenCodeSession): void {
    session.child.stderr?.on('data', chunk => {
      session.stderrBytes += Buffer.byteLength(chunk);
      if (session.stderrBytes > 64 * 1024) void this.stop(session.value.sessionId);
    });
    session.child.once('error', () => {
      if (!session.stopRequested) this.finish(session, 'failed', 'agent.failed', { reason: 'process-error' });
    });
    session.child.once('close', code => {
      if (session.stopRequested || ['stopped', 'failed'].includes(session.value.status)) return;
      this.finish(session, 'failed', 'agent.failed', { reason: 'session-closed-unexpectedly', exitCode: code ?? null });
    });
  }

  private emitOutput(session: OpenCodeSession, raw: string): void {
    const text = safeText(raw).slice(0, Math.min(MAX_CHUNK, MAX_OUTPUT - session.outputBytes));
    if (!text) return;
    session.outputBytes += Buffer.byteLength(text, 'utf8');
    const chunk: ProviderOutputChunk = { sessionId: session.value.sessionId, sequence: ++session.sequence, text, receivedAt: this.now().toISOString() };
    for (const listener of session.outputListeners) listener(chunk);
  }

  private emit(session: OpenCodeSession, type: ProviderEvent['type'], data: ProviderEvent['data']): void {
    const event: ProviderEvent = { sessionId: session.value.sessionId, sequence: ++session.sequence, type, occurredAt: this.now().toISOString(), data };
    for (const listener of session.listeners) listener(event);
  }

  private finish(session: OpenCodeSession, status: ProviderSessionStatus, type: ProviderEvent['type'], data: ProviderEvent['data']): void {
    if (['completed', 'failed', 'stopped'].includes(session.value.status)) return;
    session.value.status = status;
    session.value.finishedAt = this.now().toISOString();
    if (session.timeout) clearTimeout(session.timeout);
    this.emit(session, type, data);
  }

  private requireSession(sessionId: string): OpenCodeSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new ProviderOperationError('not-found', 'OpenCode provider session was not found.');
    return session;
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw new ProviderOperationError('cancelled', 'OpenCode operation was cancelled.');
  }

  private async withTimeout<T>(operation: Promise<T>, ms: number, message: string, signal?: AbortSignal): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new ProviderOperationError('timeout', message)), ms);
          onAbort = () => reject(new ProviderOperationError('cancelled', 'OpenCode operation was cancelled.'));
          signal?.addEventListener('abort', onAbort, { once: true });
          if (signal?.aborted) onAbort();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) signal?.removeEventListener('abort', onAbort);
    }
  }

  private async killTree(session: OpenCodeSession): Promise<void> {
    const child = session.child;
    if (child.exitCode !== null || child.killed) return;
    if (process.platform === 'win32' && Number.isInteger(child.pid)) {
      const taskkill = join(process.env.SYSTEMROOT || 'C:\\Windows', 'System32', 'taskkill.exe');
      await new Promise<void>(resolveDone => execFile(taskkill, ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 8000 }, () => resolveDone()));
    } else {
      try { process.kill(-(child.pid as number), 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* process close is observed separately */ } }
    }
  }
}
