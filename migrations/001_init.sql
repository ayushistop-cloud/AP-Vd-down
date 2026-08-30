-- 3AP Video Downloader - initial schema (docs/11-DATABASE-SCHEMA.md)
-- Operational additions documented inline: resolve_cache table and the
-- jobs.resolve_id column (lets workers rehydrate exact format selectors
-- without retaining provider URLs beyond the active window).

CREATE TABLE IF NOT EXISTS jobs (
  id                      UUID PRIMARY KEY,
  status                  TEXT        NOT NULL,
  platform                TEXT        NOT NULL,
  kind                    TEXT        NOT NULL,
  resolve_id              UUID,
  source_url_hash         TEXT        NOT NULL,
  source_url_redacted     TEXT        NOT NULL,
  source_url              TEXT,
  ip_hash                 TEXT        NOT NULL,
  idempotency_key         TEXT UNIQUE,
  title                   TEXT,
  creator                 TEXT,
  requested_format_id     TEXT,
  requested_quality_label TEXT,
  progress                INTEGER     NOT NULL DEFAULT 0,
  error_code              TEXT,
  error_message           TEXT,
  cancel_requested        BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at              TIMESTAMPTZ,
  completed_at            TIMESTAMPTZ,
  expires_at              TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_jobs_status_expires ON jobs (status, expires_at);
CREATE INDEX IF NOT EXISTS idx_jobs_ip_active      ON jobs (ip_hash, status);
CREATE INDEX IF NOT EXISTS idx_jobs_completed_at   ON jobs (completed_at);

CREATE TABLE IF NOT EXISTS job_items (
  id                 UUID PRIMARY KEY,
  job_id             UUID        NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  ordinal            INTEGER     NOT NULL,
  title              TEXT        NOT NULL,
  source_url         TEXT        NOT NULL,
  status             TEXT        NOT NULL DEFAULT 'pending',
  progress           INTEGER     NOT NULL DEFAULT 0,
  artifact_key       TEXT,
  artifact_name      TEXT,
  artifact_size_bytes BIGINT,
  error_code         TEXT,
  error_message      TEXT
);

CREATE INDEX IF NOT EXISTS idx_job_items_job ON job_items (job_id);

CREATE TABLE IF NOT EXISTS adapter_events (
  id          UUID PRIMARY KEY,
  platform    TEXT        NOT NULL,
  event_type  TEXT        NOT NULL,
  job_id      UUID,
  latency_ms  INTEGER     NOT NULL,
  success     BOOLEAN     NOT NULL,
  error_code  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_adapter_events_created ON adapter_events (created_at);

CREATE TABLE IF NOT EXISTS resolve_cache (
  id         UUID PRIMARY KEY,
  record     JSONB       NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_resolve_cache_expiry ON resolve_cache (expires_at);
