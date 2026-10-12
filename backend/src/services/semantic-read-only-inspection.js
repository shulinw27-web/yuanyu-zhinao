import { getRole } from './authorization-service.js';
import { getMetaModel, getOAMetaModelDraft, getSemanticaModelDeployment } from '../domains/governance/public-api.js';
import { discoverSemanticSources } from './semantic-source-discovery-service.js';
import { currentSemanticModel, DEFAULT_SEMANTIC_MODEL_ID } from './semantic-tenant-context.js';
import { semanticModelReferenceMatches, assertCurrentSemanticModelAdmission } from './semantic-model-reference.js';

export async function inspectSemanticReadOnly(schedule) {
  const independent = currentSemanticModel() !== DEFAULT_SEMANTIC_MODEL_ID;
  const allowed = independent ? ['schema_integrity', 'mapping_coverage'] : ['source_readiness', 'schema_integrity', 'deployment_drift', 'mapping_coverage'];
  if (!semanticModelReferenceMatches(schedule) || !Array.isArray(schedule.checks) || !schedule.checks.length
    || schedule.checks.some(check => !allowed.includes(check))) throw new Error('SEMANTIC_INSPECTION_BINDING_INVALID');
  await assertCurrentSemanticModelAdmission();
  const role = getRole(schedule.roleId);
  if (!role) throw new Error('SEMANTIC_INSPECTION_ROLE_INVALID');
  const findings = [];
  for (const check of schedule.checks) {
    if (check === 'source_readiness') {
      const sources = discoverSemanticSources({ request: '', role, includeAllRegistered: true });
      findings.push({ check, status: sources.blockers.length ? 'warning' : 'passed', metric: `${sources.sources.length} sources / ${sources.blockers.length} blockers` });
    } else if (check === 'schema_integrity') {
      const draft = await getOAMetaModelDraft();
      const objectIds = new Set(draft.objectTypes.map(item => item.id));
      const broken = draft.relationshipTypes.filter(item => !objectIds.has(item.from) || !objectIds.has(item.to));
      findings.push({ check, status: broken.length ? 'warning' : 'passed', metric: `${draft.objectTypes.length} objects / ${broken.length} broken relations` });
    } else if (check === 'deployment_drift') {
      const deployment = await getSemanticaModelDeployment(await getMetaModel('oa-governance'));
      findings.push({ check, status: ['in_sync', 'published'].includes(deployment.drift || deployment.status) ? 'passed' : 'warning', metric: deployment.drift || deployment.status || 'unknown' });
    } else {
      const draft = await getOAMetaModelDraft();
      const fields = draft.objectTypes.flatMap(item => item.fieldDefinitions || []);
      const pending = fields.filter(field => field.mappingStatus === 'pending' || (!field.sourceField && !['derived', 'ignored'].includes(field.mappingStatus))).length;
      findings.push({ check, status: pending ? 'warning' : 'passed', metric: `${fields.length - pending}/${fields.length} mapped` });
    }
  }
  await assertCurrentSemanticModelAdmission();
  const warningCount = findings.filter(item => item.status === 'warning').length;
  return { severity: warningCount ? 'warning' : 'info', summary: warningCount ? `只读巡检发现 ${warningCount} 项待复核结果。` : '只读语义巡检全部通过。', findings };
}
