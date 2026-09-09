import test from 'node:test';
import assert from 'node:assert/strict';
import { applyPageData, fetchPageData } from '../src/page-data-registry.js';

const ref = (value = null) => ({ value });

test('配置页在没有世界模型页面权限时不请求治理接口', async () => {
  const called = [];
  const api = new Proxy({}, {
    get: (_, name) => async () => {
      called.push(String(name));
      if (name === 'metaModels') throw new Error('不应调用治理接口');
      return name.endsWith('s') ? [] : {};
    }
  });
  await fetchPageData({ pageId: 'config', activeRole: 'marketing_manager', effectiveAccess: {}, api, canAccessPage: () => false });
  assert.equal(called.includes('metaModels'), false);
  assert.deepEqual(called.sort(), ['accountCenter', 'agentModelConfig', 'configurations', 'keyCenter', 'permissionCenter', 'simulationOverview'].sort());
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
