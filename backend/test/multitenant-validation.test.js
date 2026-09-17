import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { multitenantFixture, isolatedPortal } from './helpers/multitenant-fixture.js';
import { createAgentConversation, getAgentConversation, getAgentConversationContext, listAgentConversations, archiveAgentConversation, recordAgentConversationExchange } from '../src/services/agent-conversation-service.js';
import { rememberAgentLongTermGoal, getAgentLongTermMemory, forgetAgentLongTermMemory } from '../src/services/agent-runtime-store.js';
import { saveLibraryDocument, readLibraryDocument, searchLibraryDocuments, retractLibraryDocument } from '../src/services/knowledge-library-service.js';
import { listDomainEvents } from '../src/domains/events/domain-event-outbox.js';
import { createSemanticOperationsProposal, applySemanticOperationsProposal, listSemanticOperationsSnapshots, rollbackSemanticOperationsSnapshot } from '../src/services/semantic-operations-agent-service.js';
import { getRole } from '../src/services/authorization-service.js';
import { resetRuntimeState } from '../src/repositories/runtime-state-repository.js';

if (process.env.NODE_ENV !== 'test' || process.env.RUNTIME_STORE_DRIVER !== 'memory') {
  throw new Error('Run npm run test:multitenant so runtime reset is restricted to the isolated memory store.');
}

const rejected = (fn, code) => assert.throws(fn, error => error.code === code);
const scope = tenantId => ({ tenantId, subjectId: 'same-user', sessionId: 'same-session', deviceId: 'same-device' });
test.beforeEach(() => resetRuntimeState(['agent_conversations', 'agent_conversation_subjects', 'agent_memories', 'knowledge_library_v1', 'domain_event_outbox', 'semantic_operations_agent_proposals', 'semantic_operations_agent_snapshots', 'oa_meta_model_runtime']));

test('MT-01: two owners cannot quote, pay, cancel, invite or change members in the other tenant', () => {
  const f = multitenantFixture(); const a = f.tenant('alice'); const b = f.tenant('bob');
  const order = f.order('alice', a); const before = f.state();
  for (const [action, body] of [
    ['order.quote', { tenantId: a, kind: 'recharge', amountCents: 100 }],
    ['order.pay', { orderId: order.id, method: 'sandbox', confirmed: true }],
    ['order.cancel', { orderId: order.id }],
    ['tenant.invite', { tenantId: a, email: 'carol@example.test', role: 'member' }],
    ['tenant.member', { tenantId: a, userId: 'alice', role: 'member', status: 'removed', expectedVersion: 1 }]
  ]) rejected(() => f.act('bob', action, body), 'TENANT_NOT_FOUND');
  assert.deepEqual(f.state(), before);
  assert.deepEqual(f.workspace('bob').tenants.map(t => t.id), [b]);
  assert.equal(f.workspace('bob').orders.length, 0);
});

test('MT-02: one user has independent role, wallet and billing visibility in two tenants', () => {
  const f = multitenantFixture(); const a = f.tenant('alice'); const b = f.tenant('bob');
  f.invite('bob', b, 'alice'); f.pay('alice', f.order('alice', a).id); f.pay('bob', f.order('bob', b, { amountCents: 60000 }).id);
  const workspace = f.workspace('alice');
  assert.equal(workspace.tenants.find(t => t.id === a).balanceCents, 20000);
  assert.equal(workspace.tenants.find(t => t.id === b).balanceCents, null);
  assert.equal(workspace.tenants.find(t => t.id === b).role, 'member');
  assert.ok(workspace.orders.every(o => o.tenantId === a));
  assert.ok(workspace.ledger.every(entry => entry.tenantId === a));
  rejected(() => f.order('alice', b), 'TENANT_PERMISSION_DENIED');
});

test('MT-03: identical request IDs from different owners do not alias tenant orders', () => {
  const f = multitenantFixture(); const a = f.tenant('alice'); const b = f.tenant('bob');
  const one = f.order('alice', a, { requestId: 'same-key' }); const two = f.order('bob', b, { requestId: 'same-key' });
  assert.notEqual(one.id, two.id); f.pay('alice', one.id); f.pay('bob', two.id);
  assert.deepEqual(f.state().tenants.map(t => t.balanceCents), [20000, 20000]);
  rejected(() => f.pay('bob', one.id), 'TENANT_NOT_FOUND');
  assert.equal(f.state().ledger.length, 2);
});

test('MT-04: demotion/removal invalidates old payment authority without affecting the other tenant', () => {
  const f = multitenantFixture(); const a = f.tenant('alice'); const b = f.tenant('bob');
  f.invite('alice', a, 'bob', 'admin'); const pending = f.order('bob', a);
  f.act('alice', 'tenant.member', { tenantId: a, userId: 'bob', role: 'member', status: 'active', expectedVersion: 2 });
  rejected(() => f.pay('bob', pending.id), 'TENANT_PERMISSION_DENIED');
  f.act('alice', 'tenant.member', { tenantId: a, userId: 'bob', role: 'member', status: 'removed', expectedVersion: 3 });
  rejected(() => f.pay('bob', pending.id), 'TENANT_NOT_FOUND');
  assert.deepEqual(f.workspace('bob').tenants.map(t => t.id), [b]);
  f.pay('bob', f.order('bob', b).id);
  assert.equal(f.workspace('alice').tenants[0].balanceCents, 0);
});

test('MT-05: revoking an invite issuer prevents acceptance of an already issued token', () => {
  const f = multitenantFixture(); const a = f.tenant('alice'); f.invite('alice', a, 'bob', 'admin');
  const invite = f.act('bob', 'tenant.invite', { tenantId: a, email: 'carol@example.test', role: 'member' });
  f.act('alice', 'tenant.member', { tenantId: a, userId: 'bob', role: 'member', status: 'removed', expectedVersion: 2 });
  rejected(() => f.act('carol', 'invite.accept', { token: invite.invitationToken }), 'INVITE_INVALID');
  assert.equal(f.workspace('carol').tenants.length, 0);
});

test('MT-06: tenant suspension blocks its writes, retains management visibility and leaves another tenant usable', () => {
  const f = multitenantFixture(); const a = f.tenant('alice'); const b = f.tenant('alice', 'second');
  const pending = f.order('alice', a); f.act('root', 'admin.tenant', { tenantId: a, status: 'suspended', expectedVersion: 1 });
  rejected(() => f.pay('alice', pending.id), 'TENANT_SUSPENDED');
  assert.equal(f.workspace('alice').tenants.find(t => t.id === a).status, 'suspended');
  f.pay('alice', f.order('alice', b).id);
  assert.equal(f.workspace('alice').tenants.find(t => t.id === b).balanceCents, 20000);
});

test('MT-07: platform administration does not implicitly grant a tenant wallet membership', () => {
  const f = multitenantFixture(); const a = f.tenant('alice');
  assert.equal(f.service.adminWorkspace(f.sessions.root.token).tenants.length, 1);
  rejected(() => f.order('root', a), 'TENANT_NOT_FOUND');
  assert.equal(f.workspace('root').tenants.length, 0);
});

test('MT-08: HTTP forged tenant/role headers and another session CSRF never grant access', async t => {
  const f = multitenantFixture(); const a = f.tenant('alice'); const b = f.tenant('bob'); const pending = f.order('alice', a);
  const server = await isolatedPortal(f); t.after(server.close);
  const forged = await server.call('bob', 'order/pay', { orderId: pending.id, method: 'sandbox', confirmed: true }, { 'X-Tenant-Id': a, 'X-Role': 'owner' });
  assert.equal(forged.status, 404); assert.equal(forged.body.code, 'TENANT_NOT_FOUND');
  const csrf = await server.call('bob', 'order/create', { tenantId: b, kind: 'recharge', amountCents: 100, requestId: 'csrf-cross' }, { 'X-CSRF-Token': f.sessions.alice.csrf });
  assert.equal(csrf.status, 403); assert.equal(csrf.body.code, 'CSRF_REJECTED');
  const view = await server.call('bob', 'me', undefined, { 'X-Tenant-Id': a });
  assert.deepEqual(view.body.tenants.map(t => t.id), [b]); assert.equal(view.headers['cache-control'], 'no-store');
  assert.equal(f.state().ledger.length, 0);
});

test('MT-09: forty concurrent HTTP payment retries credit two tenants once each', async t => {
  const f = multitenantFixture(); const a = f.tenant('alice'); const b = f.tenant('bob');
  const one = f.order('alice', a); const two = f.order('bob', b, { amountCents: 50000 });
  const server = await isolatedPortal(f); t.after(server.close);
  const results = await Promise.all(Array.from({ length: 40 }, (_, i) => server.call(i % 2 ? 'alice' : 'bob', 'order/pay', { orderId: i % 2 ? one.id : two.id, method: 'sandbox', confirmed: true })));
  assert.ok(results.every(r => r.status === 200)); assert.equal(results.filter(r => !r.body.duplicate).length, 2);
  assert.deepEqual(f.state().tenants.map(t => t.balanceCents), [20000, 50000]); assert.equal(f.state().ledger.length, 2);
});

test('MT-10: concurrent coupon reservation across tenants cannot exceed the global cap', async t => {
  const f = multitenantFixture(); const a = f.tenant('alice'); const b = f.tenant('bob');
  f.act('root', 'admin.coupon', { code: 'ONE_USE', type: 'fixed', value: 1000, minCents: 0, maxUses: 1, startsAt: f.now, expiresAt: f.now + 86400000, planId: null });
  const server = await isolatedPortal(f); t.after(server.close);
  const results = await Promise.all([['alice', a], ['bob', b]].map(([who, tenantId]) => server.call(who, 'order/create', { tenantId, kind: 'subscription', planId: 'professional', couponCode: 'ONE_USE', requestId: 'coupon-race' })));
  assert.equal(results.filter(r => r.status === 200).length, 1);
  assert.equal(f.state().orders.length, 1);
});

test('MT-11: same subject/session/device cannot read, append or archive another tenant conversation', async () => {
  const a = scope('mt-chat-a'); const b = scope('mt-chat-b');
  const conversation = await createAgentConversation({ roleId: 'executive', identityScope: a });
  await recordAgentConversationExchange({ conversationId: conversation.id, identityScope: a, roleId: 'executive', userText: '合成甲公司专属任务', response: { text: '甲公司内部答复', evidence: [] } });
  assert.equal(await getAgentConversation(conversation.id, b), null);
  assert.equal(await getAgentConversationContext(conversation.id, b), null);
  assert.equal((await listAgentConversations(b)).length, 0);
  const before = await getAgentConversation(conversation.id, a);
  await recordAgentConversationExchange({ conversationId: conversation.id, identityScope: b, roleId: 'executive', userText: '越界追加', response: { text: '不应写入' } });
  assert.equal((await archiveAgentConversation(conversation.id, b)).code, 'AGENT_CONVERSATION_NOT_FOUND');
  assert.deepEqual(await getAgentConversation(conversation.id, a), before);
});

test('MT-12: long-term memory remains tenant-local with the same user and role', () => {
  const a = scope('mt-memory-a'); const b = scope('mt-memory-b');
  const first = rememberAgentLongTermGoal({ roleId: 'executive', identityScope: a, goal: '持续跟踪合成甲公司的供应商资质' });
  assert.ok(first.memory); assert.equal(getAgentLongTermMemory('executive', b).length, 0);
  assert.ok(forgetAgentLongTermMemory('executive', b, first.memory.id).error);
  assert.equal(getAgentLongTermMemory('executive', a)[0].id, first.memory.id);
});

test('MT-13: same document ID has independent tenant text, retrieval, revisions, revocation and events', async () => {
  const a = { identityScope: scope('mt-knowledge-a'), roleId: 'executive' }; const b = { identityScope: scope('mt-knowledge-b'), roleId: 'executive' };
  for (const [context, marker] of [[a, '甲'], [b, '乙']]) {
    const result = await saveLibraryDocument({ ...context, id: 'same-document', body: { expectedRevision: 0, title: `${marker}公司供应商制度`, source: '合成制度', sourceVersion: 'v1', kind: 'policy', text: `${marker}公司供应商资质必须每月审核。` } });
    assert.equal(result.revision, 1);
  }
  const reading = await readLibraryDocument({ ...b, id: 'same-document', revision: 1 }); assert.match(reading.text, /乙公司/); assert.doesNotMatch(reading.text, /甲公司/);
  const search = await searchLibraryDocuments({ ...b, query: '供应商' }); assert.ok(search.results.length); assert.doesNotMatch(JSON.stringify(search), /甲公司/);
  await retractLibraryDocument({ ...a, id: 'same-document', expectedRevision: 1 });
  assert.equal((await readLibraryDocument({ ...a, id: 'same-document', revision: 1 })).status, 404);
  assert.match((await readLibraryDocument({ ...b, id: 'same-document', revision: 1 })).text, /乙公司/);
  const events = await listDomainEvents({ tenantId: b.identityScope.tenantId }); assert.equal(events.length, 1); assert.ok(events.every(e => e.tenantId === b.identityScope.tenantId));
});

test('MT-14: semantic proposal and snapshot ownership checks reject another tenant with identical user/device', () => {
  const a = scope('mt-semantic-a'); const b = scope('mt-semantic-b'); const role = getRole('executive');
  const proposal = createSemanticOperationsProposal({ input: '建立供应商和原料批次的语义模型。', identityScope: a });
  assert.equal(applySemanticOperationsProposal({ proposalId: proposal.id, role, identityScope: b }).code, 'SEMANTIC_PROPOSAL_NOT_FOUND');
  const applied = applySemanticOperationsProposal({ proposalId: proposal.id, role, identityScope: a }); assert.ok(applied.snapshot);
  assert.equal(listSemanticOperationsSnapshots({ identityScope: b }).length, 0);
  assert.ok(rollbackSemanticOperationsSnapshot({ snapshotId: applied.snapshot.id, role, identityScope: b }).error);
  assert.equal(listSemanticOperationsSnapshots({ identityScope: a }).length, 1);
});

test('MT-15: four independent SQLite processes preserve exactly-once tenant credits after restart', async () => {
  const output = resolve(fileURLToPath(new URL('../../output/', import.meta.url))); mkdirSync(output, { recursive: true });
  const directory = mkdtempSync(join(output, 'multitenant-sqlite-'));
  const run = (mode, payload = {}) => new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./helpers/multitenant-sqlite-worker.mjs', import.meta.url)), mode], { windowsHide: true,
      env: { ...process.env, NODE_ENV: 'test', RUNTIME_STORE_DRIVER: 'sqlite', RUNTIME_SQLITE_PATH: join(directory, 'synthetic.db'), MT_SYNTHETIC_INPUT: JSON.stringify(payload) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    const timeout = setTimeout(() => child.kill(), 20000);
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('close', code => { clearTimeout(timeout); if (code !== 0) return reject(new Error(`Synthetic SQLite worker failed: ${stderr}`));
      try { resolveResult(JSON.parse(stdout)); } catch (error) { reject(error); }
    });
  });
  const seeded = await run('seed');
  const results = await Promise.all(['alice', 'bob', 'alice', 'bob'].map(who => run('pay', { ...seeded, who })));
  assert.equal(results.reduce((sum, item) => sum + item.credited, 0), 2);
  assert.deepEqual(await run('inspect'), { balances: [20000, 50000], ledgerCount: 2, paid: 2, models: ['synthetic-model-a', 'synthetic-model-b'] });
  assert.deepEqual(await run('provision', seeded), { checked: 2 });
  assert.deepEqual(await run('provision-inspect'), Array.from({ length: 2 }, () => ({ status: 'blocked', attempts: 1, runtimeConnected: false })));
});

test('MT-16: authenticated accounts behind one IP retain independent request budgets', async t => {
  const f = multitenantFixture(); f.tenant('alice'); f.tenant('bob');
  const server = await isolatedPortal(f); t.after(server.close);
  const traffic = await Promise.all(Array.from({ length: 180 }, () => server.call('alice', 'catalog')));
  assert.ok(traffic.every(r => r.status === 200));
  assert.equal((await server.call('alice', 'me')).status, 429);
  assert.equal((await server.call('bob', 'me')).status, 200);
});

test('MT-17: anonymous traffic and spoofed tenant/forwarded-IP headers cannot steal a verified account budget', async t => {
  const f = multitenantFixture(); f.tenant('bob'); const server = await isolatedPortal(f); t.after(server.close);
  const traffic = await Promise.all(Array.from({ length: 180 }, () => server.call(null, 'catalog')));
  assert.ok(traffic.every(r => r.status === 200));
  assert.equal((await server.call(null, 'catalog', undefined, { 'X-Forwarded-For': '192.0.2.1', 'X-Tenant-Id': 'new-tenant' })).status, 429);
  assert.equal((await server.call('bob', 'me')).status, 200);
});

test('MT-18: stale cookies do not block public catalogue loading or authenticate a private workspace', async t => {
  const f = multitenantFixture(); const server = await isolatedPortal(f); t.after(server.close);
  const headers = { Cookie: `yy_portal=${'X'.repeat(43)}` };
  assert.equal((await server.call(null, 'catalog', undefined, headers)).status, 200);
  assert.equal((await server.call(null, 'me', undefined, headers)).status, 401);
});
