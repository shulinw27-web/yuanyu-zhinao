import assert from 'node:assert/strict';
import test from 'node:test';
import {
  accessSignature,
  canAccessPage,
  captureAccessGeneration,
  firstAccessiblePage,
  isCurrentAccessGeneration
} from '../src/permission-navigation.js';
import {
  isAuthorizationRejection,
  request,
  subscribeAuthorizationInvalidated
} from '../src/api/client.js';

const access = (menuIds, pagePermissionIds) => ({ menuIds, pagePermissionIds, buttonPermissionIds: [] });

test('页面必须同时具有菜单和页面权限', () => {
  assert.equal(canAccessPage('risks', access(['risks'], ['page.risks.view'])), true);
  assert.equal(canAccessPage('risks', access(['risks'], [])), false);
  assert.equal(canAccessPage('risks', access([], ['page.risks.view'])), false);
});

test('「元模型」页已移出管理 Web（4.3 决策 A），持有旧权限也不可进入', () => {
  // 2026-10-07 元域智语权限语义独立：page.world.view 条目已删除，接替条目为
  // page.semantic-operations.view（元域智语端专用）。前端从不注册 world 页面，
  // 即使构造完整旧菜单与页面权限也无法导航到 world。
  assert.equal(canAccessPage('world', access(['world'], ['page.world.view'])), false);
  assert.equal(canAccessPage('world', access(['dashboard'], ['page.dashboard.view'])), false);
});

test('采购协同继承智脑页面访问边界', () => {
  assert.equal(canAccessPage('procurement', access(['agent'], ['page.agent.view'])), true);
  assert.equal(canAccessPage('procurement', access(['dashboard'], ['page.dashboard.view'])), false);
});

test('权限撤销后可确定性选择首个可访问页面', () => {
  const marketingAccess = access(['config', 'channels'], ['page.config.view', 'page.channels.view']);
  assert.equal(firstAccessiblePage(marketingAccess), 'channels');
  assert.equal(firstAccessiblePage(access([], [])), null);
});

test('权限签名与数组顺序无关，但能识别角色、页面、按钮和组织范围变化', () => {
  const baseline = {
    roleIds: ['quality_manager', 'marketing_manager'],
    menuIds: ['risks', 'dashboard'],
    pagePermissionIds: ['page.risks.view', 'page.dashboard.view'],
    buttonPermissionIds: ['risk.approve', 'risk.detail.view'],
    organizationIds: ['org-quality-dept', 'org-group']
  };
  const reordered = Object.fromEntries(Object.entries(baseline).map(([key, values]) => [key, [...values].reverse()]));
  assert.equal(accessSignature(baseline), accessSignature(reordered));
  assert.notEqual(accessSignature(baseline), accessSignature({ ...baseline, buttonPermissionIds: ['risk.detail.view'] }));
  assert.notEqual(accessSignature(baseline), accessSignature({ ...baseline, organizationIds: ['org-quality-dept'] }));
});

test('延迟响应在权限代际变化后不能回填旧数据', async () => {
  let generation = 7;
  let currentRole = 'quality_manager';
  const snapshot = captureAccessGeneration(generation, currentRole);
  let resolveResponse;
  let committed = false;
  const delayedResponse = new Promise((resolve) => { resolveResponse = resolve; });
  const commitTask = delayedResponse.then(() => {
    if (isCurrentAccessGeneration(snapshot, generation, currentRole)) committed = true;
  });

  generation += 1;
  currentRole = 'executive';
  resolveResponse({ stale: true });
  await commitTask;
  assert.equal(committed, false);
});

test('页面、按钮和业务权限拒绝会发布授权失效事件且请求不重试', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  const events = [];
  const unsubscribe = subscribeAuthorizationInvalidated((event) => events.push(event));
  globalThis.fetch = async () => {
    fetchCount += 1;
    return {
      ok: false,
      status: 403,
      json: async () => ({ code: 'BUTTON_PERMISSION_DENIED', message: '按钮权限已撤销。' })
    };
  };

  try {
    await assert.rejects(
      request('/risk-cases/RISK-001/approve', 'quality_manager', { method: 'POST' }),
      (error) => error.status === 403 && error.code === 'BUTTON_PERMISSION_DENIED'
    );
    assert.equal(fetchCount, 1);
    assert.deepEqual(events, [{ status: 403, code: 'BUTTON_PERMISSION_DENIED', path: '/risk-cases/RISK-001/approve', role: 'quality_manager' }]);
    globalThis.fetch = async () => {
      fetchCount += 1;
      return { ok: false, status: 401, json: async () => ({ message: '会话已失效。' }) };
    };
    await assert.rejects(request('/access/me', 'quality_manager'), (error) => error.status === 401 && error.code === null);
    assert.equal(fetchCount, 2);
    assert.deepEqual(events[1], { status: 401, code: null, path: '/access/me', role: 'quality_manager' });
    assert.equal(isAuthorizationRejection(401, 'BUSINESS_ROLE_DENIED'), true);
    assert.equal(isAuthorizationRejection(401, undefined), true);
    assert.equal(isAuthorizationRejection(403, 'PAGE_PERMISSION_DENIED'), true);
    assert.equal(isAuthorizationRejection(403, 'AGENT_ORIGIN_ROLE_DENIED'), true);
    assert.equal(isAuthorizationRejection(409, 'BUTTON_PERMISSION_DENIED'), false);
  } finally {
    unsubscribe();
    globalThis.fetch = originalFetch;
  }
});
