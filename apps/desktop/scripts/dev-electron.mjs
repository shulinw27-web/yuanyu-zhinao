import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const electronPath = require('electron');
const desktopDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npmCliPath = process.env.npm_execpath;
const npmCommand = npmCliPath ? process.execPath : (process.platform === 'win32' ? 'npm.cmd' : 'npm');
const npmArguments = npmCliPath ? [npmCliPath, 'run', 'dev:web'] : ['run', 'dev:web'];
const rendererUrl = 'http://127.0.0.1:5184';

const vite = spawn(npmCommand, npmArguments, {
  cwd: desktopDirectory,
  stdio: 'inherit',
  windowsHide: true
});
let electron = null;
let stopping = false;

async function waitForRenderer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(rendererUrl);
      if (response.ok) return;
    } catch {
      // Vite 仍在启动。
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`桌面 Web 渲染器未在预期时间内启动：${rendererUrl}`);
}

function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  electron?.kill();
  vite.kill();
  setTimeout(() => process.exit(exitCode), 150);
}

process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
vite.on('exit', (code) => { if (!stopping && code) stop(code); });

try {
  await waitForRenderer();
  electron = spawn(electronPath, ['.'], {
    cwd: desktopDirectory,
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_RENDERER_URL: rendererUrl }
  });
  electron.on('exit', (code) => stop(code || 0));
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  stop(1);
}
