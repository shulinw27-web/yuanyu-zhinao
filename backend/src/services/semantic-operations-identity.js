export const semanticOperationsPrincipalKey = (identity = {}) => [
  identity.tenantId || 'demo-enterprise',
  identity.subjectId || 'anonymous'
].join(':');

export const legacySemanticOperationsOwnerKey = (identity = {}) => [
  identity.tenantId || 'demo-enterprise',
  identity.subjectId || 'anonymous',
  identity.deviceId || 'unknown-device'
].join(':');

export const semanticOperationsOwnerMatches = (owner, identity) => owner === semanticOperationsPrincipalKey(identity)
  || owner === legacySemanticOperationsOwnerKey(identity);
