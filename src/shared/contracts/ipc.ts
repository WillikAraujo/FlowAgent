import { isAdeSettings, type AdeSettings, type ProviderAvailability } from '../settings.ts';
import { isCollaborationQuery, isCollaborationCommand, isCollaborationPage, isCollaborationResult, type CollaborationCommand, type CollaborationQuery, type CollaborationPage } from './collaboration.ts';
﻿/** Shared, renderer-safe IPC contract for the ADE-101 shell. No Electron or Node imports. */
export const IPC_CHANNELS = Object.freeze({ invoke: "ade:invoke", flowAgentEvent: "ade:flow-agent-event", runtimeActivity: "ade:runtime-activity" } as const);
export const MAX_IPC_REQUEST_BYTES = 4096;
export const MAX_FLOW_AGENT_EVENT_BYTES = 8192;
export const MAX_FLOW_AGENT_EVENT_PAYLOAD_BYTES = 4096;
export const MAX_FLOW_AGENT_TASK_CHARS = 700;

export type IpcErrorCategory =
  | "unsupported-operation"
  | "forbidden"
  | "invalid-payload"
  | "payload-too-large";

export interface AppInfo {
  name: string;
  version: string;
  platform: string;
}

export interface IpcRequestMap {
  'collaboration.query': CollaborationQuery;
  'collaboration.command': CollaborationCommand;
  "settings.load": null;
  "settings.save": AdeSettings;
  "settings.providers": null;
  "workspace.listResponsibilities": { projectId: string };
  "workspace.listArtifacts": { projectId: string; worktreeId: string };
  "workspace.readArtifact": { projectId: string; worktreeId: string; path: string };
  "workspace.createTask": { projectId: string; worktreePath: string; description: string; profile: FlowAgentProfile };
  "agentRuntime.subscribe": { projectId: string };
  "agentRuntime.unsubscribe": { projectId: string };
  "agentRuntime.control": { projectId: string; agentId: string; action: 'interrupt' | 'stop' | 'resume' };
  "app.getInfo": null;
  "flowAgent.openProject": null;
  "workspace.listProjects": null;
  "workspace.listWorktrees": { projectId: string };
  "workspace.listTasks": { projectId: string };
  "workspace.listExecutions": { projectId: string };
  "workspace.listNotes": { projectId: string };
  "workspace.listAgents": { projectId: string };
  "workspace.listAgentEvents": { projectId: string; worktreeId: string };
  "workspace.pickReferences": { projectId: string; worktreePath: string };
  "workspace.saveNote": { projectId: string; title: string; body: string };
  "workspace.setChecklist": { projectId: string; taskId: string; index: number; checked: boolean };
  "flowAgent.start": FlowAgentStartRequest;
  "flowAgent.getRun": FlowAgentRunReference;
  "flowAgent.subscribe": FlowAgentRunReference;
  "flowAgent.unsubscribe": FlowAgentRunReference;
  "flowAgent.cancel": FlowAgentRunReference;
  "agentRuntime.startMcpServer": { projectId: string; agentId: string };
  "agentRuntime.launchAgent": { projectId: string; worktreeId: string; providerId: string; role: string; task: string; taskId?: string; agentId?: string; displayName?: string; specialties?: string[] };
  "agentRuntime.sendMessage": { projectId: string; agentIds: string[]; message: string };
}

export interface IpcResponseMap {
  'collaboration.query': CollaborationPage;
  'collaboration.command': import('../../domain/collaboration').KnowledgeRecord | import('../../domain/collaboration').CollaborationMessage;
  "settings.load": AdeSettings;
  "settings.save": AdeSettings;
  "settings.providers": ProviderAvailability[];
  "workspace.listResponsibilities": ResponsibilityView[];
  "workspace.listArtifacts": { path: string; status: string }[];
  "workspace.readArtifact": { path: string; content: string; kind: "diff" | "file" };
  "workspace.createTask": WorkspaceTask;
  "agentRuntime.subscribe": { subscribed: boolean };
  "agentRuntime.unsubscribe": { subscribed: boolean };
  "agentRuntime.control": WorkspaceAgent;
  "app.getInfo": AppInfo;
  "flowAgent.openProject": FlowAgentOpenProjectResult;
  "workspace.listProjects": WorkspaceProject[];
  "workspace.listWorktrees": WorkspaceWorktree[];
  "workspace.listTasks": WorkspaceTask[];
  "workspace.listExecutions": WorkspaceExecution[];
  "workspace.listNotes": WorkspaceNote[];
  "workspace.listAgents": WorkspaceAgent[];
  "workspace.listAgentEvents": WorkspaceAgentEvent[];
  "workspace.pickReferences": string[];
  "workspace.saveNote": WorkspaceNote;
  "workspace.setChecklist": WorkspaceTask;
  "flowAgent.start": FlowAgentStartResult;
  "flowAgent.getRun": FlowAgentRunSnapshot;
  "flowAgent.subscribe": FlowAgentSubscriptionResult;
  "flowAgent.unsubscribe": FlowAgentSubscriptionResult;
  "flowAgent.cancel": FlowAgentCancelResult;
  "agentRuntime.startMcpServer": { endpoint: string; token: string };
  "agentRuntime.launchAgent": WorkspaceAgent;
  "agentRuntime.sendMessage": MessageDelivery;
}

export interface MessageDelivery { sent: number; results: { agentId: string; sent: boolean; error?: string }[] }
export interface ResponsibilityView { responsibilityId: string; projectId: string; taskId: string; title: string; assignedTo: string | null; dependsOn: string[]; status: string; createdAt: string; updatedAt: string }
export type FlowAgentProfile = "developer" | "reviewer";
export interface WorkspaceProject { projectId: string; displayName: string; rootPath: string }
export interface WorkspaceWorktree { path: string; branch: string; isMain: boolean }
export interface WorkspaceTask { taskId: string; projectId: string; runId: string | null; description: string; profile: FlowAgentProfile; status: string; priority: string; impact: string; worktreePath: string; references: string[]; checklist: boolean[]; createdAt: string; updatedAt: string }
export interface WorkspaceExecution { executionId: string; projectId: string; taskId: string | null; agentId: string; sessionId: string; status: string; startedAt: string | null; finishedAt: string | null; exitCode: number | null; summary: string | null; worktreeId?: string }
export interface WorkspaceNote {
  revision?: number; authorId?: string; status?: import('../../domain/collaboration').NoteStatus; relations?: import('../../domain/collaboration').ContextReference[];
  noteId: string; projectId: string; title: string; body: string; createdAt: string;
  linkedAgentIds?: string[]; permissions?: { readers: string[]; writers: string[] };
}
export interface WorkspaceAgent {
  specialties?: string[];
  capabilities?: import('../../domain/agent-provider').AgentCapabilities;
  agentId: string; projectId: string; worktreeId: string; taskId?: string;
  providerId: string; role: string; displayName: string;
  status: 'created' | 'starting' | 'ready' | 'running' | 'waiting' | 'blocked' | 'completed' | 'failed' | 'stopped' | 'unresponsive';
  createdAt: string; updatedAt: string; activeSessionId: string | null;
}
export interface WorkspaceAgentEvent {
  order?: number;
  agentId: string; projectId: string; worktreeId: string; sessionId?: string;
  sequence: number; type: string; occurredAt: string;
  data: Record<string, string | number | boolean | null>;
  agentName: string; role: string; providerId: string;
}
export type FlowAgentRunState = "queued" | "running" | "cancel_requested" | "succeeded" | "failed" | "cancelled";
export interface FlowAgentProject { projectId: string; displayName: string }
export type FlowAgentOpenProjectResult =
  | { outcome: "opened"; project: FlowAgentProject }
  | { outcome: "cancelled" }
  | { outcome: "invalid"; reason: "not-git" | "access-denied" | "invalid-root" };
export interface FlowAgentStartRequest { requestId: string; projectId: string; task: string; profile: FlowAgentProfile; worktreePath?: string; priority?: string; impact?: string; references?: string[] }
export interface FlowAgentRunReference { projectId: string; runId: string }
export interface FlowAgentStartResult { requestId: string; projectId: string; runId: string; state: "queued" }
export interface FlowAgentRunResult {
  status: "succeeded" | "failed" | "cancelled";
  exitCode: number | null;
  reason?: "process-error" | "malformed-jsonl" | "truncated-jsonl" | "cancelled";
}
export interface FlowAgentRunSnapshot extends FlowAgentRunReference {
  state: FlowAgentRunState;
  profile: FlowAgentProfile;
  startedAt?: string;
  finishedAt?: string;
  result?: FlowAgentRunResult;
}
export type FlowAgentSubscriptionResult =
  | { outcome: "subscribed" }
  | { outcome: "unsubscribed" }
  | { outcome: "not-found" };
export type FlowAgentCancelResult =
  | { outcome: "cancel-requested" }
  | { outcome: "already-terminal" }
  | { outcome: "not-found" };
export type FlowAgentEvent =
  | FlowAgentEventBase<"run.started", { profile: FlowAgentProfile }>
  | FlowAgentEventBase<"run.progress", { message: string }>
  | FlowAgentEventBase<"run.output", { text: string }>
  | FlowAgentEventBase<"run.completed", FlowAgentRunResult>
  | FlowAgentEventBase<"run.failed", FlowAgentRunResult>
  | FlowAgentEventBase<"run.cancel_requested", Record<string, never>>
  | FlowAgentEventBase<"run.cancelled", FlowAgentRunResult>
  | FlowAgentEventBase<"run.protocol_error", { reason: "malformed-jsonl" | "truncated-jsonl" }>;
export interface FlowAgentEventBase<T extends string, P> extends FlowAgentRunReference {
  seq: number;
  type: T;
  payload: P;
}

export type IpcOperation = keyof IpcRequestMap;
export type IpcRequest = {
  [K in IpcOperation]: { operation: K; payload: IpcRequestMap[K] }
}[IpcOperation];

export type IpcSuccess<T> = { ok: true; value: T };
export type IpcFailure = {
  ok: false;
  error: { category: IpcErrorCategory; message: string };
};
export type IpcReply<T> = IpcSuccess<T> | IpcFailure;
export type IpcResponse<K extends IpcOperation = IpcOperation> = IpcReply<IpcResponseMap[K]>;

export interface AdeRendererApi {
  collaboration: { query(input:CollaborationQuery):Promise<CollaborationPage>; command(input:CollaborationCommand):Promise<IpcResponseMap['collaboration.command']> };
  loadSettings(): Promise<AdeSettings>;
  saveSettings(settings: AdeSettings): Promise<AdeSettings>;
  inspectProviders(): Promise<ProviderAvailability[]>;
  getAppInfo(): Promise<AppInfo>;
}

export interface FlowAgentRendererApi {
  openProject(): Promise<FlowAgentOpenProjectResult>;
  start(request: FlowAgentStartRequest): Promise<FlowAgentStartResult>;
  getRun(reference: FlowAgentRunReference): Promise<FlowAgentRunSnapshot>;
  subscribe(reference: FlowAgentRunReference, listener: (event: FlowAgentEvent) => void): Promise<FlowAgentSubscriptionResult>;
  unsubscribe(reference: FlowAgentRunReference): Promise<FlowAgentSubscriptionResult>;
  cancel(reference: FlowAgentRunReference): Promise<FlowAgentCancelResult>;
}
export interface AgentRuntimeRendererApi {
  subscribe(projectId: string, listener: () => void): Promise<() => void>;
  startMcpServer(projectId: string, agentId: string): Promise<{ endpoint: string; token: string }>;
  launchAgent(input: IpcRequestMap["agentRuntime.launchAgent"]): Promise<WorkspaceAgent>;
  sendMessage(input: IpcRequestMap["agentRuntime.sendMessage"]): Promise<MessageDelivery>;
  control(projectId: string, agentId: string, action: 'interrupt' | 'stop' | 'resume'): Promise<WorkspaceAgent>;
}
export interface WorkspaceRendererApi {
  listResponsibilities(projectId: string): Promise<ResponsibilityView[]>;
  listArtifacts(projectId: string, worktreeId: string): Promise<{ path: string; status: string }[]>;
  readArtifact(projectId: string, worktreeId: string, path: string): Promise<{ path: string; content: string; kind: "diff" | "file" }>;
  createTask(input: IpcRequestMap["workspace.createTask"]): Promise<WorkspaceTask>;
  listProjects(): Promise<WorkspaceProject[]>;
  listWorktrees(projectId: string): Promise<WorkspaceWorktree[]>;
  listTasks(projectId: string): Promise<WorkspaceTask[]>;
  listExecutions(projectId: string): Promise<WorkspaceExecution[]>;
  listNotes(projectId: string): Promise<WorkspaceNote[]>;
  listAgents(projectId: string): Promise<WorkspaceAgent[]>;
  listAgentEvents(projectId: string, worktreeId: string): Promise<WorkspaceAgentEvent[]>;
  pickReferences(projectId: string, worktreePath: string): Promise<string[]>;
  saveNote(projectId: string, title: string, body: string): Promise<WorkspaceNote>;
  setChecklist(projectId: string, taskId: string, index: number, checked: boolean): Promise<WorkspaceTask>;
}

declare global {
  interface Window {
    readonly ade: AdeRendererApi & { readonly flowAgent: FlowAgentRendererApi; readonly workspace: WorkspaceRendererApi; readonly agentRuntime: AgentRuntimeRendererApi };
  }
}

export class IpcContractError extends Error {
  readonly category: IpcErrorCategory;
  constructor(category: IpcErrorCategory, message: string) {
    super(message);
    this.name = "IpcContractError";
    this.category = category;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function serializedSize(value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? Number.POSITIVE_INFINITY : new TextEncoder().encode(serialized).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export function isAppInfo(value: unknown): value is AppInfo {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 3 &&
    keys.every((key) => key === "name" || key === "version" || key === "platform") &&
    typeof value.name === "string" && value.name.length > 0 && value.name.length <= 100 &&
    typeof value.version === "string" && value.version.length > 0 && value.version.length <= 80 &&
    typeof value.platform === "string" && value.platform.length > 0 && value.platform.length <= 32;
}

export function isIpcRequest(value: unknown): value is IpcRequest {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 2 && keys.includes("operation") && keys.includes("payload") &&
    typeof value.operation === "string" && isOperationPayload(value.operation, value.payload);
}

const IPC_OPERATIONS: readonly IpcOperation[] = [
  'collaboration.query', 'collaboration.command',
  "app.getInfo", "flowAgent.openProject", "flowAgent.start", "flowAgent.getRun",
  "flowAgent.subscribe", "flowAgent.unsubscribe", "flowAgent.cancel",
  "workspace.listResponsibilities", "workspace.listArtifacts", "workspace.readArtifact", "agentRuntime.subscribe", "agentRuntime.unsubscribe", "settings.load", "settings.save", "settings.providers", "workspace.createTask", "agentRuntime.control", "workspace.listProjects", "workspace.listWorktrees", "workspace.listTasks", "workspace.listExecutions", "workspace.listNotes", "workspace.listAgents", "workspace.listAgentEvents", "workspace.pickReferences", "workspace.saveNote", "workspace.setChecklist",
  "agentRuntime.startMcpServer", "agentRuntime.launchAgent", "agentRuntime.sendMessage",
];

function isBoundedId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

export function isFlowAgentRunReference(value: unknown): value is FlowAgentRunReference {
  return isRecord(value) && Object.keys(value).length === 2 &&
    isBoundedId(value.projectId) && isBoundedId(value.runId);
}

function isWorkspaceAgent(value: unknown): value is WorkspaceAgent {
  if (!isRecord(value)) return false;
  const statuses = ['created','starting','ready','running','waiting','blocked','completed','failed','stopped','unresponsive'];
  return isBoundedId(value.agentId) && isBoundedId(value.projectId) && isBoundedId(value.worktreeId) &&
    (value.taskId === undefined || isBoundedId(value.taskId)) && typeof value.providerId === 'string' && value.providerId.length <= 40 &&
    typeof value.role === 'string' && value.role.length <= 80 && typeof value.displayName === 'string' && value.displayName.length <= 120 &&
    typeof value.status === 'string' && statuses.includes(value.status) && typeof value.createdAt === 'string' && typeof value.updatedAt === 'string' &&
    (value.activeSessionId === null || isBoundedId(value.activeSessionId));
}

function isWorkspaceAgentEvent(value: unknown): value is WorkspaceAgentEvent {
  return isRecord(value) && isBoundedId(value.agentId) && isBoundedId(value.projectId) && isBoundedId(value.worktreeId) &&
    (value.sessionId === undefined || isBoundedId(value.sessionId)) && Number.isSafeInteger(value.sequence) &&
    typeof value.type === 'string' && value.type.length <= 80 && typeof value.occurredAt === 'string' && isRecord(value.data) &&
    Object.values(value.data).every(item => item === null || ['string','number','boolean'].includes(typeof item)) &&
    typeof value.agentName === 'string' && value.agentName.length <= 120 && typeof value.role === 'string' && value.role.length <= 80 &&
    typeof value.providerId === 'string' && value.providerId.length <= 40;
}

export function isFlowAgentStartRequest(value: unknown): value is FlowAgentStartRequest {
  return isRecord(value) && hasOnlyKeys(value, ["requestId", "projectId", "task", "profile", "worktreePath", "priority", "impact", "references"]) &&
    isBoundedId(value.requestId) && isBoundedId(value.projectId) &&
    typeof value.task === "string" && value.task.trim().length > 0 &&
    value.task.length <= MAX_FLOW_AGENT_TASK_CHARS &&
    (value.profile === "developer" || value.profile === "reviewer") &&
    (value.worktreePath === undefined || (typeof value.worktreePath === "string" && value.worktreePath.length <= 1024)) &&
    (value.priority === undefined || ["Baixa", "Média", "Alta"].includes(String(value.priority))) &&
    (value.impact === undefined || ["Baixo", "Médio", "Alto"].includes(String(value.impact))) &&
    (value.references === undefined || (Array.isArray(value.references) && value.references.length <= 8 && value.references.every(item => typeof item === "string" && item.length > 0 && item.length <= 180)));
}

function isOperationPayload(operation: string, payload: unknown): operation is IpcOperation {
  if (!IPC_OPERATIONS.includes(operation as IpcOperation)) return false;
  if (operation === 'collaboration.query') return isCollaborationQuery(payload);
  if (operation === 'collaboration.command') return isCollaborationCommand(payload);
  if (operation === "app.getInfo" || operation === "flowAgent.openProject" || operation === "workspace.listProjects") return payload === null;
  if (operation === "agentRuntime.subscribe" || operation === "agentRuntime.unsubscribe") return isRecord(payload) && Object.keys(payload).length === 1 && isBoundedId(payload.projectId);
  if (operation === "settings.load" || operation === "settings.providers") return payload === null;
  if (operation === "settings.save") return isAdeSettings(payload);
  if (operation === 'workspace.listArtifacts') return isRecord(payload) && Object.keys(payload).length === 2 && isBoundedId(payload.projectId) && isBoundedId(payload.worktreeId);
  if (operation === 'workspace.readArtifact') return isRecord(payload) && Object.keys(payload).length === 3 && isBoundedId(payload.projectId) && isBoundedId(payload.worktreeId) && typeof payload.path === 'string' && payload.path.length > 0 && payload.path.length <= 1024;
  if (operation === "workspace.createTask") return isRecord(payload) && hasOnlyKeys(payload, ['projectId','worktreePath','description','profile']) && isBoundedId(payload.projectId) && typeof payload.worktreePath === 'string' && payload.worktreePath.length <= 1024 && typeof payload.description === 'string' && payload.description.trim().length > 0 && payload.description.length <= 700 && ['developer','reviewer'].includes(String(payload.profile));
  if (operation === "agentRuntime.control") return isRecord(payload) && Object.keys(payload).length === 3 && isBoundedId(payload.projectId) && isBoundedId(payload.agentId) && ['interrupt','stop','resume'].includes(String(payload.action));
  if (operation === "flowAgent.start") return isFlowAgentStartRequest(payload);
  if (operation === "agentRuntime.startMcpServer") return isRecord(payload) && Object.keys(payload).length === 2 && isBoundedId(payload.projectId) && isBoundedId(payload.agentId);
  if (operation === "agentRuntime.launchAgent") return isRecord(payload) && hasOnlyKeys(payload, ["projectId","worktreeId","providerId","role","task","taskId","agentId","displayName","specialties"]) && (payload.taskId === undefined || isBoundedId(payload.taskId)) && (payload.agentId === undefined || isBoundedId(payload.agentId)) && (payload.displayName === undefined || (typeof payload.displayName === 'string' && payload.displayName.length <= 120)) && (payload.specialties === undefined || (Array.isArray(payload.specialties) && payload.specialties.length <= 16 && payload.specialties.every(s => typeof s === 'string' && s.length <= 60))) &&
    isBoundedId(payload.projectId) && isBoundedId(payload.worktreeId) && typeof payload.providerId === "string" && /^[a-z][a-z0-9-]{0,39}$/.test(payload.providerId) &&
    typeof payload.role === "string" && ["maestro", "planner", "developer", "reviewer", "tester"].includes(payload.role) &&
    typeof payload.task === "string" && payload.task.trim().length > 0 && payload.task.length <= 3000;
  if (operation === "agentRuntime.sendMessage") return isRecord(payload) && Object.keys(payload).length === 3 && isBoundedId(payload.projectId) &&
    Array.isArray(payload.agentIds) && payload.agentIds.length >= 1 && payload.agentIds.length <= 10 && payload.agentIds.every(isBoundedId) &&
    typeof payload.message === 'string' && payload.message.trim().length > 0 && payload.message.length <= 8000;
  if (operation === "workspace.listAgentEvents") return isRecord(payload) && Object.keys(payload).length === 2 && isBoundedId(payload.projectId) && isBoundedId(payload.worktreeId);
  if (operation.startsWith("workspace.")) {
    if (!isRecord(payload) || !isBoundedId(payload.projectId)) return false;
    if (operation === "workspace.saveNote") return typeof payload.title === "string" && payload.title.trim().length > 0 && payload.title.length <= 120 && typeof payload.body === "string" && payload.body.length <= 1500;
    if (operation === "workspace.pickReferences") return typeof payload.worktreePath === "string" && payload.worktreePath.length > 0 && payload.worktreePath.length <= 1024;
    if (operation === "workspace.setChecklist") return isBoundedId(payload.taskId) && Number.isInteger(payload.index) && (payload.index as number) >= 0 && (payload.index as number) < 5 && typeof payload.checked === "boolean";
    return Object.keys(payload).length === 1;
  }
  return isFlowAgentRunReference(payload);
}

export function parseIpcRequest(value: unknown): IpcRequest {
  if (serializedSize(value) > (isRecord(value) && (value.operation === "agentRuntime.sendMessage" || value.operation === 'collaboration.command') ? 40_000 : MAX_IPC_REQUEST_BYTES)) {
    throw new IpcContractError("payload-too-large", "IPC request exceeds the payload limit.");
  }
  if (!isRecord(value)) throw new IpcContractError("invalid-payload", "IPC request must be an object.");
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes("operation") || !keys.includes("payload") || typeof value.operation !== "string") {
    throw new IpcContractError("invalid-payload", "IPC request must contain only operation and payload.");
  }
  if (typeof value.operation !== "string" || !IPC_OPERATIONS.includes(value.operation as IpcOperation)) {
    throw new IpcContractError("unsupported-operation", "IPC operation is not allowlisted.");
  }
  if (!isOperationPayload(value.operation, value.payload)) {
    throw new IpcContractError("invalid-payload", "IPC operation payload is invalid.");
  }
  return value as IpcRequest;
}

export function isIpcFailure(value: unknown): value is IpcFailure {
  if (!isRecord(value) || value.ok !== false || Object.keys(value).length !== 2 || !isRecord(value.error)) return false;
  const error = value.error;
  const categories: readonly string[] = [
    "unsupported-operation", "forbidden", "invalid-payload", "payload-too-large",
  ];
  return Object.keys(error).length === 2 &&
    typeof error.category === "string" && categories.includes(error.category) &&
    typeof error.message === "string" && error.message.length > 0 && error.message.length <= 240;
}

export function isIpcResponse<K extends IpcOperation>(
  operation: K,
  value: unknown,
): value is IpcResponse<K> {
  if (!isRecord(value) || typeof value.ok !== "boolean" || Object.keys(value).length !== 2) return false;
  if (value.ok === false) return isIpcFailure(value);
  return Object.keys(value).every((key) => key === "ok" || key === "value") &&
    isOperationResponse(operation, value.value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isRunResult(value: unknown): value is FlowAgentRunResult {
  if (!isRecord(value) || !hasOnlyKeys(value, ["status", "exitCode", "reason"])) return false;
  return ["succeeded", "failed", "cancelled"].includes(String(value.status)) &&
    (value.exitCode === null || Number.isInteger(value.exitCode)) &&
    (value.reason === undefined || ["process-error", "malformed-jsonl", "truncated-jsonl", "cancelled"].includes(String(value.reason)));
}

function isOperationResponse(operation: IpcOperation, value: unknown): boolean {
  if (operation === 'collaboration.query') return isCollaborationPage(value) && serializedSize(value) <= 2_000_000;
  if (operation === 'collaboration.command') return isCollaborationResult(value) && serializedSize(value) <= 40_000;
  if (operation === "agentRuntime.subscribe" || operation === "agentRuntime.unsubscribe") return isRecord(value) && Object.keys(value).length === 1 && typeof value.subscribed === "boolean";
  if (operation === "settings.load" || operation === "settings.save") return isAdeSettings(value);
  if (operation === "settings.providers") return Array.isArray(value) && value.length <= 10 && value.every(item => isRecord(item) && ['codex','opencode'].includes(String(item.providerId)) && ['available','unavailable','error'].includes(String(item.status)) && Array.isArray(item.roles) && item.roles.every(role => typeof role === 'string') && typeof item.name === 'string' && typeof item.detail === 'string' && item.authentication === 'unknown' && (item.executable === null || typeof item.executable === 'string') && (item.version === null || typeof item.version === 'string'));
  if (operation === "agentRuntime.control") return isWorkspaceAgent(value);
  if (operation === "workspace.createTask") return isRecord(value) && isBoundedId(value.taskId) && isBoundedId(value.projectId);
  if (operation === "app.getInfo") return isAppInfo(value);
  if (operation === "agentRuntime.startMcpServer") return isRecord(value) && Object.keys(value).length === 2 &&
    typeof value.endpoint === 'string' && /^http:\/\/127\.0\.0\.1:\d{1,5}\/mcp$/.test(value.endpoint) &&
    typeof value.token === 'string' && /^[A-Za-z0-9_-]{40,80}$/.test(value.token);
  if (operation === "agentRuntime.launchAgent") return isWorkspaceAgent(value);
  if (operation === "agentRuntime.sendMessage") return isRecord(value) && Object.keys(value).length === 2 && Number.isInteger(value.sent) && Number(value.sent) >= 0 && Number(value.sent) <= 10 && Array.isArray(value.results) && value.results.length <= 10 && value.results.every(item => isRecord(item) && isBoundedId(item.agentId) && typeof item.sent === "boolean" && (item.error === undefined || typeof item.error === "string"));
  if (operation === "workspace.listAgents") return Array.isArray(value) && value.length <= 500 && value.every(isWorkspaceAgent);
  if (operation === "workspace.listAgentEvents") return Array.isArray(value) && value.length <= 2000 && value.every(isWorkspaceAgentEvent) && serializedSize(value) <= 2_000_000;
  if (operation.startsWith("workspace.")) {
    const item = operation === "workspace.saveNote" || operation === "workspace.setChecklist" || operation === "workspace.readArtifact" ? value : Array.isArray(value) ? value : null;
    return item !== null && serializedSize(item) <= 2_000_000;
  }
  if (!isRecord(value)) return false;
  if (operation === "flowAgent.openProject") {
    if (value.outcome === "cancelled") return Object.keys(value).length === 1;
    if (value.outcome === "invalid") return Object.keys(value).length === 2 &&
      ["not-git", "access-denied", "invalid-root"].includes(String(value.reason));
    return value.outcome === "opened" && Object.keys(value).length === 2 && isRecord(value.project) &&
      Object.keys(value.project).length === 2 && isBoundedId(value.project.projectId) &&
      typeof value.project.displayName === "string" && value.project.displayName.length > 0 && value.project.displayName.length <= 240;
  }
  if (operation === "flowAgent.start") return Object.keys(value).length === 4 &&
    isBoundedId(value.requestId) && isBoundedId(value.projectId) && isBoundedId(value.runId) && value.state === "queued";
  if (operation === "flowAgent.getRun") {
    const states: readonly string[] = ["queued", "running", "cancel_requested", "succeeded", "failed", "cancelled"];
    return hasOnlyKeys(value, ["projectId", "runId", "state", "profile", "startedAt", "finishedAt", "result"]) &&
      isBoundedId(value.projectId) && isBoundedId(value.runId) && typeof value.state === "string" && states.includes(value.state) &&
      (value.profile === "developer" || value.profile === "reviewer") &&
      (value.startedAt === undefined || typeof value.startedAt === "string") &&
      (value.finishedAt === undefined || typeof value.finishedAt === "string") &&
      (value.result === undefined || isRunResult(value.result));
  }
  if (typeof value.outcome !== "string") return false;
  if (operation === "flowAgent.subscribe" || operation === "flowAgent.unsubscribe") {
    const expected = operation === "flowAgent.subscribe" ? ["subscribed", "not-found"] : ["unsubscribed", "not-found"];
    return Object.keys(value).length === 1 && expected.includes(String(value.outcome));
  }
  return Object.keys(value).length === 1 && ["cancel-requested", "already-terminal", "not-found"].includes(String(value.outcome));
}

export function isFlowAgentEvent(value: unknown): value is FlowAgentEvent {
  if (!isRecord(value) || !hasOnlyKeys(value, ["projectId", "runId", "seq", "type", "payload"]) ||
      !isBoundedId(value.projectId) || !isBoundedId(value.runId) || !Number.isSafeInteger(value.seq) ||
      (value.seq as number) < 1 || !isRecord(value.payload) || serializedSize(value.payload) > MAX_FLOW_AGENT_EVENT_PAYLOAD_BYTES ||
      serializedSize(value) > MAX_FLOW_AGENT_EVENT_BYTES || typeof value.type !== "string") return false;
  const payload = value.payload;
  switch (value.type) {
    case "run.started": return Object.keys(payload).length === 1 && (payload.profile === "developer" || payload.profile === "reviewer");
    case "run.progress": return Object.keys(payload).length === 1 && typeof payload.message === "string" && payload.message.length <= 2048;
    case "run.output": return Object.keys(payload).length === 1 && typeof payload.text === "string" && payload.text.length <= 2048;
    case "run.completed":
    case "run.failed":
    case "run.cancelled": return isRunResult(payload);
    case "run.cancel_requested": return Object.keys(payload).length === 0;
    case "run.protocol_error": return Object.keys(payload).length === 1 &&
      ["malformed-jsonl", "truncated-jsonl"].includes(String(payload.reason));
    default: return false;
  }
}

/** True means syntactically valid envelope with a future event type; callers may ignore it. */
export function isUnknownFlowAgentEvent(value: unknown): boolean {
  return isRecord(value) && hasOnlyKeys(value, ["projectId", "runId", "seq", "type", "payload"]) &&
    isBoundedId(value.projectId) && isBoundedId(value.runId) && Number.isSafeInteger(value.seq) &&
    (value.seq as number) >= 1 && typeof value.type === "string" && isRecord(value.payload) &&
    serializedSize(value.payload) <= MAX_FLOW_AGENT_EVENT_PAYLOAD_BYTES && serializedSize(value) <= MAX_FLOW_AGENT_EVENT_BYTES &&
    !["run.started", "run.progress", "run.output", "run.completed", "run.failed", "run.cancel_requested", "run.cancelled", "run.protocol_error"].includes(value.type);
}

export function parseIpcResponse<K extends IpcOperation>(
  operation: K,
  value: unknown,
): IpcResponse<K> {
  if (!isIpcResponse(operation, value)) {
    throw new IpcContractError("invalid-payload", "Main returned a response outside the IPC contract.");
  }
  return value;
}



