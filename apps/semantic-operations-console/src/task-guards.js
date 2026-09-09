export function canExecuteSemanticTask({ task, editorDirty = false, busy = false } = {}) {
  if (!task || busy || editorDirty || !['waiting_confirmation', 'retryable'].includes(task.status) || !task.confirmationRequired || !task.command) return false;
  if (task.command !== 'apply_proposal') return true;
  return task.proposal?.critic?.status === 'passed' && !task.proposal?.mappingValidation?.blocked;
}
