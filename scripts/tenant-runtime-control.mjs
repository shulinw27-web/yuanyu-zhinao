import { readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';

// Explicitly configured sandbox databases only; never initialize an accidental default DB.
try {
  if (process.env.NODE_ENV === 'production' || !isAbsolute(process.env.RUNTIME_SQLITE_PATH || '') || !isAbsolute(process.env.TENANT_PORTAL_DB || '')) throw new Error('SANDBOX_DATABASE_PATHS_REQUIRED');
  if (process.env.RUNTIME_STORE_DRIVER && process.env.RUNTIME_STORE_DRIVER !== 'sqlite') throw new Error('SQLITE_SANDBOX_ONLY');
  process.env.RUNTIME_STORE_DRIVER = 'sqlite';
  const { createTenantRuntimeControl } = await import('../backend/src/services/tenant-runtime-control-service.js');
  const service = createTenantRuntimeControl();
  const [command, target, confirmation] = process.argv.slice(2);
  if (!target || target.startsWith('--')) throw new Error('COMMAND_TARGET_REQUIRED');
  let result;
  if (['prepare', 'apply'].includes(command)) {
    if (!isAbsolute(target || '') || statSync(target).size > 128 * 1024) throw new Error('MANIFEST_FILE_INVALID');
    const input = JSON.parse(readFileSync(target, 'utf8').replace(/^\uFEFF/, ''));
    if (command === 'prepare') { const prepared = await service.prepare(input); result = { ...prepared.summary, approvalDigest: prepared.digest }; }
    else result = await service.apply(input, confirmation);
  } else if (command === 'inspect') result = await service.inspect(target);
  else if (command === 'revoke') result = await service.revoke(target, Number(confirmation));
  else throw new Error('COMMAND_INVALID');
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(JSON.stringify({ status: 'failed', code: /^[A-Z0-9_]{1,80}$/.test(error.code || error.message || '') ? (error.code || error.message) : 'TENANT_RUNTIME_CONTROL_FAILED' }));
  process.exitCode = 1;
}
