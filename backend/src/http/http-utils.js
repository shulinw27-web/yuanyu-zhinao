export const buildSecurityHeaders = ({ strictTransportSecurity = false } = {}) => ({
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-site',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'X-Permitted-Cross-Domain-Policies': 'none',
  ...(strictTransportSecurity ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {})
});

export const sendJson = (res, status, data) => {
  const payload = status >= 400 && data && typeof data === 'object' && !Array.isArray(data)
    ? (() => {
        const detail = String(data.error || data.message || '请求处理失败。');
        return { ...data, error: detail, message: detail };
      })()
    : data;
  const headers = {
    ...buildSecurityHeaders({ strictTransportSecurity: res.strictTransportSecurity }),
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-identity-provider, x-request-id, x-demo-role, x-client-platform, x-client-device-id, x-client-version, x-device-session, x-oa-session, x-identity-session',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'X-Request-Id': res.requestId
  };
  if (res.corsOrigin) Object.assign(headers, { 'Access-Control-Allow-Origin': res.corsOrigin, Vary: 'Origin' });
  if (res.retryAfterSeconds) headers['Retry-After'] = res.retryAfterSeconds;
  res.writeHead(status, headers);
  res.end(JSON.stringify(payload));
};

export const createBodyReader = (maxBodyBytes) => (req) => new Promise((resolve, reject) => {
  let raw = '';
  let size = 0;
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > maxBodyBytes) {
      const error = new Error('请求体超过大小限制。');
      error.status = 413;
      reject(error);
      req.resume();
      return;
    }
    raw += chunk;
  });
  req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); } });
  req.on('error', reject);
});

export const permissionErrorStatus = (result) => {
  if (result?.code === 'FORBIDDEN') return 403;
  if (result?.code === 'VERSION_CONFLICT') return 409;
  if (['USER_NOT_FOUND', 'ROLE_POLICY_NOT_FOUND'].includes(result?.code)) return 404;
  return 400;
};
