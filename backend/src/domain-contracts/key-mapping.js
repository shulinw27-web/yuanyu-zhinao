export const KEY_MAPPING_BASES = Object.freeze({ master_data_lookup: '主数据对照表', manual_register: '人工维护的对照登记', derived_rule: '规则派生（补零 / 加前缀等）', external_system: '外部系统提供的映射' });
export const KEY_MAPPING_OWNER_MAX = 48;
export const KEY_MAPPING_VERSION_MAX = 24;
export const KEY_MAPPING_SOURCE_MAX = 120;
const clean = (value, maxLength) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength);
export function sanitizeKeyMapping(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const fromField = clean(value.fromField, 64); const toField = clean(value.toField, 64); const basis = clean(value.basis, 32);
  if (!fromField || !toField || !Object.hasOwn(KEY_MAPPING_BASES, basis)) return null;
  const lookupSource = clean(value.lookupSource, KEY_MAPPING_SOURCE_MAX);
  if (basis === 'master_data_lookup' && !lookupSource) return null;
  const owner = clean(value.owner, KEY_MAPPING_OWNER_MAX); const version = clean(value.version, KEY_MAPPING_VERSION_MAX);
  if (!owner || !version) return null;
  return { fromField, toField, basis, ...(lookupSource ? { lookupSource } : {}), owner, version };
}
