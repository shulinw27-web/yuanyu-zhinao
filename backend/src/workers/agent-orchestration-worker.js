import { claimDueAgentOrchestrations, finalizeAgentOrchestrationRun, recordAgentOrchestrationCheckpoint } from '../services/agent-orchestration-service.js';
import { runWithTenantExecution } from '../services/tenant-execution-context.js';

const successfulDependency = (task, step) => step.dependsOn.every((id) => task.checkpoints[id]?.status === 'succeeded');

export function agentResponseToOrchestrationResult(response) {
  const lifecycleStatus = response?.lifecycle?.state || null;
  const authorizationDecision = response?.authorization?.decision || null;
  const authorized = authorizationDecision === 'ALLOW_BY_POLICY';
  const pendingConfirmation = authorized && lifecycleStatus === 'awaiting_confirmation' && response?.command?.requiresConfirmation && Boolean(response.command.confirmationToken);
  const verified = authorized && lifecycleStatus === 'analysis_completed' && response?.task?.execution?.status === 'completed' && !response?.command;
  return {
    traceId: response?.traceId || null, lifecycleStatus, authorizationDecision,
    outcome: !response?.traceId ? 'failed' : pendingConfirmation ? 'waiting_confirmation' : verified ? 'succeeded' : 'failed'
  };
}

export async function executeClaimedAgentOrchestration({ task, workerId, executeStep, now = () => Date.now() }) {
  const identityScope = { tenantId: task.tenantId, subjectId: task.subjectId };
  let waitingForConfirmation = false;
  let failed = false;
  const remaining = new Map(task.steps.map((step) => [step.id, step]));

  while (remaining.size && !failed && !waitingForConfirmation) {
    const ready = [...remaining.values()].filter((step) => successfulDependency(task, step));
    if (!ready.length) { failed = true; break; }
    for (const step of ready) {
      const started = await recordAgentOrchestrationCheckpoint({ identityScope, orchestrationId: task.id, stepId: step.id, status: 'running', nowAt: now() });
      if (started.error) { failed = true; break; }
      task.checkpoints[step.id] = started.checkpoints[step.id];
      try {
        const result = await runWithTenantExecution({ identity: identityScope, roleId: task.roleId, feature: 'background-agent', permission: 'page.agent.view' }, () => executeStep({ task, step, identityScope }));
        // A returned message is not a completion receipt. Clarification,
        // refusal and partial analyses must stop the dependent DAG steps.
        if (!result?.traceId || !['succeeded', 'waiting_confirmation'].includes(result.outcome) || (step.mode === 'proposal' && result.outcome !== 'waiting_confirmation')) {
          throw Object.assign(new Error('Agent step did not return a verified completion or confirmation.'), { code: 'AGENT_ORCHESTRATION_STEP_UNVERIFIED' });
        }
        const status = result.outcome;
        const checkpoint = await recordAgentOrchestrationCheckpoint({ identityScope, orchestrationId: task.id, stepId: step.id, status, result, nowAt: now() });
        if (checkpoint.error) { failed = true; break; }
        task.checkpoints[step.id] = checkpoint.checkpoints[step.id];
        waitingForConfirmation = status === 'waiting_confirmation';
      } catch (error) {
        const checkpoint = await recordAgentOrchestrationCheckpoint({ identityScope, orchestrationId: task.id, stepId: step.id, status: 'failed', result: { errorCode: error?.code || 'AGENT_ORCHESTRATION_STEP_FAILED' }, nowAt: now() });
        if (!checkpoint.error) task.checkpoints[step.id] = checkpoint.checkpoints[step.id];
        failed = true;
      }
      remaining.delete(step.id);
      if (failed || waitingForConfirmation) break;
    }
  }

  const outcome = failed ? 'failed' : waitingForConfirmation ? 'waiting_confirmation' : 'succeeded';
  return finalizeAgentOrchestrationRun({ identityScope, orchestrationId: task.id, workerId, outcome, nowAt: now() });
}

export async function runAgentOrchestrationWorkerCycle({ workerId, executeStep, now = () => Date.now(), limit = 10, leaseMs = 180_000 } = {}) {
  if (typeof executeStep !== 'function') throw new TypeError('Agent orchestration worker requires a governed step executor.');
  const claimed = await claimDueAgentOrchestrations({ workerId, nowAt: now(), limit, leaseMs });
  const completed = [];
  for (const task of claimed) completed.push(await executeClaimedAgentOrchestration({ task, workerId, executeStep, now }));
  return { workerId, claimed: claimed.length, completed: completed.length, items: completed };
}
