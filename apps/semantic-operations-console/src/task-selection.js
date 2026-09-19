// Explicit deep links must never silently select an unrelated recent task.
export async function resolveSemanticTaskSelection({ client, tasks, preferredId, selectedId }) {
  if (preferredId) {
    const listed = tasks.find(task => task.id === preferredId);
    if (listed) return { tasks, selected: listed };
    const result = await client.getTask(preferredId);
    if (!result?.task || result.task.id !== preferredId) throw new Error('目标任务不可见或已不存在，请返回接入项目核对。');
    return { tasks: [result.task, ...tasks], selected: result.task };
  }
  return { tasks, selected: tasks.find(task => task.id === selectedId) || tasks[0] || null };
}
