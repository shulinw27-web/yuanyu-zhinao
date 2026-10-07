import { createHash } from 'node:crypto';
import { readSemanticGovernanceState, mutateSemanticGovernanceState } from './semantic-governance-store.js';
import { discoverSchemasFromAttachments } from './semantic-schema-discovery-service.js';
import { semanticOperationsOwnerMatches, semanticOperationsPrincipalKey } from './semantic-operations-identity.js';
import { getAllSystemDocumentTexts } from './system-access-service.js';

const namespace = 'semantic_material_artifacts';
const maxBytes = 2 * 1024 * 1024;
const maxDocuments = 64;
const digest = text => createHash('sha256').update(text).digest('hex');

// These refs are internal task state, never accepted from request bodies.
// Owner AND originating role must match again on every retrieval.
export async function loadSemanticMaterials(refs, identityScope, roleId) {
  const documents = [];
  for (const ref of refs || []) {
    const artifact = await readSemanticGovernanceState(namespace, ref, null);
    if (!artifact || !semanticOperationsOwnerMatches(artifact.owner, identityScope) || artifact.roleId !== roleId) throw new Error('SEMANTIC_MATERIAL_ACCESS_DENIED');
    documents.push(artifact.document);
  }
  return documents;
}

export async function extendSemanticMaterials({ previousRefs = [], content, identityScope, roleId }) {
  const owner = semanticOperationsPrincipalKey(identityScope);
  const documents = await loadSemanticMaterials(previousRefs, identityScope, roleId);
  const refs = [...previousRefs];
  const additions = [];
  for (const document of content.documents || []) {
    const ref = digest(JSON.stringify([owner, roleId, document.name, document.mimeType, document.text]));
    if (refs.includes(ref)) continue;
    refs.push(ref);
    additions.push({ ref, document: { ...document, attachmentId: ref } });
  }
  if (documents.length + additions.length > maxDocuments || [...documents, ...additions.map(item => item.document)].reduce((sum, item) => sum + Buffer.byteLength(item.text), 0) > maxBytes) {
    return { error: '任务材料超过64份或2MiB受控文本上限，请新建限定范围的建模任务；没有截断或覆盖旧材料。', code: 'SEMANTIC_MATERIAL_LIMIT', status: 413 };
  }
  for (const { ref, document } of additions) {
    await mutateSemanticGovernanceState(namespace, ref, null, () => ({ value: { owner, roleId, document } }));
    documents.push(document);
  }
  return { refs, documents };
}

export function discoverWorkspaceSchemas(documents, input) {
  // 8-5：合并系统级文档物料（登记时的 attachmentDocuments 提取文本）进入候选。
  // 系统文档与工作台文档走同一条确定性候选路径；证据等级同级。
  const systemDocState = getAllSystemDocumentTexts();
  const systemDocuments = Object.values(systemDocState).flatMap((entry) => entry.documents || []);
  const allDocuments = [...documents, ...systemDocuments];
  return discoverSchemasFromAttachments({ input, documents: allDocuments,
    attachments: allDocuments.map(document => ({ id: document.attachmentId, name: document.name, mimeType: document.mimeType })),
    reports: allDocuments.map(document => ({ attachmentId: document.attachmentId, status: 'content_scanned', structuredSchemaCandidate: true })) });
}

export function materialSchemaIndex(discovery) {
  return (discovery.objectTypes || []).map(item => `${item.id}: source=${item.sourceSystems.join(',')}; granularity=${item.granularity}; key=${item.key}; fields=${item.fields.join(',')}`).join('\n');
}
