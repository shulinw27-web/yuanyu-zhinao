import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const root = resolve(import.meta.dirname, '..');
if (process.argv.slice(2).some(argument => argument !== '--portable')) throw new Error('Only --portable is supported.');
const portable = process.argv.includes('--portable');
const artifactRoot = join(root, 'output', 'native-smoke');
await mkdir(artifactRoot, { recursive: true });
if (process.platform !== 'win32') throw new Error('This acceptance runner requires Windows packaged executables.');
const variants = [
  { id: 'semantic', path: portable ? 'apps/semantic-operations-console/release/v0.2.0/Yuanyu-Semantic-Ops-Portable-0.2.0-x64.exe' : 'apps/semantic-operations-console/release/v0.2.0/win-unpacked/元域智语 Agent.exe', flag: 'SEMANTIC_OPS_ELECTRON_SMOKE', marker: 'SEMANTIC_OPS_ELECTRON_SMOKE_OK' },
  { id: 'zhinao', path: portable ? 'apps/desktop/release/v0.3.0/YuanyuZhinao-Portable-0.3.0-x64.exe' : 'apps/desktop/release/v0.3.0/win-unpacked/元域智脑.exe', flag: 'ZHINAO_ELECTRON_SMOKE', marker: 'ELECTRON_SMOKE_OK' }
];
for (const variant of variants) {
  const executable = join(root, variant.path); await access(executable);
  const profile = await mkdtemp(join(artifactRoot, `${variant.id}-`));
  const result = await new Promise((done, reject) => {
    const env = { ...process.env, [variant.flag]: '1', YUANYU_ELECTRON_SMOKE_USER_DATA: profile, TEMP: profile, TMP: profile };
    delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
    const child = spawn(executable, [], { cwd: root, windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; let overflow = false; let timedOut = false;
    const capture = chunk => { if (output.length + chunk.length > 65536) { overflow = true; child.kill(); } else output += chunk.toString(); };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 30000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', async code => {
      clearTimeout(timer);
      const line = output.split(/\r?\n/u).find(item => item.startsWith(`${variant.marker} `));
      let report; try { report = line && JSON.parse(line.slice(variant.marker.length + 1)); } catch { /* fail closed */ }
      // Portable launchers do not forward the child application's stdout.
      if (!report && portable && code === 0 && !timedOut && !overflow) {
        const deadline = Date.now() + 30000;
        while (!report && Date.now() < deadline) {
          try { report = JSON.parse(await readFile(join(profile, 'smoke-result.json'), 'utf8')); } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
        }
      }
      done({ id: variant.id, passed: code === 0 && !overflow && !timedOut && report?.mounted === true && report?.authRequired === true && report?.runtime === 'electron' && !report?.loading && !report?.error, exitCode: code, timedOut, overflow, report: report || null, profile });
    });
  });
  console.log(JSON.stringify(result));
  if (!result.passed) { process.exitCode = 1; break; }
}
