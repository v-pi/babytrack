-- ── 4.sql ── Migration: volume column for bottle logs ───────────────────────
-- Run after 1.sql, 2.sql, 3.sql.
-- Adds the `volume` integer column (ml) to the logs table for bottle tracking.

ALTER TABLE logs ADD COLUMN IF NOT EXISTS volume integer;
