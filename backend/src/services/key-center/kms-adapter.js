import { randomUUID } from 'node:crypto';

const externalAdapters = new Map();
const selectedProvider = () => process.env.KEY_CENTER_PROVIDER || 'demo-kms';

export function registerKmsCredentialProvider(name, adapter) {
  const providerName = String(name || '').trim();
  if (!providerName || providerName === 'demo-kms' || typeof adapter?.issueOpaqueCredential !== 'function') throw new Error('External KMS provider requires a name and issueOpaqueCredential adapter.');
  externalAdapters.set(providerName, adapter);
}

export function unregisterKmsCredentialProvider(name) { externalAdapters.delete(String(name)); }

// Adapter contract: a production adapter resolves material inside Vault/KMS/HSM,
// then returns only an opaque handle to the calling workload. It never exposes key material.
export async function issueOpaqueCredential({ secretRef, leaseId, expiresAt }) {
  const provider = selectedProvider();
  if (provider !== 'demo-kms') {
    const adapter = externalAdapters.get(provider);
    if (!adapter) { const error = new Error('External KMS provider is selected but no adapter is registered.'); error.code = 'KMS_PROVIDER_UNAVAILABLE'; throw error; }
    const credential = await adapter.issueOpaqueCredential({ secretRef, leaseId, expiresAt });
    if (!credential?.handle || ['secret', 'value', 'token', 'material'].some((field) => Object.hasOwn(credential, field))) {
      const error = new Error('KMS adapter must return only an opaque credential handle.'); error.code = 'KMS_ADAPTER_CONTRACT_VIOLATION'; throw error;
    }
    return { provider, handle: String(credential.handle), leaseId, expiresAt, materialExposed: false };
  }
  return {
    provider,
    secretRef,
    handle: `kch-${randomUUID()}`,
    leaseId,
    expiresAt,
    materialExposed: false
  };
}

export function getKmsAdapterStatus() {
  const provider = selectedProvider();
  const available = provider === 'demo-kms' || externalAdapters.has(provider);
  return {
    provider,
    mode: provider === 'demo-kms' ? 'simulated_adapter' : available ? 'external_adapter_registered' : 'external_adapter_unavailable',
    available,
    note: provider === 'demo-kms'
      ? 'Demo adapter only issues opaque handles. Deploy Vault, cloud KMS, or HSM adapter before production use.'
      : available ? 'External KMS adapter is registered; key material remains inside the provider boundary.' : 'External KMS provider was selected but no runtime adapter is registered; lease issuance fails closed.'
  };
}

export async function probeKmsAdapter() {
  const status = getKmsAdapterStatus();
  if (!status.available || status.provider === 'demo-kms') return status;
  const adapter = externalAdapters.get(status.provider);
  if (typeof adapter?.probe !== 'function') return { ...status, available: false, mode: 'external_adapter_unhealthy', note: 'External KMS adapter does not expose a readiness probe.' };
  try {
    const result = await adapter.probe();
    return result?.ready === true ? status : { ...status, available: false, mode: 'external_adapter_unhealthy', note: 'External KMS provider readiness probe failed.' };
  } catch {
    return { ...status, available: false, mode: 'external_adapter_unhealthy', note: 'External KMS provider readiness probe failed.' };
  }
}
