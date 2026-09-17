export const publicPages = ['home', 'product', 'semantic', 'architecture', 'demo', 'pricing'];
const pages = new Set([...publicPages, 'docs', 'login', 'register', 'console', 'billing', 'team', 'admin', 'terms', 'privacy']);
export function parsePortalHash(hash = '') {
  const [path, query = ''] = hash.replace(/^#\/?/, '').split('?');
  const parts = (path || 'home').split('/');
  if (!pages.has(parts[0]) || parts.length > (parts[0] === 'docs' ? 2 : 1)) return { page: 'not-found', article: '', section: '' };
  return { page: parts[0], article: parts[0] === 'docs' ? parts[1] || 'overview' : '', section: new URLSearchParams(query).get('section') || '' };
}
export function docLink(id, section = '') { return `#/docs/${encodeURIComponent(id)}${section ? `?section=${encodeURIComponent(section)}` : ''}`; }
