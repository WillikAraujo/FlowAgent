import test from "node:test";
import assert from "node:assert/strict";
import { IpcContractError, parseIpcRequest, parseIpcResponse, IPC_CHANNELS, MAX_IPC_REQUEST_BYTES } from "../../src/shared/contracts/ipc.ts";

test("the frozen ADE-101 IPC contract accepts app.getInfo and its reply envelope", () => {
  assert.equal(IPC_CHANNELS.invoke, "ade:invoke");
  assert.deepEqual(parseIpcRequest({ operation: "app.getInfo", payload: null }), { operation: "app.getInfo", payload: null });
  assert.deepEqual(parseIpcResponse("app.getInfo", { ok: true, value: { name: "ADE", version: "1.0", platform: "win32" } }),
    { ok: true, value: { name: "ADE", version: "1.0", platform: "win32" } });
  assert.equal(parseIpcResponse("app.getInfo", { ok: false, error: { category: "forbidden", message: "Denied" } }).ok, false);
});

test("IPC runtime contract enforces size, exact shape, allowlist and response shape", () => {
  assert.throws(() => parseIpcRequest({ operation: "app.getInfo", payload: null, extra: true }), IpcContractError);
  assert.throws(() => parseIpcRequest({ operation: "not.allowed", payload: null }), (error) => error.category === "unsupported-operation");
  assert.throws(() => parseIpcRequest({ operation: "app.getInfo", payload: "x".repeat(MAX_IPC_REQUEST_BYTES) }), (error) => error.category === "payload-too-large");
  assert.throws(() => parseIpcResponse("app.getInfo", { ok: true, value: { name: "ADE" } }), IpcContractError);
});

test("FlowAgent start and run snapshots accept their declared response shapes", () => {
  const start = { ok: true, value: { requestId: "request-1", projectId: "project-1", runId: "run-1", state: "queued" } };
  const run = { ok: true, value: { projectId: "project-1", runId: "run-1", state: "running", profile: "reviewer" } };
  assert.deepEqual(parseIpcResponse("flowAgent.start", start), start);
  assert.deepEqual(parseIpcResponse("flowAgent.getRun", run), run);
  assert.throws(() => parseIpcResponse("flowAgent.getRun", { ok: true, value: { ...run.value, profile: "invalid" } }), IpcContractError);
});
