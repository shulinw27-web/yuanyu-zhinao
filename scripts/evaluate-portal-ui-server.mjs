import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { multitenantFixture } from '../backend/test/helpers/multitenant-fixture.js';
import { createProductPortalServer } from '../backend/src/http/product-portal-server.js';

if (process.env.NODE_ENV !== 'test' || process.env.RUNTIME_STORE_DRIVER !== 'memory' || !process.argv.includes('--synthetic')) throw new Error('Explicit synthetic memory mode required.');
const fixture = multitenantFixture({ provisioningInspector: async () => [
  { id: 'semantic_instance', status: 'passed', code: 'SYNTHETIC_INSTANCE' },
  ...['business_iam', 'runtime_entitlements', 'runtime_revocation'].map(id => ({ id, status: 'blocked', code: 'SYNTHETIC_BLOCKER' }))
] });
const a = fixture.tenant('alice'); const b = fixture.tenant('bob');
for (const tenantId of [a, b]) fixture.act('root', 'admin.tenant', { tenantId, expectedVersion: 1, status: 'sandbox_ready' });
fixture.invite('bob', b, 'alice', 'member');
const root = resolve('apps/product-portal/dist');
const api = createProductPortalServer({ service: fixture.service, origins: ['http://127.0.0.1:16197'] });
const apiHandler = api.listeners('request')[0];
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (path.startsWith('/api/portal/')) return apiHandler(req, res);
  if (path === '/synthetic/alice') {
    res.writeHead(302, { 'Set-Cookie': `yy_portal=${fixture.sessions.alice.token}; HttpOnly; SameSite=Strict; Path=/api/portal`, Location: '/#/console' }); res.end(); return;
  }
  if (path === '/synthetic/check') {
    const job = fixture.workspace('alice').tenants.find(tenant => tenant.id === a)?.provisioning;
    if (job) await fixture.service.inspectProvisioning(job.id);
    res.writeHead(302, { Location: '/#/console' }); res.end(); return;
  }
  const file = resolve(root, `.${path === '/' ? '/index.html' : path}`);
  if (!file.startsWith(root + sep)) { res.writeHead(404); res.end(); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' })[extname(file)] || 'application/octet-stream' }); res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
server.listen(16197, '127.0.0.1', () => console.log('Synthetic portal UI: http://127.0.0.1:16197/synthetic/alice (no real accounts/database)'));
