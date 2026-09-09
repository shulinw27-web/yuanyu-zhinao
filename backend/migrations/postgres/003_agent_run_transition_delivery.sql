ALTER TABLE agent_runtime_run_transitions
  ADD COLUMN IF NOT EXISTS claimed_by TEXT,
  ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_agent_runtime_run_transitions_claimable
  ON agent_runtime_run_transitions(created_at, lease_expires_at)
  WHERE consumed_at IS NULL;

INSERT INTO platform_schema_migrations(version, name)
VALUES (3, 'agent_run_transition_delivery')
ON CONFLICT (version) DO NOTHING;
