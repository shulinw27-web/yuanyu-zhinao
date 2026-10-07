import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const script = new URL('../../scripts/e2e-normal-flow.mjs', import.meta.url);

test('全流程 E2E 默认拒绝运行，不允许误改共享模型', async () => {
  await assert.rejects(
    run(process.execPath, [fileURLToPath(script)], { env: { ...process.env, E2E_BASE_URL: '' } }),
    error => error.stderr?.includes('E2E_ISOLATED_RUNTIME_REQUIRED')
  );
});

test('全流程 E2E 不再归档已有会话腾出任务容量', async () => {
  const source = await readFile(script, 'utf8');
  assert.doesNotMatch(source, /call\([^\n]*\/archive/);
  assert.match(source, /AGENT_ACTIVE_TASK_LIMIT/);
});
