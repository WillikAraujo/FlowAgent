import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { lstat, realpath, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { delimiter, isAbsolute, join, normalize, parse, relative, resolve, sep } from 'node:path';
import type {
  AgentCapabilities, AgentProviderAdapter, ProviderCallOptions, ProviderEvent,
  ProviderEventHandler, ProviderOutputChunk, ProviderOutputHandler,
  ProviderSession, ProviderSessionInput, ProviderSessionStatus, ProviderStartInput,
  Unsubscribe,
} from '../../../domain/agent-provider.ts';
import { ProviderOperationError } from '../../../domain/agent-provider.ts';

const MAX_LINE = 128 * 1024;
const MAX_STDOUT = 2 * 1024 * 1024;
const MAX_STDERR = 64 * 1024;
const MAX_OUTPUT_CHUNK = 2048;

type CodexSession = {
  value: ProviderSession;
  input: ProviderSessionInput;
  child?: ChildProcess;
  lineBuffer: string;
  stdoutBytes: number;
  stderrBytes: number;
  outputBytes: number;
  sequence: number;
  streamedItems: Set<string>;
  streamedAny: boolean;
  turnFailed: boolean;
  turnCompleted: boolean;
  processFailed: boolean;
  protocolError?: 'malformed-jsonl' | 'truncated-jsonl';
  stopRequested: boolean;
  listeners: Set<ProviderEventHandler>;
  outputListeners: Set<ProviderOutputHandler>;
  timeout?: NodeJS.Timeout;
  killTimer?: NodeJS.Timeout;
  abortHandler?: () => void;
  signal?: AbortSignal;
};

export interface CodexProviderAdapterOptions {
  spawnProcess?: typeof spawn;
  executable?: () => Promise<string>;
  exec?: (file: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number }) => Promise<string>;
  now?: () => Date;
}

function pathKey(path: string): string {
  const normalized = normalize(resolve(path));
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isLocalPath(path: string): boolean {
  return parse(path).root !== path && !(process.platform === 'win32' && /^(?:\\\\|\/\/)/.test(path));
}

function minimalEnvironment(): NodeJS.ProcessEnv {
  const names = process.platform === 'win32'
    ? ['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH', 'CODEX_HOME']
    : ['PATH', 'HOME', 'TMPDIR', 'CODEX_HOME'];
  return Object.fromEntries(names.flatMap(name => process.env[name] === undefined ? [] : [[name, process.env[name]!]]));
}

function redact(value: string): string {
  return value
    .replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gi, '[REDACTED]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/g, '[REDACTED]')
    .replace(/\b(?:api[_-]?key|client[_-]?secret|password|access[_-]?token)\s*[:=]\s*\S+/gi, '[REDACTED]');
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

export async function findCodex(): Promise<string> {
  const path = process.env.PATH;
  if (!path) throw new ProviderOperationError('unsupported', 'Codex CLI is unavailable.');
  const name = process.platform === 'win32' ? 'codex.exe' : 'codex';
  for (const directoryValue of path.split(delimiter).filter(Boolean)) {
    const directory = directoryValue.replace(/^"(.*)"$/, '$1');
    if (!isLocalPath(directory)) continue;
    const candidate = join(directory, name);
    try {
      const metadata = await lstat(candidate);
      if (!metadata.isFile() || metadata.isSymbolicLink()) continue;
      const actual = await realpath(candidate);
      if (pathKey(actual) === pathKey(candidate) && await safePath(candidate)) return actual;
      const localAppData = process.env.LOCALAPPDATA;
      const codexHome = process.env.CODEX_HOME || (process.env.USERPROFILE && join(process.env.USERPROFILE, '.codex'));
      if (process.platform === 'win32' && localAppData && codexHome &&
          pathKey(candidate) === pathKey(join(localAppData, 'Programs', 'OpenAI', 'Codex', 'bin', name)) &&
          pathKey(actual).startsWith(pathKey(join(codexHome, 'packages', 'standalone', 'releases')) + sep) &&
          await safePath(actual)) return actual;
    } catch { /* continue searching PATH */ }
  }
  throw new ProviderOperationError('unsupported', 'Codex CLI is unavailable or unsafe.');
}

async function validateConfig(env: NodeJS.ProcessEnv): Promise<void> {
  const home = env.CODEX_HOME || join(process.platform === 'win32' ? env.USERPROFILE || '' : env.HOME || '', '.codex');
  if (!home || !await safePath(home)) throw new ProviderOperationError('unsupported', 'Codex configuration is unavailable or unsafe.');
  const path = join(home, 'config.toml');
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 262144 || !await safePath(path)) throw new Error();
    const config = await readFile(path, 'utf8');
    if (/^\s*approval_policy\s*=\s*["']never["']/im.test(config) || /dangerously-bypass-approvals-and-sandbox/i.test(config)) throw new Error();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new ProviderOperationError('unsupported', 'Codex configuration is invalid or disables safeguards.');
    }
  }
}

const capability = (support: AgentCapabilities[keyof AgentCapabilities]['support'], reason?: string) => ({ support, ...(reason ? { reason } : {}) });

export class CodexProviderAdapter implements AgentProviderAdapter {
  readonly providerId = 'codex';
  private readonly sessions = new Map<string, CodexSession>();
  private readonly spawnProcess: typeof spawn;
  private readonly exec: NonNullable<CodexProviderAdapterOptions['exec']>;
  private readonly now: () => Date;
  private closing = false;

  constructor(options: CodexProviderAdapterOptions = {}) {
    this.spawnProcess = options.spawnProcess ?? spawn;
    this.exec = options.exec ?? execText;
    this.now = options.now ?? (() => new Date());
    this.optionsExecutable = options.executable;
  }

  async getCapabilities(sessionId?: string): Promise<AgentCapabilities> {
    const role = sessionId ? this.sessions.get(sessionId)?.input.role : undefined;
    return {
      terminal: capability('unsupported', 'Codex is launched with piped stdio, without a PTY.'),
      shellExecute: capability('conditional', 'Shell tools depend on the Codex execution profile and local sandbox policy.'),
      testExecute: capability('conditional', 'Tests can run when the selected Codex profile permits the required shell tools.'),
      streaming: capability('supported'),
      mcpClient: capability('unknown', 'Not negotiated by the current CLI integration.'),
      mcpServer: capability('unknown', 'Not negotiated by the current CLI integration.'),
      fileEditing: capability(role === 'reviewer' ? 'unsupported' : role === 'developer' ? 'supported' : 'conditional', 'The execution profile controls the Codex sandbox.'),
      toolCalling: capability('conditional', 'Tool activity is internal to Codex; the current integration exposes only selected text events.'),
      sessionResume: capability('unsupported', 'Current integration runs codex exec as a one-shot process.'),
      structuredOutput: capability('unknown', 'No structured output contract is configured.'),
      structuredEvents: capability('conditional', 'The JSONL protocol is parsed, but only lifecycle and agent-message events are normalized.'),
      sendMessage: capability('unsupported', 'The child process stdin is not interactive.'),
      interrupt: capability('unsupported', 'The current integration supports stopping the process, not interrupting a turn.'),
      stop: capability('supported'),
      subagents: capability('unknown', 'Subagent support is not negotiated by the current integration.'),
    };
  }

  async create(input: ProviderSessionInput, options: ProviderCallOptions = {}): Promise<ProviderSession> {
    this.throwIfAborted(options.signal);
    if (!['developer', 'reviewer'].includes(input.role)) throw new ProviderOperationError('unsupported', 'Codex supports developer and reviewer roles.');
    if (this.closing) throw new ProviderOperationError('invalid-state', 'Codex provider is shutting down.');
    if (!input.agentId || !input.projectId || !input.worktreeId || !input.workingDirectory || !input.role) {
      throw new ProviderOperationError('failed', 'Codex session requires an agent, project, worktree, working directory, and role.');
    }
    const session: ProviderSession = {
      sessionId: randomUUID(), providerId: this.providerId, status: 'created', createdAt: this.now().toISOString(),
    };
    this.sessions.set(session.sessionId, {
      value: session, input, lineBuffer: '', stdoutBytes: 0, stderrBytes: 0, outputBytes: 0,
      sequence: 0, streamedItems: new Set(), streamedAny: false, turnFailed: false, turnCompleted: false, processFailed: false,
      stopRequested: false, listeners: new Set(), outputListeners: new Set(),
    });
    return { ...session };
  }

  async start(sessionId: string, input: ProviderStartInput): Promise<ProviderSession> {
    const session = this.requireSession(sessionId);
    if (session.value.status !== 'created') throw new ProviderOperationError('invalid-state', 'Codex session has already been started.');
    this.throwIfAborted(input.signal);
    if (!input.task.trim()) throw new ProviderOperationError('failed', 'Task instruction cannot be empty.');
    session.value.status = 'starting';
    session.signal = input.signal;
    session.abortHandler = input.signal ? () => { void this.stop(sessionId); } : undefined;
    input.signal?.addEventListener('abort', session.abortHandler!, { once: true });

    try {
      const root = await realpath(session.input.workingDirectory);
      if (pathKey(root) !== pathKey(session.input.workingDirectory) || !await safePath(root)) {
        throw new ProviderOperationError('failed', 'Worktree changed or is unsafe.');
      }
      const git = (await this.exec('git', ['-C', root, 'rev-parse', '--show-toplevel'], { cwd: root, env: minimalEnvironment() })).trim();
      if (!git || pathKey(await realpath(git)) !== pathKey(root)) throw new ProviderOperationError('failed', 'Worktree is no longer a Git root.');
      const executable = await (this.optionsExecutable ?? findCodex)();
      if (!await safePath(executable)) throw new ProviderOperationError('unsupported', 'Codex executable is unsafe.');
      const env = minimalEnvironment();
      await validateConfig(env);
      const help = await this.exec(executable, ['exec', '--help'], { cwd: root, env, timeout: 15000 });
      if (!/--sandbox\b/.test(help) || !help.includes('read-only') || !help.includes('workspace-write')) {
        throw new ProviderOperationError('unsupported', 'Codex CLI does not support the required sandbox profiles.');
      }
      if (session.stopRequested || this.closing) {
        this.finish(session, 'stopped', 'agent.stopped', { reason: 'cancelled-before-start' });
        return { ...session.value };
      }
      const reviewer = session.input.role === 'reviewer';
      const sandbox = reviewer ? 'read-only' : 'workspace-write';
      const args = ['exec', '--json', '--model', 'gpt-6-luna', '-c', 'model_reasoning_effort=medium', '--sandbox', sandbox, input.task];
      const child = this.spawnProcess(executable, args, {
        cwd: root, env, shell: false, windowsHide: true, detached: process.platform === 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      session.child = child;
      session.value.status = 'running';
      session.value.startedAt = this.now().toISOString();
      if (input.timeoutMs && input.timeoutMs > 0) {
        session.timeout = setTimeout(() => {
          session.processFailed = true;
          void this.killTree(session);
        }, input.timeoutMs);
        session.timeout.unref();
      }
      this.emit(session, 'agent.started', {});
      this.attach(session, child);
      return { ...session.value };
    } catch (error) {
      if (session.stopRequested || this.closing) {
        this.finish(session, 'stopped', 'agent.stopped', { reason: 'cancelled-before-start' });
        return { ...session.value };
      }
      this.finish(session, 'failed', 'agent.failed', { reason: 'start-failed' });
      throw error instanceof ProviderOperationError ? error : new ProviderOperationError('failed', 'Codex could not be started safely.');
    }
  }

  async send(_sessionId: string, _message: string, _options?: ProviderCallOptions): Promise<void> {
    throw new ProviderOperationError('unsupported', 'Codex session does not support follow-up messages.');
  }

  async interrupt(_sessionId: string, _options?: ProviderCallOptions): Promise<void> {
    throw new ProviderOperationError('unsupported', 'Codex session does not support turn interruption.');
  }

  async stop(sessionId: string, options: ProviderCallOptions = {}): Promise<void> {
    this.throwIfAborted(options.signal);
    const session = this.sessions.get(sessionId);
    if (!session || ['completed', 'failed', 'stopped'].includes(session.value.status)) return;
    session.stopRequested = true;
    if (session.abortHandler && session.signal) session.signal.removeEventListener('abort', session.abortHandler);
    if (!session.child) {
      this.finish(session, 'stopped', 'agent.stopped', { reason: 'cancelled-before-start' });
      return;
    }
    await this.killTree(session);
  }

  async resume(_sessionId: string, _options?: ProviderCallOptions): Promise<ProviderSession> {
    throw new ProviderOperationError('unsupported', 'Codex exec sessions cannot be resumed by this adapter.');
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
    await Promise.all([...this.sessions.values()].map(session => this.stop(session.value.sessionId)));
  }

  private optionsExecutable?: () => Promise<string>;

  private requireSession(sessionId: string): CodexSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new ProviderOperationError('not-found', 'Codex session was not found.');
    return session;
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw new ProviderOperationError('cancelled', 'Provider operation was cancelled.');
  }

  private attach(session: CodexSession, child: ChildProcess): void {
    child.stdout?.on('data', chunk => this.consumeBytes(session, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    child.stderr?.on('data', chunk => {
      session.stderrBytes += Buffer.byteLength(chunk);
      if (session.stderrBytes > MAX_STDERR) {
        session.processFailed = true;
        void this.killTree(session);
      }
    });
    child.once('error', () => { session.processFailed = true; });
    child.once('close', code => {
      this.flushFinalLine(session);
      const exitCode = Number.isInteger(code) ? code as number : null;
      if (session.protocolError) this.finish(session, 'failed', 'agent.failed', { reason: session.protocolError, exitCode });
      else if (session.processFailed) this.finish(session, 'failed', 'agent.failed', { reason: 'process-error', exitCode });
      else if (session.stopRequested) this.finish(session, 'stopped', 'agent.stopped', { reason: 'cancelled', exitCode });
      else if (exitCode !== 0 || session.turnFailed) this.finish(session, 'failed', 'agent.failed', { reason: 'process-error', exitCode });
      else if (!session.turnCompleted) this.finish(session, 'failed', 'agent.failed', { reason: 'missing-completion', exitCode });
      else this.finish(session, 'completed', 'agent.completed', { exitCode });
    });
  }

  private consumeBytes(session: CodexSession, chunk: Buffer): void {
    session.stdoutBytes += chunk.length;
    if (session.stdoutBytes > MAX_STDOUT) return this.protocolFail(session, 'malformed-jsonl');
    session.lineBuffer += chunk.toString('utf8');
    let index: number;
    while ((index = session.lineBuffer.indexOf('\n')) >= 0) {
      const line = session.lineBuffer.slice(0, index).replace(/\r$/, '');
      session.lineBuffer = session.lineBuffer.slice(index + 1);
      if (!line) continue;
      if (Buffer.byteLength(line) > MAX_LINE) return this.protocolFail(session, 'malformed-jsonl');
      let value: unknown;
      try { value = JSON.parse(line); } catch { return this.protocolFail(session, 'malformed-jsonl'); }
      this.consumeEvent(session, value);
    }
    if (Buffer.byteLength(session.lineBuffer) > MAX_LINE) this.protocolFail(session, 'malformed-jsonl');
  }

  private flushFinalLine(session: CodexSession): void {
    if (!session.lineBuffer || session.protocolError) return;
    const line = session.lineBuffer.replace(/\r$/, '');
    session.lineBuffer = '';
    if (Buffer.byteLength(line) > MAX_LINE) return this.protocolFail(session, 'malformed-jsonl');
    try { this.consumeEvent(session, JSON.parse(line)); } catch { this.protocolFail(session, 'truncated-jsonl'); }
  }

  private consumeEvent(session: CodexSession, value: unknown): void {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return this.protocolFail(session, 'malformed-jsonl');
    const event = value as Record<string, unknown>;
    if (typeof event.type !== 'string') return this.protocolFail(session, 'malformed-jsonl');
    if (event.type === 'turn.completed') { session.turnCompleted = true; return; }
    if (event.type === 'error' || event.type === 'turn.failed') { session.turnFailed = true; return; }
    if (event.type === 'turn.started' || event.type === 'thread.started') {
      this.emit(session, 'agent.action.started', { action: 'Codex is processing the task.' });
      return;
    }
    const item = typeof event.item === 'object' && event.item !== null ? event.item as Record<string, unknown> : undefined;
    if (event.type === 'item.delta' && item?.type === 'agent_message' && typeof event.delta === 'string') {
      const itemId = typeof event.item_id === 'string' ? event.item_id : typeof item.id === 'string' ? item.id : undefined;
      if (itemId) session.streamedItems.add(itemId); else session.streamedAny = true;
      this.emitOutput(session, event.delta);
    } else if (event.type === 'item.completed' && item?.type === 'agent_message' && typeof item.text === 'string') {
      const itemId = typeof item.id === 'string' ? item.id : undefined;
      if (itemId ? session.streamedItems.has(itemId) : session.streamedAny) return;
      this.emitOutput(session, item.text);
    }
  }

  private emitOutput(session: CodexSession, raw: string): void {
    const text = redact(raw).slice(0, Math.min(MAX_OUTPUT_CHUNK, MAX_STDOUT - session.outputBytes));
    if (!text) return;
    session.outputBytes += Buffer.byteLength(text);
    const chunk: ProviderOutputChunk = { sessionId: session.value.sessionId, sequence: ++session.sequence, text, receivedAt: this.now().toISOString() };
    for (const listener of session.outputListeners) listener(chunk);
  }

  private protocolFail(session: CodexSession, reason: 'malformed-jsonl' | 'truncated-jsonl'): void {
    if (session.protocolError) return;
    session.protocolError = reason;
    this.emit(session, 'provider.protocolError', { reason });
    if (session.child && session.child.exitCode === null) void this.killTree(session);
  }

  private emit(session: CodexSession, type: ProviderEvent['type'], data: ProviderEvent['data']): void {
    const event: ProviderEvent = { sessionId: session.value.sessionId, sequence: ++session.sequence, type, occurredAt: this.now().toISOString(), data };
    for (const listener of session.listeners) listener(event);
  }

  private finish(session: CodexSession, status: ProviderSessionStatus, type: ProviderEvent['type'], data: ProviderEvent['data']): void {
    if (['completed', 'failed', 'stopped'].includes(session.value.status)) return;
    session.value.status = status;
    session.value.finishedAt = this.now().toISOString();
    if (session.timeout) clearTimeout(session.timeout);
    if (session.killTimer) clearTimeout(session.killTimer);
    if (session.abortHandler && session.signal) session.signal.removeEventListener('abort', session.abortHandler);
    this.emit(session, type, data);
  }

  private async killTree(session: CodexSession): Promise<void> {
    const child = session.child;
    if (!child || child.exitCode !== null) return;
    const kill = async () => {
      if (process.platform === 'win32' && Number.isInteger(child.pid)) {
        const taskkill = join(process.env.SYSTEMROOT || 'C:\\Windows', 'System32', 'taskkill.exe');
        try { await this.exec(taskkill, ['/PID', String(child.pid), '/T', '/F'], { env: minimalEnvironment(), timeout: 8000 }); }
        catch { try { child.kill(); } catch { /* wait for close */ } }
      } else {
        try { process.kill(-(child.pid as number), 'SIGTERM'); }
        catch { try { child.kill('SIGTERM'); } catch { /* wait for close */ } }
      }
    };
    await kill();
    session.killTimer = setTimeout(() => {
      if (child.exitCode !== null) return;
      if (process.platform === 'win32' && Number.isInteger(child.pid)) {
        const taskkill = join(process.env.SYSTEMROOT || 'C:\\Windows', 'System32', 'taskkill.exe');
        void this.exec(taskkill, ['/PID', String(child.pid), '/T', '/F'], { env: minimalEnvironment(), timeout: 8000 }).catch(() => undefined);
      } else { try { child.kill('SIGKILL'); } catch { /* wait for close */ } }
    }, 8000);
    session.killTimer.unref();
  }
}
