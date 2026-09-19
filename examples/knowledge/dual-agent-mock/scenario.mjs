export { marker, dictionary, openapi, samples, requirements, proposedRule, apiNotes, documents } from './input-materials.mjs';
import { crossChannelReadPlan } from '../../semantic-schemas/cross-channel-fulfillment/read-plan.mjs';
export const plan = { ...crossChannelReadPlan(0), label: '联调现行A版：跨仓履约与信用' };
