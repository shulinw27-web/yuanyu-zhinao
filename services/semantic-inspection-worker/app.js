import { randomUUID } from 'node:crypto';
import { loadRuntimeConfiguration } from '../../backend/src/config/runtime-config.js';
import { configureRuntimeDependencies } from '../../backend/src/config/runtime-dependencies.js';
import { runInspectionWorkerCycle } from './runtime.js';
export { inspectSemanticReadOnly } from '../../backend/src/services/semantic-read-only-inspection.js';

const runtimeDependencies = await configureRuntimeDependencies(loadRuntimeConfiguration());
const once = process.argv.includes('--once');
const workerId = `semantic-inspection-worker-${randomUUID()}`;
let running = false;
const run = async () => {
  if (running) return { skipped: true };
  running = true;
  try {
    const result = await runInspectionWorkerCycle({ workerId });
    process.stdout.write(`${JSON.stringify({ service: 'semantic-inspection-worker', event: 'cycle_completed', ...result })}\n`);
    return result;
  } finally { running = false; }
};
const logFailure = error => process.stderr.write(`${JSON.stringify({ service: 'semantic-inspection-worker', event: 'cycle_failed', code: error.code || 'SEMANTIC_INSPECTION_FAILED' })}\n`);
if (once) { try { await run(); } catch (error) { logFailure(error); process.exitCode = 1; } finally { await runtimeDependencies.close(); } }
else {
  try {
  await run();
  const intervalMs = Math.max(1000, Number(process.env.SEMANTIC_INSPECTION_INTERVAL_MS) || 30_000);
  const timer = setInterval(() => void run().catch(async error => {
    clearInterval(timer);
    logFailure(error);
    await runtimeDependencies.close(); process.exitCode = 1;
  }), intervalMs);
  const stop = async () => { clearInterval(timer); await runtimeDependencies.close(); process.exit(0); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  } catch (error) { logFailure(error); await runtimeDependencies.close(); process.exitCode = 1; }
}
