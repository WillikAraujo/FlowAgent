import { ENTITY_TYPES, type CommitChange, type DomainEvent, type EntityType, type JsonObject, type JsonValue } from "../../domain/model.ts";

const forbiddenKey = /(?:secret|token|password|credential|authorization|api.?key|client.?secret|env|stdout|stderr|pty|terminal|transcript|output|private.?key|access.?key)/i;
const forbiddenEventType = /(?:^|[._-])(?:pty|stdout|stderr|terminal|transcript|raw.?output)(?:$|[._-])/i;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_JSON_BYTES = 1_000_000;
const MAX_DEPTH = 32;
const knownSecretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gi,
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}\b/g,
  /\b(?:api[_-]?key|client[_-]?secret|password)\s*[:=]\s*\S+/gi,
  /\b(?:(?:access|refresh|id|auth(?:orization)?)[_-]?)?token\s*[:=]\s*[^\s&#]+/gi,
];

export class ContractError extends Error {
  readonly code: "INVALID_CONTRACT" | "SENSITIVE_CONTENT" | "PAYLOAD_TOO_LARGE";
  constructor(code: "INVALID_CONTRACT" | "SENSITIVE_CONTENT" | "PAYLOAD_TOO_LARGE", message: string) {
    super(message); this.name = "ContractError"; this.code = code;
  }
}
function isObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function sanitizeString(value: string): string {
  return knownSecretPatterns.reduce((result, pattern) => result.replace(pattern, "[REDACTED]"), value);
}
function safeValue(value: unknown, depth = 0): JsonValue {
  if (depth > MAX_DEPTH) throw new ContractError("INVALID_CONTRACT", "Payload nesting exceeds the limit.");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") return sanitizeString(value);
  if (Array.isArray(value)) return value.map((item) => safeValue(item, depth + 1));
  if (isObject(value)) {
    const output: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      if (forbiddenKey.test(key)) throw new ContractError("SENSITIVE_CONTENT", "Payload contains a prohibited field; it was not persisted.");
      output[key] = safeValue(item, depth + 1);
    }
    return output;
  }
  throw new ContractError("INVALID_CONTRACT", "Payload must contain plain JSON values only.");
}
export function validateJsonObject(value: unknown): JsonObject {
  if (!isObject(value)) throw new ContractError("INVALID_CONTRACT", "Payload must be a plain JSON object.");
  const result = safeValue(value);
  const serialized = JSON.stringify(result);
  if (serialized === undefined) throw new ContractError("INVALID_CONTRACT", "Payload cannot be serialized as JSON.");
  if (Buffer.byteLength(serialized, "utf8") > MAX_JSON_BYTES) throw new ContractError("PAYLOAD_TOO_LARGE", "Payload exceeds the 1 MiB limit.");
  return result as JsonObject;
}
export function validateEntityType(value: unknown): EntityType {
  if (typeof value !== "string" || !ENTITY_TYPES.includes(value as EntityType)) throw new ContractError("INVALID_CONTRACT", "Unknown entity type.");
  return value as EntityType;
}
const evidenceFields = new Set(["artifactType", "displayName", "sha256", "mediaType", "sizeBytes", "sourceLabel", "uri"]);
function validateEvidenceMetadata(value: JsonObject, required: boolean): void {
  for (const key of Object.keys(value)) if (!evidenceFields.has(key)) {
    throw new ContractError("INVALID_CONTRACT", "Evidence stores metadata only; content and terminal-derived fields are not allowed.");
  }
  if (required && (!["file", "patch", "report", "image", "other"].includes(String(value.artifactType)) ||
      typeof value.displayName !== "string")) {
    throw new ContractError("INVALID_CONTRACT", "Evidence requires an allowed artifactType and displayName.");
  }
  if (value.displayName !== undefined && (typeof value.displayName !== "string" || value.displayName.length > 160 || /[\r\n\0]/.test(value.displayName))) {
    throw new ContractError("INVALID_CONTRACT", "Evidence displayName must be a short single-line label.");
  }
  if (value.uri !== undefined && value.uri !== null && (typeof value.uri !== "string" || value.uri.length > 2048 || /[\r\n\0]/.test(value.uri))) {
    throw new ContractError("INVALID_CONTRACT", "Evidence uri is invalid.");
  }
  if (value.sha256 !== undefined && value.sha256 !== null && (typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(value.sha256))) {
    throw new ContractError("INVALID_CONTRACT", "Evidence sha256 must be a hexadecimal digest.");
  }
  if (value.sizeBytes !== undefined && value.sizeBytes !== null && (typeof value.sizeBytes !== "number" || !Number.isSafeInteger(value.sizeBytes) || value.sizeBytes < 0)) {
    throw new ContractError("INVALID_CONTRACT", "Evidence sizeBytes must be a non-negative integer.");
  }
}
export function validateCommitChange(value: unknown): CommitChange {
  if (!isObject(value)) throw new ContractError("INVALID_CONTRACT", "Change must be an object.");
  const projectId = value.projectId, entityId = value.entityId, entityType = validateEntityType(value.entityType);
  if (typeof projectId !== "string" || !idPattern.test(projectId)) throw new ContractError("INVALID_CONTRACT", "Invalid project ID.");
  if (typeof entityId !== "string" || !idPattern.test(entityId)) throw new ContractError("INVALID_CONTRACT", "Invalid entity ID.");
  if (entityType === "project" && projectId !== entityId) throw new ContractError("INVALID_CONTRACT", "A project record must use its project ID as entity ID.");
  if (typeof value.type !== "string" || value.type.length < 1 || value.type.length > 120 || forbiddenEventType.test(value.type)) throw new ContractError("SENSITIVE_CONTENT", "Event type is invalid or refers to terminal output.");
  if (!["main", "renderer", "adapter", "system"].includes(String(value.origin))) throw new ContractError("INVALID_CONTRACT", "Invalid event origin.");
  if (value.correlationId !== undefined && (typeof value.correlationId !== "string" || !idPattern.test(value.correlationId))) throw new ContractError("INVALID_CONTRACT", "Invalid event correlation ID.");
  if (value.eventId !== undefined && (typeof value.eventId !== "string" || !uuidPattern.test(value.eventId))) throw new ContractError("INVALID_CONTRACT", "eventId must be a UUID.");
  if (value.correlationId !== undefined && (typeof value.correlationId !== "string" || !idPattern.test(value.correlationId))) throw new ContractError("INVALID_CONTRACT", "Invalid correlation ID.");
  if (value.expectedRevision !== undefined && (typeof value.expectedRevision !== "number" || !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0)) throw new ContractError("INVALID_CONTRACT", "expectedRevision must be a non-negative integer.");
  if (value.occurredAt !== undefined && (typeof value.occurredAt !== "string" || !Number.isFinite(Date.parse(value.occurredAt)))) throw new ContractError("INVALID_CONTRACT", "occurredAt must be a valid timestamp.");
  const payload = validateJsonObject(value.payload), entityData = validateJsonObject(value.entityData);
  if (entityType === "evidence") {
    validateEvidenceMetadata(entityData, true);
    validateEvidenceMetadata(payload, false);
  }
  return {
    ...(value.eventId === undefined ? {} : { eventId: value.eventId as string }),
    projectId, entityId, entityType,
    ...(value.occurredAt === undefined ? {} : { occurredAt: value.occurredAt as string }),
    origin: value.origin as CommitChange["origin"], type: value.type, payload, entityData,
    ...(value.correlationId === undefined ? {} : { correlationId: value.correlationId as string }),
    ...(value.expectedRevision === undefined ? {} : { expectedRevision: value.expectedRevision as number }),
  };
}
export function validateDomainEvent(value: unknown): DomainEvent {
  if (!isObject(value)) throw new ContractError("INVALID_CONTRACT", "Event must be a plain object.");
  if (typeof value.eventId !== "string" || !uuidPattern.test(value.eventId) ||
      typeof value.projectId !== "string" || !idPattern.test(value.projectId) ||
      typeof value.entityId !== "string" || !idPattern.test(value.entityId) ||
      typeof value.sequence !== "number" || !Number.isSafeInteger(value.sequence) || value.sequence < 1 ||
      typeof value.revision !== "number" || !Number.isSafeInteger(value.revision) || value.revision < 1 ||
      typeof value.occurredAt !== "string" || !Number.isFinite(Date.parse(value.occurredAt))) {
    throw new ContractError("INVALID_CONTRACT", "Event identity, sequence, revision, or timestamp is invalid.");
  }
  if (typeof value.type !== "string" || value.type.length > 120 || forbiddenEventType.test(value.type)) throw new ContractError("SENSITIVE_CONTENT", "Terminal-output events are not durable.");
  if (!["main", "renderer", "adapter", "system"].includes(String(value.origin))) throw new ContractError("INVALID_CONTRACT", "Invalid event origin.");
  if (value.correlationId !== undefined && (typeof value.correlationId !== "string" || !idPattern.test(value.correlationId))) throw new ContractError("INVALID_CONTRACT", "Invalid event correlation ID.");
  return {
    eventId: value.eventId as string, projectId: value.projectId as string, entityId: value.entityId as string,
    entityType: validateEntityType(value.entityType), sequence: value.sequence as number, revision: value.revision as number,
    occurredAt: value.occurredAt as string, origin: value.origin as DomainEvent["origin"], type: value.type,
    payload: validateJsonObject(value.payload), ...(value.correlationId === undefined ? {} : { correlationId: value.correlationId as string }),
  };
}






