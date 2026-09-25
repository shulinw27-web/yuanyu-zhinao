import { randomUUID } from 'node:crypto';
import { loadRuntimeConfiguration } from '../../backend/src/config/runtime-config.js';
import { configureRuntimeDependencies } from '../../backend/src/config/runtime-dependencies.js';
import { getRole } from '../../backend/src/services/authorization-service.js';
import { getMetaModel, getOAMetaModelDraft } from '../../backend/src/services/meta-model-service.js';
import { getSemanticaModelDeployment } from '../../backend/src/services/semantica-demo-bridge-service.js';
import { discoverSemanticSources } from '../../backend/src/services/semantic-source-discovery-service.js';
import { runSemanticInspectionCycle } from '../../backend/src/services/semantic-inspection-schedule-service.js';

export async function inspectSemanticReadOnly(schedule) {
  const role = getRole(schedule.roleId);
  const findings = [];
  for (const check of schedule.checks) {
    if (check === 'source_readiness') {
      // 只读巡检的语义就是「检视全部已登记来源」，因此**显式**请求全量范围。
      // 阶段 3 之后来源发现不再有「推断为空 → 回落全部可访问连接器」的行为，
      // 全量必须由调用方声明，不能靠传一句包含系统名的文本碰巧命中。
      const sources = discoverSemanticSources({ request: '', role, includeAllRegistered: true });
      findings.push({ check, status: sources.blockers.length ? 'warning' : 'passed', metric: `${sources.sources.length} sources / ${sources.blockers.length} blockers` });
    } else if (check === 'schema_integrity') {
      const draft = await getOAMetaModelDraft();
      const objectIds = new Set(draft.objectTypes.map((item) => item.id));
      const broken = draft.relationshipTypes.filter((item) => !objectIds.has(item.from) || !objectIds.has(item.to));
      findings.push({ check, status: broken.length ? 'warning' : 'passed', metric: `${draft.objectTypes.length} objects / ${broken.length} broken relations` });
    } else if (check === 'deployment_drift') {
      const deployment = await getSemanticaModelDeployment(await getMetaModel('oa-governance'));
      findings.push({ check, status: ['in_sync', 'published'].includes(deployment.drift || deployment.status) ? 'passed' : 'warning', metric: deployment.drift || deployment.status || 'unknown' });
    } else if (check === 'mapping_coverage') {
      const draft = await getOAMetaModelDraft();
      const fields = draft.objectTypes.flatMap((item) => item.fieldDefinitions || []);
      const pending = fields.filter((field) => field.mappingStatus === 'pending' || (!field.sourceField && !['derived', 'ignored'].includes(field.mappingStatus))).length;
      findings.push({ check, status: pending ? 'warning' : 'passed', metric: `${fields.length - pending}/${fields.length} mapped` });
    }
  }
  const warningCount = findings.filter((item) => item.status === 'warning').length;
  return { severity: warningCount ? 'warning' : 'info', summary: warningCount ? `只读巡检发现 ${warningCount} 项待复核结果。` : '只读语义巡检全部通过。', findings };
}

const runtimeDependencies = await configureRuntimeDependencies(loadRuntimeConfiguration());
const once = process.argv.includes('--once');
const workerId = `semantic-inspection-worker-${randomUUID()}`;
let running = false;
const run = async () => {
  if (running) return { skipped: true };
  running = true;
  try {
    const result = await runSemanticInspectionCycle({ workerId, executeInspection: inspectSemanticReadOnly });
    process.stdout.write(`${JSON.stringify({ service: 'semantic-inspection-worker', event: 'cycle_completed', ...result })}\n`);
    return result;
  } finally { running = false; }
};
if (once) { await run(); await runtimeDependencies.close(); }
else {
  await run();
  const timer = setInterval(() => void run(), 30_000);
  const stop = async () => { clearInterval(timer); await runtimeDependencies.close(); process.exit(0); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
