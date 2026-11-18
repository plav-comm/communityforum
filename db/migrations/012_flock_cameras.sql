-- ============================================================
-- Migration 012: Flock cameras (automated license plate readers)
--
-- A national issue in its own right: councils across the country are voting
-- on contracts with Flock Safety and other ALPR vendors, and on limits to how
-- the data is shared. Agendas name these consistently ("Flock Safety",
-- "license plate readers", "ALPR"), so keyword tagging finds them reliably.
--
-- "flock" alone is weighted low: it counts in a title or beside another term,
-- not by itself in a long description (a church "flock", a "flock of geese").
-- ============================================================

INSERT INTO topics (slug, label, description, sort_order, topic_group) VALUES
  ('flock-cameras', 'Flock Cameras & License Plate Readers',
   'Flock Safety and other automated license plate reader (ALPR) cameras: contracts, data sharing and privacy limits.',
   250, 'national')
ON CONFLICT (slug) DO UPDATE
  SET label = EXCLUDED.label, description = EXCLUDED.description,
      sort_order = EXCLUDED.sort_order, topic_group = EXCLUDED.topic_group;

WITH r(slug, term, weight) AS (VALUES
  ('flock-cameras', 'flock safety', 3.0),
  ('flock-cameras', 'flock camera', 3.0), ('flock-cameras', 'flock cameras', 3.0),
  ('flock-cameras', 'flock group', 3.0), ('flock-cameras', 'flock falcon', 3.0),
  ('flock-cameras', 'flock lpr', 3.0), ('flock-cameras', 'flock alpr', 3.0),
  ('flock-cameras', 'flock', 1.0),
  ('flock-cameras', 'license plate reader', 3.0), ('flock-cameras', 'license plate readers', 3.0),
  ('flock-cameras', 'license plate recognition', 3.0), ('flock-cameras', 'license plate camera', 3.0),
  ('flock-cameras', 'license plate cameras', 3.0), ('flock-cameras', 'plate reader', 2.5),
  ('flock-cameras', 'plate readers', 2.5), ('flock-cameras', 'automated license plate', 3.0),
  ('flock-cameras', 'alpr', 3.0), ('flock-cameras', 'alprs', 3.0), ('flock-cameras', 'lpr camera', 3.0),
  ('flock-cameras', 'lpr cameras', 3.0), ('flock-cameras', 'motorola vehicle manager', 2.5),
  ('flock-cameras', 'surveillance camera', 2.0), ('flock-cameras', 'surveillance cameras', 2.0),
  ('flock-cameras', 'surveillance technology', 2.0)
)
INSERT INTO topic_rules (topic_id, term, weight)
SELECT t.id, r.term, r.weight
FROM r JOIN topics t ON t.slug = r.slug
ON CONFLICT (topic_id, term) DO UPDATE SET weight = EXCLUDED.weight, is_active = TRUE;

-- License plate readers now have their own topic, so Policing & Homelessness
-- stops double-tagging the same agenda item.
UPDATE topic_rules SET is_active = FALSE
 WHERE topic_id = (SELECT id FROM topics WHERE slug = 'policing-oversight')
   AND term IN ('license plate reader', 'license plate readers', 'surveillance technology');
