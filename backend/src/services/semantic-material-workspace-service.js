import { createHash } from 'node:crypto';
import { readSemanticGovernanceState, mutateSemanticGovernanceState } from './semantic-governance-store.js';
import { discoverSchemasFromAttachments } from './semantic-schema-discovery-service.js';
import { semanticOperationsOwnerMatches, semanticOperationsPrincipalKey } from './semantic-operations-identity.js';
import { getAllSystemDocumentTexts } from './system-access-service.js';
import { currentSemanticModel, DEFAULT_SEMANTIC_MODEL_ID, assertSemanticTenant } from './semantic-tenant-context.js';
import { assertCurrentSemanticModelAdmission, semanticModelReferenceMatches } from './semantic-model-reference.js';

const namespace = 'semantic_material_artifacts';
const maxBytes = 2 * 1024 * 1024;
const maxDocuments = 64;
const digest = text => createHash('sha256').update(text).digest('hex');

// These refs are internal task state, never accepted from request bodies.
// Owner AND originating role must match again on every retrieval.
export async function loadSemanticMaterials(refs, identityScope, roleId) {
  const selected = structuredClone(refs || []); const identity = structuredClone(identityScope);
  assertSemanticTenant(identity);
  const referencePattern = currentSemanticModel() === DEFAULT_SEMANTIC_MODEL_ID ? /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u : /^[a-f0-9]{64}$/u;
  if (!Array.isArray(selected) || selected.length > maxDocuments || selected.some(ref => typeof ref !== 'string' || !referencePattern.test(ref))) throw new Error('SEMANTIC_MATERIAL_REFERENCE_INVALID');
  await assertCurrentSemanticModelAdmission();
  const documents = [];
  for (const ref of selected) {
    const artifact = await readSemanticGovernanceState(namespace, ref, null);
    if (!semanticModelReferenceMatches(artifact) || !semanticOperationsOwnerMatches(artifact.owner, identity) || artifact.roleId !== roleId) throw new Error('SEMANTIC_MATERIAL_ACCESS_DENIED');
    const document = artifact.document;
    if (!document || typeof document.text !== 'string'
      || currentSemanticModel() !== DEFAULT_SEMANTIC_MODEL_ID && (typeof document.name !== 'string' || typeof document.mimeType !== 'string')) throw new Error('SEMANTIC_MATERIAL_CONTENT_INVALID');
    if (currentSemanticModel() !== DEFAULT_SEMANTIC_MODEL_ID
      && digest(JSON.stringify([currentSemanticModel(), semanticOperationsPrincipalKey(identity), roleId, document.name, document.mimeType, document.text])) !== ref) throw new Error('SEMANTIC_MATERIAL_INTEGRITY_INVALID');
    documents.push(artifact.document);
  }
  if (documents.reduce((bytes, document) => bytes + Buffer.byteLength(document.text), 0) > maxBytes) throw new Error('SEMANTIC_MATERIAL_LIMIT');
  await assertCurrentSemanticModelAdmission();
  return documents;
}

export async function extendSemanticMaterials({ previousRefs = [], content, identityScope, roleId }) {
  previousRefs = structuredClone(previousRefs); content = structuredClone(content); identityScope = structuredClone(identityScope);
  assertSemanticTenant(identityScope);
  await assertCurrentSemanticModelAdmission();
  const modelId = currentSemanticModel();
  const owner = semanticOperationsPrincipalKey(identityScope);
  const documents = await loadSemanticMaterials(previousRefs, identityScope, roleId);
  const refs = [...previousRefs];
  const additions = [];
  for (const document of content.documents || []) {
    const binding = [owner, roleId, document.name, document.mimeType, document.text];
    const ref = digest(JSON.stringify(modelId === DEFAULT_SEMANTIC_MODEL_ID ? binding : [modelId, ...binding]));
    if (refs.includes(ref)) continue;
    refs.push(ref);
    additions.push({ ref, document: { ...document, attachmentId: ref } });
  }
  if (documents.length + additions.length > maxDocuments || [...documents, ...additions.map(item => item.document)].reduce((sum, item) => sum + Buffer.byteLength(item.text), 0) > maxBytes) {
    return { error: '任务材料超过64份或2MiB受控文本上限，请新建限定范围的建模任务；没有截断或覆盖旧材料。', code: 'SEMANTIC_MATERIAL_LIMIT', status: 413 };
  }
  for (const { ref, document } of additions) {
    await assertCurrentSemanticModelAdmission();
    await mutateSemanticGovernanceState(namespace, ref, null, () => ({ value: { modelId, owner, roleId, document } }));
    documents.push(document);
  }
  await assertCurrentSemanticModelAdmission();
  return { refs, documents };
}

export function discoverWorkspaceSchemas(documents, input) {
  // 8-5：合并系统级文档物料（登记时的 attachmentDocuments 提取文本）进入候选。
  // 系统文档与工作台文档走同一条确定性候选路径；证据等级同级。
  // Registered models must explicitly bind source documents; do not silently
  // inherit the default workspace's system-material pool.
  const systemDocState = currentSemanticModel() === DEFAULT_SEMANTIC_MODEL_ID ? getAllSystemDocumentTexts() : {};
  const systemDocuments = Object.values(systemDocState).flatMap((entry) => entry.documents || []);
  const allDocuments = [...documents, ...systemDocuments];
  return discoverSchemasFromAttachments({ input, documents: allDocuments,
    attachments: allDocuments.map(document => ({ id: document.attachmentId, name: document.name, mimeType: document.mimeType })),
    reports: allDocuments.map(document => ({ attachmentId: document.attachmentId, status: 'content_scanned', structuredSchemaCandidate: true })) });
}

export function materialSchemaIndex(discovery) {
  return (discovery.objectTypes || []).map(item => `${item.id}: source=${item.sourceSystems.join(',')}; granularity=${item.granularity}; key=${item.key}; fields=${item.fields.join(',')}`).join('\n');
}
