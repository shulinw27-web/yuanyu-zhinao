// Adapter registration is server-side code, never a dynamic module or endpoint
// selected by unverified JWT claims. Provider IDs are exact allowlist keys.
export function createIdentityProviderRegistry(adapters) {
  const entries = new Map();
  for (const adapter of adapters) {
    if (typeof adapter?.id !== 'string' || !/^[a-z][a-z0-9-]{0,47}$/.test(adapter.id) || entries.has(adapter.id) || typeof adapter.validateBinding !== 'function') throw new TypeError('Invalid or duplicate identity adapter.');
    entries.set(adapter.id, Object.freeze(adapter));
  }
  return Object.freeze({
    get: (id) => entries.get(id) || null,
    list: () => [...entries.values()].map(({ id, type, name, configured, capabilities }) => ({ id, type, name, configured, capabilities }))
  });
}
