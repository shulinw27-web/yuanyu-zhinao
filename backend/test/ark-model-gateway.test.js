import test from 'node:test';
import { createSemanticOperationsTask } from '../src/services/semantic-operations-task-service.js';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateModelSummary, getLocalModelRuntime, getModelConnectionConfiguration, configureModelConnection, getModelGatewayObservability, resetModelGatewayObservability } from '../src/services/local-model-gateway.js';
import { getModelGovernanceObservability, resetModelGovernanceForTest } from '../src/services/model-governance-service.js';
import { ARK_DEFAULT_BASE_URL, getArkRequestOptions, isAllowedArkEndpoint } from '../src/services/ark-model-config.js';
import { planSemanticOperationsRequest } from '../src/services/semantic-operations-planner-service.js';
import { runPrivateAgent } from '../src/services/private-agent-service.js';
import { getRole } from '../src/services/authorization-service.js';
import { readState } from '../src/repositories/runtime-state-repository.js';
import { createAgentConversation, recordAgentConversationExchange, getAgentConversationContext } from '../src/services/agent-conversation-service.js';

const envelope = (answer = '你好，我可以协助分析问题和整理工作，尚未执行任何操作。') => ({ schemaVersion: 'agent-summary.v1', answer, proposedAction: null, claimsExecution: false, executionReceipt: null });
const reply = (value = envelope()) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value), reasoning_content: 'never expose this reasoning' } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
const options = { prompt: '你好，请介绍你能协助处理的工作。', fallback: '本次未取得可用模型结果，请稍后重试。', safetyIdentifier: 'ark-test-subject' };
const withArk = async (overrides, handler) => {
  const values = { AGENT_RUNTIME_MODE: 'ark', AGENT_MODEL_CONFIG_SOURCE: 'environment', ARK_BASE_URL: ARK_DEFAULT_BASE_URL, ARK_MODEL: 'ep-synthetic-test', ARK_API_KEY: 'synthetic-test-credential', MODEL_ALLOWLIST_JSON: JSON.stringify({ ark: ['ep-synthetic-test'], mock: ['deterministic-demo'] }), AGENT_EXTERNAL_DATA_MODE: 'redacted', AGENT_EXTERNAL_MULTIMODAL_MODE: 'metadata_only', ...overrides };
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  const oldFetch = globalThis.fetch;
  Object.assign(process.env, values);
  resetModelGatewayObservability(); resetModelGovernanceForTest();
  try { await handler(); } finally {
    globalThis.fetch = oldFetch;
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    resetModelGatewayObservability(); resetModelGovernanceForTest();
  }
};

test('latest ERP report clarifies scope and an explanation uses the last reply without routing business actions', async () => {
  await withArk({}, async () => {
    const identity = { tenantId: 'dialogue-test', subjectId: 'dialogue-test', sessionId: 'dialogue-test', deviceId: 'dialogue-test' };
    const conversation = await createAgentConversation({ roleId: 'executive', identityScope: identity });
    let sent;
    globalThis.fetch = async (_url, request) => { sent = JSON.parse(request.body); return reply(envelope(JSON.stringify({ schemaVersion: 'agent-turn.v1', intent: 'dialogue', answer: '你希望查看综合报告还是库存专项？目前还没有读取 ERP 数据或生成报告。', resolvedRequest: '', needsClarification: true }))); };
    const first = await runPrivateAgent({ text: '我需要最新的ERP系统报告' }, getRole('executive'), identity);
    assert.equal(first.agent.inferenceSource, 'ark');
    assert.equal(first.lifecycle.state, 'needs_input');
    assert.equal(first.command, null);
    assert.deepEqual(first.evidence, []);
    assert.match(sent.messages[1].content, /不要把普通工作安排或最新报告理解成数据库历史快照/);
    await recordAgentConversationExchange({ conversationId: conversation.id, identityScope: identity, roleId: 'executive', userText: '我需要最新的ERP系统报告', response: first });
    const context = await getAgentConversationContext(conversation.id, identity);
    globalThis.fetch = async (_url, request) => { sent = JSON.parse(request.body); return reply(envelope(JSON.stringify({ schemaVersion: 'agent-turn.v1', intent: 'dialogue', answer: '我的意思是先选报告范围，比如综合概览或库存专项，之后再核验数据来源和更新时间。', resolvedRequest: '', needsClarification: false }))); };
    const next = await runPrivateAgent({ text: '这是什么意思？' }, getRole('executive'), identity, { conversationContext: context });
    assert.match(sent.messages[1].content, /你希望查看综合报告还是库存专项/);
    assert.equal(next.agent.inferenceSource, 'ark');
    assert.equal(next.command, null);
    assert.deepEqual(next.evidence, []);
    assert.equal(next.authorization.decision, 'CONVERSATION_ONLY');
  });
});

test('a failed conversational inference is not represented as completed or usable desktop content', async () => {
  await withArk({}, async () => {
    globalThis.fetch = async () => { throw new Error('simulated failure'); };
    const result = await runPrivateAgent({ text: '你好，你能帮我做什么？' }, getRole('executive'), { tenantId: 'demo-enterprise', subjectId: 'failure-test' });
    assert.equal(result.lifecycle.state, 'conversation_failed');
    assert.equal(result.command, null);
    assert.ok(result.evidenceTrace.events.some(event => event.stage === 'model_inference' && event.status === 'failed'));
    assert.ok(!result.evidenceTrace.events.some(event => event.type === 'conversation_completed'));
  });
});

test('semantic model advice cannot override current prohibitions or invent publication authority', async () => {
  await withArk({}, async () => {
    const identityScope = { tenantId: 'turn-guard', subjectId: 'turn-guard', deviceId: 'turn-guard' };
    for (const [text, suggested] of [['只讨论方案，不保存、不发布。采购订单如何建模？', 'publish_model'], ['检查当前模型状态', 'publish_model'], ['不要建模，只解释主键是什么。', 'build_model']]) {
      globalThis.fetch = async () => reply(envelope(JSON.stringify({ schemaVersion: 'agent-turn.v1', intent: suggested, answer: '', resolvedRequest: '发布模型', needsClarification: false })));
      const task = await createSemanticOperationsTask({ body: { text }, role: getRole('executive'), identityScope });
      assert.equal(task.command, null, text);
      assert.equal(task.confirmationRequired, false, text);
      assert.equal(task.proposal, null, text);
    }
    globalThis.fetch = async () => { throw new Error('synthetic transport error'); };
    const failed = await createSemanticOperationsTask({ body: { text: '请解释主键和外键的区别' }, role: getRole('executive'), identityScope });
    assert.equal(failed.status, 'failed');
    assert.equal(failed.command, null);
    assert.ok(failed.events.some(event => event.type === 'conversation_failed'));
    assert.ok(!failed.events.some(event => event.type === 'conversation_completed'));
  });
});

test('broad inventory report uses scoped records without fixed procurement or risk summaries', async () => {
  await withArk({}, async () => {
    const prompts = [];
    globalThis.fetch = async (_url, request) => {
      const prompt = JSON.parse(request.body).messages[1].content;
      prompts.push(prompt);
      if (prompt.includes('agent-turn.v1')) return reply(envelope(JSON.stringify({ schemaVersion: 'agent-turn.v1', intent: 'read_business', answer: '', resolvedRequest: '根据 ERP 和 WMS 库存模拟记录分析三个问题', needsClarification: false })));
      if (prompt.includes('agent-read-next.v1')) return reply(envelope(JSON.stringify({ schemaVersion: 'agent-read-next.v1', toolId: 'analyze_production_impact' })));
      return reply(envelope('本次仅根据可见模拟记录提出库存核对建议，不能据此判断全量库存，未执行任何业务变更。'));
    };
    const response = await runPrivateAgent({ text: '只看库存，用当前可访问的模拟数据，列出三个问题。不要生成文件，也不要发起业务流程。' }, getRole('executive'), { tenantId: 'demo-enterprise', subjectId: 'synthetic-inventory', deviceId: 'synthetic-inventory' });
    const businessPrompt = prompts.find(prompt => prompt.includes('已检索的业务事实'));
    assert.ok(businessPrompt);
    assert.doesNotMatch(businessPrompt, /内务核验完成|当前授权范围内未发现需要处置的生产质量风险/);
    assert.match(businessPrompt, /有限样本/);
    assert.equal(response.command, null);
    assert.equal(response.agent.inferenceSource, 'ark');
  });
});

test('inner turn format repairs are bounded and safety-rejected output is never retried', async () => {
  await withArk({}, async () => {
    let calls = 0;
    globalThis.fetch = async (_url, request) => {
      calls += 1;
      assert.match(JSON.parse(request.body).messages[0].content, /本次是服务器内部的意图理解调用/);
      return reply(envelope(JSON.stringify(calls === 1 ? { invalidContract: 'synthetic only' } : { schemaVersion: 'agent-turn.v1', intent: 'dialogue', answer: '我可以协助整理你的工作。', resolvedRequest: '', needsClarification: false })));
    };
    const identity = { tenantId: 'format-test', subjectId: 'format-test', deviceId: 'format-test' };
    const result = await runPrivateAgent({ text: '你能做什么？' }, getRole('executive'), identity);
    assert.equal(calls, 2); assert.equal(result.agent.inferenceSource, 'ark'); assert.equal(result.command, null);
    calls = 0;
    globalThis.fetch = async () => { calls += 1; return reply({ ...envelope('已经执行了发布操作。'), claimsExecution: true }); };
    const rejected = await runPrivateAgent({ text: '你能做什么？' }, getRole('executive'), identity);
    assert.equal(calls, 1); assert.equal(rejected.lifecycle.state, 'conversation_failed'); assert.equal(rejected.command, null);
  });
});

test('Ark retries transient connection failure once using the original deadline and never retries HTTP rejection', async () => {
  await withArk({}, async () => {
    let calls = 0;
    let signal;
    globalThis.fetch = async (_url, request) => {
      calls++;
      if (calls === 1) { signal = request.signal; throw new TypeError('fetch failed', { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } }); }
      assert.equal(request.signal, signal);
      return reply();
    };
    assert.equal((await generateModelSummary(options)).source, 'ark');
    assert.equal(calls, 2);
    calls = 0;
    globalThis.fetch = async () => { calls++; return new Response('', { status: 429 }); };
    assert.equal((await generateModelSummary(options)).source, 'fallback');
    assert.equal(calls, 1);
  });
});

test('Ark requests use bounded JSON chat protocol, redacted context, secret header and no redirects', async () => {
  await withArk({}, async () => {
    let calls = 0;
    globalThis.fetch = async (url, request) => {
      calls += 1;
      assert.equal(url, `${ARK_DEFAULT_BASE_URL}/chat/completions`);
      assert.equal(request.headers.Authorization, 'Bearer synthetic-test-credential');
      assert.equal(request.redirect, 'error');
      const body = JSON.parse(request.body);
      assert.equal(body.model, 'ep-synthetic-test');
      assert.deepEqual(body.response_format, { type: 'json_object' });
      assert.match(body.messages[0].content, /"required":\["schemaVersion","answer","proposedAction","claimsExecution","executionReceipt"\]/);
      assert.match(body.messages[0].content, /不得用 agent-summary.v1 作为外层键/);
      assert.deepEqual(body.thinking, { type: 'disabled' });
      assert.equal(body.max_tokens, 2048);
      assert.doesNotMatch(request.body, /person@example.com|13800138000|synthetic-test-credential/);
      assert.match(request.body, /\[邮箱\]/);
      return reply();
    };
    const result = await generateModelSummary({ ...options, prompt: '请联系 person@example.com，电话 13800138000，先整理方案。' });
    assert.equal(calls, 1);
    assert.equal(result.source, 'ark');
    assert.doesNotMatch(JSON.stringify(result), /reasoning|synthetic-test-credential/);
    assert.equal(getLocalModelRuntime().mode, 'ark');
    assert.equal(getModelConnectionConfiguration().providers.find((item) => item.id === 'ark').configured, true);
    assert.doesNotMatch(JSON.stringify(getModelConnectionConfiguration()), /synthetic-test-credential/);
    assert.equal(getModelGovernanceObservability().activeRequests, 0);
  });
});

test('Ark refuses unapproved models, missing keys and untrusted endpoints before sending any request', async () => {
  for (const overrides of [{ ARK_API_KEY: '' }, { ARK_MODEL: 'ep-unapproved' }, { ARK_BASE_URL: 'https://attacker.example/api/v3' }]) {
    await withArk(overrides, async () => {
      let calls = 0; globalThis.fetch = async () => { calls += 1; return reply(); };
      const result = await generateModelSummary(options);
      assert.notEqual(result.source, 'ark');
      assert.equal(calls, 0);
      assert.equal(getModelConnectionConfiguration().providers.find((item) => item.id === 'ark').configured, false);
    });
  }
  for (const endpoint of ['http://ark.cn-beijing.volces.com/api/v3', `${ARK_DEFAULT_BASE_URL}?key=secret`, 'https://user:password@ark.cn-beijing.volces.com/api/v3', 'https://ark.cn-beijing.volces.com.evil.example/api/v3', 'https://ark.cn-beijing.volces.com/api/coding/v3']) assert.equal(isAllowedArkEndpoint(endpoint), false);
});

test('Ark empty, malformed or action-claiming answers cannot be counted as successful inference', async () => {
  for (const invalid of [envelope('当然可以'), { 'agent-summary.v1': envelope() }, { ...envelope(), claimsExecution: true }, { ...envelope(), tool: 'publish_model' }]) {
    await withArk({}, async () => {
      globalThis.fetch = async () => reply(invalid);
      const result = await generateModelSummary(options);
      assert.equal(result.source, 'output_safety');
      assert.equal(getModelGatewayObservability().successfulCalls, 0);
    });
  }
});

test('Ark failures and request timeouts release quota and never expose provider bodies or credential-like errors', async () => {
  for (const failure of [async () => new Response('private upstream error', { status: 401 }), async () => { throw new Error('synthetic-test-credential'); }, async (_url, request) => new Promise((_resolve, reject) => {
    const keepAlive = setTimeout(() => reject(new Error('test deadline exceeded')), 1000);
    request.signal.addEventListener('abort', () => { clearTimeout(keepAlive); reject(request.signal.reason); }, { once: true });
  })]) {
    await withArk({}, async () => {
      globalThis.fetch = failure;
      const result = await generateModelSummary({ ...options, timeoutMs: 100 });
      assert.equal(result.source, 'fallback');
      assert.doesNotMatch(JSON.stringify([result, getModelGatewayObservability()]), /private upstream|synthetic-test-credential/);
      assert.equal(getModelGovernanceObservability().activeRequests, 0);
    });
  }
  assert.equal(getArkRequestOptions({ ARK_MAX_TOKENS: '10000', MODEL_MAX_RESERVED_OUTPUT_TOKENS: '2048' }).max_tokens, 2048);
});

test('Ark image content requires both approved egress and individually eligible material', async () => {
  const attachments = [true, false].map((eligible) => ({ type: 'image', name: 'synthetic.png', mimeType: 'image/png', dataUrl: `data:image/png;base64,${eligible ? 'QUJD' : 'REVG'}`, promptSecurity: { modelContentEligible: eligible, rawImageEligible: eligible } }));
  attachments.push({ ...attachments[0], name: 'ocr-only.png', promptSecurity: { modelContentEligible: true, rawImageEligible: false } });
  for (const approved of [false, true]) await withArk({ AGENT_EXTERNAL_MULTIMODAL_MODE: approved ? 'approved' : 'metadata_only' }, async () => {
    globalThis.fetch = async (_url, request) => {
      const content = JSON.parse(request.body).messages[1].content;
      assert.equal(Array.isArray(content), approved);
      assert.doesNotMatch(request.body, /REVG/);
      if (approved) assert.equal(content.filter((item) => item.type === 'image_url').length, 1);
      else assert.doesNotMatch(request.body, /data:image/);
      return reply();
    };
    assert.equal((await generateModelSummary({ ...options, attachments })).source, 'ark');
  });
});

test('both business Agent and semantic planning recognize Ark without granting model-proposed writes', async () => {
  await withArk({}, async () => {
    globalThis.fetch = async () => reply(envelope(JSON.stringify({ schemaVersion: 'agent-turn.v1', intent: 'dialogue', answer: '我可以帮助整理工作。', resolvedRequest: '', needsClarification: false })));
    const identityScope = { tenantId: 'demo-enterprise', subjectId: 'admin@demo.local', sessionId: 'ark-session', deviceId: 'ark-device' };
    const greeting = await runPrivateAgent({ text: '你好，请介绍一下能帮助我做什么' }, getRole('executive'), identityScope);
    assert.equal(greeting.agent.inferenceSource, 'ark');
    assert.equal(greeting.command, null);
    globalThis.fetch = async () => reply(envelope(JSON.stringify({ schemaVersion: 'semantic-operations-plan.v1', intent: 'publish_model', goal: '发布模型', systems: ['ERP'], rationale: '错误模型建议', questions: [] })));
    const planning = await planSemanticOperationsRequest({ request: '检查模型状态', authoritativeIntent: 'inspect_status', sourceDiscovery: { sources: [] }, identityScope });
    assert.equal(planning.provider, 'ark');
    assert.equal(planning.mode, 'external_model_advisory');
    assert.equal(planning.intentConflict, true);
    assert.equal(planning.goal, '检查模型状态');
    assert.deepEqual(planning.systems, []);
  });
});

test('Ark environment-managed launch overrides a saved local selection and refuses runtime UI mutations', async () => {
  await withArk({ AGENT_MODEL_CONFIG_SOURCE: '', MODEL_ALLOWLIST_JSON: JSON.stringify({ local: ['old-model'], ark: ['ep-synthetic-test'], mock: ['deterministic-demo'] }) }, async () => {
    configureModelConnection({ mode: 'local', baseUrl: 'http://127.0.0.1:8080/v1', model: 'old-model' });
    assert.equal(getLocalModelRuntime().mode, 'local');
    process.env.AGENT_MODEL_CONFIG_SOURCE = 'environment';
    assert.equal(getLocalModelRuntime().mode, 'ark');
    assert.equal(getLocalModelRuntime().model, 'ep-synthetic-test');
    assert.equal(configureModelConnection({ mode: 'mock' }).code, 'MODEL_CONFIGURATION_ENVIRONMENT_MANAGED');
    assert.doesNotMatch(JSON.stringify(readState('model_configuration', 'active', {})), /synthetic-test-credential/);
    process.env.AGENT_MODEL_CONFIG_SOURCE = '';
    configureModelConnection({ mode: 'mock' });
  });
});

test('Ark preflight fails honestly without credentials and does not start a server', () => {
  const result = spawnSync(process.execPath, ['scripts/ark-runtime.mjs', '--check'], { env: { ...process.env, ARK_API_KEY: '', ARK_MODEL: '' }, encoding: 'utf8' });
  assert.equal(result.status, 2);
  const output = JSON.parse(result.stderr.trim());
  assert.equal(output.status, 'blocked');
  assert.equal(output.modelActuallyUsed, false);
  assert.ok(output.missing.includes('ARK_API_KEY'));
});
