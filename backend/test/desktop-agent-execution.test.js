import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { getRole } from '../src/services/authorization-service.js';
import { claimPrivateAgentLongTask, completePrivateAgentDesktopExecution, executePrivateAgentCommand, runPrivateAgent } from '../src/services/private-agent-service.js';
import { buildDesktopArtifactCommand, buildDesktopCommandForInput, getDesktopToolCatalog, validateDesktopToolInvocation } from '../src/services/desktop-tool-registry.js';
import { getAgentLearningProfile, updateAgentLearningProfile } from '../src/services/agent-learning-governance-service.js';
import { registerDesktopEndpointHeartbeat } from '../src/services/desktop-endpoint-service.js';

test('negative desktop clauses never create confirmation cards or shadow an affirmative destination', () => {
  for (const input of ['分析库存，不要生成文件，也不要发起业务流程。', '不要打开 https://example.com', '不要读取工作区中的 test.txt', '不要复制到剪贴板', '不保存报告，只解释内容']) {
    assert.equal(buildDesktopCommandForInput({ input, content: '这是合成测试内容。' }), null, input);
  }
  const command = buildDesktopCommandForInput({ input: '不要保存到桌面，生成一份工作清单到文档目录', content: '这是合成测试内容。' });
  assert.equal(command.target, 'desktop');
  assert.match(command.label, /文档/);
});

const identity = {
  tenantId: 'desktop-test-tenant',
  subjectId: 'desktop-test-user',
  sessionId: 'desktop-test-session',
  deviceId: 'desktop-test-device',
  platform: 'desktop'
};

const endpointKeyPair = generateKeyPairSync('ed25519');
const endpointPublicKey = endpointKeyPair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
const connectEndpoint = (identityScope) => {
  const heartbeat = {
    protocolVersion: 'endpoint-runtime.v1',
    endpointId: 'endpoint-123e4567-e89b-12d3-a456-426614174000',
    appVersion: '0.3.0',
    platform: 'win32',
    packaged: false,
    trustClaim: 'development_untrusted',
    keyProtection: 'file_system',
    capabilityManifestHash: 'c'.repeat(64),
    observedAt: new Date().toISOString(),
    publicKey: endpointPublicKey
  };
  const payload = JSON.stringify([heartbeat.protocolVersion, heartbeat.endpointId, heartbeat.appVersion, heartbeat.platform, heartbeat.packaged, heartbeat.trustClaim, heartbeat.keyProtection, heartbeat.capabilityManifestHash, heartbeat.observedAt]);
  heartbeat.signature = sign(null, Buffer.from(payload), endpointKeyPair.privateKey).toString('base64url');
  return registerDesktopEndpointHeartbeat({ identityScope, heartbeat });
};

test('desktop tool catalog fails closed for destructive and external actions', () => {
  const catalog = getDesktopToolCatalog();
  assert.equal(catalog.find((item) => item.id === 'desktop.artifact.create_text').riskLevel, 'L1');
  assert.equal(catalog.find((item) => item.id === 'desktop.artifact.create_docx').enabled, true);
  assert.equal(catalog.find((item) => item.id === 'desktop.artifact.create_xlsx').enabled, true);
  assert.equal(catalog.find((item) => item.id === 'desktop.workspace.read_text').requiresConfirmation, true);
  assert.equal(catalog.find((item) => item.id === 'desktop.clipboard.write_text').enabled, true);
  assert.equal(validateDesktopToolInvocation('desktop.mail.send', {}).code, 'DESKTOP_TOOL_DISABLED');
  assert.equal(validateDesktopToolInvocation('desktop.file.delete', {}).code, 'DESKTOP_TOOL_DISABLED');
  assert.equal(validateDesktopToolInvocation('desktop.unknown', {}).code, 'DESKTOP_TOOL_NOT_REGISTERED');
  assert.equal(validateDesktopToolInvocation('desktop.artifact.create_text', {
    fileName: '../escape.md', content: 'x', conflictPolicy: 'create_unique'
  }).code, 'DESKTOP_TOOL_INPUT_SCHEMA');
  assert.equal(validateDesktopToolInvocation('desktop.artifact.create_text', {
    fileName: 'safe.md', content: 'x', conflictPolicy: 'create_unique', overwrite: true
  }).code, 'DESKTOP_TOOL_INPUT_ADDITIONAL_PROPERTY');
  assert.equal(validateDesktopToolInvocation('desktop.browser.open_https', { url: 'http://example.com' }).code, 'DESKTOP_TOOL_INPUT_SCHEMA');
  assert.equal(validateDesktopToolInvocation('desktop.browser.open_https', { url: 'https://user:secret@example.com' }).code, 'DESKTOP_TOOL_INPUT_SCHEMA');
  assert.equal(validateDesktopToolInvocation('desktop.workspace.read_text', { fileName: '../secret.txt' }).code, 'DESKTOP_TOOL_INPUT_SCHEMA');
  assert.equal(validateDesktopToolInvocation('desktop.clipboard.write_text', { text: '' }).code, 'DESKTOP_TOOL_INPUT_SCHEMA');
});

test('table and Word requests produce native Office artifact dispatches without overwrite controls', async () => {
  const role = getRole('production_manager');
  const tableIdentity = { ...identity, subjectId: 'desktop-table-user', sessionId: 'desktop-table-session' };
  assert.equal(connectEndpoint(tableIdentity).allowed, true);
  const planned = await runPrivateAgent('请生成一份《任务清单》表格并保存到工作区', role, tableIdentity);
  const queued = await executePrivateAgentCommand(planned.command.id, role, planned.runId, planned.command.confirmationToken, tableIdentity);
  const authorized = await claimPrivateAgentLongTask({ taskId: queued.runtimeTask.id, role, identityScope: tableIdentity });
  assert.equal(authorized.desktopExecution.toolId, 'desktop.artifact.create_xlsx');
  assert.match(authorized.desktopExecution.input.fileName, /\.xlsx$/);
  assert.match(authorized.desktopExecution.input.content, /## 用户目标/);
  assert.equal(authorized.desktopExecution.input.conflictPolicy, 'create_unique');
  assert.equal(Object.hasOwn(authorized.desktopExecution.input, 'overwrite'), false);

  const wordIdentity = { ...identity, subjectId: 'desktop-word-user', sessionId: 'desktop-word-session' };
  assert.equal(connectEndpoint(wordIdentity).allowed, true);
  const wordPlanned = await runPrivateAgent('请生成一份《周会纪要》Word 文档并保存到工作区', role, wordIdentity);
  const wordQueued = await executePrivateAgentCommand(wordPlanned.command.id, role, wordPlanned.runId, wordPlanned.command.confirmationToken, wordIdentity);
  const wordAuthorized = await claimPrivateAgentLongTask({ taskId: wordQueued.runtimeTask.id, role, identityScope: wordIdentity });
  assert.equal(wordAuthorized.desktopExecution.toolId, 'desktop.artifact.create_docx');
  assert.match(wordAuthorized.desktopExecution.input.fileName, /\.docx$/);
});

test('desktop destination words are not included in the generated artifact file name', () => {
  const desktopCommand = buildDesktopArtifactCommand({
    input: '给我生成一份当前工作清单到桌面',
    content: '- 检查今日任务'
  });
  const documentsCommand = buildDesktopArtifactCommand({ input: '生成一份当前工作清单保存到我的文档', content: '- 检查今日任务' });
  const shortDocumentsCommand = buildDesktopArtifactCommand({ input: '生成一份当前工作清单保存到文档', content: '- 检查今日任务' });
  const downloadsCommand = buildDesktopArtifactCommand({ input: '生成一份当前工作清单放到下载目录', content: '- 检查今日任务' });
  const defaultCommand = buildDesktopArtifactCommand({ input: '生成一份当前工作清单', content: '- 检查今日任务' });
  assert.equal(desktopCommand.endpointAction.input.fileName, '当前工作清单.xlsx');
  assert.equal(desktopCommand.endpointAction.input.destination, 'desktop');
  assert.equal(documentsCommand.endpointAction.input.destination, 'documents');
  assert.equal(shortDocumentsCommand.endpointAction.input.destination, 'documents');
  assert.equal(downloadsCommand.endpointAction.input.destination, 'downloads');
  assert.equal(defaultCommand.endpointAction.input.destination, 'desktop');
  assert.match(desktopCommand.label, /桌面“元域智脑工作区”/u);
  assert.match(documentsCommand.label, /文档“元域智脑工作区”/u);
  assert.match(downloadsCommand.label, /下载“元域智脑工作区”/u);
});

test('desktop artifact task requires confirmation, dispatches once, and closes with a bound receipt', async () => {
  const role = getRole('production_manager');
  assert.equal(connectEndpoint(identity).allowed, true);
  await updateAgentLearningProfile({ identityScope: identity, settings: { workflowLearningEnabled: true }, expectedVersion: 1 });
  const planned = await runPrivateAgent('请生成一份《端侧闭环测试》文档并保存到本地工作区', role, identity);
  assert.equal(planned.command?.target, 'desktop');
  assert.equal(planned.command?.id, 'desktop_create_text_artifact');
  assert.equal(planned.task?.status, 'awaiting_confirmation');
  assert.ok(planned.command?.confirmationToken);
  assert.equal(planned.evidenceTrace?.status, 'awaiting_confirmation');

  const queued = await executePrivateAgentCommand(planned.command.id, role, planned.runId, planned.command.confirmationToken, identity);
  assert.equal(queued.runtimeTask.status, 'queued');
  assert.equal(queued.desktopExecution, undefined);
  const authorized = await claimPrivateAgentLongTask({ taskId: queued.runtimeTask.id, role, identityScope: identity });
  assert.equal(authorized.desktopExecution?.protocolVersion, 'desktop-execution.v1');
  assert.equal(authorized.desktopExecution?.toolId, 'desktop.artifact.create_text');
  assert.equal(Object.hasOwn(authorized.desktopExecution.input, 'overwrite'), false);

  const replay = await executePrivateAgentCommand(planned.command.id, role, planned.runId, planned.command.confirmationToken, identity);
  assert.match(replay.error, /不处于待确认状态|重复执行/);

  const wrongReceipt = await completePrivateAgentDesktopExecution({
    role,
    runId: planned.runId,
    commandId: planned.command.id,
    dispatchId: 'desktop-dispatch-wrong',
    identityScope: identity,
    receipt: { status: 'failed', dispatchId: 'desktop-dispatch-wrong', toolId: 'desktop.artifact.create_text', error: 'test', completedAt: new Date().toISOString() }
  });
  assert.equal(wrongReceipt.code, 'DESKTOP_RECEIPT_DISPATCH_MISMATCH');

  const dispatchId = authorized.desktopExecution.dispatchId;
  const completed = await completePrivateAgentDesktopExecution({
    role,
    runId: planned.runId,
    commandId: planned.command.id,
    dispatchId,
    identityScope: identity,
    receipt: {
      status: 'succeeded',
      dispatchId,
      toolId: 'desktop.artifact.create_text',
      artifact: { relativePath: '端侧闭环测试.md', bytes: 128, sha256: 'a'.repeat(64), workspace: '元域智脑工作区' },
      completedAt: new Date().toISOString()
    }
  });
  assert.equal(completed.run.status, 'executed');
  assert.equal(completed.evidenceTrace.status, 'executed');
  assert.match(completed.text, /端侧闭环测试\.md/);
  assert.equal(completed.learning.recorded, true);
  assert.equal((await getAgentLearningProfile(identity)).signals[0].toolId, 'desktop.artifact.create_text');
});

test('natural-language browser navigation remains confirmation-bound and records only the HTTPS origin', async () => {
  const role = getRole('production_manager');
  const browserIdentity = { ...identity, subjectId: 'desktop-browser-user', sessionId: 'desktop-browser-session' };
  assert.equal(connectEndpoint(browserIdentity).allowed, true);
  const planned = await runPrivateAgent('请用浏览器打开 https://example.com/docs?query=private', role, browserIdentity);
  assert.equal(planned.command?.id, 'desktop_open_https_url');
  assert.equal(planned.command?.target, 'desktop');
  const queued = await executePrivateAgentCommand(planned.command.id, role, planned.runId, planned.command.confirmationToken, browserIdentity);
  const authorized = await claimPrivateAgentLongTask({ taskId: queued.runtimeTask.id, role, identityScope: browserIdentity });
  assert.equal(authorized.desktopExecution.toolId, 'desktop.browser.open_https');
  const dispatchId = authorized.desktopExecution.dispatchId;
  const completed = await completePrivateAgentDesktopExecution({
    role,
    runId: planned.runId,
    commandId: planned.command.id,
    dispatchId,
    identityScope: browserIdentity,
    receipt: {
      status: 'succeeded', dispatchId, toolId: 'desktop.browser.open_https',
      result: { kind: 'browser_navigation', origin: 'https://example.com' }, completedAt: new Date().toISOString()
    }
  });
  assert.equal(completed.run.status, 'executed');
  assert.match(completed.text, /https:\/\/example\.com/);
  assert.equal(JSON.stringify(completed.evidenceTrace).includes('query=private'), false);
});

test('offline endpoint blocks dispatch without consuming the one-time confirmation', async () => {
  const role = getRole('production_manager');
  const offlineIdentity = { ...identity, subjectId: 'desktop-offline-user', sessionId: 'desktop-offline-session' };
  const planned = await runPrivateAgent('请生成一份《离线门禁验证》文档并保存到工作区', role, offlineIdentity);
  const rejected = await executePrivateAgentCommand(planned.command.id, role, planned.runId, planned.command.confirmationToken, offlineIdentity);
  assert.match(rejected.code, /^DESKTOP_ENDPOINT_/u);
  assert.equal(rejected.endpoint.connected, false);
  assert.equal(connectEndpoint(offlineIdentity).allowed, true);
  const queued = await executePrivateAgentCommand(planned.command.id, role, planned.runId, planned.command.confirmationToken, offlineIdentity);
  const authorized = await claimPrivateAgentLongTask({ taskId: queued.runtimeTask.id, role, identityScope: offlineIdentity });
  assert.equal(authorized.desktopExecution.toolId, 'desktop.artifact.create_text');
});
