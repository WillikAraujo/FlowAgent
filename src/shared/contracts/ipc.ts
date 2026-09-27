/** Shared, renderer-safe IPC contract for the ADE-101 shell. No Electron or Node imports. */
export const IPC_CHANNELS = Object.freeze({ invoke: "ade:invoke" } as const);
export const MAX_IPC_REQUEST_BYTES = 1024;

export type IpcErrorCategory =
  | "unsupported-operation"
  | "forbidden"
  | "invalid-payload"
  | "payload-too-large";

export interface AppInfo {
  name: string;
  version: string;
  platform: string;
}

export interface IpcRequestMap {
  "app.getInfo": null;
}

export interface IpcResponseMap {
  "app.getInfo": AppInfo;
}

export type IpcOperation = keyof IpcRequestMap;
export type IpcRequest = {
  [K in IpcOperation]: { operation: K; payload: IpcRequestMap[K] }
}[IpcOperation];

export type IpcSuccess<T> = { ok: true; value: T };
export type IpcFailure = {
  ok: false;
  error: { category: IpcErrorCategory; message: string };
};
export type IpcReply<T> = IpcSuccess<T> | IpcFailure;
export type IpcResponse<K extends IpcOperation = IpcOperation> = IpcReply<IpcResponseMap[K]>;

export interface AdeRendererApi {
  getAppInfo(): Promise<AppInfo>;
}

declare global {
  interface Window {
    readonly ade: AdeRendererApi;
  }
}

export class IpcContractError extends Error {
  readonly category: IpcErrorCategory;
  constructor(category: IpcErrorCategory, message: string) {
    super(message);
    this.name = "IpcContractError";
    this.category = category;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function serializedSize(value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? Number.POSITIVE_INFINITY : new TextEncoder().encode(serialized).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export function isAppInfo(value: unknown): value is AppInfo {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 3 &&
    keys.every((key) => key === "name" || key === "version" || key === "platform") &&
    typeof value.name === "string" && value.name.length > 0 && value.name.length <= 100 &&
    typeof value.version === "string" && value.version.length > 0 && value.version.length <= 80 &&
    typeof value.platform === "string" && value.platform.length > 0 && value.platform.length <= 32;
}

export function isIpcRequest(value: unknown): value is IpcRequest {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 2 && keys.includes("operation") && keys.includes("payload") &&
    value.operation === "app.getInfo" && value.payload === null;
}

export function parseIpcRequest(value: unknown): IpcRequest {
  if (serializedSize(value) > MAX_IPC_REQUEST_BYTES) {
    throw new IpcContractError("payload-too-large", "IPC request exceeds the payload limit.");
  }
  if (!isRecord(value)) throw new IpcContractError("invalid-payload", "IPC request must be an object.");
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes("operation") || !keys.includes("payload") || typeof value.operation !== "string") {
    throw new IpcContractError("invalid-payload", "IPC request must contain only operation and payload.");
  }
  if (value.operation !== "app.getInfo") {
    throw new IpcContractError("unsupported-operation", "IPC operation is not allowlisted.");
  }
  if (value.payload !== null) throw new IpcContractError("invalid-payload", "app.getInfo accepts no payload.");
  return value as IpcRequest;
}

export function isIpcFailure(value: unknown): value is IpcFailure {
  if (!isRecord(value) || value.ok !== false || Object.keys(value).length !== 2 || !isRecord(value.error)) return false;
  const error = value.error;
  const categories: readonly string[] = [
    "unsupported-operation", "forbidden", "invalid-payload", "payload-too-large",
  ];
  return Object.keys(error).length === 2 &&
    typeof error.category === "string" && categories.includes(error.category) &&
    typeof error.message === "string" && error.message.length > 0 && error.message.length <= 240;
}

export function isIpcResponse<K extends IpcOperation>(
  operation: K,
  value: unknown,
): value is IpcResponse<K> {
  if (!isRecord(value) || typeof value.ok !== "boolean" || Object.keys(value).length !== 2) return false;
  if (value.ok === false) return isIpcFailure(value);
  return Object.keys(value).every((key) => key === "ok" || key === "value") &&
    (operation === "app.getInfo" ? isAppInfo(value.value) : false);
}

export function parseIpcResponse<K extends IpcOperation>(
  operation: K,
  value: unknown,
): IpcResponse<K> {
  if (!isIpcResponse(operation, value)) {
    throw new IpcContractError("invalid-payload", "Main returned a response outside the IPC contract.");
  }
  return value;
}



