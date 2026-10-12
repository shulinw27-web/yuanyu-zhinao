import { createHash } from 'node:crypto';
export const mockOnboardingBasis = project => createHash('sha256').update(JSON.stringify({
  ...(project.modelId && project.modelId !== 'oa-governance' ? { modelId: project.modelId } : {}),
  materialRevision: project.materialRevision,
  materials: Object.entries(project.materials || {}).sort(([a], [b]) => a.localeCompare(b)).map(([kind, value]) => [kind, value.digest]),
  config: project.alignment?.config || null, connection: project.connection || null
})).digest('hex');
