'use strict';

async function ensureModelTraceTables(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS model_trace_jobs (
    id UUID PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    team_id INTEGER, model_id TEXT NOT NULL, provider_id TEXT NOT NULL,
    idempotency_key VARCHAR(100) NOT NULL, parent_job_id UUID REFERENCES model_trace_jobs(id),
    target JSONB NOT NULL, version JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','completed','partial','failed','canceled','interrupted')),
    budget INTEGER NOT NULL DEFAULT 3 CHECK (budget BETWEEN 1 AND 3),
    attempted INTEGER NOT NULL DEFAULT 0 CHECK (attempted BETWEEN 0 AND 3),
    valid_outputs INTEGER NOT NULL DEFAULT 0, result JSONB, error TEXT,
    cancel_requested BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, finished_at TIMESTAMP,
    UNIQUE(user_id, idempotency_key)
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS model_trace_jobs_owner ON model_trace_jobs(user_id, created_at DESC)`);
  await db.query(`CREATE INDEX IF NOT EXISTS model_trace_jobs_active ON model_trace_jobs(status) WHERE status IN ('pending','running')`);
  await db.query(`CREATE TABLE IF NOT EXISTS model_trace_probes (
    job_id UUID NOT NULL REFERENCES model_trace_jobs(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 1 AND 3),
    status TEXT NOT NULL DEFAULT 'reserved', sent BOOLEAN NOT NULL DEFAULT FALSE,
    reserved_cost NUMERIC(18,6) NOT NULL DEFAULT 0,
    reserved_weight BIGINT NOT NULL DEFAULT 0, quota_covered BOOLEAN NOT NULL DEFAULT FALSE,
    cost NUMERIC(18,6), total_tokens INTEGER NOT NULL DEFAULT 0,
    prompt_tokens INTEGER NOT NULL DEFAULT 0, completion_tokens INTEGER NOT NULL DEFAULT 0,
    weighted_tokens BIGINT NOT NULL DEFAULT 0, usage_unknown BOOLEAN NOT NULL DEFAULT FALSE,
    valid BOOLEAN NOT NULL DEFAULT FALSE, number_count INTEGER NOT NULL DEFAULT 0,
    expected_count INTEGER, response_model TEXT, error TEXT,
    usage_record_id INTEGER REFERENCES usage_records(id) ON DELETE SET NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(job_id, ordinal)
  )`);
}

module.exports = { ensureModelTraceTables };
