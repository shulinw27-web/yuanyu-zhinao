import { runAuditIntegrityInspection } from '../../backend/src/services/audit-governance-service.js';

const report = await runAuditIntegrityInspection();
process.stdout.write(`${JSON.stringify({ service: 'audit-integrity-worker', event: 'inspection_cycle', ...report })}\n`);
if (report.status === 'failed') process.exitCode = 1;
