-- ============================================================
-- Migration 003: governing-body hints + a general-session fallback
--
-- Why this exists. Municipal clerks often title a video with nothing but
-- "City Council Meeting - August 11, 2026". There is no agenda text to match,
-- so a pure keyword pass leaves it untagged and it disappears from every topic
-- filter on the site.
--
-- Two fixes, both explainable:
--   1. The governing BODY itself is evidence. A School Board meeting is about
--      schools; a Planning & Zoning hearing is about zoning. We encode that as
--      weighted hints rather than pretending the classifier read an agenda.
--   2. A "General Session" topic so a full mixed-agenda meeting is still
--      browsable instead of vanishing.
-- ============================================================

INSERT INTO topics (slug, label, description, sort_order) VALUES
  ('general-session', 'General Session',
   'A full regular meeting covering a mixed agenda, with no single dominant subject.', 95)
ON CONFLICT (slug) DO UPDATE
  SET label = EXCLUDED.label, description = EXCLUDED.description, sort_order = EXCLUDED.sort_order;

-- ------------------------------------------------------------
-- gov_body_topics: what the type of meeting implies on its own.
-- Weights are deliberately modest so real agenda text always wins.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS gov_body_topics (
  id        SERIAL PRIMARY KEY,
  gov_body  TEXT NOT NULL,
  topic_id  INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  weight    NUMERIC(4,2) NOT NULL DEFAULT 1.0,
  UNIQUE (gov_body, topic_id)
);

WITH h(gov_body, slug, weight) AS (VALUES
  ('School Board',      'schools-education', 3.0),
  ('School Board',      'budget-taxes',      0.8),
  ('Planning & Zoning', 'zoning-housing',    3.0),
  ('Planning & Zoning', 'public-comment',    1.0),
  ('County Commission', 'general-session',   1.0),
  ('City Council',      'general-session',   1.0),
  ('Select Board',      'general-session',   1.0),
  ('Board of Aldermen', 'general-session',   1.0),
  ('Town Council',      'general-session',   1.0)
)
INSERT INTO gov_body_topics (gov_body, topic_id, weight)
SELECT h.gov_body, t.id, h.weight
FROM h JOIN topics t ON t.slug = h.slug
ON CONFLICT (gov_body, topic_id) DO UPDATE SET weight = EXCLUDED.weight;

-- ------------------------------------------------------------
-- Title-shape rules. These catch the very common case where the title names
-- the KIND of meeting, which is itself a strong topic signal.
-- ------------------------------------------------------------
WITH r(slug, term, weight) AS (VALUES
  ('general-session', 'regular meeting',       2.0),
  ('general-session', 'regular session',       2.0),
  ('general-session', 'formal meeting',        2.0),
  ('general-session', 'business meeting',      2.0),
  ('general-session', 'full meeting',          2.0),
  ('general-session', 'voting meeting',        2.0),
  ('general-session', 'council meeting',       1.2),
  ('general-session', 'commission meeting',    1.2),
  ('general-session', 'board meeting',         1.2),
  ('general-session', 'work session',          1.5),
  ('general-session', 'special meeting',       1.8),
  ('budget-taxes',    'budget amendment',      2.5),
  ('budget-taxes',    'millage hearing',       3.0),
  ('public-comment',  'input time',            2.5),
  ('public-comment',  'citizens input time',   3.0),
  ('zoning-housing',  'zoning commission',     3.0),
  ('zoning-housing',  'zoning hearing',        3.0),
  ('infrastructure',  'city manager report',   1.2),
  ('open-government', 'agenda',                0.8)
)
INSERT INTO topic_rules (topic_id, term, weight)
SELECT t.id, r.term, r.weight
FROM r JOIN topics t ON t.slug = r.slug
ON CONFLICT (topic_id, term) DO UPDATE SET weight = EXCLUDED.weight, is_active = TRUE;
