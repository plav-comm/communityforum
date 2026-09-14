-- ============================================================
-- Migration 004: keep the catch-all out of the trending module
--
-- "General Session" is a fallback bucket, not a subject anyone browses by
-- interest. It should stay filterable, but it should not sit at the top of
-- "Top community topics" purely because most full meetings land there.
-- ============================================================

ALTER TABLE topics ADD COLUMN IF NOT EXISTS show_in_trending BOOLEAN NOT NULL DEFAULT TRUE;

UPDATE topics SET show_in_trending = FALSE WHERE slug = 'general-session';
