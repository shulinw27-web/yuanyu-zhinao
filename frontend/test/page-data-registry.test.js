import test from 'node:test';
import assert from 'node:assert/strict';
import { applyPageData, fetchPageData } from '../src/page-data-registry.js';

const ref = (value = null) => ({ value });

test('配置页结构上不再请求世界模型 / 系统接入接口', async () => {
  const called = [];
  const forbidden = ['worldTemplates', 'worldConnectionTargets', 'worldDrafts'];
  const api = new Proxy({}, {
    get: (_, name) => async () => {
      called.push(String(name));
      if (forbidden.includes(String(name))) throw new Error(`配置页不应再调用 ${String(name)}：入口已迁至元域智语端系统接入视图`);
      return String(name).endsWith('s') ? [] : {};
    }
  });
  // 阶段 2 之前这里靠 canAccessPage('world') 分支跳过；现在调用签名已不含权限判定，
  // 因此断言的是「不存在这条调用路径」，而不是「这条路径被权限挡住」。
  await fetchPageData({ pageId: 'config', activeRole: 'marketing_manager', api });
  assert.deepEqual(called.filter((name) => forbidden.includes(name)), []);
  assert.deepEqual(called.sort(), ['accountCenter', 'agentModelConfig', 'configurations', 'keyCenter', 'permissionCenter', 'simulationOverview'].sort());
});

test('「元模型」页已移出管理 Web，不存在数据加载路径（4.3 决策 A）', async () => {
  const api = new Proxy({}, {
    get: (_, name) => async () => { throw new Error(`不应调用 ${String(name)}`); }
  });
  await assert.rejects(fetchPageData({ pageId: 'world', activeRole: 'quality_manager', api }), /未知页面/);
});

test('配置页数据应用不再写入世界模型相关状态', () => {
  const state = {
    configuration: ref(), agentModelConfig: ref(), simulation: ref(),
    accountCenter: ref(), permissionCenter: ref(), keyCenter: ref()
  };
  applyPageData({
    pageId: 'config',
    data: { configurationValue: {}, agentModelConfigValue: {}, simulationValue: {}, accountCenterValue: {}, permissionCenterValue: {}, keyCenterValue: {} },
    state
  });
  assert.deepEqual(Object.keys(state).sort(), ['accountCenter', 'agentModelConfig', 'configuration', 'keyCenter', 'permissionCenter', 'simulation'].sort());
});

test('权限工作区应用时拒绝无效响应结构', () => {
  const state = { permissionWorkspace: ref() };
  assert.throws(() => applyPageData({
    pageId: 'permissions',
    data: { permissionWorkspaceValue: { invalid: true } },
    state,
    unwrapPermissionWorkspace: () => null
  }), /数据结构无效/);
});
