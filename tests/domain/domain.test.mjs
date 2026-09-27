import test from "node:test";
import assert from "node:assert/strict";
import { validateCommitChange, validateDomainEvent, validateJsonObject, ContractError } from "../../src/shared/contracts/domain.ts";
import { nextRevision, entityKey } from "../../src/domain/entities.ts";
import { randomUUID } from "node:crypto";

function projectChange() {
  return { eventId: randomUUID(), projectId: "p1", entityId: "p1", entityType: "project", origin: "main",
    type: "project.created", payload: {}, entityData: { displayName: "ADE", rootPath: "C:/repos/ade" } };
}

test("domain rules calculate optimistic revisions and stable keys", () => {
  assert.equal(nextRevision(3, 3), 4);
  assert.throws(() => nextRevision(3, 2));
  assert.equal(entityKey("p", "task", "t"), '["p","task","t"]');
});

test("runtime command schema rejects secrets, environment and terminal data", () => {
  assert.equal(validateCommitChange(projectChange()).entityType, "project");
  assert.throws(() => validateCommitChange({ ...projectChange(), entityData: { accessToken: "x" } }), ContractError);
  assert.throws(() => validateCommitChange({ ...projectChange(), type: "pty.stdout" }), ContractError);
  assert.throws(() => validateCommitChange({ ...projectChange(), payload: { stderr: "terminal bytes" } }), ContractError);
  assert.throws(() => validateCommitChange({ ...projectChange(), payload: { apiKey: "sk-abcdefghijklmnopqrstuvwxyz012345" } }), ContractError);
  const cleaned = validateJsonObject({ details: "Bearer abc.def.ghi" });
  assert.equal(cleaned.details, "[REDACTED]");
  assert.throws(() => validateJsonObject(Buffer.from("terminal bytes")), ContractError);
});

test("Evidence permits non-terminal metadata only", () => {
  const item = { ...projectChange(), entityId: "ev1", entityType: "evidence", type: "evidence.created",
    entityData: { artifactType: "report", displayName: "Review", uri: "file:///safe/report.md" } };
  assert.equal(validateCommitChange(item).entityType, "evidence");
  assert.throws(() => validateCommitChange({ ...item, entityData: { artifactType: "report", displayName: "bad", content: "terminal" } }), ContractError);
  assert.throws(() => validateCommitChange({ ...item, entityData: { artifactType: "report", displayName: "bad", stdout: "forbidden" } }), ContractError);
  assert.throws(() => validateCommitChange({ ...item, payload: { content: "captured stdout" } }), ContractError);
});

test("common token assignments are redacted from permitted text and Evidence metadata", () => {
  for (const value of ["token=bare-secret", "access_token=access-secret", "refresh_token: refresh-secret"]) {
    const cleaned = validateJsonObject({ body: value, uri: value });
    assert.equal(cleaned.body.includes("secret"), false);
    assert.equal(cleaned.uri.includes("secret"), false);
  }
});

test("persisted event contract requires UUID, positive sequence and revision", () => {
  const event = { eventId: randomUUID(), projectId: "p1", entityId: "t1", entityType: "task",
    sequence: 1, revision: 1, occurredAt: new Date().toISOString(), origin: "main", type: "task.saved", payload: {} };
  assert.equal(validateDomainEvent(event).sequence, 1);
  assert.throws(() => validateDomainEvent({ ...event, sequence: 0 }));
});


