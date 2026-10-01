export interface AdeSettings {
  defaultProvider: 'codex' | 'opencode';
  projectProviders: Record<string, 'codex' | 'opencode'>;
}
export interface ProviderAvailability {
  providerId: 'codex' | 'opencode';
  name: string;
  status: 'available' | 'unavailable' | 'error';
  executable: string | null;
  version: string | null;
  authentication: 'unknown';
  roles: string[];
  detail: string;
}
export const defaultSettings = (): AdeSettings => ({ defaultProvider: 'codex', projectProviders: {} });
export function isAdeSettings(value: unknown): value is AdeSettings {
  if (!value || typeof value !== 'object') return false;
  const data = value as AdeSettings;
  return Object.keys(data).length === 2 && ['codex', 'opencode'].includes(data.defaultProvider) &&
    !!data.projectProviders && typeof data.projectProviders === 'object' && !Array.isArray(data.projectProviders) &&
    Object.entries(data.projectProviders).length <= 100 && Object.entries(data.projectProviders).every(([key, provider]) => key.length > 0 && key.length <= 180 && !['__proto__', 'constructor', 'prototype'].includes(key) && ['codex', 'opencode'].includes(provider));
}
