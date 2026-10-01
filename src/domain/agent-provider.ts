export type CapabilitySupport = 'supported' | 'unsupported' | 'conditional' | 'unknown';

export interface CapabilityValue {
  support: CapabilitySupport;
  reason?: string;
  observedAt?: string;
}

export interface AgentCapabilities {
  terminal: CapabilityValue;
  shellExecute: CapabilityValue;
  testExecute: CapabilityValue;
  streaming: CapabilityValue;
  mcpClient: CapabilityValue;
  mcpServer: CapabilityValue;
  fileEditing: CapabilityValue;
  toolCalling: CapabilityValue;
  sessionResume: CapabilityValue;
  structuredOutput: CapabilityValue;
  structuredEvents: CapabilityValue;
  sendMessage: CapabilityValue;
  interrupt: CapabilityValue;
  stop: CapabilityValue;
  subagents: CapabilityValue;
}

export type ProviderSessionStatus =
  | 'created' | 'starting' | 'ready' | 'running' | 'waiting' | 'blocked'
  | 'completed' | 'failed' | 'stopped' | 'unresponsive';

export type AgentStatus = ProviderSessionStatus;

export interface AgentRecord {
  specialties?: string[];
  agentId: string;
  projectId: string;
  worktreeId: string;
  taskId?: string;
  providerId: string;
  role: string;
  displayName: string;
  status: AgentStatus;
  createdAt: string;
  updatedAt: string;
  activeSessionId: string | null;
}

export interface AgentSessionRecord extends ProviderSession {
  executionId?: string;
  taskId?: string;
  agentId: string;
  projectId: string;
  worktreeId: string;
  resumable: boolean;
  capabilities: AgentCapabilities;
  providerSessionId: string | null;
}

export interface AgentRuntimeEvent {
  order?: number;
  agentId: string;
  projectId: string;
  worktreeId: string;
  sessionId?: string;
  sequence: number;
  type: ProviderEvent['type'] | 'agent.created' | 'agent.starting' | 'session.created' | 'session.resumed'
    | 'agent.message.sent' | 'agent.message.received';
  occurredAt: string;
  data: Record<string, string | number | boolean | null>;
}

export interface AgentExecutionRecord {
  worktreeId?: string;
  executionId: string;
  projectId: string;
  taskId: string | null;
  agentId: string;
  sessionId: string;
  status: AgentStatus;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  summary: string | null;
}

export interface AgentRuntimeOutput extends ProviderOutputChunk {
  agentId: string;
  projectId: string;
  worktreeId: string;
}

export interface ProviderSession {
  sessionId: string;
  providerSessionId?: string | null;
  providerId: string;
  status: ProviderSessionStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface ProviderSessionInput {
  agentId: string;
  projectId: string;
  worktreeId: string;
  workingDirectory: string;
  role: string;
  mcpServers?: Array<{ name: string; url: string; headers?: Array<{ name: string; value: string }> }>;
}

export interface ProviderStartInput {
  task: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface ProviderCallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface ProviderOutputChunk {
  sessionId: string;
  sequence: number;
  text: string;
  receivedAt: string;
}

export interface ProviderEvent {
  sessionId: string;
  sequence: number;
  type:
    | 'agent.started' | 'agent.action.started' | 'agent.action.completed'
    | 'agent.waiting' | 'agent.completed' | 'agent.failed' | 'agent.stopped'
    | 'provider.protocolError' | 'agent.turn.completed' | 'agent.response';
  occurredAt: string;
  data: Record<string, string | number | boolean | null>;
}

export type Unsubscribe = () => void;
export type ProviderOutputHandler = (chunk: ProviderOutputChunk) => void;
export type ProviderEventHandler = (event: ProviderEvent) => void;

export class ProviderOperationError extends Error {
  readonly code: 'unsupported' | 'not-found' | 'invalid-state' | 'timeout' | 'cancelled' | 'failed';
  constructor(
    code: ProviderOperationError['code'],
    message: string,
  ) {
    super(message);
    this.name = 'ProviderOperationError';
    this.code = code;
  }
}

/** Provider boundary. Process and terminal handles stay private to adapters. */
export interface AgentProviderAdapter {
  readonly providerId: string;
  getCapabilities(sessionId?: string): Promise<AgentCapabilities>;
  create(input: ProviderSessionInput, options?: ProviderCallOptions): Promise<ProviderSession>;
  start(sessionId: string, input: ProviderStartInput): Promise<ProviderSession>;
  send(sessionId: string, message: string, options?: ProviderCallOptions): Promise<void>;
  interrupt(sessionId: string, options?: ProviderCallOptions): Promise<void>;
  stop(sessionId: string, options?: ProviderCallOptions): Promise<void>;
  resume(sessionId: string, options?: ProviderCallOptions): Promise<ProviderSession>;
  getStatus(sessionId: string): Promise<ProviderSession | undefined>;
  subscribeOutput(sessionId: string, handler: ProviderOutputHandler): Unsubscribe;
  subscribeEvents(sessionId: string, handler: ProviderEventHandler): Unsubscribe;
  shutdown?(): Promise<void>;
}
