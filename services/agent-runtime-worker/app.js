import { randomUUID } from 'node:crypto';
import { runAgentLongTaskMaintenanceCycle } from '../../backend/src/services/agent-long-task-service.js';
import { createPostgresAgentLongTaskRepository } from '../../backend/src/repositories/postgres-agent-long-task-repository.js';

const intervalMs = Math.min(Math.max(Number(process.env.AGENT_RUNTIME_WORKER_INTERVAL_MS) || 5_000, 500), 60_000);
const leaseMs = Math.max(intervalMs * 3, 5_000);
const workerId = String(process.env.AGENT_RUNTIME_WORKER_ID || `agent-runtime-worker-${randomUUID()}`).slice(0, 120);
let cycleRunning = false;
const storeDriver = String(process.env.AGENT_RUNTIME_TASK_STORE_DRIVER || 'sqlite').trim().toLowerCase();
if (!['sqlite', 'postgres'].includes(storeDriver)) throw new Error('AGENT_RUNTIME_TASK_STORE_DRIVER must be sqlite or postgres.');
const repository = storeDriver === 'postgres' ? await createPostgresAgentLongTaskRepository() : null;

const runOnce = async () => {
  if (cycleRunning) return { workerId, skipped: true, reason: 'previous_cycle_running' };
  cycleRunning = true;
  try {
    const result = repository
      ? await repository.runMaintenanceCycle({ workerId, intervalMs, leaseMs })
      : runAgentLongTaskMaintenanceCycle({ workerId, intervalMs, leaseMs });
    process.stdout.write(`${JSON.stringify({ service: 'agent-runtime-worker', event: 'maintenance_cycle', storeDriver, ...result })}\n`);
    return result;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ service: 'agent-runtime-worker', event: 'cycle_failed', workerId, error: String(error?.message || error).slice(0, 300) })}\n`);
    return { workerId, error: error?.message || String(error) };
  } finally {
    cycleRunning = false;
  }
};

if (process.env.AGENT_RUNTIME_WORKER_ONCE === 'true' || process.argv.includes('--once')) {
  const result = await runOnce();
  if (result.error) process.exitCode = 1;
  await repository?.close();
} else {
  process.stdout.write(`${JSON.stringify({ service: 'agent-runtime-worker', event: 'worker_started', workerId, intervalMs, leaseMs, storeDriver })}\n`);
  await runOnce();
  const timer = setInterval(() => { void runOnce(); }, intervalMs);
  const stop = async () => { clearInterval(timer); await repository?.close(); process.exit(0); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
