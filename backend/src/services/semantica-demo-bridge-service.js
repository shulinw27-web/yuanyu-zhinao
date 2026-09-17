import { getMockScenarioSemanticFacts } from './mock-scenario-service.js';
import { semanticFingerprint } from './semantic-model-fingerprint.js';
import { currentSemanticTenant } from './semantic-tenant-context.js';
import { semanticInstanceConnection, requestSemanticInstance } from './semantic-instance-transport.js';

const isEnabled = () => process.env.SEMANTICA_DEMO_BRIDGE_ENABLED === 'true' || (!process.env.NODE_ENV || process.env.NODE_ENV === 'development');

function unavailable(reason, detail) {
  return { status: 'unavailable', engine: 'local-projection', reason, detail, checkedAt: new Date().toISOString() };
}

function boundary(connection) {
  const reason = connection.reason || (!isEnabled() ? 'bridge_disabled' : null);
  return reason ? { ...unavailable(reason, '语义实例未启用、未绑定或配置无效；未访问共享图。'), requestAttempted: false } : null;
}

function requestFailure(error) {
  return { ...unavailable(error.message, '语义实例连接或身份回执校验未通过；未返回实例数据。'), requestAttempted: error.requestAttempted === true };
}

export async function syncMockScenarioToSemantica(runId) {
  const connection = semanticInstanceConnection(); const blocked = boundary(connection); if (blocked) return blocked;
  // The existing fixture store has no tenant provenance. Never copy its runs into a new tenant.
  if (currentSemanticTenant() !== 'demo-enterprise') return { ...unavailable('tenant_fixture_unavailable', '共享 Demo 演练事实尚未具备租户来源证明，未导入独立实例。'), requestAttempted: false };
  const fixture = await getMockScenarioSemanticFacts(runId);
  if (fixture.error) return unavailable('run_not_found', fixture.error);
  try {
    const result = await requestSemanticInstance(connection, '/demo/ingest', {
      method: 'POST',
      body: {
        runId,
        scenarioId: fixture.run.scenarioId,
        businessKey: fixture.businessKey,
        expectedSystems: fixture.expectedSystems,
        facts: fixture.facts
      }
    });
    return {
      status: result.status === 'verified' && result.validation?.passed ? 'verified' : 'failed',
      engine: result.engine || 'semantica',
      ingestedFacts: result.ingestedFacts || 0,
      graph: result.graph,
      run: result.run,
      validation: result.validation,
      checkedAt: new Date().toISOString()
    };
  } catch (error) {
    return requestFailure(error);
  }
}

export async function resetSemanticaDemoGraph() {
  const connection = semanticInstanceConnection(); const blocked = boundary(connection); if (blocked) return blocked;
  try {
    const result = await requestSemanticInstance(connection, '/demo/reset', { method: 'POST' });
    return { status: 'reset', engine: result.engine || 'semantica', graph: result.graph, checkedAt: new Date().toISOString() };
  } catch (error) {
    return requestFailure(error);
  }
}

export async function getSemanticaModelDiscovery() {
  const connection = semanticInstanceConnection(); const blocked = boundary(connection); if (blocked) return blocked;
  try {
    const result = await requestSemanticInstance(connection, '/demo/model-candidates');
    return {
      status: result.status || 'observed', engine: result.engine || 'semantica', graph: result.graph,
      observedRunCount: result.observedRunCount || 0, candidateObjects: result.candidateObjects || [],
      candidateRelationships: result.candidateRelationships || [], boundary: result.boundary,
      checkedAt: new Date().toISOString()
    };
  } catch (error) {
    return requestFailure(error);
  }
}

export async function getSemanticaModelDeployment() {
  const connection = semanticInstanceConnection(); const blocked = boundary(connection); if (blocked) return blocked;
  try {
    return await requestSemanticInstance(connection, '/demo/model-definition');
  } catch (error) {
    return requestFailure(error);
  }
}

const semanticDefinition = (model, version = 'draft') => ({
  id: model.id,
  code: model.code,
  version,
  sourceFingerprint: semanticFingerprint(model),
  modelingProfile: model.modelingProfile || 'oa-approval',
  scenario: model.scenario || null,
  ...(model.worldModel ? { worldModel: model.worldModel } : {}),
  stateMachines: model.stateMachines || [],
  events: model.events || [],
  objectTypes: model.objectTypes,
  relationshipTypes: model.relationshipTypes,
  metrics: model.metrics || [],
  glossaryTerms: model.glossaryTerms || [],
  dataContracts: model.dataContracts || [],
  qualityRules: model.qualityRules || [],
  accessPolicies: model.accessPolicies || [],
  lineageEdges: model.lineageEdges || []
});

export async function validateSemanticaModelDefinition(model) {
  const connection = semanticInstanceConnection(); const blocked = boundary(connection); if (blocked) return blocked;
  try {
    const result = await requestSemanticInstance(connection, '/demo/model-definition/validate', { method: 'POST', body: { definition: semanticDefinition(model) } });
    return { ...result, checkedAt: new Date().toISOString() };
  } catch (error) {
    return requestFailure(error);
  }
}

export async function publishSemanticaModelDefinition(model, version) {
  const connection = semanticInstanceConnection(); const blocked = boundary(connection); if (blocked) return blocked;
  try {
    const result = await requestSemanticInstance(connection, '/demo/model-definition/publish', { method: 'POST', body: { definition: semanticDefinition(model, version) } });
    return { ...result, requestAttempted: true, checkedAt: new Date().toISOString() };
  } catch (error) {
    return requestFailure(error);
  }
}
