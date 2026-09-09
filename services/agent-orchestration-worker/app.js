import { randomUUID } from 'node:crypto';
import { loadRuntimeConfiguration } from '../../backend/src/config/runtime-config.js';
import { configureRuntimeDependencies } from '../../backend/src/config/runtime-dependencies.js';
import { getRole } from '../../backend/src/services/authorization-service.js';
import { runPrivateAgent } from '../../backend/src/services/private-agent-service.js';
import { agentResponseToOrchestrationResult, runAgentOrchestrationWorkerCycle } from '../../backend/src/workers/agent-orchestration-worker.js';

const configuration = loadRuntimeConfiguration();
const runtimeDependencies = await configureRuntimeDependencies(configuration);

const intervalMs = Math.max(5_000, Math.min(Number(process.env.AGENT_ORCHESTRATION_WORKER_INTERVAL_MS) || 30_000, 300_000));
const workerId = String(process.env.AGENT_ORCHESTRATION_WORKER_ID || `agent-orchestration-worker-${randomUUID()}`).slice(0, 120);
let running = false;

const executeStep = async ({ task, step, identityScope }) => {
  const role = getRole(task.roleId);
  if (role.id === 'denied') throw Object.assign(new Error('Scheduled role is no longer available.'), { code: 'AGENT_ORCHESTRATION_ROLE_REVOKED' });
  const modeGuard = step.mode === 'proposal'
    ? '只生成可审核提案，不执行写操作；任何业务动作都必须等待本人确认。'
    : '仅执行只读检索和分析，不发起、批准或完成任何业务动作。';
  const response = await runPrivateAgent(
    { text: `${task.goal}\n\n当前计划步骤：${step.title}。${modeGuard}` },
    role,
    { ...identityScope, sessionId: `scheduled:${task.id}`, deviceId: 'server-orchestration-worker' },
    { platform: 'scheduled_agent_orchestration', requestId: `${task.id}:${task.runCount}:${step.id}` }
  );
  return agentResponseToOrchestrationResult(response);
};

const runOnce = async () => {
  if (running) return { workerId, skipped: true };
  running = true;
  try {
    const result = await runAgentOrchestrationWorkerCycle({ workerId, executeStep });
    process.stdout.write(`${JSON.stringify({ service: 'agent-orchestration-worker', event: 'cycle_completed', ...result })}\n`);
    return result;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ service: 'agent-orchestration-worker', event: 'cycle_failed', workerId, error: String(error?.message || error).slice(0, 300) })}\n`);
    return { workerId, error: error?.message || String(error) };
  } finally {
    running = false;
  }
};

if (process.argv.includes('--once') || process.env.AGENT_ORCHESTRATION_WORKER_ONCE === 'true') {
  const result = await runOnce();
  if (result.error) process.exitCode = 1;
  await runtimeDependencies.close();
} else {
  process.stdout.write(`${JSON.stringify({ service: 'agent-orchestration-worker', event: 'worker_started', workerId, intervalMs })}\n`);
  await runOnce();
  const timer = setInterval(() => { void runOnce(); }, intervalMs);
  const stop = async () => { clearInterval(timer); await runtimeDependencies.close(); process.exit(0); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
