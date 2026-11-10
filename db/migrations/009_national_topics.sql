-- ============================================================
-- Migration 009: nationally relevant topics
--
-- Five issues local bodies are debating all over the country. They sit in
-- their own group ("national") so the site can show them as a separate row,
-- and so they never use up a meeting's ordinary topic slots.
--
-- Deliberately strict: every term names the issue itself. A meeting is tagged
-- only when its title, description or YouTube tags actually mention it, and
-- there are no governing-body hints for these. A School Board meeting is NOT
-- assumed to be about book challenges.
--
-- Terms match whole words and phrases, so plurals are listed separately.
-- Ambiguous words ("solar", "BESS", which is also a first name) carry low
-- weights: they count in a title, or alongside another term, but not alone
-- in a description.
-- ============================================================

ALTER TABLE topics ADD COLUMN IF NOT EXISTS topic_group TEXT NOT NULL DEFAULT 'local';

INSERT INTO topics (slug, label, description, sort_order, topic_group) VALUES
  ('data-centers',       'Data Centers',
   'Data center proposals, rezonings, tax incentives, water and power use.', 200, 'national'),
  ('housing-reform',     'Housing & Zoning Reform',
   'Accessory dwelling units (ADUs), multi-family zoning, inclusionary zoning and affordable-housing mandates.', 210, 'national'),
  ('energy-siting',      'Solar, Wind & Grid',
   'Siting of solar farms, wind turbines, battery energy storage (BESS), substations and transmission lines.', 220, 'national'),
  ('books-curriculum',   'Books & Curriculum',
   'Library book challenges, curriculum transparency and parental-rights policies.', 230, 'national'),
  ('policing-oversight', 'Policing & Homelessness',
   'Police funding, civilian oversight boards, community policing, encampments and homelessness ordinances.', 240, 'national')
ON CONFLICT (slug) DO UPDATE
  SET label = EXCLUDED.label, description = EXCLUDED.description,
      sort_order = EXCLUDED.sort_order, topic_group = EXCLUDED.topic_group;

WITH r(slug, term, weight) AS (VALUES
  -- Data centers
  ('data-centers', 'data center', 3.0), ('data-centers', 'data centers', 3.0),
  ('data-centers', 'data centre', 3.0), ('data-centers', 'data centres', 3.0),
  ('data-centers', 'datacenter', 3.0), ('data-centers', 'datacenters', 3.0),
  ('data-centers', 'data center campus', 3.0), ('data-centers', 'hyperscale', 3.0),
  ('data-centers', 'hyperscaler', 3.0), ('data-centers', 'server farm', 3.0),
  ('data-centers', 'large load', 1.5), ('data-centers', 'large-load', 1.5),

  -- Housing & zoning reform
  ('housing-reform', 'accessory dwelling', 3.0), ('housing-reform', 'accessory dwelling unit', 3.0),
  ('housing-reform', 'accessory dwelling units', 3.0), ('housing-reform', 'adu', 2.5), ('housing-reform', 'adus', 2.5),
  ('housing-reform', 'inclusionary zoning', 3.0), ('housing-reform', 'inclusionary housing', 3.0),
  ('housing-reform', 'missing middle', 3.0), ('housing-reform', 'upzoning', 3.0), ('housing-reform', 'upzone', 3.0),
  ('housing-reform', 'zoning reform', 3.0), ('housing-reform', 'zoning code update', 2.5),
  ('housing-reform', 'zoning code rewrite', 2.5), ('housing-reform', 'unified development code', 2.5),
  ('housing-reform', 'single-family zoning', 3.0), ('housing-reform', 'single family zoning', 3.0),
  ('housing-reform', 'multi-family', 2.2), ('housing-reform', 'multifamily', 2.2), ('housing-reform', 'multi family', 2.2),
  ('housing-reform', 'duplex', 2.0), ('housing-reform', 'duplexes', 2.0), ('housing-reform', 'triplex', 2.2),
  ('housing-reform', 'fourplex', 2.2), ('housing-reform', 'quadplex', 2.2),
  ('housing-reform', 'affordable housing', 2.5), ('housing-reform', 'workforce housing', 2.5),
  ('housing-reform', 'housing affordability', 2.5), ('housing-reform', 'housing element', 2.5),
  ('housing-reform', 'housing needs assessment', 2.5), ('housing-reform', 'housing trust fund', 2.5),

  -- Solar, wind & grid
  ('energy-siting', 'solar farm', 3.0), ('energy-siting', 'solar farms', 3.0),
  ('energy-siting', 'solar facility', 3.0), ('energy-siting', 'solar facilities', 3.0),
  ('energy-siting', 'solar energy facility', 3.0), ('energy-siting', 'solar energy system', 2.5),
  ('energy-siting', 'utility-scale solar', 3.0), ('energy-siting', 'utility scale solar', 3.0),
  ('energy-siting', 'solar ordinance', 3.0), ('energy-siting', 'solar project', 2.5), ('energy-siting', 'solar projects', 2.5),
  ('energy-siting', 'community solar', 2.5), ('energy-siting', 'solar array', 2.5), ('energy-siting', 'solar', 1.5),
  ('energy-siting', 'wind farm', 3.0), ('energy-siting', 'wind farms', 3.0), ('energy-siting', 'wind turbine', 3.0),
  ('energy-siting', 'wind turbines', 3.0), ('energy-siting', 'wind energy', 3.0), ('energy-siting', 'wind project', 2.5),
  ('energy-siting', 'battery storage', 3.0), ('energy-siting', 'battery energy storage', 3.0),
  ('energy-siting', 'bess', 1.5), ('energy-siting', 'energy storage', 2.5),
  ('energy-siting', 'transmission line', 2.5), ('energy-siting', 'transmission lines', 2.5),
  ('energy-siting', 'substation', 2.2), ('energy-siting', 'renewable energy', 2.5),

  -- Books & curriculum
  ('books-curriculum', 'book challenge', 3.0), ('books-curriculum', 'book challenges', 3.0),
  ('books-curriculum', 'challenged books', 3.0), ('books-curriculum', 'book ban', 3.0),
  ('books-curriculum', 'book bans', 3.0), ('books-curriculum', 'banned books', 3.0),
  ('books-curriculum', 'book removal', 3.0), ('books-curriculum', 'library books', 2.5),
  ('books-curriculum', 'library book', 2.5), ('books-curriculum', 'library materials', 2.5),
  ('books-curriculum', 'library policy', 2.2), ('books-curriculum', 'reconsideration', 2.5),
  ('books-curriculum', 'instructional materials', 2.2), ('books-curriculum', 'materials review', 2.5),
  ('books-curriculum', 'book review committee', 3.0), ('books-curriculum', 'textbook adoption', 2.2),
  ('books-curriculum', 'parental rights', 3.0), ('books-curriculum', 'parents rights', 3.0),
  ('books-curriculum', 'parents'' rights', 3.0), ('books-curriculum', 'curriculum transparency', 3.0),
  ('books-curriculum', 'sex education', 2.5), ('books-curriculum', 'health curriculum', 2.2),
  ('books-curriculum', 'diversity, equity', 2.2), ('books-curriculum', 'diversity equity and inclusion', 2.2),

  -- Policing & homelessness
  ('policing-oversight', 'police oversight', 3.0), ('policing-oversight', 'civilian oversight', 3.0),
  ('policing-oversight', 'civilian review board', 3.0), ('policing-oversight', 'citizen review board', 3.0),
  ('policing-oversight', 'police review board', 3.0), ('policing-oversight', 'police accountability', 3.0),
  ('policing-oversight', 'community policing', 3.0), ('policing-oversight', 'police budget', 3.0),
  ('policing-oversight', 'police funding', 3.0), ('policing-oversight', 'police staffing', 2.5),
  ('policing-oversight', 'body camera', 2.5), ('policing-oversight', 'body cameras', 2.5),
  ('policing-oversight', 'body-worn camera', 2.5), ('policing-oversight', 'body-worn cameras', 2.5),
  ('policing-oversight', 'use of force', 2.5), ('policing-oversight', 'license plate reader', 2.5),
  ('policing-oversight', 'license plate readers', 2.5), ('policing-oversight', 'surveillance technology', 2.5),
  ('policing-oversight', 'encampment', 3.0), ('policing-oversight', 'encampments', 3.0),
  ('policing-oversight', 'homeless', 2.5), ('policing-oversight', 'homelessness', 3.0),
  ('policing-oversight', 'unhoused', 3.0), ('policing-oversight', 'camping ban', 3.0),
  ('policing-oversight', 'unauthorized camping', 3.0), ('policing-oversight', 'public camping', 3.0),
  ('policing-oversight', 'homeless shelter', 3.0)
)
INSERT INTO topic_rules (topic_id, term, weight)
SELECT t.id, r.term, r.weight
FROM r JOIN topics t ON t.slug = r.slug
ON CONFLICT (topic_id, term) DO UPDATE SET weight = EXCLUDED.weight, is_active = TRUE;
