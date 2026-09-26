import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const electronPath = require('electron');
const appDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npmCliPath = process.env.npm_execpath;
const npmCommand = npmCliPath ? process.execPath : (process.platform === 'win32' ? 'npm.cmd' : 'npm');
const npmArguments = npmCliPath ? [npmCliPath, 'run', 'dev:web'] : ['run', 'dev:web'];
const rendererUrl = 'http://127.0.0.1:5174';
let renderer = null;
let electron = null;
let stopping = false;

async function rendererReady() {
  try {
    const response = await fetch(rendererUrl);
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForRenderer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (await rendererReady()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`元域智语桌面渲染器未在预期时间内启动：${rendererUrl}`);
}

function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  electron?.kill();
  renderer?.kill();
  setTimeout(() => process.exit(exitCode), 150);
}

process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

try {
  if (!(await rendererReady())) {
    renderer = spawn(npmCommand, npmArguments, {
      cwd: appDirectory,
      stdio: 'inherit',
      windowsHide: true
    });
    renderer.on('exit', (code) => { if (!stopping && code) stop(code); });
  }
  await waitForRenderer();
  electron = spawn(electronPath, ['.'], {
    cwd: appDirectory,
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_RENDERER_URL: rendererUrl }
  });
  electron.on('exit', (code) => stop(code || 0));
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  stop(1);
}
