// 语义面意图裁决测试：模型理解与确定性回落的边界。
//
// 这些用例守护的有两条：
//   1. 模型不可用时入口不得变成死路（历史缺陷：任何自然语言诉求都返回「模型未返回可用结果」）。
//   2. 回落不得放宽安全边界（发布必须同时具备语义理解与本轮明确请求）。
// 同时钉住反向约束：模型**正常**判定为需澄清时不得被确定性分类覆盖，
// 否则模型的澄清判断会被静默绕过。
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSemanticOperationsIntent, classifySemanticOperationsIntent } from '../src/services/semantic-operations-task-service.js';

const BUILD_TEXT = '分析 ERP 和 WMS，建立采购订单、入库单和库存之间的语义模型。';
const PUBLISH_TEXT = '发布并登记当前语义模型。';
const SCOPE_MISSING_TEXT = '建立语义模型。';
const failedTurn = { intent: 'dialogue', answer: '', resolvedRequest: '', needsClarification: false, source: 'understanding_failed', failureCode: 'MODEL_RESULT_UNAVAILABLE_FALLBACK' };
const resolve = (turn, text) => resolveSemanticOperationsIntent({ turn, text, contextualText: text, hasAttachments: false });

test('模型不可用 + 明确建模诉求：回落确定性分类，产出可执行计划而不是死路', () => {
  const { classified, turnUnavailable } = resolve(failedTurn, BUILD_TEXT);
  assert.equal(turnUnavailable, true);
  assert.equal(classified.intent, 'build_model');
  assert.equal(classified.command, 'apply_proposal');
  assert.equal(classified.permission, 'meta_model.draft.save');
  assert.equal(classified.reason, 'explicit_grounded_build');
  // 回落走的是服务端规则，不得标记为模型理解
  assert.notEqual(classified.reason, 'model_understood_server_gated');
});

test('模型不可用 + 发布诉求：不得降级授权发布', () => {
  const { classified } = resolve(failedTurn, PUBLISH_TEXT);
  assert.equal(classified.intent, 'needs_clarification');
  assert.equal(classified.reason, 'publish_requires_model_understanding');
  assert.equal(classified.permission, null);
  assert.equal(classified.command, null);
  assert.match(classified.response, /不会降级授权发布/);
});

test('模型不可用 + 建模但缺范围：给出可操作的澄清，而不是模型失败提示', () => {
  const { classified } = resolve(failedTurn, SCOPE_MISSING_TEXT);
  assert.equal(classified.intent, 'needs_clarification');
  assert.equal(classified.reason, 'build_scope_missing');
  assert.match(classified.response, /缺少对象范围或结构材料/);
});

test('模型可用 + 建模意图：由模型理解驱动，并保留服务端门禁', () => {
  const turn = { intent: 'build_model', answer: '', resolvedRequest: BUILD_TEXT, needsClarification: false, source: 'workbuddy' };
  const { classified, turnUnavailable } = resolve(turn, BUILD_TEXT);
  assert.equal(turnUnavailable, false);
  assert.equal(classified.intent, 'build_model');
  assert.equal(classified.reason, 'model_understood_server_gated');
  assert.equal(classified.permission, 'meta_model.draft.save');
});

test('模型可用 + 对话意图：保留模型回答，不回落', () => {
  const turn = { intent: 'dialogue', answer: '我可以协助建设语义模型。', resolvedRequest: '', needsClarification: false, source: 'workbuddy' };
  const { classified } = resolve(turn, '你好，你能做什么？');
  assert.equal(classified.intent, 'conversation');
  assert.equal(classified.reason, 'model_dialogue');
  assert.equal(classified.response, '我可以协助建设语义模型。');
});

test('模型可用但主动要求澄清：不得被确定性分类覆盖', () => {
  // 文本本身足以触发确定性 build_model；模型却判断需要澄清。模型的判断必须优先，
  // 否则「回落」会变成绕过模型澄清的静默提权通道。
  const turn = { intent: 'dialogue', answer: '请确认是否已启用批次管理。', resolvedRequest: '', needsClarification: true, source: 'workbuddy' };
  const { classified, turnUnavailable } = resolve(turn, BUILD_TEXT);
  assert.equal(turnUnavailable, false);
  assert.equal(classified.intent, 'needs_clarification');
  assert.equal(classified.reason, 'model_dialogue');
  assert.equal(classified.permission, null);
  // 对照：同一文本走确定性分类是 build_model，证明上面确实是模型的澄清判断生效
  assert.equal(classifySemanticOperationsIntent(BUILD_TEXT, { hasAttachments: false }).intent, 'build_model');
});

test('模型可用 + 发布意图，但本轮没有明确发布请求：仍不得授权', () => {
  const turn = { intent: 'publish_model', answer: '', resolvedRequest: '', needsClarification: false, source: 'workbuddy' };
  const { classified } = resolve(turn, '看看当前模型状态。');
  assert.equal(classified.intent, 'conversation');
  assert.equal(classified.reason, 'model_dialogue');
  assert.equal(classified.permission, null);
});

test('模型可用 + 发布意图 + 本轮明确发布请求：授权并保留确认门禁', () => {
  const turn = { intent: 'publish_model', answer: '', resolvedRequest: PUBLISH_TEXT, needsClarification: false, source: 'workbuddy' };
  const { classified } = resolve(turn, PUBLISH_TEXT);
  assert.equal(classified.intent, 'publish_model');
  assert.equal(classified.reason, 'model_understood_server_gated');
  assert.equal(classified.permission, 'meta_model.publish');
});

test('无模型（mock 模式）：turn 为空时走确定性分类，且不标记降级', () => {
  const { classified, turnUnavailable } = resolve(null, BUILD_TEXT);
  assert.equal(turnUnavailable, false);
  assert.equal(classified.intent, 'build_model');
  assert.equal(classified.reason, 'explicit_grounded_build');
});

test('模型审核通过使用独立审核权限，而不是混同建模权限', () => {
  const classified = classifySemanticOperationsIntent('审核通过');
  assert.equal(classified.intent, 'approve_model');
  assert.equal(classified.permission, 'meta_model.draft.review');
  assert.equal(classified.command, 'apply_proposal');
});
