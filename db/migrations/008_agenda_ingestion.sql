-- ============================================================
-- Migration 008: agenda ingestion
--
-- Why: a YouTube title and description usually cannot tell you what a meeting
-- was about. The agenda can. Legistar (Granicus) and PrimeGov both publish
-- agendas over public HTTP with no key and no fee, so we ingest them and feed
-- the text to the same classifier.
--
--   agenda_sources   a catalogue of towns whose agenda system we can read,
--                    so new communities can be picked from a list instead of
--                    hand-configured
--   agenda_meetings  one row per published meeting agenda
--   agenda_items     the individual agenda items — this is the topical text
-- ============================================================

-- ---------- catalogue of readable agenda systems ----------
CREATE TABLE IF NOT EXISTS agenda_sources (
  id                 SERIAL PRIMARY KEY,
  vendor             TEXT NOT NULL,              -- legistar | primegov
  client_code        TEXT NOT NULL,              -- 'seattle', 'longmont'
  display_name       TEXT,                       -- 'Seattle, WA'
  state_code         CHAR(2),
  bodies             JSONB NOT NULL DEFAULT '[]'::jsonb,  -- governing bodies seen
  meetings_seen      INTEGER NOT NULL DEFAULT 0,
  latest_meeting_at  TIMESTAMPTZ,
  is_available       BOOLEAN NOT NULL DEFAULT TRUE,
  last_verified_at   TIMESTAMPTZ,
  last_error         TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (vendor, client_code),
  CONSTRAINT agenda_sources_vendor_chk CHECK (vendor IN ('legistar', 'primegov'))
);
CREATE INDEX IF NOT EXISTS agenda_sources_avail_idx ON agenda_sources(is_available, vendor);
CREATE INDEX IF NOT EXISTS agenda_sources_name_idx  ON agenda_sources(display_name);

DROP TRIGGER IF EXISTS agenda_sources_touch ON agenda_sources;
CREATE TRIGGER agenda_sources_touch BEFORE UPDATE ON agenda_sources
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ---------- link a monitored channel to its agenda system ----------
ALTER TABLE channels ADD COLUMN IF NOT EXISTS agenda_vendor     TEXT;
ALTER TABLE channels ADD COLUMN IF NOT EXISTS agenda_client     TEXT;
ALTER TABLE channels ADD COLUMN IF NOT EXISTS agenda_synced_at  TIMESTAMPTZ;
ALTER TABLE channels ADD COLUMN IF NOT EXISTS agenda_last_error TEXT;

-- ---------- published meeting agendas ----------
CREATE TABLE IF NOT EXISTS agenda_meetings (
  id            SERIAL PRIMARY KEY,
  vendor        TEXT NOT NULL,
  client_code   TEXT NOT NULL,
  external_id   TEXT NOT NULL,          -- EventId / meeting id at the vendor
  channel_id    INTEGER REFERENCES channels(id) ON DELETE SET NULL,
  body_name     TEXT,                   -- 'Land Use and Sustainability Committee'
  title         TEXT,
  meeting_date  DATE,
  meeting_at    TIMESTAMPTZ,
  agenda_url    TEXT,
  item_count    INTEGER NOT NULL DEFAULT 0,
  agenda_text   TEXT,                   -- flattened item text, fed to the classifier
  fetched_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (vendor, client_code, external_id)
);
CREATE INDEX IF NOT EXISTS agenda_meetings_date_idx    ON agenda_meetings(meeting_date DESC);
CREATE INDEX IF NOT EXISTS agenda_meetings_channel_idx ON agenda_meetings(channel_id, meeting_date DESC);

-- ---------- individual agenda items ----------
CREATE TABLE IF NOT EXISTS agenda_items (
  id            BIGSERIAL PRIMARY KEY,
  meeting_id    INTEGER NOT NULL REFERENCES agenda_meetings(id) ON DELETE CASCADE,
  position      INTEGER NOT NULL,
  title         TEXT NOT NULL,
  matter_type   TEXT,                   -- Ordinance, Resolution, Appointment ...
  action        TEXT,
  UNIQUE (meeting_id, position)
);
CREATE INDEX IF NOT EXISTS agenda_items_meeting_idx ON agenda_items(meeting_id);

-- ---------- which agenda a video was matched to ----------
ALTER TABLE videos ADD COLUMN IF NOT EXISTS agenda_meeting_id INTEGER
  REFERENCES agenda_meetings(id) ON DELETE SET NULL;
ALTER TABLE videos ADD COLUMN IF NOT EXISTS agenda_matched_at TIMESTAMPTZ;

-- Expose the agenda link on the public view so the API and UI can show
-- "agenda-backed" tagging and, later, the item list itself.
--
-- DROP then CREATE, not CREATE OR REPLACE: Postgres will not let a replacement
-- insert new columns ahead of existing ones, and these belong next to the other
-- meeting fields rather than tacked on the end.
DROP VIEW IF EXISTS v_videos_public;
CREATE VIEW v_videos_public AS
SELECT
  v.yt_video_id,
  v.title,
  v.description,
  v.published_at,
  v.duration_seconds,
  v.thumbnail_url,
  v.view_count,
  v.status,
  v.scheduled_start_at,
  v.actual_start_at,
  c.yt_channel_id,
  c.name          AS channel_name,
  c.municipality,
  c.county,
  c.state_code,
  c.state_name,
  c.gov_body,
  c.population,
  c.size_tier,
  am.id           AS agenda_meeting_id,
  am.agenda_url,
  am.item_count   AS agenda_item_count,
  COALESCE(
    (SELECT jsonb_agg(jsonb_build_object('slug', t.slug, 'label', t.label, 'score', vt.score,
                                         'source', vt.source)
            ORDER BY vt.score DESC, t.sort_order)
     FROM video_topics vt JOIN topics t ON t.id = vt.topic_id
     WHERE vt.video_id = v.id),
    '[]'::jsonb
  ) AS topics,
  v.search_tsv
FROM videos v
JOIN channels c ON c.id = v.channel_id
LEFT JOIN agenda_meetings am ON am.id = v.agenda_meeting_id
WHERE NOT v.is_hidden AND c.is_active;
