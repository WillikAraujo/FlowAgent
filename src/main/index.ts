import { listWorktreeArtifacts, readWorktreeArtifact } from './worktree-artifacts';
import { SettingsService, inspectProviders } from './settings-service';
import { randomUUID } from 'node:crypto';
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { realpath } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { WorkspaceCatalog } from './workspace-catalog';
import {
  IPC_CHANNELS,
  IpcContractError,
  MAX_IPC_REQUEST_BYTES,
  parseIpcRequest,
  parseIpcResponse,
  type IpcFailure,
  type IpcResponse,
} from '../shared/contracts/ipc';

let mainWindow: BrowserWindow | undefined;
let flowAgent: import('./orchestration/flow-agent-service').FlowAgentService | undefined;
let settingsService: SettingsService | undefined;
function getSettingsService() { return settingsService ??= new SettingsService(join(app.getPath('userData'), 'preferences.json')); }
let catalog: WorkspaceCatalog | undefined;
function getCatalog(): WorkspaceCatalog {
  if (!catalog) catalog = new WorkspaceCatalog(join(app.getPath('userData'), 'ade-workspace.sqlite'));
  return catalog;
}
async function getFlowAgent() {
  if (!flowAgent) {
    const { FlowAgentService } = await import('./orchestration/flow-agent-service');
    flowAgent = new FlowAgentService({
      persistence: getCatalog(),
      onFinished: (projectId, requestId, status) => { getCatalog().patchTask(projectId, requestId, { status }); },
      chooseDirectory: async () => {
        if (!mainWindow) return null;
        const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
        return result.canceled ? null : result.filePaths[0] ?? null;
      },
    });
    for (const project of getCatalog().listProjects()) flowAgent.registerProject(project.projectId, project.rootPath, project.displayName);
  }
  return flowAgent;
}
const runtimeSubscriptions = new Map<string, () => void>();
const flowSubscriptions = new Map<number, Map<string, (event: import('../shared/contracts/ipc').FlowAgentEvent) => void>>();

function failure(category: IpcFailure['error']['category'], message: string): IpcFailure {
  return { ok: false, error: { category, message } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function serializedSize(value: unknown): number {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? Number.POSITIVE_INFINITY : new TextEncoder().encode(json).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

type TrustedRenderer =
  | { mode: 'development'; url: string }
  | { mode: 'file'; url: string; filePath: string };

const DEV_RENDERER_URL = 'http://127.0.0.1:5173/';

function resolveTrustedRenderer(): TrustedRenderer {
  const configuredUrl = process.env.ADE_RENDERER_URL;
  if (!app.isPackaged && configuredUrl !== undefined) {
    let parsed: URL;
    try {
      parsed = new URL(configuredUrl);
    } catch {
      throw new Error('ADE_RENDERER_URL is invalid.');
    }
    if (parsed.href !== DEV_RENDERER_URL) {
      throw new Error('ADE_RENDERER_URL must exactly match the local Vite URL.');
    }
    return { mode: 'development', url: DEV_RENDERER_URL };
  }

  const filePath = join(__dirname, '../renderer/index.html');
  return { mode: 'file', filePath, url: pathToFileURL(filePath).href };
}

const trustedRenderer = resolveTrustedRenderer();

function isTrustedRendererUrl(target: string): boolean {
  try {
    return new URL(target).href === trustedRenderer.url;
  } catch {
    return false;
  }
}

function isAllowedSender(event: Electron.IpcMainInvokeEvent): boolean {
  const sender = event.sender;
  const frame = event.senderFrame;
  if (!mainWindow || sender !== mainWindow.webContents || !frame || frame !== sender.mainFrame) return false;
  return isTrustedRendererUrl(frame.url);
}

function safeResponse<K extends import('../shared/contracts/ipc').IpcOperation>(operation: K, value: unknown): IpcResponse<K> {
  return parseIpcResponse(operation, value);
}

async function handleFlowAgentRequest(event: Electron.IpcMainInvokeEvent, request: Exclude<import('../shared/contracts/ipc').IpcRequest, { operation: 'app.getInfo' }>): Promise<IpcResponse> {
 try {
    const service = await getFlowAgent();
    let value: unknown;
    switch (request.operation) {
      case 'collaboration.query': value = service.collaborationQuery(request.payload); break;
      case 'collaboration.command': value = await service.collaborationCommand(request.payload); break;
      case 'agentRuntime.subscribe': {
        const key = `${event.sender.id}:${request.payload.projectId}`;
        runtimeSubscriptions.get(key)?.();
        runtimeSubscriptions.set(key, service.subscribeProject(request.payload.projectId, runtimeEvent => {
          if (!event.sender.isDestroyed() && isTrustedRendererUrl(event.sender.getURL())) event.sender.send(IPC_CHANNELS.runtimeActivity, { projectId: runtimeEvent.projectId });
        }));
        value = { subscribed: true }; break;
      }
      case 'agentRuntime.unsubscribe': {
        const key = `${event.sender.id}:${request.payload.projectId}`;
        runtimeSubscriptions.get(key)?.(); runtimeSubscriptions.delete(key); value = { subscribed: false }; break;
      }
      case 'settings.load': value = await getSettingsService().load(); break;
      case 'settings.save': value = await getSettingsService().save(request.payload); break;
      case 'settings.providers': value = await inspectProviders(); break;
      case 'agentRuntime.control': value = await service.controlAgent(request.payload.projectId, request.payload.agentId, request.payload.action); break;
      case 'workspace.listResponsibilities': {
        if (!service.getProject(request.payload.projectId)) return failure('forbidden', 'Project is not open.');
        value = getCatalog().listResponsibilities(request.payload.projectId); break;
      }
      case 'workspace.listArtifacts':
      case 'workspace.readArtifact': {
        const tree = (await service.listWorktrees(request.payload.projectId)).find(tree => tree.branch === request.payload.worktreeId);
        if (!tree) return failure('forbidden', 'Worktree is unavailable.');
        value = request.operation === 'workspace.readArtifact' ? await readWorktreeArtifact(tree.path, request.payload.path) : await listWorktreeArtifacts(tree.path); break;
      }
      case 'workspace.createTask': {
        const input = request.payload;
        const tree = (await service.listWorktrees(input.projectId)).find(tree => tree.path === input.worktreePath);
        if (!tree) return failure('forbidden', 'Selecione uma worktree registrada.');
        const now = new Date().toISOString();
        value = getCatalog().saveTask({ taskId: randomUUID(), projectId: input.projectId, runId: null, description: input.description.trim(), profile: input.profile, status: 'todo', priority: 'Média', impact: 'Médio', worktreePath: tree.path, references: [], checklist: [], createdAt: now, updatedAt: now });
        break;
      }
      case 'agentRuntime.startMcpServer': value = await service.startMcpServer(request.payload.projectId, request.payload.agentId); break;
      case 'agentRuntime.launchAgent': value = await service.launchRuntimeAgent(request.payload); break;
      case 'agentRuntime.sendMessage': value = await service.sendRuntimeMessage(request.payload.projectId, request.payload.agentIds, request.payload.message); break;
      case 'flowAgent.openProject': {
        value = await service.openProject();
        const result = value as import('../shared/contracts/ipc').FlowAgentOpenProjectResult;
        if (result.outcome === 'opened') {
          const project = service.getProject(result.project.projectId)!;
          getCatalog().saveProject({ projectId: project.projectId, displayName: project.displayName, rootPath: project.root });
        }
        break;
      }
      case 'workspace.listProjects': value = getCatalog().listProjects(); break;
      case 'workspace.listWorktrees': value = await service.listWorktrees(request.payload.projectId); break;
      case 'workspace.listTasks': value = getCatalog().listTasks(request.payload.projectId); break;
      case 'workspace.listExecutions': value = getCatalog().listExecutions(request.payload.projectId); break;
      case 'workspace.listNotes': value = service.listNotes(request.payload.projectId); break;
      case 'workspace.listAgents': value = await service.listAgents(request.payload.projectId); break;
      case 'workspace.listAgentEvents': value = service.listAgentEvents(request.payload.projectId, request.payload.worktreeId); break;
      case 'workspace.pickReferences': {
        const selected = (await service.listWorktrees(request.payload.projectId)).find(item => resolve(item.path).toLowerCase() === resolve(request.payload.worktreePath).toLowerCase());
        if (!selected || !mainWindow) return failure('forbidden', 'Worktree is unavailable.');
        const root = await realpath(selected.path);
        const picked = await dialog.showOpenDialog(mainWindow, { defaultPath: root, properties: ['openFile', 'multiSelections'] });
        value = picked.canceled ? [] : (await Promise.all(picked.filePaths.slice(0, 8).map(async file => {
          const actual = await realpath(file);
          const rel = relative(root, actual);
          if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Selecione arquivos dentro da worktree.');
          return rel;
        })));
        break;
      }
      case 'workspace.saveNote': value = service.saveNote(request.payload.projectId, request.payload.title, request.payload.body); break;
      case 'workspace.setChecklist': value = getCatalog().setChecklist(request.payload.projectId, request.payload.taskId, request.payload.index, request.payload.checked); break;
      case 'flowAgent.start': {
        const input = request.payload;
        const taskId = input.requestId;
        const now = new Date().toISOString();
        const worktreePath = input.worktreePath ?? service.getProject(input.projectId)?.root ?? '';
        getCatalog().saveTask({ taskId, projectId: input.projectId, runId: null, description: input.task, profile: input.profile, status: 'queued', priority: input.priority ?? 'Média', impact: input.impact ?? 'Médio', worktreePath, references: input.references ?? [], checklist: [false,false,false,false,false], createdAt: now, updatedAt: now });
        try {
          value = await service.start(input);
          const current = getCatalog().getTask(input.projectId, taskId);
          getCatalog().patchTask(input.projectId, taskId, { runId: (value as import('../shared/contracts/ipc').FlowAgentStartResult).runId, status: current.status === 'queued' ? 'running' : current.status });
        } catch (error) {
          const task = getCatalog().getTask(input.projectId, taskId);
          if (task.status === 'queued' || task.status === 'running') getCatalog().patchTask(input.projectId, taskId, { status: 'failed' });
          throw error;
        }
        break;
      }
      case 'flowAgent.getRun': {
        const run = service.getRun(request.payload);
        if (!run) return failure('invalid-payload', 'Run was not found for this project');
        value = run; break;
      }
      case 'flowAgent.subscribe': {
        const sender = event.sender;
        const key = `${request.payload.projectId}:${request.payload.runId}`;
        let subscriptions = flowSubscriptions.get(sender.id);
        if (!subscriptions) { subscriptions = new Map(); flowSubscriptions.set(sender.id, subscriptions); }
        const old = subscriptions.get(key);
        if (old) service.unsubscribe(request.payload, old);
        const listener = (flowEvent: import('../shared/contracts/ipc').FlowAgentEvent) => {
          if (mainWindow?.webContents === sender && !sender.isDestroyed() && isTrustedRendererUrl(sender.getURL())) sender.send(IPC_CHANNELS.flowAgentEvent, flowEvent);
        };
        if (!service.subscribe(request.payload, listener)) return { ok: true, value: { outcome: 'not-found' } } as IpcResponse;
        subscriptions.set(key, listener); value = { outcome: 'subscribed' }; break;
      }
      case 'flowAgent.unsubscribe': {
        const subscriptions = flowSubscriptions.get(event.sender.id);
        const key = `${request.payload.projectId}:${request.payload.runId}`;
        const listener = subscriptions?.get(key);
        if (listener) { service.unsubscribe(request.payload, listener); subscriptions?.delete(key); }
        if (subscriptions?.size === 0) flowSubscriptions.delete(event.sender.id);
        value = { outcome: listener ? 'unsubscribed' : 'not-found' }; break;
      }
      case 'flowAgent.cancel': value = { outcome: await service.cancel(request.payload) }; break;
    }
    return safeResponse(request.operation, { ok: true, value });
  } catch (error) {
    if (error instanceof Error && error.name === 'FlowAgentError' && 'category' in error) {
      return failure((error as Error & { category: IpcFailure['error']['category'] }).category, error.message);
    }
    return failure('unsupported-operation', error instanceof Error ? error.message.slice(0, 240) : 'ADE operation failed safely');
  }
}

ipcMain.handle(IPC_CHANNELS.invoke, (event, rawRequest: unknown): IpcResponse | Promise<IpcResponse> => {
  if (!isAllowedSender(event)) return failure('forbidden', 'IPC sender is not authorized');
  if (serializedSize(rawRequest) > (isRecord(rawRequest) && rawRequest.operation === "agentRuntime.sendMessage" ? 40_000 : MAX_IPC_REQUEST_BYTES)) {
    return failure('payload-too-large', 'IPC request exceeds the 4096-byte limit');
  }

  let request;
  try {
    request = parseIpcRequest(rawRequest);
  } catch (error) {
    if (error instanceof IpcContractError) return failure(error.category, error.message);
    return failure('invalid-payload', 'IPC request is invalid');
  }

  if (request.operation === 'app.getInfo') {
    if (request.payload !== null) return failure('invalid-payload', 'app.getInfo accepts no payload');
    const reply = { ok: true, value: { name: app.getName(), version: app.getVersion(), platform: process.platform } };
    return safeResponse('app.getInfo', reply);
  }

  return handleFlowAgentRequest(event, request);
});



async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 900,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  const preventUntrustedNavigation = (event: Electron.Event, targetUrl: string) => {
    if (!isTrustedRendererUrl(targetUrl)) event.preventDefault();
  };
  mainWindow.webContents.on('will-navigate', preventUntrustedNavigation);
  mainWindow.webContents.on('will-redirect', preventUntrustedNavigation);

  if (trustedRenderer.mode === 'development') await mainWindow.loadURL(trustedRenderer.url);
  else await mainWindow.loadFile(trustedRenderer.filePath);
  mainWindow.on('closed', () => { flowAgent?.removeRendererListeners(); flowSubscriptions.clear(); for (const unsubscribe of runtimeSubscriptions.values()) unsubscribe(); runtimeSubscriptions.clear(); mainWindow = undefined; });
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
let quittingAfterFlowAgentShutdown = false;
app.on('before-quit', (event) => {
  if (quittingAfterFlowAgentShutdown) { ipcMain.removeHandler(IPC_CHANNELS.invoke); return; }
  event.preventDefault();
  quittingAfterFlowAgentShutdown = true;
  ipcMain.removeHandler(IPC_CHANNELS.invoke);
  void (flowAgent ? flowAgent.shutdown() : Promise.resolve()).finally(() => { catalog?.close(); app.quit(); });
});
