// Generates an isolated cross-system fixture from the project's stateful Mock
// runtime. Run this module with backend/test/runtime-test-bootstrap.js so it
// never reads or changes the desktop application's SQLite runtime.
import {
  getMockSystemRecords,
  resetMockSimulation,
  runMockScenario
} from '../../backend/src/services/mock-scenario-service.js';

const SYSTEMS = ['lims', 'mes', 'erp', 'qms', 'oms'];
const SCENARIOS = [
  'quality_batch_exception',
  'inventory_supply_risk',
  'order_fulfillment_risk'
];

resetMockSimulation('executive');
const generated = SCENARIOS.map((id) => runMockScenario(id, 'executive'));

const records = SYSTEMS.flatMap((systemId) => getMockSystemRecords(systemId))
  .filter((record) => record.runtime && generated.some((item) => item.run.id === record.payload?.runId));

// OA only produces an approval object in this Mock; represent it as a source
// fact so the semantic test can verify the complete source-to-decision chain.
const approvals = generated.map((item) => ({
  id: item.approval.id,
  system: 'OA',
  objectType: 'Approval',
  eventType: 'ApprovalCreated',
  status: item.approval.status,
  classification: '流程受限',
  occurredAt: item.approval.createdAt,
  runtime: true,
  payload: {
    subject: item.approval.subject,
    scenarioId: item.approval.scenarioId,
    runId: item.approval.runId,
    title: item.approval.title,
    approverRoles: item.approval.approverRoles
  }
}));

const scenarios = generated.map((item) => ({
  id: item.run.scenarioId,
  runId: item.run.id,
  businessKey: item.run.businessKey,
  approvalId: item.approval.id,
  systems: [...new Set(records.filter((record) => record.payload?.runId === item.run.id).map((record) => record.system).concat('OA'))]
}));

process.stdout.write(JSON.stringify({
  fixture: 'stateful_mock_connector_data',
  generatedAt: new Date().toISOString(),
  records: records.concat(approvals),
  scenarios
}));
