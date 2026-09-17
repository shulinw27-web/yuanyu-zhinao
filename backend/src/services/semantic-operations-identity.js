export const semanticOperationsPrincipalKey = (identity = {}) => JSON.stringify([
  identity.tenantId || 'demo-enterprise',
  identity.subjectId || 'anonymous'
]);

export const legacySemanticOperationsOwnerKey = (identity = {}) => [
  identity.tenantId || 'demo-enterprise',
  identity.subjectId || 'anonymous',
  identity.deviceId || 'unknown-device'
].join(':');

export const semanticOperationsOwnerMatches = (owner, identity = {}) => {
  if (owner === semanticOperationsPrincipalKey(identity)) return true;
  const parts = [identity.tenantId || 'demo-enterprise', identity.subjectId || 'anonymous'];
  // Only a two-part legacy owner without delimiter-bearing components has an
  // unambiguous interpretation. Device-scoped and ambiguous owners require an
  // operator-reviewed migration; accepting them could cross tenant boundaries.
  return parts.every(part => typeof part === 'string' && !part.includes(':')) && owner === parts.join(':');
};
