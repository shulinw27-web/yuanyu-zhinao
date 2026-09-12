import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { retrieveEnterpriseKnowledge, retrieveEnterpriseKnowledgeBaseline } from '../backend/src/services/enterprise-knowledge-service.js';

const raw = readFileSync(new URL('../examples/knowledge/lexical-baseline.json', import.meta.url), 'utf8');
const fixture = JSON.parse(raw);
const check = (item, results) => {
  const ids = results.map(result => result.id);
  return (!item.expected || item.expected.every(id => ids.includes(id)))
    && (!item.forbidden || item.forbidden.every(id => !ids.includes(id))) && (!item.empty || !ids.length);
};
const rows = fixture.cases.map((item, index) => {
  const output = {};
  // Alternate ordering to reduce systematic warm-up bias; timings remain
  // diagnostic single samples, not a stable latency claim.
  for (const name of index % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
    const retrieve = name === 'baseline' ? retrieveEnterpriseKnowledgeBaseline : retrieveEnterpriseKnowledge;
    const start = performance.now();
    const response = retrieve(item.query, item.role, fixture.limit);
    output[name] = { passed: check(item, response.results), ids: response.results.map(result => result.id), elapsedMs: Math.round((performance.now() - start) * 1000) / 1000 };
  }
  return { id: item.id, ...output };
});
const summarize = name => ({ total: rows.length, passed: rows.filter(row => row[name].passed).length,
  positiveHitAt3: rows.filter((row, index) => fixture.cases[index].expected && row[name].passed).length,
  positiveCases: fixture.cases.filter(item => item.expected).length,
  boundaryPassed: rows.filter((row, index) => !fixture.cases[index].expected && row[name].passed).length,
  boundaryCases: fixture.cases.filter(item => !item.expected).length });
const report = { schemaVersion: fixture.schemaVersion, fixtureHash: createHash('sha256').update(raw).digest('hex'),
  scope: 'synthetic_seed_retrieval_only_no_llm_no_weknora_deployment', baseline: summarize('baseline'), candidate: summarize('candidate'), rows };
console.log(JSON.stringify(report, null, 2));
if (rows.some(row => !row.candidate.passed)) process.exitCode = 1;
