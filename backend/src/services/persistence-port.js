// 持久化端口（persistence port）。
//
// 背景：Agent 侧的多个 store 服务（agent-run-store、agent-long-task-store、
// agent-evidence-trace-service 等）各自维护一份「Postgres 仓库是否已注入」
// 的判断，并各自复制 `postgresRepository ? postgresPath : sqlitePath` 三元分支。
// 实测共有 35 处这样的分支，散落在 10 个文件里；每新增一个能力都要再复制一遍，
// 且各文件对 `getInfo()` 的 schemaVersion 硬编码互不一致。
//
// 本模块把「驱动选择」收敛为一处：上层只声明「仓库端口」，
// 由本模块决定当前使用哪个实现，并统一对外报告驱动信息。
//
// 设计约束（见 docs/architecture/adr/ADR-004）：
// - 这是「驱动选择」抽象，不是「数据模型」抽象：JSON blob 存储仍是唯一事实源；
// - 缺省（未注入仓库）行为必须与历史完全一致，否则 Demo/SQLite 路径会回归；
// - 不做隐式重试或静默降级：仓库调用抛错必须原样向上传播。

// 端口方法名 → 用途，供 configure 时校验实现完整性。
// 只登记「契约必需」方法。缺失时按缺失面分级处理：
// - 缺少必需方法 → 抛错（防止半成品仓库被静默启用）；
// - 缺少可选方法 → 仅在流程中调用到该能力时才失败（见可选方法注释）。
const RUNTIME_STATE_PORT_METHODS = Object.freeze(['readState', 'writeState', 'mutateState', 'mutateStates', 'listState', 'deleteState', 'resetRuntimeState']);
const LONG_TASK_PORT_METHODS = Object.freeze(['enqueue', 'expireDueTasks', 'claimTask', 'markDispatched', 'failTask']);
// 可选方法：故障注入用的局部替身可能只实现被调用到的那几个。
// 因此这里不强制实现，缺失即视为「该能力不可用」由调用处自然报错。
const LONG_TASK_PORT_OPTIONAL_METHODS = Object.freeze([
  'getTask', 'listTasks', 'controlTask', 'completeByRun', 'getMetrics',
  'probe', 'initialize', 'close', 'recordHeartbeat', 'claimRunTransitions',
  'completeRunTransition', 'releaseRunTransition', 'getTransitionConsumerStatus',
  'acquireLease', 'runMaintenanceCycle'
]);

const registries = new Map();
const portWarnings = new Map();

const assertPort = (portName, repository, methods) => {
  if (!repository) return null;
  if (typeof repository !== 'object') throw new TypeError(`${portName} repository must be an object.`);
  const missing = methods.filter((method) => typeof repository[method] !== 'function');
  if (missing.length) throw new TypeError(`${portName} repository does not implement the required port; missing: ${missing.join(', ')}.`);
  return repository;
};

// 注册/注销一个持久化端口的实现。传入 null 表示回退到本地（Memory/SQLite）路径。
export const configurePort = (portName, repository, { methods = [], optionalMethods = [] } = {}) => {
  const validated = assertPort(portName, repository, methods);
  if (!validated) {
    registries.delete(portName);
    portWarnings.delete(portName);
    return null;
  }
  registries.set(portName, validated);
  const missingOptional = optionalMethods.filter((method) => typeof repository[method] !== 'function');
  if (missingOptional.length) portWarnings.set(portName, missingOptional);
  else portWarnings.delete(portName);
  return validated;
};

export const getPort = (portName) => registries.get(portName) || null;
export const hasPort = (portName) => registries.has(portName);
// 观测用：某端口缺少哪些可选能力。用于健康检查与故障注入测试的自我说明。
export const getPortWarnings = (portName) => [...(portWarnings.get(portName) || [])];

// 统一驱动描述。缺省（无端口）时由调用方传入本地 store 的真实信息，
// 避免各文件各自硬编码 schemaVersion。
export const describePersistence = (portName, localInfo) => {
  const repository = getPort(portName);
  if (!repository) return { ...localInfo, driver: localInfo?.driver || 'memory' };
  return {
    driver: 'postgres',
    persistence: 'durable_distributed',
    schemaVersion: Number(repository.schemaVersion || localInfo?.schemaVersion || 0)
  };
};

// 端口委派：注入仓库时走异步端口，否则走本地同步实现。
// 两个分支的返回值形态保持一致（同步实现按需由调用方 Promise 化），
// 这样上层不必再写三元分支。
export const delegate = (portName, { remote, local }) => {
  const repository = getPort(portName);
  return repository ? remote(repository) : local();
};

export const RUNTIME_STATE_PORT = 'runtimeState';
export const LONG_TASK_PORT = 'longTask';
export const PERSISTENCE_PORT_METHODS = Object.freeze({
  [RUNTIME_STATE_PORT]: RUNTIME_STATE_PORT_METHODS,
  [LONG_TASK_PORT]: LONG_TASK_PORT_METHODS
});
export const PERSISTENCE_PORT_OPTIONAL_METHODS = Object.freeze({
  [RUNTIME_STATE_PORT]: [],
  [LONG_TASK_PORT]: LONG_TASK_PORT_OPTIONAL_METHODS
});
