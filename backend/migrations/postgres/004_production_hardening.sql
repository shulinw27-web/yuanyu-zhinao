ALTER TABLE platform_schema_migrations
  ADD COLUMN IF NOT EXISTS checksum_sha256 TEXT;

CREATE TABLE IF NOT EXISTS agent_audit_export_requests (
  request_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL CHECK (char_length(tenant_id) BETWEEN 1 AND 120),
  requester_subject_fingerprint TEXT NOT NULL CHECK (char_length(requester_subject_fingerprint) BETWEEN 16 AND 64),
  approver_subject_fingerprint TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending_approval', 'approved', 'downloaded', 'rejected', 'expired')),
  trace_ids JSONB NOT NULL CHECK (jsonb_typeof(trace_ids) = 'array'),
  justification TEXT NOT NULL CHECK (char_length(justification) BETWEEN 8 AND 500),
  export_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  approved_at TIMESTAMPTZ,
  downloaded_at TIMESTAMPTZ,
  version BIGINT NOT NULL DEFAULT 1 CHECK (version > 0)
);

CREATE INDEX IF NOT EXISTS idx_agent_audit_export_tenant_status
  ON agent_audit_export_requests(tenant_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS model_usage_ledger (
  usage_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL CHECK (char_length(tenant_id) BETWEEN 1 AND 120),
  subject_fingerprint TEXT NOT NULL CHECK (char_length(subject_fingerprint) BETWEEN 16 AND 64),
  provider TEXT NOT NULL,
  model_version TEXT NOT NULL,
  input_tokens BIGINT NOT NULL CHECK (input_tokens >= 0),
  reserved_output_tokens BIGINT NOT NULL CHECK (reserved_output_tokens >= 0),
  estimated_cost_usd NUMERIC(18, 8) NOT NULL DEFAULT 0 CHECK (estimated_cost_usd >= 0),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_model_usage_tenant_subject_time
  ON model_usage_ledger(tenant_id, subject_fingerprint, occurred_at DESC);

CREATE TABLE IF NOT EXISTS connector_runtime_events (
  event_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL CHECK (char_length(tenant_id) BETWEEN 1 AND 120),
  system_id TEXT NOT NULL CHECK (char_length(system_id) BETWEEN 1 AND 80),
  status TEXT NOT NULL CHECK (status IN ('connected', 'unavailable', 'circuit_open', 'bulkhead_rejected')),
  latency_ms INTEGER CHECK (latency_ms >= 0),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_connector_runtime_tenant_system_time
  ON connector_runtime_events(tenant_id, system_id, occurred_at DESC);

ALTER TABLE agent_audit_export_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_audit_export_requests FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_agent_audit_export ON agent_audit_export_requests;
CREATE POLICY tenant_isolation_agent_audit_export ON agent_audit_export_requests
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

ALTER TABLE model_usage_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE model_usage_ledger FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_model_usage ON model_usage_ledger;
CREATE POLICY tenant_isolation_model_usage ON model_usage_ledger
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

ALTER TABLE connector_runtime_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE connector_runtime_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_connector_runtime ON connector_runtime_events;
CREATE POLICY tenant_isolation_connector_runtime ON connector_runtime_events
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

INSERT INTO platform_schema_migrations(version, name)
VALUES (4, 'production_hardening')
ON CONFLICT (version) DO NOTHING;
