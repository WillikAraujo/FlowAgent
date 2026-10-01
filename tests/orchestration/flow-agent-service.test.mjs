import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { FlowAgentService } from '../../src/main/orchestration/flow-agent-service.ts';

test('shutdown cancels a setup run and waits for setup before returning', async () => {
  let releaseHelp;
  let helpStarted;
  const helpStartedPromise = new Promise((resolve) => { helpStarted = resolve; });
  const helpPromise = new Promise((resolve) => { releaseHelp = resolve; });
  let spawned = false;
  const root = process.cwd();
  const service = new FlowAgentService({
    chooseDirectory: async () => root,
    executable: async () => process.execPath,
    exec: async (file, args) => {
      if (file === 'git') return args.includes('worktree') ? `worktree ${root}\nbranch refs/heads/main\n\n` : `${root}\n`;
      helpStarted();
      return helpPromise;
    },
    spawnProcess: () => { spawned = true; throw new Error('must not spawn after shutdown'); },
  });
  const opened = await service.openProject();
  assert.equal(opened.outcome, 'opened');
  const starting = service.start({ requestId: 'request-1', projectId: opened.project.projectId, task: 'review', profile: 'reviewer' });
  await helpStartedPromise;
  const shuttingDown = service.shutdown();
  let shutdownFinished = false;
  void shuttingDown.then(() => { shutdownFinished = true; });
  await Promise.resolve();
  assert.equal(shutdownFinished, false);
  releaseHelp('--sandbox read-only workspace-write');
  await assert.rejects(starting, /cancelled before process start/);
  await shuttingDown;
  assert.equal(spawned, false);
});

test('cancel during setup prevents the later spawn', async () => {
  let releaseHelp;
  let helpStarted;
  const helpStartedPromise = new Promise((resolve) => { helpStarted = resolve; });
  const helpPromise = new Promise((resolve) => { releaseHelp = resolve; });
  let spawned = false;
  const root = process.cwd();
  const service = new FlowAgentService({
    chooseDirectory: async () => root,
    executable: async () => process.execPath,
    exec: async (file, args) => {
      if (file === 'git') return args.includes('worktree') ? `worktree ${root}\nbranch refs/heads/main\n\n` : `${root}\n`;
      helpStarted();
      return helpPromise;
    },
    spawnProcess: () => { spawned = true; throw new Error('must not spawn after cancellation'); },
  });
  const opened = await service.openProject();
  assert.equal(opened.outcome, 'opened');
  const starting = service.start({ requestId: 'request-2', projectId: opened.project.projectId, task: 'review', profile: 'reviewer' });
  await helpStartedPromise;
  const run = [...service.runs.values()][0];
  assert.equal(await service.cancel({ projectId: opened.project.projectId, runId: run.runId }), 'cancel-requested');
  releaseHelp('--sandbox read-only workspace-write');
  await assert.rejects(starting, /cancelled before process start/);
  assert.equal(service.getRun({ projectId: opened.project.projectId, runId: run.runId }).state, 'cancelled');
  assert.equal(spawned, false);
  await service.shutdown();
});
