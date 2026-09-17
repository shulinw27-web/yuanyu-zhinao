import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
const exec = promisify(execFile);

test('real SQLite CLI: preview, atomic approval, cross-process quota, revoke and portal read-only evidence', { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tenant-enrollment-test-'));
  const portalPath = join(directory, 'portal.db'); const runtimePath = join(directory, 'runtime.db');
  const providerPath = join(directory, 'identity-providers.local.json'); const manifestPath = join(directory, 'enrollment.local.json');
  const portal = { users: [{ id: 'p1', status: 'active' }], tenants: [{ id: 'sqlite-company', version: 1, status: 'sandbox_ready',
    members: [{ userId: 'p1', role: 'owner', status: 'active' }] }], provisioning: [{ id: 'job', tenantId: 'sqlite-company', tenantVersion: 1, requestedBy: 'p1', status: 'blocked' }] };
  const manifest = { version: 1, tenantId: 'sqlite-company', provisioningId: 'job', expectedPortalVersion: 1, expiresAt: Date.now() + 86400000,
    dailyRequests: 3, features: ['iam'], organizations: [{ id: 'org1', name: 'Synthetic', parentId: null }],
    users: [{ portalUserId: 'p1', account: 'synthetic@example.test', name: 'Synthetic', orgUnitId: 'org1', roleIds: ['executive'], primaryRoleId: 'executive', providerId: 'synthetic-sso', subject: 'employee' }] };
  const provider = { version: 1, defaultBearerProviderId: 'synthetic-sso', providers: [{ id: 'synthetic-sso', name: 'Synthetic', type: 'oidc', enabled: true,
    tenantId: 'sqlite-company', issuer: 'https://synthetic.example.test', audience: 'synthetic', jwksUri: 'https://synthetic.example.test/jwks', bindings: [{ account: 'synthetic@example.test', subject: 'employee' }] }] };
  const env = { ...process.env, NODE_ENV: 'test', RUNTIME_STORE_DRIVER: 'sqlite', RUNTIME_SQLITE_PATH: runtimePath, TENANT_PORTAL_DB: portalPath, IDENTITY_PROVIDERS_FILE: providerPath };
  const cli = async args => JSON.parse((await exec(process.execPath, ['scripts/tenant-runtime-control.mjs', ...args], { env, windowsHide: true })).stdout);
  try {
    const portalDb = new DatabaseSync(portalPath);
    try { portalDb.exec('CREATE TABLE runtime_state(namespace TEXT,state_key TEXT,value_json TEXT)'); portalDb.prepare('INSERT INTO runtime_state VALUES(?,?,?)').run('product_portal_v1', 'platform', JSON.stringify(portal)); }
    finally { portalDb.close(); }
    await writeFile(providerPath, JSON.stringify(provider)); await writeFile(manifestPath, JSON.stringify(manifest));
    const before = await readFile(portalPath);
    const preview = await cli(['prepare', manifestPath]);
    const uninitialized = new DatabaseSync(runtimePath, { readOnly: true });
    try { assert.equal(uninitialized.prepare('SELECT COUNT(*) AS n FROM runtime_state').get().n, 0); } finally { uninitialized.close(); }
    assert.equal((await cli(['apply', manifestPath, preview.approvalDigest])).revision, 1);
    assert.equal((await cli(['apply', manifestPath, preview.approvalDigest])).duplicate, true);
    const results = await Promise.all(Array.from({ length: 6 }, async () => JSON.parse((await exec(process.execPath, ['backend/test/helpers/tenant-runtime-usage-worker.mjs'], { env, windowsHide: true })).stdout)));
    assert.equal(results.filter(item => item.allowed).length, 3);
    assert.equal(results.filter(item => item.code === 'RUNTIME_DAILY_QUOTA_EXCEEDED').length, 3);
    assert.equal((await cli(['inspect', manifest.tenantId])).usage.count, 3);
    await cli(['revoke', manifest.tenantId, '1']);
    assert.equal((await cli(['inspect', manifest.tenantId])).status, 'revoked');
    assert.deepEqual(await readFile(portalPath), before);
    await assert.rejects(cli(['revoke', manifest.tenantId, '1']), error => error.stderr.includes('ENROLLMENT_REVISION_CONFLICT') && !error.stderr.includes(directory));
  } finally { await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});
