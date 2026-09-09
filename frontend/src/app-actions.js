import { createAdministrationActions } from './actions/administration-actions.js';
import { createAgentActions } from './actions/agent-actions.js';
import { createGovernanceActions } from './actions/governance-actions.js';
import { createRiskProcurementActions } from './actions/risk-procurement-actions.js';

export function createAppActions(context) {
  return {
    ...createRiskProcurementActions(context),
    ...createAgentActions(context),
    ...createGovernanceActions(context),
    ...createAdministrationActions(context)
  };
}
