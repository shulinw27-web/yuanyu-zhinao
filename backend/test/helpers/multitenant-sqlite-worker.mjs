import { multitenantFixture } from './multitenant-fixture.js';
import { createProductPortalService } from '../../src/services/product-portal-service.js';
import { readState, writeState, mutateState } from '../../src/repositories/runtime-state-repository.js';
import { runWithSemanticTenant } from '../../src/services/semantic-tenant-context.js';
import { getOAMetaModelDraft, saveOAMetaModelDraft } from '../../src/services/meta-model-service.js';
import { getRole } from '../../src/services/authorization-service.js';

if (process.env.NODE_ENV !== 'test' || process.env.RUNTIME_STORE_DRIVER !== 'sqlite' || !process.env.RUNTIME_SQLITE_PATH?.includes('multitenant-sqlite-')) {
  throw new Error('This helper only accepts isolated synthetic SQLite test paths.');
}
const namespace = 'multitenant_portal_test';
const mode = process.argv[2];
if (mode === 'seed') {
  const fixture = multitenantFixture(); const a = fixture.tenant('alice'); const b = fixture.tenant('bob');
  const orders = { alice: fixture.order('alice', a).id, bob: fixture.order('bob', b, { amountCents: 50000 }).id };
  writeState(namespace, 'platform', fixture.state());
  for (const tenantId of ['synthetic-model-a', 'synthetic-model-b']) runWithSemanticTenant({ tenantId }, () => saveOAMetaModelDraft({ policies: [tenantId] }, getRole('executive')));
  console.log(JSON.stringify({ sessions: fixture.sessions, orders, now: fixture.now }));
} else if (mode === 'pay') {
  const { sessions, orders, now, who } = JSON.parse(process.env.MT_SYNTHETIC_INPUT);
  const service = createProductPortalService({ sandboxPayments: true, clock: () => now,
    read: initial => readState(namespace, 'platform', initial),
    mutate: (initial, callback) => mutateState(namespace, 'platform', initial, callback)
  });
  let credited = 0;
  for (let i = 0; i < 10; i++) {
    const result = service.perform(sessions[who].token, sessions[who].csrf, 'order.pay', { orderId: orders[who], method: 'sandbox', confirmed: true });
    if (!result.duplicate) credited++;
  }
  console.log(JSON.stringify({ credited }));
} else if (mode === 'provision') {
  const { sessions, now } = JSON.parse(process.env.MT_SYNTHETIC_INPUT);
  const service = createProductPortalService({ clock: () => now,
    read: initial => readState(namespace, 'platform', initial),
    mutate: (initial, callback) => mutateState(namespace, 'platform', initial, callback)
  });
  for (const who of ['alice', 'bob']) {
    const tenant = service.workspace(sessions[who].token).tenants[0];
    service.perform(sessions.root.token, sessions.root.csrf, 'admin.tenant', { tenantId: tenant.id, expectedVersion: tenant.version, status: 'sandbox_ready' });
    const request = service.perform(sessions[who].token, sessions[who].csrf, 'tenant.provision', { tenantId: tenant.id, expectedVersion: tenant.version + 1, requestId: 'durable-request', confirmed: true });
    await service.inspectProvisioning(request.provisioning.id);
  }
  console.log(JSON.stringify({ checked: 2 }));
} else if (mode === 'provision-inspect') {
  const state = readState(namespace, 'platform');
  console.log(JSON.stringify(state.provisioning.map(job => ({ status: job.status, attempts: job.attempts, runtimeConnected: job.runtimeConnected }))));
} else if (mode === 'inspect') {
  const state = readState(namespace, 'platform');
  const models = ['synthetic-model-a', 'synthetic-model-b'].map(tenantId => runWithSemanticTenant({ tenantId }, () => getOAMetaModelDraft().policies[0]));
  console.log(JSON.stringify({ balances: state.tenants.map(t => t.balanceCents), ledgerCount: state.ledger.length, paid: state.orders.filter(o => o.status === 'paid').length, models }));
} else throw new Error('Unknown synthetic test mode');
