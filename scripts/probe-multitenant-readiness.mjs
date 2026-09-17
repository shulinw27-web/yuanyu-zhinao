// Deliberately separate from regression tests: nonzero means a production
// multi-tenant requirement is unmet, not that the current sandbox contract broke.
process.env.NODE_ENV = 'test';
process.env.RUNTIME_STORE_DRIVER = 'memory';
const { resetRuntimeState } = await import('../backend/src/repositories/runtime-state-repository.js');
const { handleGovernanceRoutes } = await import('../backend/src/routes/governance-routes.js');
const { getRole } = await import('../backend/src/services/authorization-service.js');
const { multitenantFixture, isolatedPortal } = await import('../backend/test/helpers/multitenant-fixture.js');

resetRuntimeState(['oa_meta_model_runtime']);
const results = [];
const role = getRole('executive');
async function draftRoute(tenantId, method = 'GET', body = {}) {
  let response;
  const handled = await handleGovernanceRoutes({
    req: { method }, res: {}, url: new URL('http://127.0.0.1/api/meta-models/oa-governance/draft'), role: 'executive',
    agentIdentity: { tenantId, subjectId: 'same-architect' }, selectActionRole: () => role,
    readBody: async () => body, denyButton: () => { throw new Error('Unexpected fixture permission denial'); },
    send: (_res, status, value) => { response = { status, value }; }
  });
  if (!handled || response?.status !== 200) throw new Error('Synthetic draft route did not execute successfully');
  return response.value;
}

const originalB = await draftRoute('synthetic-b');
await draftRoute('synthetic-a', 'POST', { policies: ['SYNTHETIC_A_ONLY_POLICY'] });
const afterA = await draftRoute('synthetic-b');
await draftRoute('synthetic-b', 'POST', { policies: ['SYNTHETIC_B_ONLY_POLICY'] });
const afterB = await draftRoute('synthetic-a');
const isolated = !afterA.policies.includes('SYNTHETIC_A_ONLY_POLICY') && !afterB.policies.includes('SYNTHETIC_B_ONLY_POLICY');
results.push({ id: 'MT-GAP-01', status: isolated ? 'passed' : 'failed', severity: 'P0',
  requirement: 'Authorized tenant A and tenant B must maintain independent semantic drafts',
  layer: 'real route handler + real memory repository; synthetic trusted identity, not a live JWT penetration test',
  evidence: { initialBWasDistinct: !originalB.policies.includes('SYNTHETIC_A_ONLY_POLICY'), aPolicyVisibleToB: afterA.policies.includes('SYNTHETIC_A_ONLY_POLICY'), bPolicyReplacesA: afterB.policies.includes('SYNTHETIC_B_ONLY_POLICY') }
});

const fixture = multitenantFixture(); const a = fixture.tenant('alice'); fixture.tenant('bob');
const server = await isolatedPortal(fixture);
try {
  const before = await server.call('bob', 'me');
  const traffic = await Promise.all(Array.from({ length: 179 }, () => server.call('alice', 'catalog')));
  const after = await server.call('bob', 'me');
  if (before.status !== 200 || !traffic.every(r => r.status === 200)) throw new Error('Rate-limit fixture did not reach the intended boundary');
  results.push({ id: 'MT-GAP-02', status: after.status === 200 ? 'passed' : 'failed', severity: 'P2',
    requirement: 'One tenant behind a shared egress IP must not exhaust another tenant\'s entire normal-request quota',
    layer: 'real loopback HTTP, independent cookie sessions, single server process',
    evidence: { beforeStatus: before.status, aRequests: traffic.length, bNextStatus: after.status, code: after.body.code || null }
  });
} finally { await server.close(); }

fixture.pay('alice', fixture.order('alice', a, { kind: 'subscription', amountCents: undefined, planId: 'professional' }).id);
fixture.act('root', 'admin.tenant', { tenantId: a, status: 'sandbox_ready', expectedVersion: fixture.workspace('alice').tenants.find(t => t.id === a).version });
const tenant = fixture.workspace('alice').tenants.find(t => t.id === a);
results.push({ id: 'MT-GAP-03', status: tenant.runtimeConnected ? 'passed' : 'not_implemented', severity: 'P0',
  requirement: 'A provisioned paid tenant has a verified business/semantic runtime identity and resource binding',
  layer: 'portal service synthetic subscription and administrative sandbox activation',
  evidence: { portalStatus: tenant.status, paidPlan: tenant.plan.id, runtimeConnected: tenant.runtimeConnected },
  note: 'Explicit sandbox release boundary, not a payment bypass or evidence of data leakage.'
});
console.log(JSON.stringify({ syntheticOnly: true, externalModelCalls: 0, testedAt: new Date().toISOString(), results }, null, 2));
process.exitCode = results.every(result => result.status === 'passed') ? 0 : 1;
