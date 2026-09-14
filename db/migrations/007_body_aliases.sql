-- ============================================================
-- Migration 007: make governing-body hints survive new feeds
--
-- The gap: hints are looked up by an exact gov_body string. Only
-- "School Board" and "Planning & Zoning" had rows, so a new town added as
-- "Board of Education", "School Committee" or "Zoning Board of Appeals" would
-- silently get no hint — the tagging quietly degrades as you scale, which is
-- the worst kind of bug because nothing errors.
--
-- Fix: cover the naming conventions American municipalities actually use.
-- Lookup is also normalised (trimmed, case-insensitive) in the classifier.
-- ============================================================

WITH h(gov_body, slug, weight) AS (VALUES
  -- schools
  ('School Board',              'schools-education', 3.0),
  ('Board of Education',        'schools-education', 3.0),
  ('School Committee',          'schools-education', 3.0),
  ('School District',           'schools-education', 3.0),
  ('Board of School Directors', 'schools-education', 3.0),
  ('School Board',              'budget-taxes',      0.8),
  ('Board of Education',        'budget-taxes',      0.8),

  -- land use
  ('Planning & Zoning',         'zoning-housing',    3.0),
  ('Planning Commission',       'zoning-housing',    3.0),
  ('Planning Board',            'zoning-housing',    3.0),
  ('Zoning Board',              'zoning-housing',    3.0),
  ('Zoning Commission',         'zoning-housing',    3.0),
  ('Zoning Board of Appeals',   'zoning-housing',    3.0),
  ('Board of Adjustment',       'zoning-housing',    2.6),
  ('Board of Appeals',          'zoning-housing',    2.2),
  ('Design Review Board',       'zoning-housing',    2.2),
  ('Historic Commission',       'zoning-housing',    1.8),
  ('Planning & Zoning',         'public-comment',    1.0),
  ('Planning Commission',       'public-comment',    1.0),
  ('Zoning Commission',         'public-comment',    1.0),

  -- single-purpose bodies whose subject really is their name
  ('Board of Health',           'water-environment', 2.0),
  ('Water Board',               'water-environment', 3.0),
  ('Water District',            'water-environment', 3.0),
  ('Sewer Commission',          'water-environment', 3.0),
  ('Conservation Commission',   'water-environment', 2.8),
  ('Parks Board',               'parks-recreation',  3.0),
  ('Parks & Recreation Board',  'parks-recreation',  3.0),
  ('Library Board',             'parks-recreation',  2.6),
  ('Police Commission',         'public-safety',     3.0),
  ('Fire District',             'public-safety',     3.0),
  ('Public Safety Committee',   'public-safety',     3.0),
  ('Finance Committee',         'budget-taxes',      3.0),
  ('Budget Committee',          'budget-taxes',      3.0),
  ('Board of Assessors',        'budget-taxes',      2.4),
  ('Audit Committee',           'budget-taxes',      2.4),
  ('Public Works Board',        'infrastructure',    3.0),
  ('Transportation Commission', 'infrastructure',    3.0),
  ('Utilities Board',           'infrastructure',    2.6),
  ('Ethics Commission',         'open-government',   3.0),
  ('Election Commission',       'open-government',   3.0),
  ('Charter Commission',        'open-government',   2.6)
  -- General-purpose bodies (City Council, Select Board, County Commission,
  -- Town Council, Board of Aldermen, City Commission, Board of Supervisors,
  -- Board of Trustees) deliberately get NO hint: their agendas are mixed, so
  -- any subject we assigned would be a guess. Those fall to General Session
  -- unless the title or description names a subject.
)
INSERT INTO gov_body_topics (gov_body, topic_id, weight)
SELECT h.gov_body, t.id, h.weight
FROM h JOIN topics t ON t.slug = h.slug
ON CONFLICT (gov_body, topic_id) DO UPDATE SET weight = EXCLUDED.weight;
