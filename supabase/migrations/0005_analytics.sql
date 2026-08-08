-- =============================================================
-- 0005_analytics.sql — Analytics read layer (PRD FR-34 to FR-42)
--
-- Aggregation lives in Postgres, not the browser. Every filter predicate is
-- pushed into the scoped CTE BEFORE any group by, so each metric is computed
-- once over the requested slice and nothing is ever re-aggregated — which is
-- what structurally rules out average-of-averages and double-counted
-- respondents. A dashboard load stays a few small payloads instead of pulling
-- every answer row over the wire (NFR-2, NFR-5).
--
-- SECURITY INVOKER throughout: RLS decides which rows a caller sees, exactly as
-- for a plain select. analytics_admin_ok() turns "not an admin, so you saw your
-- own two responses" into a loud error rather than a quietly wrong dashboard.
--
-- Idempotent: create or replace / if not exists throughout, so a re-paste into
-- the SQL editor is safe. Run after 0004.
-- =============================================================

-- ---------- guard ----------
-- Returns boolean rather than void so a `language sql` body can call it from a
-- where clause; it still raises rather than returning false.
create or replace function analytics_admin_ok()
returns boolean
language plpgsql
stable
security invoker
set search_path = public
as $$
begin
  if not is_admin() then
    raise exception 'Admin access is required to read analytics.'
      using errcode = '42501';
  end if;
  return true;
end;
$$;

comment on function analytics_admin_ok is
  'RLS already filters the rows; this makes a non-admin call fail loudly instead of returning a plausible-looking subset.';

-- ---------- shared filter (FR-37) ----------
-- One definition of "the requested slice", so every metric filters identically.
--
-- The stakeholder dimension comes from responses.form_id -> forms.stakeholder_type,
-- NEVER from profiles.role: role is mutable, so re-roling graduating students to
-- alumni would retroactively rewrite last year's totals. The form someone
-- actually filled in cannot change.
create or replace function analytics_response_ids(
  p_cycle_id    uuid      default null,
  p_stakeholder user_role default null,
  p_program     text      default null,
  p_course_key  text      default null
)
returns setof uuid
language sql
stable
security invoker
set search_path = public
as $$
  select r.id from responses r join forms f on f.id = r.form_id
  where analytics_admin_ok()
    and (p_cycle_id    is null or r.cycle_id         = p_cycle_id)
    and (p_stakeholder is null or f.stakeholder_type = p_stakeholder)
    and (p_program     is null or r.program          = p_program)
    and (p_course_key  is null or r.course_key       = p_course_key);
$$;

-- ---------- scale bounds ----------
-- Pre-grouped to ONE row per scale. Joining rating_scale_options straight into
-- an answer rowset multiplies every count by the option count (verified: 18 rows
-- become 90) while leaving the average untouched, so the result looks merely
-- surprising rather than broken. Bounds always come from here — never from the
-- answers present, never as a literal 5. Faculty's scale tops out at 4.
create or replace function analytics_scale_bounds()
returns table (
  scale_id uuid, scale_name text,
  min_score numeric, max_score numeric, option_count int
)
language sql
stable
security invoker
set search_path = public
as $$
  select s.id, s.name,
         min(o.score) filter (where o.score is not null),
         max(o.score) filter (where o.score is not null),
         count(*)::int
  from rating_scales s join rating_scale_options o on o.scale_id = s.id
  group by s.id, s.name;
$$;

-- ---------- FR-37: filter dropdowns ----------
create or replace function analytics_filter_options(p_cycle_id uuid default null)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select case when analytics_admin_ok() then jsonb_build_object(
    'cycles', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', c.id, 'label', c.label, 'isActive', c.is_active,
        'opensAt', c.opens_at, 'closesAt', c.closes_at) order by c.opens_at desc), '[]'::jsonb)
      from academic_cycles c),
    'stakeholders', (select coalesce(jsonb_agg(distinct f.stakeholder_type::text), '[]'::jsonb)
      from responses r join forms f on f.id = r.form_id
      where p_cycle_id is null or r.cycle_id = p_cycle_id),
    'programs', (select coalesce(jsonb_agg(x order by x), '[]'::jsonb) from (
        select distinct r.program as x from responses r
        where r.program is not null and btrim(r.program) <> ''
          and (p_cycle_id is null or r.cycle_id = p_cycle_id)) t),
    -- course_key is the normalised grouping key; course_title is one spelling a
    -- respondent actually typed, carried so the option is readable.
    'courses', (select coalesce(jsonb_agg(jsonb_build_object('key', key, 'title', title) order by title), '[]'::jsonb)
      from (select r.course_key as key, min(r.course_title) as title from responses r
        where r.course_key <> '__none__' and (p_cycle_id is null or r.cycle_id = p_cycle_id)
        group by r.course_key) t)
  ) end;
$$;

-- ---------- FR-35: totals ----------
-- Every count is taken from `responses` directly. Counting off a rowset joined
-- to `answers` reports one row per answer: on the current data that turns 2
-- responses into 24, and the tile reads "24 Responses".
--
-- plpgsql, not sql, so `perform analytics_admin_ok()` runs before any row work.
-- In a sql body the guard sits inside the row-producing path, and when RLS
-- empties that path the planner skips it — a non-admin then gets a dashboard of
-- zeros instead of an error. That failure was observed, not theorised.
create or replace function analytics_totals(
  p_cycle_id    uuid      default null,
  p_stakeholder user_role default null,
  p_program     text      default null,
  p_course_key  text      default null
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $$
declare result jsonb;
begin
  perform analytics_admin_ok();

  with scoped as (
    select r.id, r.user_id, r.cycle_id, r.program, r.course_key, r.course_title,
           f.stakeholder_type as st
    from responses r join forms f on f.id = r.form_id
    where r.id in (select analytics_response_ids(p_cycle_id, p_stakeholder, p_program, p_course_key))
  )
  select jsonb_build_object(
    'responseCount',   (select count(*) from scoped),
    'respondentCount', (select count(distinct s.user_id) from scoped s),
    'answerCount',     (select count(*) from answers a join scoped s on s.id = a.response_id),
    'byStakeholder', (select coalesce(jsonb_agg(jsonb_build_object(
        'stakeholderType', t.st, 'responseCount', t.rc, 'respondentCount', t.pc)
        order by t.rc desc, t.st), '[]'::jsonb)
      from (select s.st, count(*) as rc, count(distinct s.user_id) as pc
            from scoped s group by s.st) t),
    'byProgram', (select coalesce(jsonb_agg(jsonb_build_object(
        'program', t.program, 'responseCount', t.rc) order by t.rc desc, t.program), '[]'::jsonb)
      from (select s.program, count(*) as rc from scoped s
            where s.program is not null and btrim(s.program) <> '' group by s.program) t),
    'byCourse', (select coalesce(jsonb_agg(jsonb_build_object(
        'courseKey', t.course_key, 'courseTitle', t.title, 'responseCount', t.rc)
        order by t.rc desc, t.title), '[]'::jsonb)
      from (select s.course_key, min(s.course_title) as title, count(*) as rc
            from scoped s where s.course_key <> '__none__' group by s.course_key) t),
    'byCycle', (select coalesce(jsonb_agg(jsonb_build_object(
        'cycleId', c.id, 'label', c.label, 'responseCount', t.rc) order by c.opens_at), '[]'::jsonb)
      from (select s.cycle_id, count(*) as rc from scoped s group by s.cycle_id) t
      join academic_cycles c on c.id = t.cycle_id)
  ) into result;

  return result;
end;
$$;

-- ---------- FR-36 + FR-34: per-question rating stats ----------
-- Grain: one row per (stakeholder, question_key, scale). question_key is unique
-- only WITHIN a form, so 'recommendations' exists on several forms; and scale_id
-- is in the key so a question whose scale changed between versions cannot have
-- two incompatible ranges averaged together.
--
-- Three separate denominators, because conflating them is what makes Likert bars
-- sum past 100%:
--   n_answers        every answer             -- the DISTRIBUTION denominator
--   n_scored         answers carrying a score -- the AVERAGE denominator
--   n_not_applicable the difference           -- the non-scoring options
--
-- avg_score is NULL, never 0, when nothing scored: recharts draws a gap for null
-- and a floor-scraping dip for 0, and the second reads as "rated terribly".
--
-- #variable_conflict use_column because RETURNS TABLE output names become
-- variables that shadow real columns of the same name (SQLSTATE 42702).
create or replace function analytics_question_stats(
  p_cycle_id    uuid      default null,
  p_stakeholder user_role default null,
  p_program     text      default null,
  p_course_key  text      default null
)
returns table (
  stakeholder_type text, form_id uuid, question_key text, question_id uuid,
  question_text text, is_active boolean, scale_id uuid, scale_name text,
  min_score numeric, max_score numeric, n_answers bigint, n_scored bigint,
  n_not_applicable bigint, n_respondents bigint, score_sum numeric,
  avg_score numeric, normalised_sum numeric, normalised_avg numeric,
  versions_answered bigint, versions_total bigint, version_nos int[]
)
language plpgsql
stable
security invoker
set search_path = public
as $$
#variable_conflict use_column
begin
  perform analytics_admin_ok();
  return query
  with scoped as (
    select analytics_response_ids(p_cycle_id, p_stakeholder, p_program, p_course_key) as id
  ),
  ans as (
    select a.response_id as rid, a.question_version_id as qvid, a.value_numeric as vn,
           qv.question_id as q_id, qv.scale_id as s_id, qv.version_no as vno,
           q.form_id as f_id, q.question_key as q_key, q.is_active as q_active,
           f.stakeholder_type as st
    from answers a
    join scoped s on s.id = a.response_id
    join question_versions qv on qv.id = a.question_version_id
    join questions q on q.id = qv.question_id
    join forms f on f.id = q.form_id
    where qv.type = 'rating'
  ),
  bounds as (
    select o.scale_id as s_id, min(o.score) as lo, max(o.score) as hi
    from rating_scale_options o where o.score is not null group by o.scale_id
  ),
  -- All versions that EXIST, counted separately from the versions actually
  -- answered. The FR-34 badge fires on the second: student/overall_effectiveness
  -- already has 2 versions with every answer on v1, and warning that its average
  -- "may span reworded variants" would be a lie about data that spans nothing.
  version_totals as (
    select qv.question_id as q_id, count(*) as total from question_versions qv group by qv.question_id
  ),
  grouped as (
    select ans.st, ans.f_id, ans.q_key, ans.q_id, ans.q_active, ans.s_id,
           count(*) as n_ans, count(ans.vn) as n_sc,
           count(*) - count(ans.vn) as n_na, count(distinct ans.rid) as n_resp,
           sum(ans.vn) as score_sum, avg(ans.vn) as avg_sc,
           count(distinct ans.qvid) as v_ans,
           -- A set unions across slices where count(distinct) cannot, so a
           -- client may widen a filter without recomputing.
           array_agg(distinct ans.vno order by ans.vno) as vnos
    from ans group by 1,2,3,4,5,6
  )
  select g.st::text, g.f_id, g.q_key, g.q_id,
         -- Display only. Attribution never goes through current_version_id,
         -- which already disagrees with where the answers sit.
         cv.text, g.q_active, g.s_id, sc.name,
         b.lo, b.hi, g.n_ans, g.n_sc, g.n_na, g.n_resp, g.score_sum, g.avg_sc,
         -- Additive, so a client may re-fold buckets exactly instead of
         -- averaging averages. Identical to summing per-answer normalisations,
         -- because scale_id is in the grouping key.
         case when b.hi > b.lo then (g.score_sum - b.lo * g.n_sc) / (b.hi - b.lo) end,
         case when b.hi > b.lo and g.n_sc > 0
              then ((g.score_sum / g.n_sc) - b.lo) / (b.hi - b.lo) end,
         g.v_ans, coalesce(vt.total, 0), g.vnos
  from grouped g
  join questions q on q.id = g.q_id
  left join question_versions cv on cv.id = q.current_version_id
  left join bounds b on b.s_id = g.s_id
  left join rating_scales sc on sc.id = g.s_id
  left join version_totals vt on vt.q_id = g.q_id
  order by g.st, g.q_key;
end;
$$;

-- ---------- FR-38: Likert distribution ----------
-- Answers are aggregated FIRST, then the option list is joined on. Joining the
-- options into the answer rowset would fan every answer out to one row per
-- option. The join is composite (scale_id, label) because all 9 scoring labels
-- appear in exactly two of the four seeded scales — matching on label alone
-- returns 36 rows where the truth is 18, and attaches the wrong score with it.
--
-- Left join from the options so an option nobody chose reports 0 rather than
-- vanishing from the chart.
create or replace function analytics_distribution(
  p_cycle_id    uuid      default null,
  p_stakeholder user_role default null,
  p_program     text      default null,
  p_course_key  text      default null
)
returns table (
  stakeholder_type text, form_id uuid, question_key text, scale_id uuid,
  option_label text, option_score numeric, display_order int,
  n bigint, n_answers bigint
)
language plpgsql
stable
security invoker
set search_path = public
as $$
#variable_conflict use_column
begin
  perform analytics_admin_ok();
  return query
  with scoped as (
    select analytics_response_ids(p_cycle_id, p_stakeholder, p_program, p_course_key) as id
  ),
  ans as (
    select a.value_text as vt, qv.scale_id as s_id, q.form_id as f_id,
           q.question_key as q_key, f.stakeholder_type as st
    from answers a
    join scoped s on s.id = a.response_id
    join question_versions qv on qv.id = a.question_version_id
    join questions q on q.id = qv.question_id
    join forms f on f.id = q.form_id
    where qv.type = 'rating'
  ),
  counted as (
    select ans.st, ans.f_id, ans.q_key, ans.s_id, ans.vt, count(*) as c_n from ans group by 1,2,3,4,5
  ),
  totals as (
    select ans.st, ans.f_id, ans.q_key, ans.s_id, count(*) as t_n from ans group by 1,2,3,4
  ),
  axis as (
    select distinct t.st, t.f_id, t.q_key, t.s_id, o.label as lbl, o.score as osc,
           o.display_order as ord
    from totals t join rating_scale_options o on o.scale_id = t.s_id
  )
  select axis.st::text, axis.f_id, axis.q_key, axis.s_id, axis.lbl, axis.osc, axis.ord,
         coalesce(c.c_n, 0), t.t_n
  from axis
  join totals t on t.st = axis.st and t.f_id = axis.f_id and t.q_key = axis.q_key and t.s_id = axis.s_id
  left join counted c on c.st = axis.st and c.f_id = axis.f_id and c.q_key = axis.q_key
                     and c.s_id = axis.s_id and c.vt = axis.lbl
  order by axis.st, axis.q_key, axis.ord;
end;
$$;

-- ---------- FR-38: choice distribution for select questions ----------
-- value_options is text[], so it is unnested in its OWN CTE. Unnesting it in a
-- rowset that also feeds counts would turn one multi_select answer into one row
-- per chosen option and inflate every denominator with it.
--
-- Labels join on (question_version_id, value), the actual unique key: 'Other'
-- alone appears under three different questions, and 'B.A.' under two.
create or replace function analytics_choice_distribution(
  p_cycle_id    uuid      default null,
  p_stakeholder user_role default null,
  p_program     text      default null,
  p_course_key  text      default null
)
returns table (
  stakeholder_type text, form_id uuid, question_key text, question_type text,
  option_value text, option_label text, n bigint, n_respondents bigint
)
language plpgsql
stable
security invoker
set search_path = public
as $$
#variable_conflict use_column
begin
  perform analytics_admin_ok();
  return query
  with scoped as (
    select analytics_response_ids(p_cycle_id, p_stakeholder, p_program, p_course_key) as id
  ),
  ans as (
    select a.response_id as rid, a.question_version_id as qvid, a.value_options as vo,
           qv.type as qtype, q.form_id as f_id, q.question_key as q_key, f.stakeholder_type as st
    from answers a
    join scoped s on s.id = a.response_id
    join question_versions qv on qv.id = a.question_version_id
    join questions q on q.id = qv.question_id
    join forms f on f.id = q.form_id
    -- Discriminate on the declared type, never on array length: a one-choice
    -- multi_select and a single_select are indistinguishable by shape.
    where qv.type in ('single_select', 'multi_select')
  ),
  -- The denominator: respondents who answered at all, counted BEFORE the array
  -- is unnested.
  answered as (
    select ans.st, ans.f_id, ans.q_key, ans.qtype, count(distinct ans.rid) as n_resp
    from ans group by 1,2,3,4
  ),
  exploded as (
    select ans.st, ans.f_id, ans.q_key, ans.qtype, ans.qvid, choice
    from ans, unnest(coalesce(ans.vo, '{}')) as choice
  ),
  counted as (
    select e.st, e.f_id, e.q_key, e.qtype, e.choice, count(*) as c_n, min(qo.label) as lbl
    from exploded e
    left join question_options qo on qo.question_version_id = e.qvid and qo.value = e.choice
    group by 1,2,3,4,5
  )
  select c.st::text, c.f_id, c.q_key, c.qtype::text, c.choice,
         coalesce(c.lbl, c.choice), c.c_n, a.n_resp
  from counted c
  join answered a on a.st = c.st and a.f_id = c.f_id and a.q_key = c.q_key and a.qtype = c.qtype
  order by c.st, c.q_key, c.c_n desc, c.choice;
end;
$$;

-- ---------- FR-39: year-over-year trend ----------
-- Grouped on (stakeholder, question_key) across cycles, ordered by the cycle's
-- opens_at rather than its label, which is text and would sort lexically.
-- versions_answered per point is what marks a version boundary on the line.
create or replace function analytics_trends(
  p_stakeholder user_role default null,
  p_program     text      default null,
  p_course_key  text      default null
)
returns table (
  stakeholder_type text, form_id uuid, question_key text, question_text text,
  cycle_id uuid, cycle_label text, opens_at timestamptz, scale_id uuid,
  min_score numeric, max_score numeric, n_scored bigint, n_answers bigint,
  avg_score numeric, normalised_avg numeric, versions_answered bigint, version_nos int[]
)
language plpgsql
stable
security invoker
set search_path = public
as $$
#variable_conflict use_column
begin
  perform analytics_admin_ok();
  return query
  with ans as (
    select r.cycle_id as c_id, a.response_id as rid, a.question_version_id as qvid,
           a.value_numeric as vn, qv.question_id as q_id, qv.scale_id as s_id,
           qv.version_no as vno, q.form_id as f_id, q.question_key as q_key,
           f.stakeholder_type as st
    from answers a
    join responses r on r.id = a.response_id
    join forms f on f.id = r.form_id
    join question_versions qv on qv.id = a.question_version_id
    join questions q on q.id = qv.question_id
    where qv.type = 'rating'
      and (p_stakeholder is null or f.stakeholder_type = p_stakeholder)
      and (p_program is null or r.program = p_program)
      and (p_course_key is null or r.course_key = p_course_key)
  ),
  bounds as (
    select o.scale_id as s_id, min(o.score) lo, max(o.score) hi
    from rating_scale_options o where o.score is not null group by o.scale_id
  ),
  grouped as (
    select ans.st, ans.f_id, ans.q_key, ans.q_id, ans.c_id, ans.s_id,
           count(*) as n_ans, count(ans.vn) as n_sc, sum(ans.vn) as score_sum,
           avg(ans.vn) as avg_sc, count(distinct ans.qvid) as v_ans,
           array_agg(distinct ans.vno order by ans.vno) as vnos
    from ans group by 1,2,3,4,5,6
  )
  select g.st::text, g.f_id, g.q_key, cv.text, g.c_id, c.label, c.opens_at, g.s_id,
         b.lo, b.hi, g.n_sc, g.n_ans, g.avg_sc,
         case when b.hi > b.lo and g.n_sc > 0
              then ((g.score_sum / g.n_sc) - b.lo) / (b.hi - b.lo) end,
         g.v_ans, g.vnos
  from grouped g
  join academic_cycles c on c.id = g.c_id
  join questions q on q.id = g.q_id
  left join question_versions cv on cv.id = q.current_version_id
  left join bounds b on b.s_id = g.s_id
  order by g.st, g.q_key, c.opens_at;
end;
$$;

-- ---------- FR-40: text answers for sentiment ----------
-- long_text only. Selecting on "value_text is not null" would sweep in every
-- rating, because a rating stores its chosen LABEL there as well as its score —
-- and the lexicon scores those labels ('Excellent' +3, 'Poor' -2), so the
-- sentiment split would be an echo of the rating distribution.
create or replace function analytics_text_answers(
  p_cycle_id    uuid      default null,
  p_stakeholder user_role default null,
  p_program     text      default null,
  p_course_key  text      default null,
  p_limit       int       default 1000,
  p_offset      int       default 0
)
returns table (
  answer_id uuid, response_id uuid, stakeholder_type text, question_key text,
  question_text text, version_no int, cycle_label text, value_text text
)
language plpgsql
stable
security invoker
set search_path = public
as $$
#variable_conflict use_column
begin
  perform analytics_admin_ok();
  return query
  select a.id, a.response_id, f.stakeholder_type::text, q.question_key,
         qv.text, qv.version_no, c.label, a.value_text
  from answers a
  join responses r on r.id = a.response_id
  join academic_cycles c on c.id = r.cycle_id
  join forms f on f.id = r.form_id
  join question_versions qv on qv.id = a.question_version_id
  join questions q on q.id = qv.question_id
  where qv.type = 'long_text'
    and a.value_text is not null and btrim(a.value_text) <> ''
    and r.id in (select analytics_response_ids(p_cycle_id, p_stakeholder, p_program, p_course_key))
  -- Stable order: paging without one can repeat or skip rows between pages.
  order by a.response_id, a.id
  limit p_limit offset p_offset;
end;
$$;

-- ---------- FR-42: CSV export rows ----------
-- One row per answer, carrying the version metadata that makes historical
-- rewording visible in the file. Paged with a stable order because PostgREST
-- caps rows and a silently truncated export is worse than a slow one.
create or replace function analytics_export_rows(
  p_cycle_id    uuid      default null,
  p_stakeholder user_role default null,
  p_program     text      default null,
  p_course_key  text      default null,
  p_limit       int       default 5000,
  p_offset      int       default 0
)
returns table (
  response_id uuid, cycle_label text, stakeholder_type text, program text,
  course_title text, submitted_at timestamptz, updated_at timestamptz,
  question_key text, question_text text, question_type text, version_no int,
  is_current_version boolean, scale_name text, value_text text,
  value_numeric numeric, value_options text[]
)
language plpgsql
stable
security invoker
set search_path = public
as $$
#variable_conflict use_column
begin
  perform analytics_admin_ok();
  return query
  select r.id, c.label, f.stakeholder_type::text, r.program, r.course_title,
         r.submitted_at, r.updated_at, q.question_key, qv.text, qv.type::text,
         qv.version_no, (q.current_version_id = qv.id), sc.name,
         a.value_text, a.value_numeric, a.value_options
  from answers a
  join responses r on r.id = a.response_id
  join academic_cycles c on c.id = r.cycle_id
  join forms f on f.id = r.form_id
  join question_versions qv on qv.id = a.question_version_id
  join questions q on q.id = qv.question_id
  left join rating_scales sc on sc.id = qv.scale_id
  where r.id in (select analytics_response_ids(p_cycle_id, p_stakeholder, p_program, p_course_key))
  order by r.submitted_at, r.id, q.question_key, qv.version_no
  limit p_limit offset p_offset;
end;
$$;

-- ---------- indexes ----------
-- Covers the cycle- and form-scoped reads every function above issues.
create index if not exists responses_by_cycle_form on responses (cycle_id, form_id);

-- ---------- permissions ----------
-- CREATE FUNCTION grants EXECUTE to PUBLIC by default and anon inherits it, so
-- revoking from anon alone is a no-op — verified. Revoke from PUBLIC, then grant
-- back to the roles that should have it.
do $$
declare fn record;
begin
  for fn in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'analytics\_%'
  loop
    execute format('revoke all on function %s from public, anon', fn.sig);
    execute format('grant execute on function %s to authenticated, service_role', fn.sig);
  end loop;
end;
$$;

-- PostgREST caches the schema; without this the new functions 404 until it
-- reloads on its own.
notify pgrst, 'reload schema';
