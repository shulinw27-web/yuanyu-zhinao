import { connectedSystems, getClientVersionPolicy, getDomainEventContractCatalog, getDomainEventOutboxMetrics, getPlatformLiveness, getPlatformReadiness, getSystemCapabilities, globalConfigurations, listDomainEventConsumerMetrics, listDomainEvents, platformStatus, replayDeadLetterEvent, systemConfigurations } from '../domains/platform/public-api.js';

export async function handlePlatformRoutes({ req, res, url, agentIdentity, selectActionRole, denyButton, readBody, send }) {
  if (req.method === 'GET' && url.pathname === '/api/health/live') { send(res, 200, getPlatformLiveness()); return true; }
  if (req.method === 'GET' && url.pathname === '/api/health/ready') {
    const readiness = await getPlatformReadiness();
    send(res, readiness.status === 'ready' ? 200 : 503, readiness);
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/system/capabilities') { send(res, 200, getSystemCapabilities()); return true; }
  if (req.method === 'GET' && url.pathname === '/api/platform/client-policy') { send(res, 200, { clients: getClientVersionPolicy(), policy: '低于最低版本返回 HTTP 426；低于推荐版本提示升级；写请求不进行隐式网络重试。' }); return true; }
  if (req.method === 'GET' && url.pathname === '/api/platform-status') {
    send(res, 200, platformStatus);
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/configurations') {
    send(res, 200, { global: globalConfigurations, systems: systemConfigurations, connectedSystems });
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/domain-events/contracts') {
    if (!selectActionRole('event.outbox.view')) { denyButton('event.outbox.view'); return true; }
    send(res, 200, { items: getDomainEventContractCatalog(), compatibility: 'type + version immutable; additive payload fields only within a version' });
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/domain-events/outbox') {
    if (!selectActionRole('event.outbox.view')) { denyButton('event.outbox.view'); return true; }
    const [items, metrics, consumers] = await Promise.all([
      listDomainEvents({
        tenantId: agentIdentity.tenantId,
        status: url.searchParams.get('status') || undefined,
        limit: url.searchParams.get('limit') || 100
      }),
      getDomainEventOutboxMetrics({ tenantId: agentIdentity.tenantId }),
      listDomainEventConsumerMetrics()
    ]);
    send(res, 200, {
      items,
      metrics,
      consumers,
      deliveryContract: { claim: 'lease', acknowledgment: 'consumer-bound', retry: 'exponential', maxAttempts: 5 }
    });
    return true;
  }
  const replayMatch = url.pathname.match(/^\/api\/domain-events\/outbox\/([^/]+)\/replay$/);
  if (req.method === 'POST' && replayMatch) {
    if (!selectActionRole('event.outbox.replay')) { denyButton('event.outbox.replay'); return true; }
    const body = await readBody(req);
    const result = await replayDeadLetterEvent(decodeURIComponent(replayMatch[1]), {
      tenantId: agentIdentity.tenantId,
      actor: { type: 'user', id: agentIdentity.subjectId || 'unknown' },
      reason: body.reason
    });
    send(res, result.error ? 409 : 200, result.error ? { message: result.error, code: result.code } : result);
    return true;
  }
  return false;
}
