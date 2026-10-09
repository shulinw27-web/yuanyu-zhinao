const test = require('node:test'); const assert = require('node:assert/strict');
const { restoreSemanticSession } = require('../src/session-bootstrap.js');
test('session is restored before optional role names; role failure cannot block authentication', async () => {
  const calls = []; const result = await restoreSemanticSession({ client: { identitySessionId: 'session', identitySession: async () => { calls.push('session'); return { user: {} }; }, roles: async () => { calls.push('roles'); throw new Error('catalog unavailable'); } }, finishAuthentication: async () => calls.push('device-and-workspace') });
  assert.equal(result.authenticated, true); assert.deepEqual(result.roles, []); assert.deepEqual(calls, ['session', 'device-and-workspace', 'roles']);
});
test('expired identity prompts login, service failure prompts connection retry and never loads roles', async () => {
  for (const status of [401, 500]) {
    let calls = 0; const result = await restoreSemanticSession({ client: { enterpriseSession: async () => { throw Object.assign(new Error('failure'), { status }); }, roles: async () => { calls++; } }, finishAuthentication: async () => { calls++; } });
    assert.equal(result.authenticated, false); assert.equal(calls, 0); assert.equal(status === 401 ? result.message : result.message.includes('后端服务'), status === 401 ? '' : true);
  }
});
test('device registration failure cannot expose an authenticated workbench', async () => {
  const result = await restoreSemanticSession({ client: { enterpriseSession: async () => ({ user: {} }) }, finishAuthentication: async () => { throw Object.assign(new Error('device denied'), { status: 403 }); } });
  assert.equal(result.authenticated, false);
});
