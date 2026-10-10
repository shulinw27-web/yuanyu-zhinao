// Bounded, isolated diagnostic runs. Never retries a production request or changes its timeout.
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function parseRepeatOptions(args) {
  const options = { rounds: 12, concurrency: 2 };
  for (let i = 0; i < args.length; i += 2) {
    const key = { '--rounds': 'rounds', '--concurrency': 'concurrency' }[args[i]];
    const value = Number(args[i + 1]);
    if (!key || !/^\d+$/u.test(args[i + 1] || '') || !Number.isInteger(value) || value < 1 || value > (key === 'rounds' ? 30 : 4)) throw new Error('WEKNORA_REPEAT_OPTIONS_INVALID');
    options[key] = value;
  }
  return options;
}

export async function repeatWeKnoraTests(options, run) {
  const rows = []; let next = 0;
  await Promise.all(Array.from({ length: Math.min(options.concurrency, options.rounds) }, async () => {
    while (next < options.rounds) {
      const round = ++next;
      rows.push({ round, ...await run(round) });
    }
  }));
  rows.sort((a, b) => a.round - b.round);
  return { scope: 'isolated_mock_http_not_live_provider', rounds: options.rounds, concurrency: options.concurrency,
    passed: rows.filter(row => row.passed).length, failures: rows.filter(row => !row.passed),
    conclusion: rows.every(row => row.passed) ? 'not_reproduced_not_proof_of_fix' : 'failure_reproduced_requires_investigation' };
}

function runIsolatedTest() {
  return new Promise(resolveResult => {
    const start = performance.now(); let output = ''; let timedOut = false;
    const child = spawn(process.execPath, ['--import', './backend/test/runtime-test-bootstrap.js', '--test', '--test-reporter=tap', 'backend/test/knowledge-evidence.test.js'],
      { cwd: resolve(import.meta.dirname, '..'), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 45000);
    const capture = bytes => { if (output.length < 262144) output += bytes.toString().slice(0, 262144 - output.length); };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
    child.once('error', () => { clearTimeout(timer); resolveResult({ passed: false, code: 'TEST_PROCESS_START_FAILED' }); });
    child.once('close', code => {
      clearTimeout(timer);
      // Only test names and explicit fixture diagnostics are emitted, never raw TAP bodies,
      // source excerpts, credentials or configuration.
      const failedTests = output.split(/\r?\n/u).filter(line => /^not ok \d+ - /u.test(line)).map(line => line.replace(/^not ok \d+ - /u, '').slice(0, 240));
      const diagnostics = output.split(/\r?\n/u).filter(line => line.includes('WK_MOCK_DIAGNOSTIC=')).slice(0, 4).map(line => {
        try { return JSON.parse(line.split('WK_MOCK_DIAGNOSTIC=')[1]); } catch { return { code: 'DIAGNOSTIC_PARSE_FAILED' }; }
      });
      resolveResult({ passed: code === 0 && !timedOut, exitCode: code, timedOut, elapsedMs: Math.round(performance.now() - start), failedTests, diagnostics });
    });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await repeatWeKnoraTests(parseRepeatOptions(process.argv.slice(2)), runIsolatedTest);
    console.log(JSON.stringify(result, null, 2)); process.exitCode = result.failures.length ? 1 : 0;
  } catch { console.error('WEKNORA_REPEAT_OPTIONS_INVALID'); process.exitCode = 2; }
}
