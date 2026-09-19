import net from 'node:net';
import dns from 'node:dns';
import { syncBuiltinESMExports } from 'node:module';

// Test-process guard, not an OS sandbox. No subprocesses or untrusted code are
// executed by the onboarding runner. Only its explicitly registered listener
// may be contacted; other localhost services are deliberately not allowlisted.
export function installOfflineNetworkGuard() {
  const original = { fetch: globalThis.fetch, connect: net.Socket.prototype.connect, lookup: dns.lookup };
  const ports = new Set();
  let denied = 0;
  const reject = () => {
    denied++;
    throw Object.assign(new Error('Offline validation blocked an unregistered network destination.'), { code: 'MOCK_NETWORK_BLOCKED' });
  };
  const valid = (host, port) => host === '127.0.0.1' && ports.has(Number(port));
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.protocol !== 'http:' || url.username || url.password || !valid(url.hostname, url.port || 80)) reject();
    return original.fetch(input, { ...options, redirect: 'error' });
  };
  net.Socket.prototype.connect = function (...args) {
    const actual = Array.isArray(args[0]) ? args[0] : args;
    const option = actual[0];
    const host = typeof option === 'object' ? option.host : typeof actual[1] === 'string' ? actual[1] : undefined;
    const port = typeof option === 'object' ? option.port : option;
    if (option?.path || !valid(host, port)) reject();
    return Reflect.apply(original.connect, this, args);
  };
  dns.lookup = function (hostname, ...args) {
    if (hostname !== '127.0.0.1') reject();
    return Reflect.apply(original.lookup, this, [hostname, ...args]);
  };
  syncBuiltinESMExports();
  return {
    allowPort(port) {
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid local test port.');
      ports.add(port);
      return () => ports.delete(port);
    },
    get deniedAttempts() { return denied; },
    restore() {
      globalThis.fetch = original.fetch;
      net.Socket.prototype.connect = original.connect;
      dns.lookup = original.lookup;
      syncBuiltinESMExports();
    }
  };
}
