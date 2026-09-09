CREATE TABLE IF NOT EXISTS platform_schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS platform_runtime_state (
  namespace TEXT NOT NULL CHECK (char_length(namespace) BETWEEN 1 AND 120),
  state_key TEXT NOT NULL CHECK (char_length(state_key) BETWEEN 1 AND 240),
  value_json JSONB NOT NULL,
  version BIGINT NOT NULL DEFAULT 1 CHECK (version >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (namespace, state_key)
);

CREATE INDEX IF NOT EXISTS idx_platform_runtime_state_namespace_updated
  ON platform_runtime_state(namespace, updated_at DESC);

INSERT INTO platform_schema_migrations(version, name)
VALUES (1, 'runtime_state')
ON CONFLICT (version) DO NOTHING;
