-- ============================================================
-- Migration 002: civic topics + the keyword rules that tag them
-- Safe to re-run. Edit or add rows here (or directly in the DB)
-- to tune tagging without touching application code.
-- ============================================================

INSERT INTO topics (slug, label, description, sort_order) VALUES
  ('zoning-housing',   'Zoning & Housing',    'Rezoning, variances, subdivisions, permits, affordable housing and land use.', 10),
  ('budget-taxes',     'Budget & Taxes',      'Budgets, millage and tax rates, audits, appropriations and bonds.',            20),
  ('public-safety',    'Public Safety',       'Police, fire, EMS, emergency management and code enforcement.',                30),
  ('infrastructure',   'Infrastructure',      'Roads, bridges, transit, utilities, sidewalks and capital projects.',          40),
  ('public-comment',   'Public Comment',      'Open citizen comment periods, public hearings and resident testimony.',        50),
  ('schools-education','Schools & Education', 'School boards, districts, curriculum, facilities and student services.',       60),
  ('water-environment','Water & Environment', 'Water, sewer, stormwater, sustainability, parks land and conservation.',       70),
  ('parks-recreation', 'Parks & Recreation',  'Parks, trails, libraries, community centers and recreation programs.',         80),
  ('open-government',  'Open Government',     'Meeting procedure, ethics, records, elections and appointments.',              90)
ON CONFLICT (slug) DO UPDATE
  SET label = EXCLUDED.label,
      description = EXCLUDED.description,
      sort_order = EXCLUDED.sort_order;

-- ------------------------------------------------------------
-- Keyword rules. Matched case-insensitively on word boundaries
-- against the video title, description and YouTube tags.
-- Higher weight = stronger signal.
-- ------------------------------------------------------------
WITH r(slug, term, weight) AS (VALUES
  -- Zoning & Housing
  ('zoning-housing', 'zoning', 3.0), ('zoning-housing', 'rezone', 3.0), ('zoning-housing', 'rezoning', 3.0),
  ('zoning-housing', 'variance', 2.5), ('zoning-housing', 'special use permit', 2.5),
  ('zoning-housing', 'conditional use', 2.5), ('zoning-housing', 'site plan', 2.0),
  ('zoning-housing', 'subdivision', 2.0), ('zoning-housing', 'plat', 1.8),
  ('zoning-housing', 'planning commission', 3.0), ('zoning-housing', 'planning board', 3.0),
  ('zoning-housing', 'zoning board', 3.0), ('zoning-housing', 'board of appeals', 2.2),
  ('zoning-housing', 'land use', 2.5), ('zoning-housing', 'comprehensive plan', 2.2),
  ('zoning-housing', 'affordable housing', 3.0), ('zoning-housing', 'housing authority', 2.5),
  ('zoning-housing', 'setback', 1.5), ('zoning-housing', 'density', 1.5),
  ('zoning-housing', 'short term rental', 2.0), ('zoning-housing', 'accessory dwelling', 2.2),
  ('zoning-housing', 'development agreement', 1.8), ('zoning-housing', 'annexation', 2.0),

  -- Budget & Taxes
  ('budget-taxes', 'budget', 3.0), ('budget-taxes', 'millage', 3.0), ('budget-taxes', 'tax rate', 3.0),
  ('budget-taxes', 'property tax', 2.8), ('budget-taxes', 'levy', 2.5), ('budget-taxes', 'appropriation', 2.5),
  ('budget-taxes', 'fiscal year', 2.2), ('budget-taxes', 'audit', 2.2), ('budget-taxes', 'bond', 2.0),
  ('budget-taxes', 'capital improvement plan', 2.2), ('budget-taxes', 'cip', 1.5),
  ('budget-taxes', 'revenue', 1.8), ('budget-taxes', 'expenditure', 1.8), ('budget-taxes', 'finance committee', 2.5),
  ('budget-taxes', 'tax abatement', 2.5), ('budget-taxes', 'assessment', 1.5),
  ('budget-taxes', 'budget hearing', 3.0), ('budget-taxes', 'budget work session', 3.0),
  ('budget-taxes', 'american rescue plan', 2.0), ('budget-taxes', 'arpa', 2.0),

  -- Public Safety
  ('public-safety', 'police', 3.0), ('public-safety', 'fire department', 3.0), ('public-safety', 'fire district', 2.8),
  ('public-safety', 'sheriff', 2.8), ('public-safety', 'ems', 2.5), ('public-safety', 'emergency management', 2.8),
  ('public-safety', 'public safety', 3.0), ('public-safety', 'code enforcement', 2.2),
  ('public-safety', 'crime', 2.0), ('public-safety', 'ordinance violation', 1.8),
  ('public-safety', 'first responder', 2.2), ('public-safety', 'ambulance', 2.0),
  ('public-safety', 'dispatch', 1.8), ('public-safety', 'hurricane', 2.0), ('public-safety', 'evacuation', 2.2),
  ('public-safety', 'speed limit', 1.5), ('public-safety', 'traffic safety', 2.0),

  -- Infrastructure
  ('infrastructure', 'infrastructure', 3.0), ('infrastructure', 'road', 2.2), ('infrastructure', 'roadway', 2.5),
  ('infrastructure', 'street improvement', 2.5), ('infrastructure', 'paving', 2.2), ('infrastructure', 'sidewalk', 2.2),
  ('infrastructure', 'bridge', 2.2), ('infrastructure', 'transit', 2.5), ('infrastructure', 'traffic signal', 2.2),
  ('infrastructure', 'right of way', 2.0), ('infrastructure', 'utility', 2.0), ('infrastructure', 'broadband', 2.5),
  ('infrastructure', 'construction contract', 2.0), ('infrastructure', 'public works', 3.0),
  ('infrastructure', 'capital project', 2.2), ('infrastructure', 'intersection', 1.8),
  ('infrastructure', 'drainage', 2.0), ('infrastructure', 'airport', 2.0),

  -- Public Comment
  ('public-comment', 'public comment', 3.0), ('public-comment', 'public hearing', 3.0),
  ('public-comment', 'citizen comment', 3.0), ('public-comment', 'citizens input', 3.0),
  ('public-comment', 'public input', 2.8), ('public-comment', 'public participation', 2.5),
  ('public-comment', 'town hall', 2.5), ('public-comment', 'listening session', 2.5),
  ('public-comment', 'open forum', 2.2), ('public-comment', 'resident testimony', 2.5),
  ('public-comment', 'community meeting', 2.0), ('public-comment', 'open house', 1.8),

  -- Schools & Education
  ('schools-education', 'school board', 3.0), ('schools-education', 'school district', 3.0),
  ('schools-education', 'superintendent', 2.8), ('schools-education', 'curriculum', 2.5),
  ('schools-education', 'student', 1.8), ('schools-education', 'teacher', 2.0),
  ('schools-education', 'elementary school', 2.2), ('schools-education', 'high school', 2.0),
  ('schools-education', 'board of education', 3.0), ('schools-education', 'enrollment', 2.0),
  ('schools-education', 'title ix', 2.2), ('schools-education', 'school budget', 2.8),
  ('schools-education', 'bus route', 1.8), ('schools-education', 'graduation', 1.5),

  -- Water & Environment
  ('water-environment', 'water', 2.2), ('water-environment', 'wastewater', 3.0), ('water-environment', 'sewer', 2.8),
  ('water-environment', 'stormwater', 2.8), ('water-environment', 'water treatment', 3.0),
  ('water-environment', 'water quality', 2.8), ('water-environment', 'drought', 2.5),
  ('water-environment', 'environmental', 2.2), ('water-environment', 'sustainability', 2.2),
  ('water-environment', 'conservation', 2.2), ('water-environment', 'solid waste', 2.5),
  ('water-environment', 'recycling', 2.2), ('water-environment', 'landfill', 2.2),
  ('water-environment', 'wetland', 2.2), ('water-environment', 'flood', 2.0),
  ('water-environment', 'climate', 2.0), ('water-environment', 'sea level', 2.2),

  -- Parks & Recreation
  ('parks-recreation', 'parks and recreation', 3.0), ('parks-recreation', 'park', 2.0),
  ('parks-recreation', 'recreation', 2.5), ('parks-recreation', 'trail', 2.2),
  ('parks-recreation', 'playground', 2.2), ('parks-recreation', 'library', 2.5),
  ('parks-recreation', 'community center', 2.5), ('parks-recreation', 'athletic field', 2.2),
  ('parks-recreation', 'pool', 1.8), ('parks-recreation', 'beach', 1.8),
  ('parks-recreation', 'festival', 1.8), ('parks-recreation', 'senior center', 2.2),

  -- Open Government
  ('open-government', 'consent agenda', 2.2), ('open-government', 'minutes', 1.5),
  ('open-government', 'executive session', 2.5), ('open-government', 'closed session', 2.5),
  ('open-government', 'ethics', 2.5), ('open-government', 'public records', 2.5),
  ('open-government', 'open meeting', 2.8), ('open-government', 'sunshine law', 2.8),
  ('open-government', 'election', 2.2), ('open-government', 'appointment', 1.8),
  ('open-government', 'proclamation', 1.8), ('open-government', 'resolution', 1.5),
  ('open-government', 'ordinance', 1.5), ('open-government', 'charter', 2.0),
  ('open-government', 'redistricting', 2.5), ('open-government', 'transparency', 2.2),
  ('open-government', 'roll call', 1.5), ('open-government', 'call to order', 1.5)
)
INSERT INTO topic_rules (topic_id, term, weight)
SELECT t.id, r.term, r.weight
FROM r JOIN topics t ON t.slug = r.slug
ON CONFLICT (topic_id, term) DO UPDATE SET weight = EXCLUDED.weight, is_active = TRUE;
