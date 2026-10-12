import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
const require = createRequire(import.meta.url);
const temporary = mkdtempSync(join(tmpdir(), 'novel-workshop-smoke-'));
const output = resolve(process.env.NOVEL_SMOKE_OUTPUT || 'artifacts');
mkdirSync(output, { recursive: true });
const env = { ...process.env, NOVEL_SMOKE: '1', NOVEL_TEST_USER_DATA: temporary, NOVEL_SMOKE_OUTPUT: output };
if (process.argv.includes('--agent')) env.NOVEL_SMOKE_FOCUS = 'agent';
if (process.argv.includes('--workflow')) env.NOVEL_SMOKE_FOCUS = 'workflow';
if (process.argv.includes('--evolution')) env.NOVEL_SMOKE_FOCUS = 'evolution';
if (process.argv.includes('--interaction')) env.NOVEL_SMOKE_FOCUS = 'interaction';
if (process.argv.includes('--companion')) env.NOVEL_SMOKE_FOCUS = 'companion';
if (process.argv.includes('--style')) env.NOVEL_SMOKE_FOCUS = 'style';
delete env.ELECTRON_RUN_AS_NODE; delete env.NOVEL_DEV_URL;
async function launch(extra = {}) {
  const child = spawn(require('electron'), ['.'], { stdio: 'inherit', env: { ...env, ...extra } });
  return await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', code => resolve(code ?? 1)); });
}
try {
  let exitCode = await launch();
  if (exitCode === 0) exitCode = await launch({ NOVEL_SMOKE_REOPEN: '1' });
  process.exitCode = exitCode;
} finally {
  if (dirname(temporary) === tmpdir() && basename(temporary).startsWith('novel-workshop-smoke-')) rmSync(temporary, { recursive: true, force: true });
}
