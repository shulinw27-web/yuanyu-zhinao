// Explicit HUMAN-reviewed test setup, not an Agent capability or production grant.
export async function prepareReviewedCalculationFixture(api) {
  if (process.env.NODE_ENV !== 'test' || process.env.RUNTIME_STORE_DRIVER !== 'memory' || !process.env.NODE_TEST_CONTEXT) throw new Error('Reviewed fixture requires isolated test memory storage.');
  const { onboardingMaterials } = await import('../../examples/mock-onboarding/materials.mjs');
  const { onboardingAlignment } = await import('../../examples/mock-onboarding/alignment.mjs');
  const { plan } = await import('../../examples/knowledge/dual-agent-mock/scenario.mjs');
  const { runWithIAMStoreContext } = await import('../../backend/src/services/iam-store.js');
  const { runWithSemanticTenant } = await import('../../backend/src/services/semantic-tenant-context.js');
  const { getRole } = await import('../../backend/src/services/authorization-service.js');
  const { issueSemanticOperationsTaskConfirmation, executeSemanticOperationsTask } = await import('../../backend/src/services/semantic-operations-task-service.js');
  const { getOAMetaModelDraft, saveOAMetaModelDraft } = await import('../../backend/src/services/meta-model-service.js');
  const tenantId = 'mock-onboarding-a';
  const checked = async (path, body) => { const result = await api.call(tenantId, path, body); if (result.status >= 400) throw new Error(`Synthetic fixture failed: ${result.body.code || result.status}`); return result.body; };
  let project = (await checked('', { scenarioId: 'fulfillment', name: '人工方案 · 草稿试算验证' })).project;
  for (const material of onboardingMaterials('fulfillment', tenantId)) project = (await checked(`/${project.id}/materials`, { ...material, expectedRevision: project.revision })).project;
  const metadata = await checked(`/${project.id}/alignment`); const source = metadata.evidenceSources.find(item => item.kind === 'rules');
  const config = onboardingAlignment('fulfillment');
  for (const category of ['identities', 'units', 'states']) for (const rule of config[category]) rule.materialEvidence = { kind: 'rules', digest: source.digest, quote: source.text.slice(0, 80) };
  project = (await checked(`/${project.id}/alignment`, { expectedRevision: project.revision, config })).project;
  project = (await checked(`/${project.id}/connection`, { expectedRevision: project.revision, faultMode: 'none' })).project;
  const handoff = await checked(`/${project.id}/handoff`, { expectedRevision: project.revision }); project = handoff.project;
  const identityScope = { tenantId, subjectId: 'admin@demo.local', source: 'test' };
  await runWithIAMStoreContext(() => runWithSemanticTenant(identityScope, async () => {
    const confirmation = await issueSemanticOperationsTaskConfirmation({ taskId: handoff.taskId, identityScope });
    const applied = await executeSemanticOperationsTask({ taskId: handoff.taskId, identityScope, role: getRole('executive'), confirmationToken: confirmation.confirmationToken });
    if (applied.error || applied.result?.error) throw new Error('Synthetic candidate adoption failed.');
    const draft = await getOAMetaModelDraft();
    const types = new Set(applied.result.proposal.objectTypes.map(item => item.id));
    const objects = draft.objectTypes.filter(item => types.has(item.id));
    draft.scenario = { objective: '合成跨系统人工计算验证', questions: ['履约和信用缺口是多少？'], actionBindings: [], requireCaseReplay: true, decisionBindings: [], readPlans: [plan] };
    draft.accessPolicies = objects.map(item => ({ objectType: item.id, roles: ['executive'], effect: 'allow', condition: 'iam_scope' }));
    const saved = await saveOAMetaModelDraft(draft, getRole('executive')); if (saved.error) throw new Error(saved.error);
    process.env.ONTOLOGY_RUNTIME_GRANTS_JSON = JSON.stringify({ [tenantId]: { executive: { objects: Object.fromEntries(objects.map(item => [item.id, { system: item.sourceSystems[0], fields: item.fields, classifications: ['internal'] }])) } } });
  }), tenantId);
  return { projectId: project.id, target: 'ORD-T900', method: 'scripted_human_review_and_test_grants', published: false };
}
