// 持久化端口（persistence port）契约测试。
//
// 守护目标：驱动选择必须收敛在一处，且「未注入仓库」时必须与本地
// Memory/SQLite 路径行为一致——否则 Demo 与单机部署会静默回归。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  configurePort,
  delegate,
  describePersistence,
  getPort,
  getPortWarnings,
  hasPort,
  LONG_TASK_PORT,
  PERSISTENCE_PORT_METHODS,
  PERSISTENCE_PORT_OPTIONAL_METHODS,
  RUNTIME_STATE_PORT
} from '../src/services/persistence-port.js';

const runtimeStateDouble = () => ({
  readState: async () => null,
  writeState: async () => null,
  mutateState: async () => null,
  mutateStates: async () => null,
  listState: async () => [],
  deleteState: async () => false,
  resetRuntimeState: async () => {}
});

test('未注册端口时 delegate 走本地分支，且驱动描述沿用本地 store', () => {
  configurePort(RUNTIME_STATE_PORT, null);
  assert.equal(hasPort(RUNTIME_STATE_PORT), false);
  assert.equal(getPort(RUNTIME_STATE_PORT), null);
  const value = delegate(RUNTIME_STATE_PORT, { remote: () => 'postgres', local: () => 'local' });
  assert.equal(value, 'local');
  assert.deepEqual(describePersistence(RUNTIME_STATE_PORT, { driver: 'sqlite', persistence: 'durable_local', schemaVersion: 1 }), {
    driver: 'sqlite', persistence: 'durable_local', schemaVersion: 1
  });
});

test('注册端口后 delegate 与驱动描述切到注入实现，注销后完全还原', () => {
  const double = { ...runtimeStateDouble(), schemaVersion: 9 };
  configurePort(RUNTIME_STATE_PORT, double, { methods: PERSISTENCE_PORT_METHODS[RUNTIME_STATE_PORT] });
  assert.equal(hasPort(RUNTIME_STATE_PORT), true);
  assert.equal(delegate(RUNTIME_STATE_PORT, { remote: () => 'postgres', local: () => 'local' }), 'postgres');
  assert.deepEqual(describePersistence(RUNTIME_STATE_PORT, { driver: 'sqlite', schemaVersion: 1 }), {
    driver: 'postgres', persistence: 'durable_distributed', schemaVersion: 9
  });
  configurePort(RUNTIME_STATE_PORT, null);
  assert.equal(hasPort(RUNTIME_STATE_PORT), false);
  assert.equal(delegate(RUNTIME_STATE_PORT, { remote: () => 'postgres', local: () => 'local' }), 'local');
});

test('缺少必需方法的仓库必须被拒绝，避免半成品实现被静默启用', () => {
  assert.throws(
    () => configurePort(RUNTIME_STATE_PORT, { readState: async () => null }, { methods: PERSISTENCE_PORT_METHODS[RUNTIME_STATE_PORT] }),
    /does not implement the required port; missing: /
  );
  assert.equal(hasPort(RUNTIME_STATE_PORT), false);
  assert.throws(
    () => configurePort(LONG_TASK_PORT, { enqueue: async () => ({}) }, { methods: PERSISTENCE_PORT_METHODS[LONG_TASK_PORT] }),
    /does not implement the required port/
  );
  assert.equal(hasPort(LONG_TASK_PORT), false);
});

test('缺少可选方法只记录告警而不阻断，支撑故障注入型替身', () => {
  const partial = {
    enqueue: async () => ({ task: { id: 't1' } }),
    expireDueTasks: async () => [],
    claimTask: async () => ({ task: { id: 't1' } }),
    markDispatched: async () => ({ task: { id: 't1' } }),
    failTask: async () => ({ task: { id: 't1' } })
  };
  const registered = configurePort(LONG_TASK_PORT, partial, {
    methods: PERSISTENCE_PORT_METHODS[LONG_TASK_PORT],
    optionalMethods: PERSISTENCE_PORT_OPTIONAL_METHODS[LONG_TASK_PORT]
  });
  assert.equal(registered, partial);
  assert.equal(hasPort(LONG_TASK_PORT), true);
  const warnings = getPortWarnings(LONG_TASK_PORT);
  assert.ok(warnings.includes('getTask'));
  assert.ok(warnings.includes('getTransitionConsumerStatus'));
  configurePort(LONG_TASK_PORT, null);
  assert.deepEqual(getPortWarnings(LONG_TASK_PORT), []);
});

test('非对象仓库实现直接拒绝，不做隐式降级', () => {
  assert.throws(() => configurePort(RUNTIME_STATE_PORT, 'postgres'), /must be an object/);
});
