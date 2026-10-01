import * as realContract from '../../src/shared/contracts/ipc.ts';
﻿import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import ts from 'typescript';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const mainSourcePath = path.join(projectRoot, 'src/main/index.ts');
const ipcSourcePath = path.join(projectRoot, 'src/shared/contracts/ipc.ts');
const nodeRequire = createRequire(import.meta.url);

async function loadMain({ packaged = false, rendererUrl } = {}) {
  const [mainSource, ipcSource] = await Promise.all([
    readFile(mainSourcePath, 'utf8'),
    readFile(ipcSourcePath, 'utf8'),
  ]);
  const mainJs = ts.transpileModule(mainSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const ipcJs = ts.transpileModule(ipcSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;

  const ipcContract = { exports: realContract };

  const invokeHandlers = new Map();
  const appListeners = new Map();
  const app = {
    isPackaged: packaged,
    getName: () => 'ade-test',
    getVersion: () => '0.0.0-test',
    whenReady: () => ({ then(callback) { return Promise.resolve().then(callback); } }),
    on: (name, callback) => appListeners.set(name, callback),
    quit() {},
  };
  const ipcMain = {
    handle: (channel, callback) => invokeHandlers.set(channel, callback),
    removeHandler: (channel) => invokeHandlers.delete(channel),
  };
  const navigationHandlers = new Map();
  let windowOpenHandler;
  let mainWindow;
  class BrowserWindow {
    constructor(options) {
      const frame = { url: '' };
      this.options = options;
      this.webContents = {
        mainFrame: frame,
        setWindowOpenHandler: (callback) => { windowOpenHandler = callback; },
        on: (name, callback) => navigationHandlers.set(name, callback),
      };
      this.loaded = undefined;
      this.on = () => {};
      this.loadURL = async (url) => { this.loaded = url; frame.url = url; };
      this.loadFile = async (file) => { this.loaded = file; frame.url = pathToFileURL(file).href; };
      mainWindow = this;
    }
  }

  const mockRequire = (specifier) => {
    if (specifier === 'electron') return { app, BrowserWindow, ipcMain };
    if (specifier.startsWith('./')) return nodeRequire(path.join(projectRoot, 'dist/main', specifier));
    if (specifier === '../shared/contracts/ipc') return ipcContract.exports;
    return nodeRequire(specifier);
  };
  const mainModule = { exports: {} };
  const priorRendererUrl = process.env.ADE_RENDERER_URL;
  if (rendererUrl === undefined) delete process.env.ADE_RENDERER_URL;
  else process.env.ADE_RENDERER_URL = rendererUrl;
  try {
    new Function('exports', 'require', 'module', '__filename', '__dirname', mainJs)(
      mainModule.exports,
      mockRequire,
      mainModule,
      path.join(projectRoot, 'dist/main/index.js'),
      path.join(projectRoot, 'dist/main'),
    );
  } finally {
    if (priorRendererUrl === undefined) delete process.env.ADE_RENDERER_URL;
    else process.env.ADE_RENDERER_URL = priorRendererUrl;
  }
  await new Promise((resolve) => setImmediate(resolve));
  const handler = invokeHandlers.get(ipcContract.exports.IPC_CHANNELS.invoke);
  assert.equal(typeof handler, 'function', 'Main registered the canonical invoke handler');
  assert.ok(mainWindow, 'Main created the ADE window');
  return {
    app,
    handler,
    mainWindow,
    navigationHandlers,
    getWindowOpenDecision: (details) => windowOpenHandler?.(details),
  };
}

function senderEvent(mainWindow, { sender = mainWindow.webContents, frame = sender.mainFrame } = {}) {
  return { sender, senderFrame: frame };
}

const validRequest = { operation: 'app.getInfo', payload: null };
const devUrl = 'http://127.0.0.1:5173/';

 test('rejects absent and non-main sender frames', async (t) => {
  const { handler, mainWindow } = await loadMain({ rendererUrl: devUrl });
  for (const [name, frame] of [
    ['null senderFrame', null],
    ['iframe', { url: devUrl }],
  ]) {
    await t.test(name, () => {
      const result = handler(senderEvent(mainWindow, { frame }), validRequest);
      assert.equal(result.ok, false);
      assert.equal(result.error.category, 'forbidden');
    });
  }
});

test('rejects a different WebContents even when its main frame has the trusted URL', async () => {
  const { handler, mainWindow } = await loadMain({ rendererUrl: devUrl });
  const otherSender = { mainFrame: { url: devUrl } };
  const result = handler(senderEvent(mainWindow, { sender: otherSender }), validRequest);
  assert.equal(result.ok, false);
  assert.equal(result.error.category, 'forbidden');
});

test('blocks untrusted navigation and redirects while allowing the exact renderer URL', async () => {
  const { mainWindow, navigationHandlers } = await loadMain({ rendererUrl: devUrl });
  for (const eventName of ['will-navigate', 'will-redirect']) {
    const callback = navigationHandlers.get(eventName);
    assert.equal(typeof callback, 'function', `${eventName} handler was registered`);

    let prevented = false;
    callback({ preventDefault: () => { prevented = true; } }, 'https://evil.example/');
    assert.equal(prevented, true, `${eventName} blocks remote navigation`);

    prevented = false;
    callback({ preventDefault: () => { prevented = true; } }, devUrl);
    assert.equal(prevented, false, `${eventName} allows the exact trusted renderer URL`);
  }
  assert.ok(mainWindow);
});

test('denies requests to open new windows', async () => {
  const { getWindowOpenDecision } = await loadMain({ rendererUrl: devUrl });
  assert.deepEqual(getWindowOpenDecision({ url: 'https://example.com/' }), { action: 'deny' });
});

test('rejects remote URLs and file URLs with a matching suffix outside the resolved entry', async (t) => {
  const fileState = await loadMain({ packaged: true, rendererUrl: 'https://evil.example/' });
  const trustedFile = pathToFileURL(path.join(projectRoot, 'dist/renderer/index.html')).href;
  const trustedResult = fileState.handler(senderEvent(fileState.mainWindow), validRequest);
  assert.equal(trustedResult.ok, true);

  await t.test('remote URL', async () => {
    const state = await loadMain({ rendererUrl: devUrl });
    const frame = { url: 'https://evil.example/' };
    const result = state.handler(senderEvent(state.mainWindow, { frame }), validRequest);
    assert.equal(result.ok, false);
    assert.equal(result.error.category, 'forbidden');
  });

  await t.test('file URL suffix outside exact path', () => {
    const frame = { url: 'file:///elsewhere/dist/renderer/index.html' };
    assert.notEqual(frame.url, trustedFile);
    const result = fileState.handler(senderEvent(fileState.mainWindow, { frame }), validRequest);
    assert.equal(result.ok, false);
    assert.equal(result.error.category, 'forbidden');
  });
});

test('allows only the exact development URL in unpackaged mode', async (t) => {
  const accepted = await loadMain({ packaged: false, rendererUrl: devUrl });
  assert.equal(accepted.mainWindow.loaded, devUrl);
  assert.equal(accepted.handler(senderEvent(accepted.mainWindow), validRequest).ok, true);

  for (const rendererUrl of ['https://evil.example/', 'http://127.0.0.1:5174/']) {
    await t.test(`rejects ${rendererUrl}`, async () => {
      await assert.rejects(loadMain({ packaged: false, rendererUrl }), /ADE_RENDERER_URL must exactly match/);
    });
  }
});

test('packaged mode ignores ADE_RENDERER_URL and trusts only the resolved file entry', async () => {
  const { handler, mainWindow } = await loadMain({ packaged: true, rendererUrl: 'https://evil.example/' });
  assert.equal(mainWindow.loaded, path.join(projectRoot, 'dist/renderer/index.html'));
  assert.equal(handler(senderEvent(mainWindow), validRequest).ok, true);
});

