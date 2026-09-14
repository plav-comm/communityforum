-- ============================================================
-- Migration 006: stop tagging on housekeeping language
--
-- Migration 005 routed "kind of meeting" phrases into real topics. Reviewing
-- the output, most of those matches were wrong in a way that matters here:
-- meetings were being labelled "Open Government" because the description
-- happened to say "agendas, minutes, and meeting videos" — vendor boilerplate
-- that appears on every video a city posts, and says nothing about what the
-- meeting was about.
--
-- For a platform whose promise is no editing, commentary or analysis, a
-- confidently wrong subject tag is worse than no subject tag. A meeting we
-- cannot honestly characterise belongs in General Session.
--
-- Rule of thumb encoded here: a term earns a topic only if it describes what
-- was DISCUSSED, never merely that a meeting happened or that records exist.
-- ============================================================

UPDATE topic_rules SET is_active = FALSE
WHERE term IN (
  -- describes that a meeting exists, not its subject
  'regular meeting', 'regular session', 'formal meeting', 'business meeting',
  'voting meeting', 'special meeting', 'work session', 'council meeting',
  'commission meeting', 'board meeting', 'full meeting', 'call to order',
  'roll call', 'council chambers', 'board of commissioners',
  -- describes that records exist, not their content
  'agenda', 'agendas', 'minutes', 'packets', 'meeting portal', 'public meeting',
  'city clerk', 'transparency', 'consent agenda', 'resolution', 'ordinance',
  'appointment', 'proclamation',
  -- too generic to carry a subject on its own
  'student', 'park', 'pool', 'beach', 'water', 'road', 'bond', 'levy', 'cip',
  'assessment', 'density', 'setback', 'plat', 'utility', 'revenue',
  'expenditure', 'intersection', 'crime', 'dispatch', 'graduation',
  'festival', 'city manager report'
);

-- Keep the genuinely substantive procedural topics active.
UPDATE topic_rules SET is_active = TRUE
WHERE term IN (
  'executive session', 'closed session', 'ethics', 'public records',
  'open meeting', 'sunshine law', 'election', 'redistricting', 'charter',
  'budget work session', 'budget hearing', 'budget session', 'public hearing',
  'public comment', 'citizen comment', 'citizens input', 'citizens input time',
  'public input'
);
