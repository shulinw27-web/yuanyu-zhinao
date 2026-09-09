import { randomUUID } from 'node:crypto';
import { createPostgresAgentLongTaskRepository } from '../../backend/src/repositories/postgres-agent-long-task-repository.js';
import { configureAgentLongTaskRepository, consumeAgentRunTransitions } from '../../backend/src/services/agent-long-task-store.js';
import { createPostgresRuntimeStateRepository } from '../../backend/src/repositories/postgres-runtime-state-repository.js';
import { configureAgentRunRepository } from '../../backend/src/services/agent-run-store.js';

if (String(process.env.AGENT_RUNTIME_TASK_STORE_DRIVER || '').toLowerCase() !== 'postgres') throw new Error('Agent Run transition worker requires AGENT_RUNTIME_TASK_STORE_DRIVER=postgres.');
if (process.env.NODE_ENV === 'production' && process.env.AGENT_RUN_STORE_DRIVER !== 'postgres' && process.env.SINGLE_NODE_DEPLOYMENT !== 'true') throw new Error('Hybrid Agent Run transition consumer is single-node only until Agent Run storage migrates to PostgreSQL.');

const intervalMs = Math.min(Math.max(Number(process.env.AGENT_RUN_TRANSITION_INTERVAL_MS) || 5_000, 500), 60_000);
const workerId = String(process.env.AGENT_RUN_TRANSITION_WORKER_ID || `agent-run-transition-${randomUUID()}`).slice(0, 120);
const repository = await createPostgresAgentLongTaskRepository();
configureAgentLongTaskRepository(repository);
const agentRunRepository = process.env.AGENT_RUN_STORE_DRIVER === 'postgres' ? await createPostgresRuntimeStateRepository() : null;
if (agentRunRepository) configureAgentRunRepository(agentRunRepository);
let running = false;

const runOnce = async () => {
  if (running) return { workerId, skipped: true, reason: 'previous_cycle_running' };
  running = true;
  try {
    const result = await consumeAgentRunTransitions({ workerId });
    process.stdout.write(`${JSON.stringify({ service: 'agent-run-transition-worker', event: 'transition_cycle', workerId, ...result })}\n`);
    return result;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ service: 'agent-run-transition-worker', event: 'transition_cycle_failed', workerId, error: String(error?.message || error).slice(0, 300) })}\n`);
    return { error: error?.message || String(error) };
  } finally { running = false; }
};

if (process.env.AGENT_RUN_TRANSITION_WORKER_ONCE === 'true' || process.argv.includes('--once')) {
  const result = await runOnce();
  if (result.error) process.exitCode = 1;
  await repository.close();
  await agentRunRepository?.close();
} else {
  process.stdout.write(`${JSON.stringify({ service: 'agent-run-transition-worker', event: 'worker_started', workerId, intervalMs })}\n`);
  await runOnce();
  const timer = setInterval(() => { void runOnce(); }, intervalMs);
  const stop = async () => { clearInterval(timer); await repository.close(); await agentRunRepository?.close(); process.exit(0); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
