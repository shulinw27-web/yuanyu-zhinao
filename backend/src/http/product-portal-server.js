import { createServer } from 'node:http';

export function createProductPortalServer({ service, origins = ['http://127.0.0.1:15195', 'http://localhost:15195'], secureCookies = false }) {
  const quotas = new Map(); let activeAuth = 0;
  const cookie = (value, maxAge = 28800) => `yy_portal=${value}; HttpOnly; SameSite=Strict; Path=/api/portal; Max-Age=${maxAge}${secureCookies ? '; Secure' : ''}`;
  return createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
    const send = (status, data) => { res.statusCode = status; res.end(JSON.stringify(data)); };
    try {
      const path = new URL(req.url, 'http://localhost').pathname;
      if (!path.startsWith('/api/portal/')) return send(404, { code: 'NOT_FOUND' });
      const isAuth = ['/api/portal/register', '/api/portal/login'].includes(path);
      const ip = req.socket.remoteAddress || 'unknown'; const time = Date.now();
      for (const [k, value] of quotas) if (value.until <= time) quotas.delete(k);
      const consume = (key, limit) => {
        if (!quotas.has(key) && quotas.size >= 10000) return false;
        const quota = quotas.get(key) || { count: 0, until: time + 60000 };
        quota.count++; quotas.set(key, quota); return quota.count <= limit;
      };
      const limited = () => { res.setHeader('Retry-After', '60'); return send(429, { code: 'RATE_LIMITED' }); };
      // A coarse IP ceiling still limits abuse. Normal authenticated traffic is
      // budgeted by verified account, not NAT address, cookie text or forged headers.
      if (!consume(`ip:${ip}:${isAuth ? 'auth' : 'general'}`, isAuth ? 12 : 1200)) return limited();
      const session = /(?:^|;\s*)yy_portal=([A-Za-z0-9_-]{43})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
      if (!isAuth) {
        let principal = null;
        if (session) {
          try { principal = service.rateLimitPrincipal(session); }
          catch (error) {
            // A stale cookie must not turn the public catalogue into an auth gate.
            if (error.code !== 'AUTH_REQUIRED' || req.method !== 'GET' || path !== '/api/portal/catalog') throw error;
          }
        }
        if (!consume(principal ? `principal:${principal}` : `anonymous:${ip}`, 180)) return limited();
      }
      if (req.method === 'GET') {
        if (path === '/api/portal/catalog') return send(200, service.catalog());
        if (path === '/api/portal/me') return send(200, { ...service.workspace(session), csrfToken: service.sessionCsrf(session) });
        if (path === '/api/portal/admin') return send(200, service.adminWorkspace(session));
        return send(404, { code: 'NOT_FOUND' });
      }
      if (req.method !== 'POST') return send(405, { code: 'METHOD_NOT_ALLOWED' });
      // Origin and custom header also protect login/registration before a session exists.
      if (!origins.includes(req.headers.origin) || req.headers['x-portal-client'] !== 'web' || !/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) return send(403, { code: 'ORIGIN_REJECTED' });
      if (Number(req.headers['content-length']) > 8192) return send(413, { code: 'BODY_TOO_LARGE' });
      let size = 0; const chunks = [];
      for await (const chunk of req) { size += chunk.length; if (size > 8192) return send(413, { code: 'BODY_TOO_LARGE' }); chunks.push(chunk); }
      let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return send(400, { code: 'INVALID_JSON' }); }
      if (isAuth) {
        if (activeAuth >= 2) return send(429, { code: 'RATE_LIMITED' }); activeAuth++;
        try {
          if (path === '/api/portal/register') return send(201, await service.register(body));
          const result = await service.login(body); res.setHeader('Set-Cookie', cookie(result.sessionToken));
          return send(200, { user: result.user, csrfToken: result.csrfToken });
        } finally { activeAuth--; }
      }
      const action = path.slice('/api/portal/'.length).replaceAll('/', '.');
      const result = service.perform(session, req.headers['x-csrf-token'] || '', action, body);
      if (action === 'logout') res.setHeader('Set-Cookie', cookie('', 0));
      return send(200, result);
    } catch (cause) { return send(cause.status || 500, { code: cause.status ? cause.code : 'SERVICE_UNAVAILABLE' }); }
  });
}
