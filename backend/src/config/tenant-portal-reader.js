import { isAbsolute } from 'node:path';
import { statSync } from 'node:fs';

// Deployment-owned path only. Never accept a database path from an HTTP request.
export async function readTenantPortalState(env = process.env) {
  const path = env.TENANT_PORTAL_DB;
  if (!path || !isAbsolute(path) || !statSync(path).isFile()) throw new Error('PORTAL_BRIDGE_UNAVAILABLE');
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 1000;');
    const row = db.prepare('SELECT value_json FROM runtime_state WHERE namespace = ? AND state_key = ? AND length(value_json) <= ?')
      .get('product_portal_v1', 'platform', 8 * 1024 * 1024);
    if (!row) throw new Error('PORTAL_BRIDGE_UNAVAILABLE');
    return JSON.parse(row.value_json);
  } finally { db.close(); }
}
