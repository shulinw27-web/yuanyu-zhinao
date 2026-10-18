export const validAgentModelBinding = value => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === 5 && Object.keys(value).every(key => ['schemaVersion', 'mode', 'modelId', 'version', 'fingerprint'].includes(key))
  && value.schemaVersion === 'agent-model-binding.v1' && value.mode === 'published_schema_only'
  && typeof value.modelId === 'string' && /^[a-z][a-z0-9-]{1,63}$/u.test(value.modelId) && value.modelId !== 'oa-governance'
  && typeof value.version === 'string' && value.version.trim().length > 0 && value.version.length <= 120 && !/[\u0000-\u001f\u007f<>]/u.test(value.version)
  && typeof value.fingerprint === 'string' && /^[a-f0-9]{24}$/u.test(value.fingerprint);
export const agentModelBindingsMatch = (left, right) => validAgentModelBinding(left) && validAgentModelBinding(right)
  && ['schemaVersion', 'mode', 'modelId', 'version', 'fingerprint'].every(key => left[key] === right[key]);
