import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { defaultSettings, isAdeSettings, type AdeSettings, type ProviderAvailability } from '../shared/settings.ts';
import { findCodex } from './adapters/codex/codex-provider-adapter.ts';
import { findOpenCode } from './adapters/opencode/opencode-provider-adapter.ts';

export class SettingsService {
  private queue = Promise.resolve();
  private readonly path: string;
  constructor(path: string) { this.path = path; }
  async load(): Promise<AdeSettings> {
    try {
      const data: unknown = JSON.parse(await readFile(this.path, 'utf8'));
      if (!isAdeSettings(data)) throw new Error('Configurações inválidas. Restaure um backup do arquivo de preferências.');
      return data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaultSettings();
      throw error;
    }
  }
  async save(value: AdeSettings): Promise<AdeSettings> {
    if (!isAdeSettings(value)) throw new Error('Configurações inválidas.');
    const snapshot = JSON.stringify(value, null, 2);
    const commit = this.queue.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      await writeFile(`${this.path}.tmp`, snapshot, { mode: 0o600 });
      await rename(`${this.path}.tmp`, this.path);
    });
    this.queue = commit.catch(() => undefined);
    await commit;
    return JSON.parse(snapshot) as AdeSettings;
  }
}

export async function inspectProviders(): Promise<ProviderAvailability[]> {
  return Promise.all((['codex', 'opencode'] as const).map(async providerId => {
    const base = { providerId, name: providerId === 'codex' ? 'Codex CLI' : 'OpenCode ACP', authentication: 'unknown' as const,
      roles: providerId === 'codex' ? ['developer', 'reviewer'] : ['maestro', 'planner', 'developer', 'reviewer', 'tester'] };
    let executable: string;
    try { executable = await (providerId === 'codex' ? findCodex() : findOpenCode()); }
    catch { return { ...base, status: 'unavailable' as const, executable: null, version: null, detail: 'Executável não encontrado em um caminho seguro do PATH.' }; }
    try {
      const version = await new Promise<string>((resolve, reject) => execFile(executable, ['--version'], { timeout: 5000, maxBuffer: 4096, windowsHide: true, shell: false }, (error, stdout) => error ? reject(error) : resolve(stdout.trim().slice(0, 120))));
      return { ...base, status: 'available' as const, executable, version, detail: 'Executável verificado. Autenticação será validada ao iniciar uma execução.' };
    } catch { return { ...base, status: 'error' as const, executable, version: null, detail: 'Não foi possível consultar a versão. Verifique a instalação e tente novamente.' }; }
  }));
}
