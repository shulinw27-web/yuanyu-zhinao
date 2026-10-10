import test from 'node:test';
import assert from 'node:assert/strict';
import { retrySqliteStartup } from '../src/repositories/sqlite-startup-retry.js';

test('startup retries only SQLite busy/locked and preserves successful setup result', () => {
  let attempts = 0; let time = 0;
  assert.equal(retrySqliteStartup(() => { if (++attempts < 3) throw { errcode: 5 }; return 'ready'; }, { now: () => time, wait: ms => { time += ms; } }), 'ready');
  assert.equal(attempts, 3); assert.equal(time, 50);
  const failure = Object.assign(new Error('schema incompatible'), { errcode: 1 });
  assert.throws(() => retrySqliteStartup(() => { throw failure; }, { wait: () => assert.fail('must not retry') }), error => error === failure);
});

test('startup retry is attempt/deadline bounded and preserves the original lock error', () => {
  const locked = Object.assign(new Error('locked'), { errcode: 6 }); let attempts = 0;
  assert.throws(() => retrySqliteStartup(() => { attempts++; throw locked; }, { now: () => 0, wait() {} }), error => error === locked);
  assert.equal(attempts, 32);
  let time = 0; attempts = 0;
  assert.throws(() => retrySqliteStartup(() => { attempts++; time += 5000; throw locked; }, { now: () => time, wait: () => assert.fail('deadline exhausted') }), error => error === locked);
  assert.equal(attempts, 1);
});
