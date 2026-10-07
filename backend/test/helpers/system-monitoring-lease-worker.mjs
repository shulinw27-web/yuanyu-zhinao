const [databasePath, tenantId, workerId, nowAt, leaseMs] = process.argv.slice(2);
if (!databasePath || !tenantId || !workerId) throw new Error('LEASE_WORKER_ARGUMENTS_REQUIRED');
process.env.RUNTIME_STORE_DRIVER = 'sqlite';
process.env.RUNTIME_SQLITE_PATH = databasePath;
process.env.NODE_ENV = 'test';

const [{ runWithSemanticTenant }, { runWithIAMStoreContext }, { acquireSystemMonitoringWorkerLease }] = await Promise.all([
  import('../../src/services/semantic-tenant-context.js'),
  import('../../src/services/iam-store.js'),
  import('../../src/services/system-monitoring-service.js')
]);

const result = await runWithIAMStoreContext(
  () => runWithSemanticTenant({ tenantId }, () => acquireSystemMonitoringWorkerLease({ workerId, nowAt: Number(nowAt), leaseMs: Number(leaseMs) })),
  tenantId
);
process.stdout.write(`${JSON.stringify(result)}\n`);
