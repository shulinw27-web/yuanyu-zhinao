const publicPaths = new Set(['/api/health', '/api/health/live', '/api/health/ready', '/api/oa/connection', '/api/auth/oa/login', '/api/auth/local/login', '/api/auth/oa/session', '/api/auth/oa/logout', '/api/session/device', '/api/roles', '/api/modules']);

const readPagePolicies = [
  { test: (path) => path === '/api/dashboard', pagePermissionIds: ['page.dashboard.view'] },
  { test: (path) => path === '/api/system/capabilities', pagePermissionIds: ['page.config.view'] },
  { test: (path) => path === '/api/systems' || path === '/api/platform-status', pagePermissionIds: ['page.dashboard.view', 'page.intelligence.view', 'page.config.view'] },
  { test: (path) => path === '/api/notifications', pagePermissionIds: ['page.dashboard.view', 'page.intelligence.view', 'page.channels.view'] },
  { test: (path) => path === '/api/alerting/workspace', pagePermissionIds: ['page.channels.view'] },
  { test: (path) => path === '/api/risk-cases' || /^\/api\/risk-cases\/[^/]+$/.test(path), pagePermissionIds: ['page.risks.view'] },
  { test: (path) => path === '/api/world-model' || path === '/api/meta-objects' || path === '/api/semantic-context' || path === '/api/meta-models' || path.startsWith('/api/meta-models/') || path.startsWith('/api/world-model/') || path.startsWith('/api/semantic-operations/'), pagePermissionIds: ['page.world.view'] },
  { test: (path) => path === '/api/authorization/explain', pagePermissionIds: ['page.risks.view', 'page.world.view'] },
  { test: (path) => path === '/api/account-center' || path === '/api/configurations' || path === '/api/domain-events/outbox' || path === '/api/domain-events/contracts' || path === '/api/system-data/overview' || /^\/api\/system-data\/[^/]+\/records$/.test(path) || path === '/api/simulation/overview' || path === '/api/permission-center' || path === '/api/agent/model-config' || path === '/api/key-center/overview', pagePermissionIds: ['page.config.view'] },
  { test: (path) => path === '/api/permission-management', pagePermissionIds: ['page.permissions.view'] },
  { test: (path) => path.startsWith('/api/agent/') || path === '/api/procurement/scenario', pagePermissionIds: ['page.agent.view'] }
];

export const isPublicPath = (path) => publicPaths.has(path) || ['/api/auth/providers', '/api/auth/dingtalk/config', '/api/auth/dingtalk/login/challenge', '/api/auth/dingtalk/login'].includes(path);
export const requiredReadPagePermissions = (path) => readPagePolicies.find((policy) => policy.test(path))?.pagePermissionIds || null;
