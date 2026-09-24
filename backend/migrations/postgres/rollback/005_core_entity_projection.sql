-- 005_core_entity_projection 回滚
--
-- 本迁移只新增「投影表 + 同步触发器 + 回填」，不删除、不修改既有表与列。
-- 因此回滚是安全的：删除投影对象后，platform_runtime_state（唯一事实源）
-- 内容不受影响，运行时读写路径与本迁移前完全一致。

DROP TRIGGER IF EXISTS trg_sync_core_entity_projection ON platform_runtime_state;
DROP FUNCTION IF EXISTS platform_sync_core_entity_projection();

DROP TABLE IF EXISTS agent_evidence_traces;
DROP TABLE IF EXISTS agent_runs;

DELETE FROM platform_schema_migrations WHERE version = 5;
