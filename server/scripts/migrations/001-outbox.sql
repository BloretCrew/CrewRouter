-- Outbox schema for reliable operation events.
-- This file is intentionally not loaded by application startup. Apply manually when ready.

-- UP
CREATE TABLE IF NOT EXISTS outbox_events (
  id BIGSERIAL PRIMARY KEY,
  idempotency_key VARCHAR(255) NOT NULL UNIQUE,
  topic VARCHAR(150) NOT NULL,
  payload JSONB NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'acked')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  locked_at TIMESTAMP,
  locked_by VARCHAR(255),
  last_error TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_outbox_claim
  ON outbox_events (available_at, id)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_outbox_status_updated
  ON outbox_events (status, updated_at);

-- DOWN (run manually to reverse the UP section)
-- DROP INDEX IF EXISTS idx_outbox_status_updated;
-- DROP INDEX IF EXISTS idx_outbox_claim;
-- DROP TABLE IF EXISTS outbox_events;
