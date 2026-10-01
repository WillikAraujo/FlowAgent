import { execFile } from 'node:child_process';
import { realpath, readFile, stat } from 'node:fs/promises';
import { resolve, relative, isAbsolute, dirname } from 'node:path';

function git(root: string, args: string[]): Promise<string> {
  return new Promise((done, fail) => execFile('git', ['-C', root, ...args], { timeout: 5000, maxBuffer: 256 * 1024, windowsHide: true, shell: false }, (error, output) => error ? fail(new Error('Não foi possível consultar o Git desta worktree.')) : done(output)));
}
export async function listWorktreeArtifacts(root: string): Promise<{ path: string; status: string }[]> {
  const raw = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const records = raw.split('\0');
  const result: { path: string; status: string }[] = [];
  for (let index = 0; index < records.length && result.length < 200; index++) {
    const entry = records[index];
    if (!entry) continue;
    result.push({ path: entry.slice(3), status: entry.slice(0, 2) });
    if (/[RC]/.test(entry.slice(0, 2))) index++;
  }
  return result;
}
export async function readWorktreeArtifact(root: string, path: string): Promise<{ path: string; content: string; kind: 'diff' | 'file' }> {
  const actualRoot = await realpath(root);
  const target = resolve(actualRoot, path);
  const rel = relative(actualRoot, target);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('O arquivo deve pertencer à worktree selecionada.');
  let actual = target;
  try { actual = await realpath(target); }
  catch { actual = resolve(await realpath(dirname(target)), target.slice(dirname(target).length + 1)); }
  const actualRel = relative(actualRoot, actual);
  if (actualRel.startsWith('..') || isAbsolute(actualRel)) throw new Error('O arquivo está fora da worktree.');
  const tracked = await git(actualRoot, ['ls-files', '--', rel]);
  if (tracked.trim()) {
    const content = await git(actualRoot, ['diff', '--no-ext-diff', '--no-textconv', 'HEAD', '--', rel]);
    if (content) return { path, content, kind: 'diff' };
  }
  const metadata = await stat(actual);
  if (!metadata.isFile() || metadata.size > 64 * 1024) throw new Error('Prévia disponível apenas para arquivos de texto de até 64 KB.');
  const content = await readFile(actual, 'utf8');
  if (content.includes('\0')) throw new Error('Arquivo binário sem prévia de texto.');
  return { path, content, kind: 'file' };
}
