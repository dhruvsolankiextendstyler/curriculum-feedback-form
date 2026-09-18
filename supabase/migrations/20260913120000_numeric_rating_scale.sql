-- =============================================================
-- 20260913120000_numeric_rating_scale.sql — a bare 1-to-5 rating scale
--
-- Every scale seeded in 0003_seed.sql is worded: "Excellent", "Strongly Agree",
-- "Not applicable". Wording is usually the right choice — it tells a respondent
-- what a 4 is supposed to mean — but it also fixes the question's shape, and some
-- questions genuinely want a bare numeric line ("rate this out of 5").
--
-- Two deliberate differences from the seeded scales:
--
--  1. The options ASCEND. The others run best-first (Excellent = 5 in position 1)
--     because reading order carries their meaning. A numeric line does not: 1..5
--     left to right is what a respondent expects, and display_order drives the
--     radio order and the distribution chart's x-axis. Scores are unaffected —
--     analytics reads `score`, never position.
--
--  2. There is no non-scoring option. "Not applicable" exists on two of the
--     seeded scales and is what n_not_applicable counts; a scale of bare numbers
--     has nowhere sensible to put one, so every answer here scores and
--     n_not_applicable is always 0 for it.
--
-- The label is the value stored in `answers.value_text` (see toAnswerRow in
-- src/lib/validation.js), so an answer here reads as "4" in the export — which is
-- the point.
--
-- Idempotent: safe to re-run.
-- =============================================================

insert into rating_scales (name) values ('numeric_1_to_5')
on conflict (name) do nothing;

with s as (select id from rating_scales where name = 'numeric_1_to_5')
insert into rating_scale_options (scale_id, label, score, display_order)
select s.id, o.label, o.score, o.display_order
from s
join (values
  ('1', 1, 1),
  ('2', 2, 2),
  ('3', 3, 3),
  ('4', 4, 4),
  ('5', 5, 5)
) as o(label, score, display_order) on true
on conflict (scale_id, label) do nothing;
