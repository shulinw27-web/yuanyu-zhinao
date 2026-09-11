// Offline replay of this project's synthetic v2 diagnostics only. No model,
// credentials, enterprise connectors or user conversations are accessed.
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { dictionary, samples } from '../examples/semantic-schemas/supply-chain-incident/scenario.mjs';
import { fullReadPlan } from '../examples/semantic-schemas/supply-chain-incident/read-plan.mjs';
import { createOntologyClaimContext, validateOntologyClaims, renderOntologyClaims } from '../backend/src/services/ontology-analysis-claims.js';
import { checkEvidenceRegression } from './ontology-evidence-regression-checks.mjs';

const base = resolve('output/ontology-model-ab');
const directory = resolve(process.argv[2] || base);
const rel = relative(base, directory);
if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('REPLAY_REQUIRES_SYNTHETIC_BATCH_DIRECTORY');
Object.assign(process.env, { NODE_ENV: 'test', RUNTIME_STORE_DRIVER: 'memory' });
const { discoverSchemasFromAttachments } = await import('../backend/src/services/semantic-schema-discovery-service.js');
const { executeOntologyReadPlan } = await import('../backend/src/services/ontology-read-plan-service.js');
const discovered = discoverSchemasFromAttachments({ attachments: [{ id: 'd', name: 'dictionary.json', mimeType: 'application/json' }], reports: [{ attachmentId: 'd', status: 'content_scanned', structuredSchemaCandidate: true }], documents: [{ attachmentId: 'd', text: JSON.stringify(dictionary) }] });
process.env.ONTOLOGY_RUNTIME_GRANTS_JSON = JSON.stringify({ 'demo-enterprise': { executive: { metadata: true, objects: Object.fromEntries(dictionary.tables.map(t => [t.name, { system: t.system, fields: t.fields.map(f => f.name), classifications: ['internal'] }])) } } });
const draft = { ...discovered, scenario: { readPlans: [fullReadPlan], requireCaseReplay: true }, accessPolicies: dictionary.tables.map(t => ({ objectType: t.name, effect: 'allow', roles: ['executive'], condition: 'iam_scope' })) };
const scope = { tenantId: 'demo-enterprise', subjectId: 'demo:executive:performance', source: 'demo_header' };
const contexts = new Map();
for (const absent of [false, true]) {
  const comparison = { target: 'RAW-N1', ...await executeOntologyReadPlan({ draft, plan: fullReadPlan, target: 'RAW-N1', roleId: 'executive', scope,
    retrieve: async (type, query) => samples.records.filter(r => (!absent || r.objectType !== 'Allocation') && r.objectType === type.id && query.filter.values.includes(r.payload[query.filter.field])) }) };
  contexts.set(absent, createOntologyClaimContext(comparison.records, [comparison], fullReadPlan));
}
const files = (await readdir(directory)).filter(name => /^\d{2}-(cause|finance|no-allocation)-.*\.json$/.test(name)).sort();
if (!files.length || files.length > 12) throw new Error('REPLAY_BATCH_SIZE_INVALID');
const rows = [];
for (const file of files) {
  const original = JSON.parse(await readFile(resolve(directory, file), 'utf8'));
  const context = contexts.get(original.case === 'no-allocation');
  const checked = validateOntologyClaims(original.syntheticProposal, context);
  const answer = checked.passed ? renderOntologyClaims(checked, context).text : null;
  const evidenceChecks = checkEvidenceRegression(answer, original.case);
  rows.push({ file, originalPassed: original.qualityChecksPassed, passed: checked.passed && evidenceChecks.passed,
    signals: checked.signals, evidenceChecks, answer });
}
const report = { syntheticOnly: true, modelCalls: 0, originalResultsUnchanged: true, allPassed: rows.every(r => r.passed), rows };
const output = resolve(directory, `replay-${Date.now()}.json`);
await writeFile(output, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ output, modelCalls: 0, samples: rows.length, passed: rows.filter(r => r.passed).length, failures: rows.filter(r => !r.passed).map(r => ({ file: r.file, signals: r.signals })) }));
if (!report.allPassed) process.exitCode = 1;
