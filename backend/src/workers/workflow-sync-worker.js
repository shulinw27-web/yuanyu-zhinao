import { randomUUID } from 'node:crypto';
import { syncConfiguredWorkflowDefinitions, workflowWebhookOperations } from '../domains/workflow-integration/public-api.js';
import { runWithSemanticTenant } from '../services/semantic-tenant-context.js';
import { runWithIAMStoreContext } from '../services/iam-store.js';

const INTERVAL_MS = Math.max(60_000, Number(process.env.WORKFLOW_SYNC_INTERVAL_MS) || 300_000);
const EVENT_POLL_MS = Math.max(1_000, Number(process.env.WORKFLOW_EVENT_POLL_INTERVAL_MS) || 5_000);
const WORKER_ID = String(process.env.WORKFLOW_SYNC_WORKER_ID || `workflow-sync-${process.pid}-${randomUUID()}`);

export function resolveWorkflowSyncTenantIds(configured = process.env.WORKFLOW_SYNC_TENANT_IDS, production = process.env.NODE_ENV === 'production') {
  if (!configured?.trim()) {
    if (production) throw new Error('WORKFLOW_SYNC_TENANT_IDS_REQUIRED');
    return ['demo-enterprise'];
  }
  const ids = configured.split(',').map(value => value.trim());
  if (ids.some(id => !id || id.length > 120 || /[\u0000-\u001f]/u.test(id)) || new Set(ids).size !== ids.length) throw new Error('WORKFLOW_SYNC_TENANT_IDS_INVALID');
  return ids;
}

export async function runConfiguredWorkflowSyncCycles({ tenantIds = resolveWorkflowSyncTenantIds(), sync = syncConfiguredWorkflowDefinitions, workerId = WORKER_ID } = {}) {
  const results = [];
  for (const tenantId of tenantIds) {
    try {
      const result = await runWithIAMStoreContext(() => runWithSemanticTenant({ tenantId }, () => sync({ actor: { type: 'service', id: workerId } })), tenantId);
      results.push({ tenantId, result });
    } catch (error) {
      results.push({ tenantId, error: error.code || error.message });
    }
  }
  return results;
}

export async function runWorkflowEventInboxCycles({ tenantIds = resolveWorkflowSyncTenantIds(), sync = syncConfiguredWorkflowDefinitions, workerId = WORKER_ID, at = Date.now() } = {}) {
  const results = [];
  for (const tenantId of tenantIds) {
    const result = await runWithIAMStoreContext(() => runWithSemanticTenant({ tenantId }, async () => {
      const claims = workflowWebhookOperations.claim({ workerId, at });
      if (!claims.length) return { status: 'idle', claimed: 0 };
      try {
        const syncResult = await sync({ actor: { type: 'service', id: workerId } });
        const succeeded = !syncResult?.error;
        const receipts = workflowWebhookOperations.complete({ claims, succeeded, errorCode: syncResult?.code, at });
        return { status: succeeded ? 'succeeded' : 'retry_scheduled', claimed: claims.length, receipts, syncRun: syncResult?.syncRun || null, error: syncResult?.code || null };
      } catch (error) {
        const receipts = workflowWebhookOperations.complete({ claims, succeeded: false, errorCode: error.code || 'WORKFLOW_SYNC_FAILED', at });
        return { status: 'retry_scheduled', claimed: claims.length, receipts, error: error.code || 'WORKFLOW_SYNC_FAILED' };
      }
    }), tenantId);
    results.push({ tenantId, result });
  }
  return results;
}

const printResults = results => {
  for (const item of results) {
    if (item.error || item.result?.error) console.error(JSON.stringify({ service: 'workflow-sync-worker', tenantId: item.tenantId, status: 'failed', code: item.error || item.result.code }));
    else console.log(JSON.stringify({ service: 'workflow-sync-worker', tenantId: item.tenantId, status: item.result?.status || 'succeeded', claimed: item.result?.claimed, syncRun: item.result?.syncRun }));
  }
};

if (process.argv.includes('--once')) {
  printResults(await runWorkflowEventInboxCycles());
  printResults(await runConfiguredWorkflowSyncCycles());
} else if (process.env.WORKER_MODE === 'daemon') {
  const tenantIds = resolveWorkflowSyncTenantIds();
  let running = false;
  const tick = async (operation) => {
    if (running) return;
    running = true;
    try { printResults(await operation({ tenantIds })); }
    finally { running = false; }
  };
  await tick(runWorkflowEventInboxCycles);
  await tick(runConfiguredWorkflowSyncCycles);
  setInterval(() => tick(runWorkflowEventInboxCycles).catch(error => console.error(JSON.stringify({ service: 'workflow-sync-worker', status: 'failed', code: error.code || error.message }))), EVENT_POLL_MS);
  setInterval(() => tick(runConfiguredWorkflowSyncCycles).catch(error => console.error(JSON.stringify({ service: 'workflow-sync-worker', status: 'failed', code: error.code || error.message }))), INTERVAL_MS);
}
