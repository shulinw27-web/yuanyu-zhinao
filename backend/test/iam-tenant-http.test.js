import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';

test('isolated HTTP simulation tasks preserve command, tenant, consent and single-use boundaries', { timeout: 20000 }, async () => {
  const probe = createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const child = fork('backend/test/helpers/tenant-iam-http-worker.mjs', [], {
    execArgv: [], windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, NODE_ENV: 'test', NODE_TEST_CONTEXT: 'child-v8', RUNTIME_STORE_DRIVER: 'memory', IAM_STORE_DRIVER: 'runtime', IDENTITY_SESSION_STORE_DRIVER: 'runtime',
      IDENTITY_PROVIDERS_FILE: '', DEMO_ALLOW_ROLE_HEADER: 'false', API_HOST: '127.0.0.1', PORT: String(port) }
  });
  let childLog = ''; child.stdout.on('data', data => { childLog += data; }); child.stderr.on('data', data => { childLog += data; });
  const closed = once(child, 'close');
  try {
    const [{ sessions }] = await Promise.race([once(child, 'message'), closed.then(() => { throw new Error(`Synthetic API failed: ${childLog}`); })]);
    const base = `http://127.0.0.1:${port}`; let ready = false;
    for (let i = 0; i < 50; i++) {
      try { if ((await fetch(`${base}/api/health/live`)).ok) { ready = true; break; } } catch { /* Isolated listener startup only. */ }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(ready, true);
    const models = async (tenant, path = '', body) => {
      const response = await fetch(`${base}/api/semantic-operations/models${path}`, { method: body === undefined ? 'GET' : 'POST',
        headers: { 'x-identity-session': sessions[tenant], 'x-client-device-id': 'test-device', 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json() };
    };
    const ids = {};
    for (const tenant of ['http-a', 'http-b']) {
      assert.equal((await models(tenant, '', { id: 'supply-chain', label: '合成模拟', expectedRevision: 0 })).status, 201);
      const fp = (await models(tenant, '/supply-chain/draft')).body.draft.fingerprint;
      const body = { confirmed: true, kind: 'simulate_model', requestId: 'a11ce000-0000-4000-8000-000000000006', expectedDraftFingerprint: fp };
      const simulation = await models(tenant, '/supply-chain/local-simulation-tasks', body);
      assert.equal(simulation.status, 201, JSON.stringify(simulation.body)); assert.equal(simulation.body.task.localSimulationTask, true); ids[tenant] = simulation.body.taskId;
      const path = `/supply-chain/tasks/${simulation.body.taskId}`;
      assert.equal((await models(tenant, '/supply-chain/local-simulation-tasks', body)).body.taskId, simulation.body.taskId);
      assert.equal((await models(tenant, `${path}/local-confirm`, { confirmed: true, expectedTaskFingerprint: simulation.body.taskFingerprint })).body.code, 'MODEL_TASK_EXECUTION_COMMAND_UNSUPPORTED');
      assert.equal((await models(tenant, '/supply-chain/local-simulation-tasks', { ...body, kind: 'publish_model' })).status, 400);
      assert.equal((await models(tenant, '/supply-chain/local-simulation-tasks?executionKind=adopt', body)).status, 400);
      assert.equal((await models(tenant, `${path}/simulation-confirm`)).status, 400);
      assert.equal((await models(tenant, `${path}/simulation-evidence-recover`, { confirmed: true, executionKind: 'adopt' })).status, 400);
      const confirmation = await models(tenant, `${path}/simulation-confirm`, { confirmed: true, expectedTaskFingerprint: simulation.body.taskFingerprint });
      assert.equal(confirmation.status, 200, JSON.stringify(confirmation.body));
      const executeBody = { confirmed: true, expectedTaskFingerprint: confirmation.body.taskFingerprint, confirmationToken: confirmation.body.confirmationToken };
      const simulated = await models(tenant, `${path}/simulation-execute`, executeBody);
      assert.equal(simulated.status, 200, JSON.stringify(simulated.body)); assert.equal(simulated.body.simulation.sourceMode, 'synthetic'); assert.equal(simulated.body.simulation.verifiesLiveSystems, false);
      assert.equal((await models(tenant, `${path}/simulation-execute`, executeBody)).status, 409);
      assert.equal((await models(tenant, `${path}/dialogue`)).body.task.simulation.sourceFingerprint, fp);
    }
    assert.notEqual(ids['http-a'], ids['http-b']);
    assert.equal((await models('http-a', `/supply-chain/tasks/${ids['http-b']}/dialogue`)).status, 404);
    assert.equal((await models('http-a', `/supply-chain/tasks/${ids['http-b']}/simulation-confirm`, { confirmed: true, expectedTaskFingerprint: 'a'.repeat(24) })).status, 403);
  } finally { child.kill(); await closed; }
});

test('real HTTP auth → tenant IAM → permissions stays isolated; only changed tenant session is revoked', { timeout: 20000 }, async () => {
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const child = fork('backend/test/helpers/tenant-iam-http-worker.mjs', [], {
    execArgv: [], windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, NODE_ENV: 'test', NODE_TEST_CONTEXT: 'child-v8', RUNTIME_STORE_DRIVER: 'memory', IAM_STORE_DRIVER: 'runtime', IDENTITY_SESSION_STORE_DRIVER: 'runtime',
      IDENTITY_PROVIDERS_FILE: '', DEMO_ALLOW_ROLE_HEADER: 'false', API_HOST: '127.0.0.1', PORT: String(port) }
  });
  // Capture child failures without exposing fixture session tokens in test output.
  let childLog = '';
  child.stdout.on('data', data => { childLog += data; }); child.stderr.on('data', data => { childLog += data; });
  const closed = once(child, 'close');
  try {
    const [{ sessions }] = await Promise.race([once(child, 'message'), closed.then(() => { throw new Error(`Synthetic API failed: ${childLog}`); })]);
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 50; i++) {
      try { if ((await fetch(`${base}/api/health/live`)).ok) break; } catch { /* Wait for test-only listener. */ }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const call = async (tenant, extra = {}) => {
      const response = await fetch(`${base}/api/permission-management`, { headers: { 'x-identity-session': sessions[tenant], 'x-client-device-id': 'test-device', ...extra } });
      return { status: response.status, body: await response.json() };
    };
    const [a, b] = await Promise.all([call('http-a', { 'x-tenant-id': 'http-b', 'x-demo-role': 'executive' }), call('http-b')]);
    assert.equal(a.status, 200); assert.equal(b.status, 200);
    assert.match(JSON.stringify(a.body), /http-a/); assert.doesNotMatch(JSON.stringify(a.body), /http-b/);
    assert.match(JSON.stringify(b.body), /http-b/); assert.doesNotMatch(JSON.stringify(b.body), /http-a/);
    assert.equal((await fetch(`${base}/api/permission-management`, { headers: { 'x-tenant-id': 'http-a', 'x-demo-role': 'executive' } })).status, 401);
    const models = async (tenant, path = '', body, extra = {}) => {
      const response = await fetch(`${base}/api/semantic-operations/models${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'x-identity-session': sessions[tenant], 'x-client-device-id': 'test-device', 'content-type': 'application/json', ...extra },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
      return { status: response.status, body: await response.json() };
    };
    const localTaskIds = {};
    for (const tenant of ['http-a', 'http-b']) {
      const initial = await models(tenant);
      assert.equal(initial.status, 200); assert.equal(initial.body.revision, 0);
      assert.equal(initial.body.runtimeSelectionEnabled, false);
      const registered = await models(tenant, '', { id: 'supply-chain', label: `${tenant}合成供应链`, expectedRevision: 0 }, { 'x-tenant-id': tenant === 'http-a' ? 'http-b' : 'http-a' });
      assert.equal(registered.status, 201); assert.equal(registered.body.revision, 1);
      assert.equal(registered.body.model.runtimeBinding, 'not_bound');
      const stale = await models(tenant, '', { id: 'another-model', label: '过期注册请求', expectedRevision: 0 });
      assert.equal(stale.status, 409); assert.equal(stale.body.code, 'MODEL_REGISTRY_REVISION_CONFLICT');
      const duplicate = await models(tenant, '', { id: 'supply-chain', label: '重复模型请求', expectedRevision: 1 });
      assert.equal(duplicate.status, 409); assert.equal(duplicate.body.code, 'MODEL_REGISTRY_DUPLICATE');
      assert.equal((await models(tenant, '', { id: 'forged-model', label: '伪造租户', expectedRevision: 1, tenantId: 'http-foreign' })).status, 400);
      const workspace = await models(tenant, '/supply-chain/workspace');
      assert.equal(workspace.status, 200);
      assert.equal(workspace.body.modelId, 'supply-chain');
      assert.equal(workspace.body.selectionScope, 'request_only');
      assert.equal(workspace.body.runtimeReadEnabled, false);
      assert.deepEqual(workspace.body.availableOperations, ['inspect_workspace']);
      assert.equal((await models(tenant, '/unregistered-model/workspace')).status, 404);
      assert.equal((await models(tenant, '?modelId=supply-chain')).status, 400);
      assert.equal((await models(tenant, '/supply-chain/workspace?tenantId=http-foreign')).status, 400);
      const listed = await models(tenant);
      assert.equal(listed.body.revision, 1); assert.equal(listed.body.models.length, 2);
      assert.equal(listed.body.models[1].label, `${tenant}合成供应链`);
      const draft = await models(tenant, '/supply-chain/draft');
      assert.equal(draft.status, 200);
      const saveBody = { confirmed: true, expectedFingerprint: draft.body.draft.fingerprint, input: { policies: [`${tenant}独立合成规则`, '人工审核后处理', '操作需重新授权'] } };
      const saved = await models(tenant, '/supply-chain/draft', saveBody, { 'x-tenant-id': 'http-foreign' });
      assert.equal(saved.status, 200); assert.equal(saved.body.modelId, 'supply-chain'); assert.ok(saved.body.snapshot);
      assert.equal((await models(tenant, '/supply-chain/draft', saveBody)).status, 409);
      assert.equal((await models(tenant, '/supply-chain/draft', { ...saveBody, confirmed: false })).status, 400);
      assert.equal((await models(tenant, '/supply-chain/draft?modelId=foreign')).status, 400);
      assert.equal((await models(tenant, '/supply-chain/draft')).body.draft.policies[0], `${tenant}独立合成规则`);
      const analysisBody = { confirmed: true, expectedFingerprint: saved.body.draft.fingerprint };
      const validation = await models(tenant, '/supply-chain/validate', analysisBody);
      assert.equal(validation.status, 200); assert.equal(validation.body.validation.status, 'passed');
      const simulated = await models(tenant, '/supply-chain/simulate', analysisBody);
      assert.equal(simulated.status, 200); assert.equal(simulated.body.simulation.sourceMode, 'synthetic');
      assert.equal(simulated.body.simulation.verifiesLiveSystems, false);
      assert.equal((await models(tenant, '/supply-chain/simulation')).body.simulation.sourceFingerprint, analysisBody.expectedFingerprint);
      assert.equal((await models(tenant, '/supply-chain/validate')).status, 400);
      assert.equal((await models(tenant, '/supply-chain/simulation', analysisBody)).status, 400);
      assert.equal((await models(tenant, '/supply-chain/simulate', { ...analysisBody, expectedFingerprint: draft.body.draft.fingerprint })).status, 409);
    }
    assert.equal((await models('http-a', '/supply-chain/draft')).body.draft.policies[0], 'http-a独立合成规则');
    const seeded = once(child, 'message'); child.send('seed-scoped-tasks'); await seeded;
    for (const tenant of ['http-a', 'http-b']) {
      const list = await models(tenant, '/supply-chain/tasks?limit=1&offset=0&includeArchived=false', undefined, { 'x-tenant-id': tenant === 'http-a' ? 'http-b' : 'http-a' });
      const statusPath = '/supply-chain/preview-requests/12345678-1234-4123-8123-123456789abc';
      const requestStatus = await models(tenant, statusPath, undefined, { 'x-tenant-id': tenant === 'http-a' ? 'http-b' : 'http-a' });
      assert.equal(requestStatus.status, 200); assert.equal(requestStatus.body.state, 'reserved');
      assert.equal(requestStatus.body.inputFingerprint, (tenant === 'http-a' ? 'a' : 'b').repeat(64));
      assert.equal(requestStatus.body.automaticTakeoverAllowed, false); assert.equal(requestStatus.body.contentReturned, false);
      assert.equal((await models(tenant, statusPath, { confirmed: true })).status, 400);
      assert.equal((await models(tenant, `${statusPath}?tenantId=foreign`)).status, 400);
      assert.equal((await models(tenant, '/supply-chain/preview-requests/not-a-uuid')).status, 400);
      assert.equal((await models(tenant, '/supply-chain/preview-requests/22345678-1234-4123-8123-123456789abc')).status, 404);
      assert.equal(list.status, 200); assert.equal(list.body.contentScope, 'task_metadata_only'); assert.equal(list.body.tasks.length, 1);
      assert.equal(list.body.tasks[0].status, tenant === 'http-a' ? 'completed' : 'waiting_confirmation');
      assert.doesNotMatch(JSON.stringify(list.body), /PRIVATE-SYNTHETIC/u);
      assert.equal((await models(tenant, '/supply-chain/tasks/http-task')).body.task.status, list.body.tasks[0].status);
      const dialogue = await models(tenant, '/supply-chain/tasks/http-task/dialogue');
      assert.equal(dialogue.status, 200); assert.equal(dialogue.body.contentScope, 'owner_dialogue_only'); assert.equal(dialogue.body.executionEnabled, false);
      assert.equal(dialogue.body.task.messages[0].content, 'PRIVATE-SYNTHETIC-TEXT'); assert.equal(dialogue.body.task.sourceDiscovery, undefined);
      assert.equal((await models(tenant, '/supply-chain/tasks/http-task/dialogue?modelId=foreign')).status, 400);
      assert.equal((await models(tenant, '/supply-chain/tasks/http-task/dialogue', { text: '写入' })).status, 400);
      assert.equal((await models(tenant, '/oa-governance/tasks/http-task/dialogue')).status, 404);
      assert.equal((await models(tenant, '/oa-governance/tasks/http-task')).status, 404);
      assert.equal((await models(tenant, '/supply-chain/tasks?limit=101')).status, 400);
      assert.equal((await models(tenant, '/supply-chain/tasks?limit=1&limit=2')).status, 400);
      assert.equal((await models(tenant, '/supply-chain/tasks?tenantId=foreign')).status, 400);
      assert.equal((await models(tenant, '/supply-chain/tasks/http-task?limit=1')).status, 400);
      assert.equal((await models(tenant, '/supply-chain/tasks', { text: '不允许创建' })).status, 400);
      const localBody = { confirmed: true, kind: 'validate_model', requestId: 'a11ce000-0000-4000-8000-000000000003', expectedDraftFingerprint: (await models(tenant, '/supply-chain/draft')).body.draft.fingerprint };
      const created = await models(tenant, '/supply-chain/local-validation-tasks', localBody);
      assert.equal(created.status, 201); localTaskIds[tenant] = created.body.taskId; assert.equal(created.body.evidenceState, 'ready');
      const reused = await models(tenant, '/supply-chain/local-validation-tasks', localBody);
      assert.equal(reused.status, 200); assert.equal(reused.body.taskId, created.body.taskId);
      const path = `/supply-chain/tasks/${created.body.taskId}`;
      const confirmed = await models(tenant, `${path}/local-confirm`, { confirmed: true, expectedTaskFingerprint: created.body.taskFingerprint });
      assert.equal((await models(tenant, `${path}/adoption-confirm`, { confirmed: true, expectedTaskFingerprint: created.body.taskFingerprint })).body.code, 'MODEL_TASK_EXECUTION_COMMAND_UNSUPPORTED');
      assert.equal((await models(tenant, `${path}/adoption-confirmation-evidence-recover`, { confirmed: true })).body.code, 'MODEL_TASK_EXECUTION_COMMAND_UNSUPPORTED');
      assert.equal(confirmed.status, 200); assert.equal(confirmed.body.confirmationEvidenceState, 'ready');
      assert.equal((await models(tenant, `${path}/dialogue`)).body.taskFingerprint, confirmed.body.taskFingerprint);
      const execution = await models(tenant, `${path}/local-execute`, { confirmed: true, expectedTaskFingerprint: confirmed.body.taskFingerprint, confirmationToken: confirmed.body.confirmationToken });
      assert.equal(execution.status, 200); assert.equal(execution.body.validation.status, 'passed');
      assert.equal((await models(tenant, '/supply-chain/local-validation-tasks')).status, 400);
      assert.equal((await models(tenant, `${path}/local-confirm`)).status, 400);
      assert.equal((await models(tenant, '/supply-chain/tasks/http-task/local-confirm', { confirmed: true, expectedTaskFingerprint: '0'.repeat(24) })).body.code, 'MODEL_TASK_EXECUTION_COMMAND_UNSUPPORTED');
      assert.equal((await models(tenant, '/supply-chain/tasks/http-task/confirmation-evidence-recover', { confirmed: true })).body.code, 'MODEL_TASK_EXECUTION_COMMAND_UNSUPPORTED');
      assert.equal((await models(tenant, '/supply-chain/local-validation-tasks?tenantId=foreign', localBody)).status, 400);
      assert.equal((await models(tenant, '/supply-chain/local-validation-tasks', { ...localBody, kind: 'publish_model' })).status, 400);
    }
    assert.notEqual(localTaskIds['http-a'], localTaskIds['http-b']);
    assert.equal((await models('http-a', `/supply-chain/tasks/${localTaskIds['http-b']}/dialogue`)).status, 404);
    const previewSeed = once(child, 'message'); child.send('seed-preview-tasks'); const [seedResult] = await previewSeed;
    for (const tenant of ['http-a', 'http-b']) {
      const fixture = seedResult.previews[tenant]; const path = `/supply-chain/tasks/${fixture.taskId}/preview-evidence-recover`;
      const receipt = await models(tenant, path, { confirmed: true, expectedTaskFingerprint: fixture.fingerprint });
      assert.equal(receipt.status, 200); assert.equal(receipt.body.evidenceState, 'ready'); assert.equal(receipt.body.confirmationTokenReturned, false);
      assert.equal(receipt.body.executionEnabled, false);
      assert.equal((await models(tenant, path)).status, 400);
      assert.equal((await models(tenant, `${path}?modelId=foreign`, { confirmed: true, expectedTaskFingerprint: fixture.fingerprint })).status, 400);
      assert.equal((await models(tenant, path, { confirmed: false, expectedTaskFingerprint: fixture.fingerprint })).status, 400);
      assert.equal((await models(tenant, path, { confirmed: true, expectedTaskFingerprint: '0'.repeat(24) })).status, 409);
      const other = seedResult.previews[tenant === 'http-a' ? 'http-b' : 'http-a'];
      assert.equal((await models(tenant, `/supply-chain/tasks/${other.taskId}/preview-evidence-recover`, { confirmed: true, expectedTaskFingerprint: other.fingerprint })).status, 409);
      const previewPath = '/supply-chain/structured-preview-tasks';
      const inspectPath = '/supply-chain/source-materials/inspect'; const bindPath = '/supply-chain/source-materials/bind';
      const sourceInspection = await models(tenant, inspectPath, { systemCodes: ['WMS'] });
      assert.equal(sourceInspection.status, 200); assert.equal(sourceInspection.body.documentCount, 1);
      assert.doesNotMatch(JSON.stringify(sourceInspection.body), /documents|StockRecord|properties|text|confirmedBy/);
      const bindingBody = { confirmed: true, systemCodes: ['WMS'], expectedRevision: sourceInspection.body.revision, expectedSourceFingerprint: sourceInspection.body.sourceFingerprint };
      const bound = await models(tenant, bindPath, bindingBody);
      assert.equal(bound.status, 200); assert.equal(bound.body.revision, sourceInspection.body.revision + 1);
      assert.equal((await models(tenant, bindPath, bindingBody)).body.code, 'MODEL_SOURCE_REVISION_CONFLICT');
      assert.equal((await models(tenant, inspectPath)).status, 400);
      assert.equal((await models(tenant, `${bindPath}?tenantId=foreign`, bindingBody)).status, 400);
      assert.equal((await models(tenant, bindPath, { ...bindingBody, endpoint: 'http://127.0.0.1:1' })).body.code, 'MODEL_SOURCE_INPUT_INVALID');
      assert.equal((await models(tenant, inspectPath, { systemCodes: ['UNKNOWN'] })).body.code, 'MODEL_SOURCE_FORBIDDEN');
      const previewBody = { confirmed: true, requestId: '32345678-1234-4123-8123-123456789abc', text: '根据WMS接口建立库存语义模型', systemCodes: ['WMS'], expectedDraftFingerprint: (await models(tenant, '/supply-chain/draft')).body.draft.fingerprint };
      const createdPreview = await models(tenant, previewPath, previewBody);
      assert.equal(createdPreview.status, 201); assert.equal(createdPreview.body.evidenceState, 'ready'); assert.equal(createdPreview.body.executionEnabled, false);
      const duplicatePreview = await models(tenant, previewPath, previewBody);
      assert.equal(duplicatePreview.status, 200); assert.equal(duplicatePreview.body.task.id, createdPreview.body.task.id); assert.equal(duplicatePreview.body.reused, true);
      assert.equal((await models(tenant, previewPath)).status, 400);
      assert.equal((await models(tenant, `${previewPath}?tenantId=foreign`, previewBody)).status, 400);
      assert.equal((await models(tenant, previewPath, { ...previewBody, provider: 'foreign' })).status, 400);
      assert.equal((await models(tenant, previewPath, { ...previewBody, attachments: {} })).status, 400);
      assert.equal((await models(tenant, previewPath, { ...previewBody, text: '根据WMS接口建立其他语义模型' })).body.code, 'MODEL_PREVIEW_REQUEST_CONFLICT');
      assert.equal((await models(tenant, previewPath, { ...previewBody, systemCodes: ['OA'] })).body.code, 'MODEL_PREVIEW_SOURCE_UNAVAILABLE');
    }
    const preparedSeed = once(child, 'message'); child.send('seed-prepared-previews'); const [preparedResult] = await preparedSeed;
    for (const tenant of ['http-a', 'http-b']) {
      const { requestId, ...fingerprints } = preparedResult.prepared[tenant]; const body = { confirmed: true, ...fingerprints };
      const path = `/supply-chain/preview-requests/${requestId}`;
      assert.equal((await models(tenant, `${path}/inspect-prepared`, body)).body.referenceState, 'valid');
      assert.equal((await models(tenant, `${path}/resume`)).status, 400);
      assert.equal((await models(tenant, `${path}/resume?tenantId=foreign`, body)).status, 400);
      assert.equal((await models(tenant, `${path}/resume`, { ...body, requestId })).status, 400);
      const other = preparedResult.prepared[tenant === 'http-a' ? 'http-b' : 'http-a'];
      assert.equal((await models(tenant, `${path}/resume`, { ...body, inputFingerprint: other.inputFingerprint })).status, 409);
      const resumed = await models(tenant, `${path}/resume`, body);
      assert.equal(resumed.status, 200); assert.equal(resumed.body.evidenceState, 'pending'); assert.equal(resumed.body.executionEnabled, false);
      assert.equal((await models(tenant, `${path}/resume`, body)).status, 409);
      const committed = await models(tenant, `${path}/recover-commit`, body);
      assert.equal(committed.status, 200); assert.equal(committed.body.task.id, resumed.body.task.id); assert.equal(committed.body.recoveredCommit, true);
      const evidence = await models(tenant, `/supply-chain/tasks/${resumed.body.task.id}/preview-evidence-recover`, { confirmed: true, expectedTaskFingerprint: committed.body.taskFingerprint });
      assert.equal(evidence.status, 200); assert.equal(evidence.body.evidenceState, 'ready'); assert.equal(evidence.body.confirmationTokenReturned, false);
    }
    const adoptionSeed = once(child, 'message'); child.send('seed-adoption-tasks'); const [adoptionResult] = await adoptionSeed;
    for (const tenant of ['http-a', 'http-b']) {
      const fixture = adoptionResult.previews[tenant]; const other = adoptionResult.previews[tenant === 'http-a' ? 'http-b' : 'http-a'];
      const path = `/supply-chain/tasks/${fixture.taskId}`; const confirmBody = { confirmed: true, expectedTaskFingerprint: fixture.fingerprint };
      const review = await models(tenant, `${path}/adoption-review`);
      assert.equal(review.status, 200); assert.equal(review.body.graph.nodes[0].id, 'InventoryLot'); assert.equal(review.body.contentScope, 'owned_candidate_structure_only');
      assert.equal(review.body.taskFingerprint, fixture.fingerprint); assert.equal(review.body.executionEnabled, false);
      assert.doesNotMatch(JSON.stringify(review.body), /transformedSamples|materialRefs|traceId|tokenHash/);
      assert.equal((await models(tenant, `${path}/adoption-review`, { confirmed: true })).status, 400);
      assert.equal((await models(tenant, `${path}/adoption-review?tenantId=foreign`)).status, 400);
      assert.equal((await models(tenant, `/supply-chain/tasks/${other.taskId}/adoption-review`)).status, 403);
      assert.equal((await models(tenant, `${path}/adoption-confirm`)).status, 400);
      assert.equal((await models(tenant, `${path}/adoption-confirm?tenantId=foreign`, confirmBody)).status, 400);
      assert.equal((await models(tenant, `${path}/adoption-confirm`, { ...confirmBody, executionKind: 'adopt' })).status, 400);
      assert.equal((await models(tenant, `/supply-chain/tasks/${other.taskId}/adoption-confirm`, { confirmed: true, expectedTaskFingerprint: other.fingerprint })).status, 403);
      const confirmed = await models(tenant, `${path}/adoption-confirm`, confirmBody);
      assert.equal(confirmed.status, 200); assert.equal(confirmed.body.confirmationEvidenceState, 'ready'); assert.equal(confirmed.body.executionEnabled, false);
      const executionBody = { confirmed: true, expectedTaskFingerprint: confirmed.body.taskFingerprint, confirmationToken: confirmed.body.confirmationToken };
      assert.equal((await models(tenant, `${path}/local-execute`, executionBody)).body.code, 'MODEL_TASK_EXECUTION_COMMAND_UNSUPPORTED');
      assert.equal((await models(tenant, `${path}/adoption-execute`, { ...executionBody, command: 'publish_model' })).status, 400);
      assert.equal((await models(tenant, `${path}/adoption-confirmation-evidence-recover`, { confirmed: false })).status, 400);
      const recovered = await models(tenant, `${path}/adoption-confirmation-evidence-recover`, { confirmed: true });
      assert.equal(recovered.status, 200); assert.equal(recovered.body.confirmationTokenReturned, false);
      const applied = await models(tenant, `${path}/adoption-execute`, executionBody);
      assert.equal(applied.status, 200); assert.equal(applied.body.executedCommand, 'apply_proposal'); assert.equal(applied.body.runtimeReadEnabled, false);
      assert.doesNotMatch(JSON.stringify(applied.body), /confirmationToken|objectTypes|materialRefs/);
      assert.equal((await models(tenant, `${path}/adoption-execute`, executionBody)).status, 409);
    }
    for (const tenant of ['http-a', 'http-b']) {
      const payload = { confirmed: true, expectedFingerprint: (await models(tenant, '/supply-chain/draft')).body.draft.fingerprint };
      assert.equal((await models(tenant, '/supply-chain/publish')).status, 400);
      assert.equal((await models(tenant, '/supply-chain/publish?tenantId=foreign', payload)).status, 400);
      assert.equal((await models(tenant, '/supply-chain/publish', { ...payload, endpoint: 'http://127.0.0.1:1' })).status, 400);
      assert.equal((await models(tenant, '/oa-governance/publish', payload)).status, 400);
      const blocked = await models(tenant, '/supply-chain/publish', payload, { 'x-tenant-id': 'foreign', 'x-demo-role': 'executive' });
      assert.equal(blocked.status, 409); assert.equal(blocked.body.code, 'LOCAL_PUBLICATION_TARGET_REQUIRED');
      assert.equal(blocked.body.publicationMayHaveCommitted, undefined);
    }
    const restricted = once(child, 'message'); child.send('remove-b-publish');
    const [restriction] = await restricted; sessions['http-b'] = restriction.session;
    const confirmed = { confirmed: true, expectedFingerprint: (await models('http-b', '/supply-chain/draft')).body.draft.fingerprint };
    assert.equal((await models('http-b', '/supply-chain/publish', confirmed)).status, 403);
    assert.equal((await models('http-b', '/supply-chain/draft')).status, 200);
    assert.equal((await fetch(`${base}/api/semantic-operations/models/supply-chain/publish`, { method: 'POST', headers: { 'x-demo-role': 'executive', 'content-type': 'application/json' }, body: JSON.stringify(confirmed) })).status, 401);
    assert.equal((await fetch(`${base}/api/semantic-operations/models`, { headers: { 'x-demo-role': 'executive' } })).status, 401);
    const changed = once(child, 'message'); child.send('change-a-policy'); await changed;
    assert.equal((await call('http-a')).status, 401);
    assert.equal((await call('http-b')).status, 200);
  } finally { child.kill(); await closed; }
});
