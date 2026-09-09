DROP TABLE IF EXISTS connector_runtime_events;
DROP TABLE IF EXISTS model_usage_ledger;
DROP TABLE IF EXISTS agent_audit_export_requests;
ALTER TABLE platform_schema_migrations DROP COLUMN IF EXISTS checksum_sha256;
