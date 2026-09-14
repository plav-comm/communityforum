-- ============================================================
-- Migration 005: make "General Session" a true last resort
--
-- The bug this fixes: General Session was scoring like any other topic, and
-- because almost every municipal title contains "council meeting" or "regular
-- meeting", it outscored the real subjects and consumed the per-video tag
-- budget. Result: 33 of 35 videos tagged General Session and nothing else,
-- while Budget & Taxes and Public Safety had zero videos and vanished from the
-- topic filter entirely.
--
-- The fix: fallback topics never compete. They are attached only when no
-- substantive topic qualifies.
-- ============================================================

ALTER TABLE topics ADD COLUMN IF NOT EXISTS is_fallback BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE topics SET is_fallback = TRUE, show_in_trending = FALSE WHERE slug = 'general-session';

-- Its keyword rules and body hints are now dead weight: retire them so nobody
-- wonders later why they appear to have no effect.
UPDATE topic_rules SET is_active = FALSE
  WHERE topic_id = (SELECT id FROM topics WHERE slug = 'general-session');

DELETE FROM gov_body_topics
  WHERE topic_id = (SELECT id FROM topics WHERE slug = 'general-session');

-- Those same "kind of meeting" phrases ARE meaningful for real topics, so route
-- them where they belong instead of throwing the signal away.
WITH r(slug, term, weight) AS (VALUES
  ('budget-taxes',   'budget work session',    3.0),
  ('budget-taxes',   'budget hearing',         3.0),
  ('budget-taxes',   'budget session',         2.8),
  ('public-comment', 'public hearing',         3.0),
  ('public-comment', 'special meeting',        1.2),
  ('open-government','work session',           1.2),
  ('open-government','executive session',      2.5),
  ('open-government','consent agenda',         2.2),
  ('open-government','regular meeting',        0.9),
  ('open-government','regular session',        0.9),
  ('open-government','formal meeting',         0.9),
  ('open-government','business meeting',       0.9),
  ('open-government','voting meeting',         1.2),
  ('open-government','agendas',                1.0),
  ('open-government','minutes',                1.0),
  ('open-government','packets',                1.0),
  ('open-government','meeting portal',         1.5),
  ('open-government','public meeting',         1.5),
  ('open-government','council chambers',       1.0),
  ('open-government','board of commissioners', 1.2),
  ('open-government','city clerk',             1.5)
)
INSERT INTO topic_rules (topic_id, term, weight)
SELECT t.id, r.term, r.weight
FROM r JOIN topics t ON t.slug = r.slug
ON CONFLICT (topic_id, term) DO UPDATE SET weight = EXCLUDED.weight, is_active = TRUE;
