import { app, BrowserWindow, ipcMain } from 'electron';
import { join } from 'node:path';
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

function isAllowedSender(event: Electron.IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame;
  if (!mainWindow || event.sender.id !== mainWindow.webContents.id || !frame) return false;
  try {
    const sender = new URL(frame.url);
    const rendererUrl = process.env.ADE_RENDERER_URL;
    if (rendererUrl) {
      const expected = new URL(rendererUrl);
      return sender.origin === expected.origin && sender.pathname === expected.pathname &&
        sender.search === expected.search && sender.hash === expected.hash;
    }
    return sender.protocol === 'file:' && sender.pathname.endsWith('/dist/renderer/index.html');
  } catch {
    return false;
  }
}

function safeResponse(value: unknown): IpcResponse<'app.getInfo'> {
  return parseIpcResponse('app.getInfo', value);
}

ipcMain.handle(IPC_CHANNELS.invoke, (event, rawRequest: unknown): IpcResponse<'app.getInfo'> => {
  if (!isAllowedSender(event)) return failure('forbidden', 'IPC sender is not authorized');
  if (serializedSize(rawRequest) > MAX_IPC_REQUEST_BYTES) {
    return failure('payload-too-large', 'IPC request exceeds the 1024-byte limit');
  }

  // The envelope shape is checked here so an unknown operation receives its
  // own stable category; parseIpcRequest then validates the known schema.
  if (isRecord(rawRequest) && Object.keys(rawRequest).length === 2 &&
      Object.keys(rawRequest).includes('operation') && Object.keys(rawRequest).includes('payload') &&
      typeof rawRequest.operation === 'string' && rawRequest.operation !== 'app.getInfo') {
    return failure('unsupported-operation', 'IPC operation is not allowlisted');
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
    return safeResponse(reply);
  }

  return failure('unsupported-operation', 'IPC operation is not implemented');
});

function isTrustedNavigation(target: string): boolean {
  try {
    const targetUrl = new URL(target);
    const rendererUrl = process.env.ADE_RENDERER_URL;
    if (rendererUrl) {
      const expected = new URL(rendererUrl);
      return targetUrl.origin === expected.origin && targetUrl.pathname === expected.pathname &&
        targetUrl.search === expected.search && targetUrl.hash === expected.hash;
    }
    return targetUrl.protocol === 'file:' && targetUrl.pathname.endsWith('/dist/renderer/index.html');
  } catch {
    return false;
  }
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
    if (!isTrustedNavigation(targetUrl)) event.preventDefault();
  });

  const rendererUrl = process.env.ADE_RENDERER_URL;
  if (rendererUrl) await mainWindow.loadURL(rendererUrl);
  else await mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  mainWindow.on('closed', () => { mainWindow = undefined; });
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { ipcMain.removeHandler(IPC_CHANNELS.invoke); });
