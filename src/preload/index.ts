import { contextBridge, ipcRenderer } from 'electron';
import {
  IPC_CHANNELS,
  parseIpcResponse,
  type AdeRendererApi,
  type IpcFailure,
} from '../shared/contracts/ipc';

const ade: AdeRendererApi = Object.freeze({
  async getAppInfo() {
    const rawReply: unknown = await ipcRenderer.invoke(IPC_CHANNELS.invoke, {
      operation: 'app.getInfo',
      payload: null,
    });
    const reply = parseIpcResponse('app.getInfo', rawReply);
    if (!reply.ok) {
      const error: IpcFailure['error'] = reply.error;
      throw Object.assign(new Error(error.message), { category: error.category });
    }
    return reply.value;
  },
});

contextBridge.exposeInMainWorld('ade', ade);
