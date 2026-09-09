import { createHash } from 'node:crypto';

const relationSignature = (item) => `${item.from}:${item.predicate}:${item.to}:${item.cardinality || ''}`;

export const semanticShape = (draft = {}) => ({
  modelingProfile: draft.modelingProfile || 'oa-approval',
  scenario: draft.scenario || null,
  stateMachines: draft.stateMachines || [],
  events: draft.events || [],
  objectTypes: (draft.objectTypes || [])
    .map((item) => ({
      ...item,
      fields: [...(item.fields || [])].sort(),
      fieldDefinitions: [...(item.fieldDefinitions || [])].sort((a, b) => String(a.name).localeCompare(String(b.name))),
      sourceSystems: [...(item.sourceSystems || [])].sort()
    }))
    .sort((a, b) => String(a.id).localeCompare(String(b.id))),
  relationshipTypes: (draft.relationshipTypes || [])
    .map((item) => ({ ...item }))
    .sort((a, b) => relationSignature(a).localeCompare(relationSignature(b))),
  policies: [...(draft.policies || [])].sort(),
  metrics: [...(draft.metrics || [])].sort((a, b) => String(a.id).localeCompare(String(b.id))),
  glossaryTerms: [...(draft.glossaryTerms || [])].sort((a, b) => String(a.id).localeCompare(String(b.id))),
  dataContracts: [...(draft.dataContracts || [])].sort((a, b) => String(a.id).localeCompare(String(b.id))),
  qualityRules: [...(draft.qualityRules || [])].sort((a, b) => String(a.id).localeCompare(String(b.id))),
  accessPolicies: [...(draft.accessPolicies || [])].sort((a, b) => String(a.id).localeCompare(String(b.id))),
  lineageEdges: [...(draft.lineageEdges || [])].sort((a, b) => `${a.from}:${a.to}`.localeCompare(`${b.from}:${b.to}`))
});

export const semanticFingerprint = (draft) => createHash('sha256')
  .update(JSON.stringify(semanticShape(draft)))
  .digest('hex')
  .slice(0, 24);
