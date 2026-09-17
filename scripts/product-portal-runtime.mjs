import { resolve } from 'node:path';
import { createProductPortalService } from '../backend/src/services/product-portal-service.js';
import { createProductPortalServer } from '../backend/src/http/product-portal-server.js';

// This release cannot accept real funds. Never expose it by changing NODE_ENV or a payment flag.
if (process.env.NODE_ENV === 'production') throw new Error('PORTAL_PRODUCTION_NOT_READY: complete payment, identity and provisioning gates first.');
process.env.RUNTIME_STORE_DRIVER = 'sqlite';
process.env.RUNTIME_SQLITE_PATH = resolve(process.env.PORTAL_SQLITE_PATH || 'backend/.data/product-portal.db');
const { readState, mutateState } = await import('../backend/src/repositories/runtime-state-repository.js');
const service = createProductPortalService({
  read: initial => readState('product_portal_v1', 'platform', initial),
  mutate: (initial, callback) => mutateState('product_portal_v1', 'platform', initial, callback),
  sandboxPayments: process.argv.includes('--sandbox-payments')
});
if (process.argv.includes('--check-provisioning')) {
  const id = process.argv[process.argv.indexOf('--check-provisioning') + 1];
  if (!id || id.startsWith('--')) throw new Error('Provide an existing portal provisioning request ID.');
  const result = await service.inspectProvisioning(id);
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = !result.resultDiscarded && result.provisioning.status === 'preflight_ready' ? 0 : 2;
} else if (process.argv.includes('--admin-email')) {
  const email = process.argv[process.argv.indexOf('--admin-email') + 1];
  if (!email) throw new Error('Provide an existing registered account email.');
  const user = service.bootstrapAdmin(email);
  console.log(`Platform admin enabled for ${user.email}. Existing sessions revoked; sign in again.`);
} else {
  const port = Number(process.env.PORTAL_API_PORT || 15196);
  const server = createProductPortalServer({ service });
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  server.listen(port, '127.0.0.1', () => console.log(`Yuanyu product portal API: http://127.0.0.1:${port}/api/portal/catalog (local sandbox, no real payments)`));
}
