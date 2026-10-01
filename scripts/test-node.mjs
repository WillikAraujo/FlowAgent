import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
async function discover(path) {
  const entries = await readdir(path, { withFileTypes: true });
  const files = await Promise.all(entries.map(entry => entry.isDirectory() ? discover(`${path}/${entry.name}`) : entry.name.endsWith('.test.mjs') ? [`${path}/${entry.name}`] : []));
  return files.flat();
}
const child = spawn(process.execPath, ['--experimental-strip-types', '--test', ...await discover('tests')], { stdio: 'inherit', windowsHide: true });
child.on('exit', code => { process.exitCode = code ?? 1; });
