import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { URL } from 'node:url';
import { consumeRequestQuota, getRateLimitPolicy } from './services/request-guard-service.js';
import { isDemoRoleHeaderEnabled, resolveRequestIdentityAsync } from './services/request-identity-service.js';
import { createBodyReader, sendJson as send } from './http/http-utils.js';
import { isPublicPath } from './http/route-security.js';
import { dispatchAuthorizedRoutes } from './http/authorized-route-dispatch.js';
import { handleIdentityRoutes } from './routes/identity-routes.js';
import { handlePermissionRoutes } from './routes/permission-routes.js';
import { handleAgentRoutes } from './routes/agent-routes.js';
import { handleEvidenceRoutes } from './routes/evidence-routes.js';
import { handleAlertingRoutes } from './routes/alerting-routes.js';
import { handleRiskRoutes } from './routes/risk-routes.js';
import { handleProcurementRoutes } from './routes/procurement-routes.js';
import { handleGovernanceRoutes } from './routes/governance-routes.js';
import { handleSystemMonitoringRoutes } from './routes/system-monitoring-routes.js';
import { handleKnowledgeRoutes } from './routes/knowledge-routes.js';
import { handleAnomalyRoutes } from './routes/anomaly-routes.js';
import { handleSimulationRoutes } from './routes/simulation-routes.js';
import { handleKeyRoutes } from './routes/key-routes.js';
import { handlePlatformRoutes } from './routes/platform-routes.js';
import { loadRuntimeConfiguration } from './config/runtime-config.js';
import { configureRuntimeDependencies } from './config/runtime-dependencies.js';
import { attachHttpCompletionLog } from './observability/structured-logger.js';
import { sendPrometheusMetrics } from './observability/prometheus-metrics.js';
import { runWithIAMStoreContext } from './services/iam-store.js';
import { getPlatformLiveness } from './domains/platform/public-api.js';
import { evaluateClientRequest } from './services/client-version-policy-service.js';

const runtimeConfiguration = loadRuntimeConfiguration();
await configureRuntimeDependencies(runtimeConfiguration);
const allowedOrigins = new Set(runtimeConfiguration.corsOrigins);
const allowDemoRoleHeader = isDemoRoleHeaderEnabled();
// Three 4MB attachments expand to roughly 16MB when Base64 encoded.
const maxBodyBytes = runtimeConfiguration.maxBodyBytes;
const readBody = createBodyReader(maxBodyBytes);
const routeHandlers = [
  handleIdentityRoutes,
  handlePermissionRoutes,
  handleAgentRoutes,
  handleEvidenceRoutes,
  handleAlertingRoutes,
  handleRiskRoutes,
  handleProcurementRoutes,
  handleGovernanceRoutes,
  handleSystemMonitoringRoutes,
  handleKnowledgeRoutes,
  handleAnomalyRoutes,
  handleSimulationRoutes,
  handleKeyRoutes,
  handlePlatformRoutes
];
const handleRequest = async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return send(res, res.corsOrigin || !req.headers.origin ? 204 : 403, {});
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === 'GET' && url.pathname === '/metrics') return await sendPrometheusMetrics(req, res);
    const quota = consumeRequestQuota({ key: req.socket.remoteAddress || 'unknown', policy: getRateLimitPolicy(url.pathname) });
    if (!quota.allowed) {
      res.retryAfterSeconds = quota.retryAfterSeconds;
      return send(res, 429, { message: '请求过于频繁，请稍后重试。' });
    }
    if (Number(req.headers['content-length'] || 0) > maxBodyBytes) return send(res, 413, { message: '请求体超过大小限制。' });

    const identity = await resolveRequestIdentityAsync({ headers: req.headers, url, allowDemoRoleHeader });
    if (!isPublicPath(url.pathname) && identity.error) return send(res, 401, { message: identity.error });
    if (!url.pathname.startsWith('/api/health')) {
      const clientPolicy = evaluateClientRequest(req.headers, { production: runtimeConfiguration.nodeEnv === 'production' });
      if (!clientPolicy.allowed) return send(res, clientPolicy.status, { message: clientPolicy.message, code: clientPolicy.code, minimumVersion: clientPolicy.minimumVersion, recommendedVersion: clientPolicy.recommendedVersion });
    }
    const role = identity.role || 'quality_manager';
    const agentIdentity = {
      tenantId: identity.tenantId || 'demo-enterprise',
      subjectId: identity.subjectId || null,
      sessionId: identity.sessionId || null,
      deviceId: identity.deviceId || null,
      source: identity.source || null,
      platform: String(req.headers['x-client-platform'] || 'unknown').slice(0, 80)
    };
    const context = {
      req,
      res,
      url,
      role,
      identity,
      agentIdentity,
      oaSessionId: req.headers['x-identity-session'] || req.headers['x-oa-session'],
      readBody,
      send
    };
    return await dispatchAuthorizedRoutes(context, routeHandlers, handleIdentityRoutes);
  } catch (error) {
    return send(res, error.status || 500, {
      message: error.status ? error.message : '服务暂时不可用，请稍后重试。',
      requestId: res.requestId
    });
  }
};
const server = createServer((req, res) => {
  attachHttpCompletionLog(req, res);
  res.requestId = String(req.headers['x-request-id'] || '').slice(0, 96) || randomUUID();
  res.strictTransportSecurity = runtimeConfiguration.nodeEnv === 'production';
  const origin = req.headers.origin;
  res.corsOrigin = origin && allowedOrigins.has(origin) ? origin : null;
  if (req.method === 'GET' && String(req.url).split('?')[0] === '/api/health/live') return send(res, 200, getPlatformLiveness());
  return runWithIAMStoreContext(() => handleRequest(req, res)).catch(() => send(res, 503, { message: '权限数据暂时不可用，请稍后重试。', code: 'IAM_STORE_UNAVAILABLE' }));
});

const port = runtimeConfiguration.port;
const host = runtimeConfiguration.host;
server.listen(port, host, () => console.log(`Demo API listening on http://${host}:${port}/api`));
