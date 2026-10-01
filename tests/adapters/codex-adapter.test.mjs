import test from 'node:test';
import assert from 'node:assert/strict';
import { createCodexAdapter } from '../../src/main/adapters/codex/codex-adapter.ts';

const fixedNow = () => new Date('2026-09-27T12:00:00.000Z');
const file = (mode = 0o755) => ({ isFile: () => true, mode });
const notFound = () => Object.assign(new Error('not found'), { code: 'ENOENT' });

function adapter(overrides = {}) {
  return createCodexAdapter({
    pathValue: 'C:\\tools',
    platform: 'win32',
    statFile: async () => { throw notFound(); },
    now: fixedNow,
    ...overrides,
  });
}

test('Codex executable metadata found reports presence without authentication inference', async () => {
  const inspected = [];
  const result = await adapter({
    statFile: async (candidate) => {
      inspected.push(candidate);
      if (candidate.endsWith('codex.cmd')) return file();
      throw notFound();
    },
  }).detect();

  assert.equal(result.provider, 'codex');
  assert.equal(result.availability, 'present');
  assert.equal(result.authentication, 'unknown');
  assert.equal(result.reason, 'executable-metadata-found');
  assert.equal(result.observedAt, '2026-09-27T12:00:00.000Z');
  assert.deepEqual(inspected, ['C:\\tools\\codex.exe', 'C:\\tools\\codex.cmd']);
  assert.equal(JSON.stringify(result).includes('C:\\tools'), false);
});

test('missing executable metadata reports absent', async () => {
  const result = await adapter().detect();
  assert.equal(result.availability, 'absent');
  assert.equal(result.authentication, 'unknown');
  assert.equal(result.reason, 'no-executable-metadata');
});

test('unavailable PATH and inconclusive metadata report unknown', async () => {
  const noPath = await adapter({ pathValue: undefined }).detect();
  assert.equal(noPath.availability, 'unknown');
  assert.equal(noPath.reason, 'path-unavailable');

  const badMetadata = await adapter({
    statFile: async () => ({ isFile: 'no', mode: 'bad' }),
  }).detect();
  assert.equal(badMetadata.availability, 'unknown');
  assert.equal(badMetadata.reason, 'metadata-inconclusive');

  const accessError = await adapter({
    statFile: async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); },
  }).detect();
  assert.equal(accessError.availability, 'unknown');
  assert.equal(accessError.reason, 'metadata-inconclusive');
});

test('directories and non-executable POSIX files do not count as an executable', async () => {
  const directory = await adapter({
    platform: 'win32',
    statFile: async () => ({ isFile: () => false, mode: 0o755 }),
  }).detect();
  assert.equal(directory.availability, 'absent');

  const notExecutable = await adapter({
    platform: 'linux',
    pathValue: '/tools',
    statFile: async () => file(0o644),
  }).detect();
  assert.equal(notExecutable.availability, 'absent');
});

test('only detection is supported; session/task/process operations remain unsupported', () => {
  const capabilities = adapter().capabilities();
  assert.equal(capabilities.detect, 'supported');
  assert.equal(capabilities.createSession, 'unsupported');
  assert.equal(capabilities.resumeSession, 'unsupported');
  assert.equal(capabilities.sendTask, 'unsupported');
  assert.equal(capabilities.streamEvents, 'unsupported');
  assert.equal(capabilities.cancel, 'unsupported');
  assert.equal(capabilities.terminate, 'unsupported');
  assert.equal('path' in capabilities, false);
  assert.equal('token' in capabilities, false);
});

test('detector is dependency-limited to metadata inspection and has no process launcher', async () => {
  let metadataCalls = 0;
  const result = await adapter({ statFile: async () => { metadataCalls += 1; throw notFound(); } }).detect();
  assert.equal(metadataCalls, 3);
  assert.equal(result.availability, 'absent');
});
