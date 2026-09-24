-- 005_core_entity_projection
--
-- 目的：为三个核心实体（Agent Run / Evidence Trace / Confirmation）建立「显式列」。
--
-- 背景（见 docs/architecture/adr/ADR-004 与 ADR-005）：
-- 当前所有运行时状态都存在 platform_runtime_state(namespace, state_key, value_json)。
-- 该 JSON blob 表让 Demo 阶段迭代很快，但有两个已明确的代价：
--   1) 按状态/时间检索必须全表读取后在应用层过滤（listState + filter + sort）；
--   2) 实体字段没有数据库级约束，字段拼写错误只能在运行时暴露。
--
-- 本迁移只做「投影」：新增带类型与 CHECK 约束的显式列表，并由触发器从
-- platform_runtime_state 同步写入。运行时读写路径暂不改动（零行为变化），
-- 因此本迁移不改变任何现有 API 语义，可随时回滚。
--
-- 退出条件（与 ADR-004 保持一致，未满足前不得把 JSON blob 表删除）：
--   1) 上述三个实体的全部读路径改为直接查询显式列表；
--   2) 显式列与 JSON blob 的一致性由测试逐字段校验通过；
--   3) 双写（blob + 显式列）在同一事务内完成且已有回滚演练记录；
--   4) 生产租户的迁移与回填在预发环境完成演练。

CREATE OR REPLACE FUNCTION platform_sync_core_entity_projection()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.namespace = 'agent_runs' THEN
    INSERT INTO agent_runs (
      run_id, role_id, tenant_id, subject_id, session_id, device_id,
      status, command_id, command_target, requires_confirmation,
      confirmation_status, confirmation_expires_at,
      evidence_trace_id, created_at, updated_at, version
    ) VALUES (
      NEW.state_key,
      NULLIF(NEW.value_json ->> 'roleId', ''),
      NULLIF(NEW.value_json -> 'identityScope' ->> 'tenantId', ''),
      NULLIF(NEW.value_json -> 'identityScope' ->> 'subjectId', ''),
      NULLIF(NEW.value_json -> 'identityScope' ->> 'sessionId', ''),
      NULLIF(NEW.value_json -> 'identityScope' ->> 'deviceId', ''),
      COALESCE(NULLIF(NEW.value_json ->> 'status', ''), 'planned'),
      NULLIF(NEW.value_json -> 'proposedCommand' ->> 'id', ''),
      NULLIF(NEW.value_json -> 'proposedCommand' ->> 'target', ''),
      COALESCE((NEW.value_json -> 'proposedCommand' ->> 'requiresConfirmation')::boolean, false),
      NULLIF(NEW.value_json -> 'confirmation' ->> 'status', ''),
      NULLIF(NEW.value_json -> 'confirmation' ->> 'expiresAt', '')::timestamptz,
      NULLIF(NEW.value_json ->> 'evidenceTraceId', ''),
      COALESCE(NULLIF(NEW.value_json ->> 'createdAt', '')::timestamptz, NEW.updated_at),
      COALESCE(NULLIF(NEW.value_json ->> 'updatedAt', '')::timestamptz, NEW.updated_at),
      NEW.version
    )
    ON CONFLICT (run_id) DO UPDATE SET
      status = EXCLUDED.status,
      command_id = EXCLUDED.command_id,
      command_target = EXCLUDED.command_target,
      requires_confirmation = EXCLUDED.requires_confirmation,
      confirmation_status = EXCLUDED.confirmation_status,
      confirmation_expires_at = EXCLUDED.confirmation_expires_at,
      evidence_trace_id = EXCLUDED.evidence_trace_id,
      updated_at = EXCLUDED.updated_at,
      version = EXCLUDED.version;

  ELSIF NEW.namespace = 'agent_evidence_traces' THEN
    INSERT INTO agent_evidence_traces (
      trace_id, run_id, role_id, tenant_id, subject_id, status,
      request_id, platform, step_count, created_at, updated_at, version
    ) VALUES (
      NEW.state_key,
      NULLIF(NEW.value_json ->> 'runId', ''),
      NULLIF(NEW.value_json ->> 'roleId', ''),
      NULLIF(NEW.value_json -> 'identityScope' ->> 'tenantId', ''),
      NULLIF(NEW.value_json -> 'identityScope' ->> 'subjectId', ''),
      COALESCE(NULLIF(NEW.value_json ->> 'status', ''), 'open'),
      NULLIF(NEW.value_json ->> 'requestId', ''),
      NULLIF(NEW.value_json ->> 'platform', ''),
      COALESCE(jsonb_array_length(NEW.value_json -> 'steps'), 0),
      COALESCE(NULLIF(NEW.value_json ->> 'createdAt', '')::timestamptz, NEW.updated_at),
      COALESCE(NULLIF(NEW.value_json ->> 'updatedAt', '')::timestamptz, NEW.updated_at),
      NEW.version
    )
    ON CONFLICT (trace_id) DO UPDATE SET
      run_id = EXCLUDED.run_id,
      status = EXCLUDED.status,
      step_count = EXCLUDED.step_count,
      updated_at = EXCLUDED.updated_at,
      version = EXCLUDED.version;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Agent Run 投影表：显式列 + 状态约束。
CREATE TABLE IF NOT EXISTS agent_runs (
  run_id TEXT PRIMARY KEY CHECK (char_length(run_id) BETWEEN 1 AND 120),
  role_id TEXT CHECK (role_id IS NULL OR char_length(role_id) BETWEEN 1 AND 120),
  tenant_id TEXT CHECK (tenant_id IS NULL OR char_length(tenant_id) BETWEEN 1 AND 120),
  subject_id TEXT CHECK (subject_id IS NULL OR char_length(subject_id) BETWEEN 1 AND 180),
  session_id TEXT CHECK (session_id IS NULL OR char_length(session_id) BETWEEN 1 AND 180),
  device_id TEXT CHECK (device_id IS NULL OR char_length(device_id) BETWEEN 1 AND 180),
  status TEXT NOT NULL CHECK (status IN (
    'planned', 'analysis_completed', 'analysis_incomplete',
    'awaiting_confirmation', 'confirmation_expired',
    'executing', 'executed', 'execution_failed', 'cancelled'
  )),
  command_id TEXT,
  command_target TEXT CHECK (command_target IS NULL OR command_target IN ('server', 'desktop')),
  requires_confirmation BOOLEAN NOT NULL DEFAULT false,
  confirmation_status TEXT CHECK (confirmation_status IS NULL OR confirmation_status IN ('pending', 'consumed', 'cancelled', 'expired')),
  confirmation_expires_at TIMESTAMPTZ,
  evidence_trace_id TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  version BIGINT NOT NULL DEFAULT 1 CHECK (version > 0)
);

-- 替代 listState 全表扫描的检索路径。
CREATE INDEX IF NOT EXISTS idx_agent_runs_scope_active
  ON agent_runs(tenant_id, subject_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_runs_pending_confirmation
  ON agent_runs(status, confirmation_expires_at)
  WHERE status = 'awaiting_confirmation' AND confirmation_status = 'pending';

-- Evidence Trace 投影表。
CREATE TABLE IF NOT EXISTS agent_evidence_traces (
  trace_id TEXT PRIMARY KEY CHECK (char_length(trace_id) BETWEEN 1 AND 160),
  run_id TEXT,
  role_id TEXT,
  tenant_id TEXT,
  subject_id TEXT,
  status TEXT NOT NULL CHECK (char_length(status) BETWEEN 1 AND 40),
  request_id TEXT,
  platform TEXT,
  step_count INTEGER NOT NULL DEFAULT 0 CHECK (step_count >= 0),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  version BIGINT NOT NULL DEFAULT 1 CHECK (version > 0)
);

CREATE INDEX IF NOT EXISTS idx_agent_evidence_traces_run
  ON agent_evidence_traces(run_id);
CREATE INDEX IF NOT EXISTS idx_agent_evidence_traces_scope_time
  ON agent_evidence_traces(tenant_id, subject_id, created_at DESC);

DROP TRIGGER IF EXISTS trg_sync_core_entity_projection ON platform_runtime_state;
CREATE TRIGGER trg_sync_core_entity_projection
  AFTER INSERT OR UPDATE ON platform_runtime_state
  FOR EACH ROW
  EXECUTE FUNCTION platform_sync_core_entity_projection();

-- 回填存量数据（幂等：ON CONFLICT 覆盖同主键行）。
INSERT INTO agent_runs (
  run_id, role_id, tenant_id, subject_id, session_id, device_id,
  status, command_id, command_target, requires_confirmation,
  confirmation_status, confirmation_expires_at,
  evidence_trace_id, created_at, updated_at, version
)
SELECT
  state_key,
  NULLIF(value_json ->> 'roleId', ''),
  NULLIF(value_json -> 'identityScope' ->> 'tenantId', ''),
  NULLIF(value_json -> 'identityScope' ->> 'subjectId', ''),
  NULLIF(value_json -> 'identityScope' ->> 'sessionId', ''),
  NULLIF(value_json -> 'identityScope' ->> 'deviceId', ''),
  COALESCE(NULLIF(value_json ->> 'status', ''), 'planned'),
  NULLIF(value_json -> 'proposedCommand' ->> 'id', ''),
  NULLIF(value_json -> 'proposedCommand' ->> 'target', ''),
  COALESCE((value_json -> 'proposedCommand' ->> 'requiresConfirmation')::boolean, false),
  NULLIF(value_json -> 'confirmation' ->> 'status', ''),
  NULLIF(value_json -> 'confirmation' ->> 'expiresAt', '')::timestamptz,
  NULLIF(value_json ->> 'evidenceTraceId', ''),
  COALESCE(NULLIF(value_json ->> 'createdAt', '')::timestamptz, updated_at),
  COALESCE(NULLIF(value_json ->> 'updatedAt', '')::timestamptz, updated_at),
  version
FROM platform_runtime_state
WHERE namespace = 'agent_runs'
  AND COALESCE(NULLIF(value_json ->> 'status', ''), 'planned') IN (
    'planned', 'analysis_completed', 'analysis_incomplete',
    'awaiting_confirmation', 'confirmation_expired',
    'executing', 'executed', 'execution_failed', 'cancelled'
  )
ON CONFLICT (run_id) DO NOTHING;

INSERT INTO agent_evidence_traces (
  trace_id, run_id, role_id, tenant_id, subject_id, status,
  request_id, platform, step_count, created_at, updated_at, version
)
SELECT
  state_key,
  NULLIF(value_json ->> 'runId', ''),
  NULLIF(value_json ->> 'roleId', ''),
  NULLIF(value_json -> 'identityScope' ->> 'tenantId', ''),
  NULLIF(value_json -> 'identityScope' ->> 'subjectId', ''),
  COALESCE(NULLIF(value_json ->> 'status', ''), 'open'),
  NULLIF(value_json ->> 'requestId', ''),
  NULLIF(value_json ->> 'platform', ''),
  COALESCE(jsonb_array_length(value_json -> 'steps'), 0),
  COALESCE(NULLIF(value_json ->> 'createdAt', '')::timestamptz, updated_at),
  COALESCE(NULLIF(value_json ->> 'updatedAt', '')::timestamptz, updated_at),
  version
FROM platform_runtime_state
WHERE namespace = 'agent_evidence_traces'
ON CONFLICT (trace_id) DO NOTHING;

INSERT INTO platform_schema_migrations(version, name)
VALUES (5, 'core_entity_projection')
ON CONFLICT (version) DO NOTHING;
