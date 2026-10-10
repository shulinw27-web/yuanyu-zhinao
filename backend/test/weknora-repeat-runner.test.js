import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRepeatOptions, repeatWeKnoraTests } from '../../scripts/repeat-weknora-regression.mjs';

test('repeat diagnostics bound workload and reject unknown, missing and invalid options', () => {
  assert.deepEqual(parseRepeatOptions([]), { rounds: 12, concurrency: 2 });
  assert.deepEqual(parseRepeatOptions(['--rounds', '3', '--concurrency', '1']), { rounds: 3, concurrency: 1 });
  for (const args of [['--rounds'], ['--rounds', '31'], ['--concurrency', '5'], ['--rounds', 'NaN'], ['--secret', '1'], ['--rounds', '0']]) assert.throws(() => parseRepeatOptions(args));
});

test('every round runs once, concurrency stays bounded and an intermittent failure remains visible', async () => {
  let active = 0; let max = 0; const seen = [];
  const result = await repeatWeKnoraTests({ rounds: 5, concurrency: 2 }, async round => {
    active++; max = Math.max(max, active); seen.push(round);
    await new Promise(resolve => setTimeout(resolve, 2)); active--;
    return { passed: round !== 3, failedTests: round === 3 ? ['synthetic failure'] : [] };
  });
  assert.equal(max, 2); assert.deepEqual(seen.sort(), [1, 2, 3, 4, 5]);
  assert.equal(result.passed, 4); assert.equal(result.failures[0].round, 3);
  assert.equal(result.conclusion, 'failure_reproduced_requires_investigation');
});

test('passing repetitions explicitly do not claim the underlying issue is fixed', async () => {
  const result = await repeatWeKnoraTests({ rounds: 2, concurrency: 1 }, async () => ({ passed: true }));
  assert.equal(result.passed, 2); assert.equal(result.conclusion, 'not_reproduced_not_proof_of_fix');
});
