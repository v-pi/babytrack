-- ── 5.sql ── Performance indexes ────────────────────────────────────────────
-- Run after 1.sql → 4.sql.
-- Without these, every sync does a sequential scan on the full logs table.

-- Primary access pattern: fetch all logs for a family (used by every sync).
CREATE INDEX IF NOT EXISTS idx_logs_family_id
  ON public.logs (family_id);
