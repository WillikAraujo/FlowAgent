import * as realContract from '../../src/shared/contracts/ipc.ts';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const nodeRequire = createRequire(import.meta.url);

async function loadBridge() {
  const [preloadSource, contractSource] = await Promise.all([
    readFile(join(root, 'src/preload/index.ts'), 'utf8'),
    readFile(join(root, 'src/shared/contracts/ipc.ts'), 'utf8'),
  ]);
  const compile = (source) => ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const contract = { exports: realContract };

  let exposed;
  const requests = [];
  const listeners = new Set();
  const responses = {
    'app.getInfo': { name: 'ADE', version: '1.0', platform: 'win32' },
    'flowAgent.openProject': { outcome: 'opened', project: { projectId: 'project-1', displayName: 'demo' } },
    'flowAgent.start': { requestId: 'request-1', projectId: 'project-1', runId: 'run-1', state: 'queued' },
    'flowAgent.getRun': { projectId: 'project-1', runId: 'run-1', state: 'running', profile: 'reviewer' },
    'flowAgent.subscribe': { outcome: 'subscribed' },
    'flowAgent.unsubscribe': { outcome: 'unsubscribed' },
    'flowAgent.cancel': { outcome: 'cancel-requested' },
  };
  const electron = {
    contextBridge: { exposeInMainWorld(name, value) { assert.equal(name, 'ade'); exposed = value; } },
    ipcRenderer: {
      async invoke(channel, request) {
        assert.equal(channel, contract.exports.IPC_CHANNELS.invoke);
        requests.push(request);
        return { ok: true, value: responses[request.operation] };
      },
      on(channel, listener) { assert.equal(channel, contract.exports.IPC_CHANNELS.flowAgentEvent); listeners.add(listener); },
      removeListener(channel, listener) { assert.equal(channel, contract.exports.IPC_CHANNELS.flowAgentEvent); listeners.delete(listener); },
    },
  };
  const preload = { exports: {} };
  const mockRequire = (name) => name === 'electron' ? electron : name === '../shared/contracts/ipc' ? contract.exports : nodeRequire(name);
  new Function('exports', 'require', 'module', compile(preloadSource))(preload.exports, mockRequire, preload);
  return { exposed, requests, listeners };
}

test('preload exposes only named operations and filters run events', async () => {
  const { exposed, requests, listeners } = await loadBridge();
  assert.deepEqual(Object.keys(exposed), ['collaboration','loadSettings','saveSettings','inspectProviders','getAppInfo','flowAgent','workspace','agentRuntime']);
  assert.deepEqual(Object.keys(exposed.collaboration), ['query','command']);
  assert.deepEqual(Object.keys(exposed.flowAgent), ['openProject', 'start', 'getRun', 'subscribe', 'unsubscribe', 'cancel']);
  assert.equal((await exposed.flowAgent.openProject()).project.displayName, 'demo');
  assert.deepEqual(requests.at(-1), { operation: 'flowAgent.openProject', payload: null });

  const ref = { projectId: 'project-1', runId: 'run-1' };
  const received = [];
  assert.equal((await exposed.flowAgent.subscribe(ref, (event) => received.push(event))).outcome, 'subscribed');
  const handler = [...listeners][0];
  handler({}, { projectId: 'project-1', runId: 'other', seq: 1, type: 'run.output', payload: { text: 'wrong run' } });
  handler({}, { projectId: 'project-1', runId: 'run-1', seq: 1, type: 'run.output', payload: { text: 'OK' } });
  handler({}, { projectId: 'project-1', runId: 'run-1', seq: 2, type: 'run.output', payload: { text: 123 } });
  assert.deepEqual(received.map((event) => event.payload.text), ['OK']);
  await exposed.flowAgent.unsubscribe(ref);
  assert.equal(listeners.size, 0);
});
