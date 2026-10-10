// Idempotent startup DDL only. Never wrap business writes or lease acquisition.
export function retrySqliteStartup(setup, { now = Date.now, wait = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) } = {}) {
  const deadline = now() + 5000;
  for (let attempt = 0; ; attempt++) {
    try { return setup(); }
    catch (error) {
      if (![5, 6].includes(error?.errcode) || attempt >= 31 || now() >= deadline) throw error;
      wait(Math.min(25, Math.max(0, deadline - now())));
    }
  }
}
