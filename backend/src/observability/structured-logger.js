const normalizePath = (url) => {
  try { return new URL(url, 'http://internal').pathname.slice(0, 300); }
  catch { return '/invalid'; }
};

export function createHttpCompletionRecord({ req, res, startedAt, now = Date.now() }) {
  return {
    timestamp: new Date(now).toISOString(),
    level: res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
    event: 'http_request_completed',
    service: 'healthcare-ai-demo-api',
    requestId: res.requestId || null,
    method: String(req.method || 'UNKNOWN').slice(0, 12),
    path: normalizePath(req.url),
    statusCode: Number(res.statusCode || 0),
    durationMs: Math.max(0, now - startedAt),
    clientPlatform: String(req.headers?.['x-client-platform'] || 'unknown').slice(0, 40)
  };
}

export function attachHttpCompletionLog(req, res, startedAt = Date.now()) {
  res.once('finish', () => {
    const record = createHttpCompletionRecord({ req, res, startedAt });
    process.stdout.write(`${JSON.stringify(record)}\n`);
  });
}
