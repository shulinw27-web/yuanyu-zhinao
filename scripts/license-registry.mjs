const validName = name => typeof name === 'string' && /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/u.test(name);
const validVersion = version => typeof version === 'string' && /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.+-]+)?$/u.test(version);
export async function resolveRegistryLicense({ name, version }, fetchImpl = fetch) {
  if (!validName(name) || !validVersion(version)) return null;
  const url = `https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`;
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(5000), redirect: 'error', headers: { accept: 'application/json' } });
    if (!response.ok || Number(response.headers.get('content-length')) > 200000) return null;
    let bytes = 0; const chunks = [];
    for await (const chunk of response.body) { bytes += chunk.length; if (bytes > 200000) { await response.body.cancel?.().catch(() => {}); return null; } chunks.push(chunk); }
    const metadata = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (metadata.name !== name || metadata.version !== version || typeof metadata.license !== 'string' || !metadata.license.trim() || metadata.license.length > 200) return null;
    return { license: metadata.license.trim(), source: url };
  } catch { return null; }
}
