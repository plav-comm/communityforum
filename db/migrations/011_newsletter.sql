-- ============================================================
-- Migration 011: weekly newsletter
--
--   newsletter_settings  one row: the hand-picked towns that always get top
--                        billing when they met that week
--   newsletter_issues    one row per issue drafted, so the weekly job never
--                        drafts the same week twice
-- ============================================================

CREATE TABLE IF NOT EXISTS newsletter_settings (
  id              INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  featured_towns  TEXT[] NOT NULL DEFAULT '{}',     -- 'Akron, OH'
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO newsletter_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS newsletter_issues (
  id              SERIAL PRIMARY KEY,
  issue_key       TEXT NOT NULL UNIQUE,              -- the Monday it was built, YYYY-MM-DD (New York time)
  subject         TEXT NOT NULL,
  meetings        INTEGER NOT NULL DEFAULT 0,
  buttondown_id   TEXT,
  status          TEXT NOT NULL DEFAULT 'draft',
  error           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
