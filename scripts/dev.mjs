import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
const require = createRequire(import.meta.url);
const children = new Set();
let closing = false;
function run(file, args, env = {}) {
  const child = spawn(process.execPath, [file, ...args], { stdio: 'inherit', env: { ...process.env, ...env } });
  children.add(child);
  child.on('exit', (code) => { children.delete(child); if (code && !closing) stop(code); });
  return child;
}
function stop(code = 0) { if (closing) return; closing = true; for (const child of children) child.kill(); process.exitCode = code; }
process.on('SIGINT', () => stop()); process.on('SIGTERM', () => stop());
const initial = run('node_modules/typescript/bin/tsc', ['-p', 'tsconfig.electron.json']);
await new Promise((resolve, reject) => initial.on('exit', code => code === 0 ? resolve() : reject(new Error('主进程编译失败'))));
run('node_modules/typescript/bin/tsc', ['-p', 'tsconfig.electron.json', '--watch', '--preserveWatchOutput']);
run('node_modules/vite/bin/vite.js', ['--host', '127.0.0.1', '--port', '5173', '--strictPort']);
let ready = false;
for (let i = 0; i < 100 && !closing; i++) { try { ready = (await fetch('http://127.0.0.1:5173')).ok; } catch {} if (ready) break; await delay(200); }
if (!ready) { stop(1); throw new Error('开发界面启动失败'); }
const electronPath = require('electron');
const electronEnv = { ...process.env, NOVEL_DEV_URL: 'http://127.0.0.1:5173' };
delete electronEnv.ELECTRON_RUN_AS_NODE;
const app = spawn(electronPath, ['.'], { stdio: 'inherit', env: electronEnv });
children.add(app); app.on('exit', code => { children.delete(app); stop(code ?? 0); });
