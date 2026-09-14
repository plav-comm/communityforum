-- ============================================================
-- Community-Span — core schema
-- Migration 001: initial tables
-- ============================================================

-- ---------- topics ----------
-- The civic subject categories a meeting can be tagged with.
CREATE TABLE IF NOT EXISTS topics (
  id           SERIAL PRIMARY KEY,
  slug         TEXT NOT NULL UNIQUE,
  label        TEXT NOT NULL,
  description  TEXT,
  sort_order   INTEGER NOT NULL DEFAULT 100,
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- topic_rules ----------
-- Keyword rules that drive classification. Kept in the DATABASE, not in code,
-- so topics can be tuned without a redeploy.
--   term   : a phrase to look for (matched on word boundaries, case-insensitive)
--   weight : how strongly this term implies the topic
CREATE TABLE IF NOT EXISTS topic_rules (
  id         SERIAL PRIMARY KEY,
  topic_id   INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  term       TEXT NOT NULL,
  weight     NUMERIC(4,2) NOT NULL DEFAULT 1.0,
  is_active  BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (topic_id, term)
);
CREATE INDEX IF NOT EXISTS topic_rules_topic_idx ON topic_rules(topic_id) WHERE is_active;

-- ---------- channels ----------
-- One row per monitored municipal / county / school district YouTube channel.
CREATE TABLE IF NOT EXISTS channels (
  id                      SERIAL PRIMARY KEY,
  yt_channel_id           TEXT NOT NULL UNIQUE,          -- e.g. UCmkFU-mJsajb_SK7sHPi2tQ
  name                    TEXT NOT NULL,                 -- channel display name
  municipality            TEXT NOT NULL,                 -- "Palm Bay"
  county                  TEXT,                          -- "Brevard County"
  state_code              CHAR(2) NOT NULL,              -- "FL"
  state_name              TEXT NOT NULL,                 -- "Florida"
  gov_body                TEXT NOT NULL,                 -- "City Council", "Select Board", ...
  population              INTEGER,                       -- best-known population served
  size_tier               TEXT,                          -- xs | sm | md | lg | xl
  timezone                TEXT NOT NULL DEFAULT 'America/New_York',
  website                 TEXT,
  is_active               BOOLEAN NOT NULL DEFAULT TRUE,

  -- WebSub subscription bookkeeping
  websub_state            TEXT NOT NULL DEFAULT 'pending',   -- pending|active|failed|unsubscribed
  websub_secret           TEXT,                              -- per-channel HMAC secret
  websub_expires_at       TIMESTAMPTZ,
  websub_last_request_at  TIMESTAMPTZ,
  websub_last_error       TEXT,

  uploads_playlist_id     TEXT,                              -- cached UU... playlist for backfill
  last_backfilled_at      TIMESTAMPTZ,

  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT channels_size_tier_chk
    CHECK (size_tier IS NULL OR size_tier IN ('xs', 'sm', 'md', 'lg', 'xl')),
  CONSTRAINT channels_websub_state_chk
    CHECK (websub_state IN ('pending', 'active', 'failed', 'unsubscribed'))
);
CREATE INDEX IF NOT EXISTS channels_state_idx  ON channels(state_code);
CREATE INDEX IF NOT EXISTS channels_active_idx ON channels(is_active) WHERE is_active;
CREATE INDEX IF NOT EXISTS channels_renew_idx  ON channels(websub_expires_at) WHERE is_active;

-- ---------- videos ----------
-- One row per ingested meeting video / livestream.
CREATE TABLE IF NOT EXISTS videos (
  id                  SERIAL PRIMARY KEY,
  yt_video_id         TEXT NOT NULL UNIQUE,
  channel_id          INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,

  title               TEXT NOT NULL,
  description         TEXT,
  published_at        TIMESTAMPTZ,
  duration_seconds    INTEGER,
  thumbnail_url       TEXT,
  view_count          BIGINT,

  -- live | upcoming | recorded  (derived from YouTube liveStreamingDetails)
  status              TEXT NOT NULL DEFAULT 'recorded',
  scheduled_start_at  TIMESTAMPTZ,
  actual_start_at     TIMESTAMPTZ,
  actual_end_at       TIMESTAMPTZ,

  is_hidden           BOOLEAN NOT NULL DEFAULT FALSE,   -- manual moderation flag
  transcript_status   TEXT NOT NULL DEFAULT 'none',     -- none|available|failed
  raw                 JSONB,                            -- full API payload, for later reprocessing

  classified_at       TIMESTAMPTZ,
  first_seen_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  search_tsv TSVECTOR GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(title, '') || ' ' || coalesce(description, ''))
  ) STORED,

  CONSTRAINT videos_status_chk CHECK (status IN ('live', 'upcoming', 'recorded')),
  CONSTRAINT videos_transcript_chk CHECK (transcript_status IN ('none', 'available', 'failed'))
);
CREATE INDEX IF NOT EXISTS videos_channel_idx   ON videos(channel_id);
CREATE INDEX IF NOT EXISTS videos_published_idx ON videos(published_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS videos_status_idx    ON videos(status) WHERE status <> 'recorded';
CREATE INDEX IF NOT EXISTS videos_search_idx    ON videos USING GIN(search_tsv);
CREATE INDEX IF NOT EXISTS videos_visible_idx   ON videos(published_at DESC) WHERE NOT is_hidden;

-- ---------- video_topics ----------
-- Many-to-many: a meeting can carry several civic topics, each with a score.
CREATE TABLE IF NOT EXISTS video_topics (
  video_id       INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  topic_id       INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  score          NUMERIC(6,2) NOT NULL DEFAULT 0,
  matched_terms  TEXT[] NOT NULL DEFAULT '{}',
  source         TEXT NOT NULL DEFAULT 'metadata',   -- metadata|transcript|manual
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (video_id, topic_id)
);
CREATE INDEX IF NOT EXISTS video_topics_topic_idx ON video_topics(topic_id);

-- ---------- websub_events ----------
-- Audit trail of every push notification YouTube sends us. Also gives us
-- idempotency: the same notification arriving twice is recorded, not double-processed.
CREATE TABLE IF NOT EXISTS websub_events (
  id               BIGSERIAL PRIMARY KEY,
  yt_channel_id    TEXT,
  yt_video_id      TEXT,
  action           TEXT NOT NULL DEFAULT 'upsert',   -- upsert|delete
  signature_valid  BOOLEAN NOT NULL DEFAULT FALSE,
  body_sha256      TEXT,
  processed        BOOLEAN NOT NULL DEFAULT FALSE,
  error            TEXT,
  received_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS websub_events_video_idx ON websub_events(yt_video_id);
CREATE INDEX IF NOT EXISTS websub_events_time_idx  ON websub_events(received_at DESC);

-- ---------- job_runs ----------
-- Every run of the daily safety net, so you can prove the pipeline is healthy.
CREATE TABLE IF NOT EXISTS job_runs (
  id           BIGSERIAL PRIMARY KEY,
  job_name     TEXT NOT NULL,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at  TIMESTAMPTZ,
  ok           BOOLEAN,
  details      JSONB,
  error        TEXT
);
CREATE INDEX IF NOT EXISTS job_runs_name_idx ON job_runs(job_name, started_at DESC);

-- ---------- keep updated_at honest ----------
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS channels_touch ON channels;
CREATE TRIGGER channels_touch BEFORE UPDATE ON channels
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

DROP TRIGGER IF EXISTS videos_touch ON videos;
CREATE TRIGGER videos_touch BEFORE UPDATE ON videos
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ---------- public read view ----------
-- One flat row per visible video, with its channel and topics already joined.
-- The API reads from this so route code stays simple.
CREATE OR REPLACE VIEW v_videos_public AS
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
  COALESCE(
    (SELECT jsonb_agg(jsonb_build_object('slug', t.slug, 'label', t.label, 'score', vt.score)
            ORDER BY vt.score DESC, t.sort_order)
     FROM video_topics vt JOIN topics t ON t.id = vt.topic_id
     WHERE vt.video_id = v.id),
    '[]'::jsonb
  ) AS topics,
  v.search_tsv
FROM videos v
JOIN channels c ON c.id = v.channel_id
WHERE NOT v.is_hidden AND c.is_active;
