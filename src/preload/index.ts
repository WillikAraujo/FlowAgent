import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import {
  IPC_CHANNELS,
  isFlowAgentEvent,
  parseIpcResponse,
  type AdeRendererApi,
  type AgentRuntimeRendererApi,
  type FlowAgentRendererApi,
  type WorkspaceRendererApi,
  type IpcFailure,
  type IpcOperation,
  type IpcRequestMap,
  type IpcResponseMap,
} from '../shared/contracts/ipc';

async function invoke<K extends IpcOperation>(operation: K, payload: IpcRequestMap[K]): Promise<IpcResponseMap[K]> {
  const rawReply: unknown = await ipcRenderer.invoke(IPC_CHANNELS.invoke, { operation, payload });
  const reply = parseIpcResponse(operation, rawReply);
  if (!reply.ok) {
    const error: IpcFailure['error'] = reply.error;
    throw Object.assign(new Error(error.message), { category: error.category });
  }
  return reply.value;
}

type EventHandler = (event: IpcRendererEvent, raw: unknown) => void;
const subscriptions = new Map<string, EventHandler>();
const subscriptionKey = (projectId: string, runId: string) => `${projectId}:${runId}`;

const flowAgent: FlowAgentRendererApi = {
  openProject: () => invoke('flowAgent.openProject', null),
  start: (request) => invoke('flowAgent.start', request),
  getRun: (reference) => invoke('flowAgent.getRun', reference),
  async subscribe(reference, listener) {
    const key = subscriptionKey(reference.projectId, reference.runId);
    const previous = subscriptions.get(key);
    if (previous) ipcRenderer.removeListener(IPC_CHANNELS.flowAgentEvent, previous);
    const handler: EventHandler = (_event, raw) => {
      if (isFlowAgentEvent(raw) && raw.projectId === reference.projectId && raw.runId === reference.runId) listener(raw);
    };
    subscriptions.set(key, handler);
    ipcRenderer.on(IPC_CHANNELS.flowAgentEvent, handler);
    try {
      const result = await invoke('flowAgent.subscribe', reference);
      if (result.outcome !== 'subscribed') {
        ipcRenderer.removeListener(IPC_CHANNELS.flowAgentEvent, handler);
        subscriptions.delete(key);
      }
      return result;
    } catch (error) {
      ipcRenderer.removeListener(IPC_CHANNELS.flowAgentEvent, handler);
      subscriptions.delete(key);
      throw error;
    }
  },
  async unsubscribe(reference) {
    const key = subscriptionKey(reference.projectId, reference.runId);
    const handler = subscriptions.get(key);
    if (handler) ipcRenderer.removeListener(IPC_CHANNELS.flowAgentEvent, handler);
    subscriptions.delete(key);
    return invoke('flowAgent.unsubscribe', reference);
  },
  cancel: (reference) => invoke('flowAgent.cancel', reference),
};
Object.freeze(flowAgent);

const workspace: WorkspaceRendererApi = Object.freeze({
  listResponsibilities: (projectId: string) => invoke('workspace.listResponsibilities', { projectId }),
  listArtifacts: (projectId: string, worktreeId: string) => invoke('workspace.listArtifacts', { projectId, worktreeId }),
  readArtifact: (projectId: string, worktreeId: string, path: string) => invoke('workspace.readArtifact', { projectId, worktreeId, path }),
  createTask: (input: import('../shared/contracts/ipc').IpcRequestMap['workspace.createTask']) => invoke('workspace.createTask', input),
  listProjects: () => invoke('workspace.listProjects', null),
  listWorktrees: (projectId: string) => invoke('workspace.listWorktrees', { projectId }),
  listTasks: (projectId: string) => invoke('workspace.listTasks', { projectId }),
  listExecutions: (projectId: string) => invoke('workspace.listExecutions', { projectId }),
  listNotes: (projectId: string) => invoke('workspace.listNotes', { projectId }),
  listAgents: (projectId: string) => invoke('workspace.listAgents', { projectId }),
  listAgentEvents: (projectId: string, worktreeId: string) => invoke('workspace.listAgentEvents', { projectId, worktreeId }),
  pickReferences: (projectId: string, worktreePath: string) => invoke('workspace.pickReferences', { projectId, worktreePath }),
  saveNote: (projectId: string, title: string, body: string) => invoke('workspace.saveNote', { projectId, title, body }),
  setChecklist: (projectId: string, taskId: string, index: number, checked: boolean) => invoke('workspace.setChecklist', { projectId, taskId, index, checked }),
});

const agentRuntime: AgentRuntimeRendererApi = Object.freeze({
  subscribe: async (projectId: string, listener: () => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => { if (payload && typeof payload === 'object' && (payload as {projectId?: unknown}).projectId === projectId) listener(); };
    ipcRenderer.on(IPC_CHANNELS.runtimeActivity, handler);
    try { await invoke('agentRuntime.subscribe', { projectId }); }
    catch(error) { ipcRenderer.removeListener(IPC_CHANNELS.runtimeActivity, handler); throw error; }
    return () => { ipcRenderer.removeListener(IPC_CHANNELS.runtimeActivity, handler); void invoke('agentRuntime.unsubscribe', { projectId }).catch(() => undefined); };
  },
  control: (projectId: string, agentId: string, action: 'interrupt' | 'stop' | 'resume') => invoke('agentRuntime.control', { projectId, agentId, action }),
  startMcpServer: (projectId: string, agentId: string) => invoke('agentRuntime.startMcpServer', { projectId, agentId }),
  launchAgent: (input: import('../shared/contracts/ipc').IpcRequestMap['agentRuntime.launchAgent']) => invoke('agentRuntime.launchAgent', input),
  sendMessage: (input: import('../shared/contracts/ipc').IpcRequestMap['agentRuntime.sendMessage']) => invoke('agentRuntime.sendMessage', input),
});

const ade: AdeRendererApi & { readonly flowAgent: FlowAgentRendererApi; readonly workspace: WorkspaceRendererApi; readonly agentRuntime: AgentRuntimeRendererApi } = Object.freeze({
  collaboration: Object.freeze({ query:(input:import('../shared/contracts/collaboration').CollaborationQuery) => invoke('collaboration.query',input), command:(input:import('../shared/contracts/collaboration').CollaborationCommand) => invoke('collaboration.command',input) }),
  loadSettings: () => invoke('settings.load', null),
  saveSettings: (settings: import('../shared/settings').AdeSettings) => invoke('settings.save', settings),
  inspectProviders: () => invoke('settings.providers', null),
  getAppInfo: () => invoke('app.getInfo', null),
  flowAgent,
  workspace,
  agentRuntime,
});

contextBridge.exposeInMainWorld('ade', ade);
