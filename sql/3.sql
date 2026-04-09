-- ── 3.sql ── Migration: baby name & emoji columns on families ────────────────
-- Run this after 1.sql and 2.sql to enable cross-device name/emoji sync.

-- Add name + emoji columns (idempotent)
ALTER TABLE families ADD COLUMN IF NOT EXISTS baby_name  text;
ALTER TABLE families ADD COLUMN IF NOT EXISTS baby_emoji text;

-- Allow anonymous users to UPDATE families (needed to push name/emoji changes).
-- The existing anon_select_families and anon_insert_families policies cover
-- SELECT and INSERT; this adds UPDATE.
CREATE POLICY "anon_update_families" ON public.families
  FOR UPDATE TO anon
  USING (true)
  WITH CHECK (true);
