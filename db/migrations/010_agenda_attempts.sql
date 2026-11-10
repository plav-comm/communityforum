-- ============================================================
-- Migration 010: remember when a video was last checked for an agenda
--
-- The daily job looked at the same 400 newest videos every day, so older
-- meetings were never matched. Recording each attempt lets it work through
-- the whole archive a batch at a time, and retry a miss only weekly (the
-- town may post the agenda late).
-- ============================================================

ALTER TABLE videos ADD COLUMN IF NOT EXISTS agenda_tried_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS videos_agenda_todo_idx
  ON videos (published_at DESC) WHERE agenda_meeting_id IS NULL;
