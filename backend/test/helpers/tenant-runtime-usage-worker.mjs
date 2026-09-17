import { createTenantRuntimeControl } from '../../src/services/tenant-runtime-control-service.js';
if (process.env.NODE_ENV !== 'test') throw new Error('Synthetic worker only');
try {
  await createTenantRuntimeControl().authorize({ tenantId: 'sqlite-company', subjectId: 'synthetic@example.test' }, { feature: 'iam', consume: true });
  console.log(JSON.stringify({ allowed: true }));
} catch (error) { console.log(JSON.stringify({ allowed: false, code: error.code })); }
