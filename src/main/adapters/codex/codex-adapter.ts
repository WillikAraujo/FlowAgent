import { stat } from 'node:fs/promises';
import { delimiter, join } from 'node:path';

export type DetectionAvailability = 'present' | 'absent' | 'unknown';
export type CapabilitySupport = 'supported' | 'unsupported';

export interface CodexDetectionResult {
  provider: 'codex';
  availability: DetectionAvailability;
  authentication: 'unknown';
  observedAt: string;
  reason: 'executable-metadata-found' | 'no-executable-metadata' | 'path-unavailable' | 'metadata-inconclusive';
}

export interface CodexCapabilities {
  detect: CapabilitySupport;
  createSession: CapabilitySupport;
  resumeSession: CapabilitySupport;
  sendTask: CapabilitySupport;
  streamEvents: CapabilitySupport;
  cancel: CapabilitySupport;
  terminate: CapabilitySupport;
}

interface FileMetadata {
  isFile(): boolean;
  mode: number;
}

export interface CodexAdapterOptions {
  pathValue: unknown;
  platform: string;
  statFile: (candidate: string) => Promise<FileMetadata>;
  now?: () => Date;
}

export interface AgentAdapter {
  detect(): Promise<CodexDetectionResult>;
  capabilities(): CodexCapabilities;
}

const codexCapabilities: Readonly<CodexCapabilities> = Object.freeze({
  detect: 'supported',
  createSession: 'unsupported',
  resumeSession: 'unsupported',
  sendTask: 'unsupported',
  streamEvents: 'unsupported',
  cancel: 'unsupported',
  terminate: 'unsupported',
});

function executableNames(platform: string): string[] {
  return platform === 'win32' ? ['codex.exe', 'codex.cmd', 'codex.bat'] : ['codex'];
}

function isExpectedMetadata(value: unknown): value is FileMetadata {
  if (typeof value !== 'object' || value === null) return false;
  const metadata = value as Partial<FileMetadata>;
  return typeof metadata.isFile === 'function' && Number.isInteger(metadata.mode);
}

function unavailable(
  availability: DetectionAvailability,
  reason: CodexDetectionResult['reason'],
  now: () => Date,
): CodexDetectionResult {
  return { provider: 'codex', availability, authentication: 'unknown', observedAt: now().toISOString(), reason };
}

/**
 * Passive presence detection only. It inspects static executable names in PATH
 * using filesystem metadata; it never starts a process or inspects session/auth data.
 */
export function createCodexAdapter(options: CodexAdapterOptions): AgentAdapter {
  const now = options.now ?? (() => new Date());

  return {
    async detect(): Promise<CodexDetectionResult> {
      if (typeof options.pathValue !== 'string') {
        return unavailable('unknown', 'path-unavailable', now);
      }

      const directories = options.pathValue
        .split(options.platform === 'win32' ? ';' : delimiter)
        .map((directory) => directory.trim().replace(/^"(.*)"$/, '$1'))
        .filter(Boolean);

      let inconclusive = false;
      for (const directory of directories) {
        for (const executableName of executableNames(options.platform)) {
          try {
            const metadata: unknown = await options.statFile(join(directory, executableName));
            if (!isExpectedMetadata(metadata)) {
              inconclusive = true;
              continue;
            }
            if (!metadata.isFile()) continue;
            if (options.platform !== 'win32' && (metadata.mode & 0o111) === 0) continue;
            return unavailable('present', 'executable-metadata-found', now);
          } catch (error) {
            const code = typeof error === 'object' && error !== null && 'code' in error
              ? (error as { code?: unknown }).code
              : undefined;
            if (code !== 'ENOENT' && code !== 'ENOTDIR') inconclusive = true;
          }
        }
      }

      if (inconclusive) return unavailable('unknown', 'metadata-inconclusive', now);
      return unavailable('absent', 'no-executable-metadata', now);
    },

    capabilities(): CodexCapabilities {
      return { ...codexCapabilities };
    },
  };
}

export function createCodexAdapterFromEnvironment(): AgentAdapter {
  return createCodexAdapter({
    pathValue: process.env.PATH,
    platform: process.platform,
    statFile: async (candidate) => stat(candidate),
  });
}
