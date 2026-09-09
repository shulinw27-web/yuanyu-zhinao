CREATE TABLE IF NOT EXISTS agent_long_tasks (
  task_id TEXT PRIMARY KEY CHECK (char_length(task_id) BETWEEN 1 AND 160),
  task_type TEXT NOT NULL CHECK (char_length(task_type) BETWEEN 1 AND 80),
  run_id TEXT NOT NULL CHECK (char_length(run_id) BETWEEN 1 AND 120),
  command_id TEXT NOT NULL CHECK (char_length(command_id) BETWEEN 1 AND 160),
  conversation_id TEXT,
  role_id TEXT NOT NULL CHECK (char_length(role_id) BETWEEN 1 AND 120),
  tenant_id TEXT NOT NULL CHECK (char_length(tenant_id) BETWEEN 1 AND 120),
  subject_id TEXT NOT NULL CHECK (char_length(subject_id) BETWEEN 1 AND 180),
  session_id TEXT NOT NULL CHECK (char_length(session_id) BETWEEN 1 AND 180),
  device_id TEXT NOT NULL CHECK (char_length(device_id) BETWEEN 1 AND 180),
  status TEXT NOT NULL CHECK (status IN ('queued', 'paused', 'running', 'succeeded', 'failed', 'cancelled', 'timed_out')),
  phase TEXT NOT NULL CHECK (char_length(phase) BETWEEN 1 AND 80),
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  progress INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  deadline_at TIMESTAMPTZ,
  pause_expires_at TIMESTAMPTZ,
  remaining_timeout_ms BIGINT,
  lease_expires_at TIMESTAMPTZ,
  dispatch_id TEXT,
  result_json JSONB,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  version BIGINT NOT NULL DEFAULT 1 CHECK (version > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_long_tasks_active_run
  ON agent_long_tasks(run_id)
  WHERE status IN ('queued', 'paused', 'running');

CREATE INDEX IF NOT EXISTS idx_agent_long_tasks_endpoint_status
  ON agent_long_tasks(tenant_id, subject_id, session_id, device_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_long_tasks_due
  ON agent_long_tasks(status, deadline_at, pause_expires_at, lease_expires_at);

CREATE TABLE IF NOT EXISTS agent_runtime_worker_heartbeats (
  worker_id TEXT PRIMARY KEY CHECK (char_length(worker_id) BETWEEN 3 AND 120),
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  interval_ms INTEGER NOT NULL CHECK (interval_ms BETWEEN 500 AND 60000),
  last_seen_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_runtime_worker_leases (
  lease_name TEXT PRIMARY KEY CHECK (char_length(lease_name) BETWEEN 1 AND 120),
  worker_id TEXT NOT NULL CHECK (char_length(worker_id) BETWEEN 3 AND 120),
  acquired_at TIMESTAMPTZ NOT NULL,
  renewed_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  version BIGINT NOT NULL DEFAULT 1 CHECK (version > 0)
);

CREATE TABLE IF NOT EXISTS agent_runtime_run_transitions (
  transition_id TEXT PRIMARY KEY CHECK (char_length(transition_id) BETWEEN 1 AND 160),
  task_id TEXT NOT NULL REFERENCES agent_long_tasks(task_id),
  run_id TEXT NOT NULL CHECK (char_length(run_id) BETWEEN 1 AND 120),
  transition_type TEXT NOT NULL CHECK (char_length(transition_type) BETWEEN 1 AND 80),
  payload_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_agent_runtime_run_transitions_pending
  ON agent_runtime_run_transitions(created_at)
  WHERE consumed_at IS NULL;

INSERT INTO platform_schema_migrations(version, name)
VALUES (2, 'agent_runtime')
ON CONFLICT (version) DO NOTHING;
