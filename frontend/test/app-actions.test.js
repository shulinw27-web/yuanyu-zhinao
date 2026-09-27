import test from 'node:test';
import assert from 'node:assert/strict';
import { createAppActions } from '../src/app-actions.js';

const ref = (value) => ({ value });

function createHarness(overrides = {}) {
  const refs = {
    page: ref('risks'), effectiveAccess: ref({ pagePermissionIds: ['page.risks.view'] }), access: ref(null),
    selectedRisk: ref(null), message: ref(''), procurementMessage: ref(''), procurement: ref(null),
    agentRuns: ref([]), agentOperations: ref(null), agentWorkItems: ref([]), assistantMessages: ref([]),
    agentEvaluations: ref(null), error: ref(''),
    agentModelConfig: ref(null), modelConfigMessage: ref(''), simulation: ref(null), simulationMessage: ref(''),
    keyCenterMessage: ref(''), keyCenter: ref(null), permissionSaving: ref(false), permissionMessage: ref(''),
    alertingSaving: ref(false), alertingMessage: ref(''), alertingWorkspace: ref(null), notifications: ref([])
  };
  const state = {
    commitAllowed: true,
    apiCalls: 0,
    ...overrides.state
  };
  const api = {
    risk: async () => { state.apiCalls += 1; return { id: 'risk-1', detail: 'visible' }; },
    access: async () => ({ policy: 'masked' }),
    launchProcurement: async () => { state.apiCalls += 1; return { status: 'launched' }; },
    approveProcurement: async () => { state.apiCalls += 1; return { status: 'approved' }; },
    ...overrides.api
  };
  const actions = createAppActions({
    api,
    refs,
    buttonPermissionIds: ref(overrides.permissions || []),
    loadedPages: new Set(),
    captureRequestAccess: () => ({ roleId: 'quality_manager', generation: 1 }),
    canCommitRequest: () => state.commitAllowed,
    loadPage: async () => {},
    runAccessGuarded: async () => false,
    canAccessPage: () => true,
    refreshPermissionWorkspace: async () => {}
  });
  return { actions, refs, state };
}

test('风险详情响应在授权代际失效后不会回填页面状态', async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const harness = createHarness({
    permissions: ['risk.detail.view'],
    api: { risk: async () => pending }
  });

  const request = harness.actions.chooseRisk({ id: 'risk-1' });
  harness.state.commitAllowed = false;
  release({ id: 'risk-1', detail: 'stale' });
  await request;

  assert.equal(harness.refs.selectedRisk.value, null);
  assert.equal(harness.refs.access.value, null);
});

test('采购按钮权限缺失时控制器不调用写接口', async () => {
  const harness = createHarness();
  await harness.actions.executeProcurement('launch');
  assert.equal(harness.state.apiCalls, 0);
  assert.match(harness.refs.procurementMessage.value, /未授予/);
});
