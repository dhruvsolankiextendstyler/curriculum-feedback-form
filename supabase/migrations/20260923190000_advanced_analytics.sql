-- Advanced analytics: course ranking, cycle delta, submission timeline,
-- response quality, and department benchmark.
--
-- All use the existing analytics_admin_ok guard and analytics_response_ids
-- filter so they respect the same access rules and filter dimensions.
--
-- Safe to run on a live database: additive. Rollback block at bottom.

-- ============================================================================
-- 1. Course ranking — average normalised score per course for a filtered slice
-- ============================================================================
create or replace function analytics_course_ranking(
  p_cycle_id      uuid             default null,
  p_stakeholder   public.user_role default null,
  p_program       text             default null,
  p_stream_id     uuid             default null,
  p_department_id uuid             default null
)
returns table (
  course_key       text,
  course_title     text,
  program          text,
  avg_score        numeric,
  normalised_avg   numeric,
  n_responses      bigint,
  n_rated          bigint
)
language plpgsql stable security invoker
set search_path = ''
as $$
begin
  perform public.analytics_admin_ok();
  return query
  with scoped as (
    select public.analytics_response_ids(
      p_cycle_id, p_stakeholder, p_program, null, p_stream_id, p_department_id
    ) as id
  ),
  ans as (
    select r.course_key, r.course_title, r.program,
           a.value_numeric as vn, qv.scale_id as s_id, r.id as rid
    from public.answers a
    join scoped s on s.id = a.response_id
    join public.responses r on r.id = a.response_id
    join public.question_versions qv on qv.id = a.question_version_id
    where qv.type = 'rating' and a.value_numeric is not null
      and r.course_key is not null
  ),
  bounds as (
    select o.scale_id as s_id, min(o.score) as lo, max(o.score) as hi
    from public.rating_scale_options o where o.score is not null group by o.scale_id
  ),
  grouped as (
    select ans.course_key, ans.course_title, ans.program, ans.s_id,
           count(distinct ans.rid) as n_resp,
           count(ans.vn) as n_rated,
           avg(ans.vn) as avg_sc
    from ans group by 1, 2, 3, 4
  )
  select g.course_key, g.course_title, g.program,
         round(g.avg_sc, 2),
         case when b.hi > b.lo
              then round((g.avg_sc - b.lo) / (b.hi - b.lo), 3)
              else null end,
         g.n_resp, g.n_rated
  from grouped g
  left join bounds b on b.s_id = g.s_id
  order by normalised_avg desc nulls last, g.n_rated desc;
end;
$$;

-- ============================================================================
-- 2. Cycle delta — per-question average this cycle vs previous cycle
-- ============================================================================
create or replace function analytics_cycle_delta(
  p_cycle_id      uuid,
  p_stakeholder   public.user_role default null,
  p_program       text             default null,
  p_course_key    text             default null,
  p_stream_id     uuid             default null,
  p_department_id uuid             default null
)
returns table (
  question_key       text,
  question_text      text,
  stakeholder_type   text,
  current_avg        numeric,
  current_normalised numeric,
  previous_avg       numeric,
  previous_normalised numeric,
  delta              numeric,
  current_n          bigint,
  previous_n         bigint,
  previous_cycle     text
)
language plpgsql stable security invoker
set search_path = ''
as $$
declare
  v_prev_id    uuid;
  v_prev_label text;
begin
  perform public.analytics_admin_ok();

  -- Find the cycle that closed most recently before this one opened.
  select c.id, c.label into v_prev_id, v_prev_label
  from public.academic_cycles c
  where c.closes_at < (select opens_at from public.academic_cycles where id = p_cycle_id)
  order by c.closes_at desc limit 1;

  if v_prev_id is null then
    return; -- no previous cycle, empty result
  end if;

  return query
  with cur as (
    select q.question_key as qk, cv.text as qt, f.stakeholder_type::text as st,
           avg(a.value_numeric) as avg_sc, count(*) as n,
           qv.scale_id as s_id
    from public.answers a
    join public.responses r on r.id = a.response_id
    join public.forms f on f.id = r.form_id
    join public.question_versions qv on qv.id = a.question_version_id
    join public.questions q on q.id = qv.question_id
    left join public.question_versions cv on cv.id = q.current_version_id
    left join public.departments d on d.id = r.department_id
    where r.cycle_id = p_cycle_id
      and qv.type = 'rating' and a.value_numeric is not null
      and (p_stakeholder   is null or f.stakeholder_type = p_stakeholder)
      and (p_program       is null or r.program          = p_program)
      and (p_course_key    is null or r.course_key       = p_course_key)
      and (p_stream_id     is null or d.stream_id        = p_stream_id)
      and (p_department_id is null or r.department_id    = p_department_id)
    group by q.question_key, cv.text, f.stakeholder_type, qv.scale_id
  ),
  prev as (
    select q.question_key as qk, f.stakeholder_type::text as st,
           avg(a.value_numeric) as avg_sc, count(*) as n,
           qv.scale_id as s_id
    from public.answers a
    join public.responses r on r.id = a.response_id
    join public.forms f on f.id = r.form_id
    join public.question_versions qv on qv.id = a.question_version_id
    join public.questions q on q.id = qv.question_id
    left join public.departments d on d.id = r.department_id
    where r.cycle_id = v_prev_id
      and qv.type = 'rating' and a.value_numeric is not null
      and (p_stakeholder   is null or f.stakeholder_type = p_stakeholder)
      and (p_program       is null or r.program          = p_program)
      and (p_course_key    is null or r.course_key       = p_course_key)
      and (p_stream_id     is null or d.stream_id        = p_stream_id)
      and (p_department_id is null or r.department_id    = p_department_id)
    group by q.question_key, f.stakeholder_type, qv.scale_id
  ),
  bounds as (
    select o.scale_id as s_id, min(o.score) as lo, max(o.score) as hi
    from public.rating_scale_options o where o.score is not null group by o.scale_id
  )
  select cur.qk, cur.qt, cur.st,
         round(cur.avg_sc, 2),
         case when bc.hi > bc.lo then round((cur.avg_sc - bc.lo) / (bc.hi - bc.lo), 3) else null end,
         round(prev.avg_sc, 2),
         case when bp.hi > bp.lo then round((prev.avg_sc - bp.lo) / (bp.hi - bp.lo), 3) else null end,
         round(
           case when bc.hi > bc.lo and bp.hi > bp.lo
                then ((cur.avg_sc - bc.lo) / (bc.hi - bc.lo))
                   - ((prev.avg_sc - bp.lo) / (bp.hi - bp.lo))
                else null end,
         3),
         cur.n, prev.n, v_prev_label
  from cur
  left join prev on prev.qk = cur.qk and prev.st = cur.st
  left join bounds bc on bc.s_id = cur.s_id
  left join bounds bp on bp.s_id = prev.s_id
  order by delta asc nulls last;
end;
$$;

-- ============================================================================
-- 3. Submission timeline — hourly buckets of when responses were submitted
-- ============================================================================
create or replace function analytics_submission_timeline(
  p_cycle_id      uuid             default null,
  p_stakeholder   public.user_role default null,
  p_stream_id     uuid             default null,
  p_department_id uuid             default null
)
returns table (
  day         date,
  hour        int,
  submissions bigint
)
language plpgsql stable security invoker
set search_path = ''
as $$
begin
  perform public.analytics_admin_ok();
  return query
  select (r.submitted_at at time zone 'UTC')::date as day,
         extract(hour from r.submitted_at at time zone 'UTC')::int as hour,
         count(*)::bigint as submissions
  from public.responses r
  join public.forms f on f.id = r.form_id
  left join public.departments d on d.id = r.department_id
  where (p_cycle_id      is null or r.cycle_id         = p_cycle_id)
    and (p_stakeholder   is null or f.stakeholder_type = p_stakeholder)
    and (p_stream_id     is null or d.stream_id        = p_stream_id)
    and (p_department_id is null or r.department_id    = p_department_id)
  group by 1, 2
  order by 1, 2;
end;
$$;

-- ============================================================================
-- 4. Response quality — % of text answers that are non-answers
-- ============================================================================
create or replace function analytics_response_quality(
  p_cycle_id      uuid             default null,
  p_stakeholder   public.user_role default null,
  p_program       text             default null,
  p_course_key    text             default null,
  p_stream_id     uuid             default null,
  p_department_id uuid             default null
)
returns table (
  question_key     text,
  question_text    text,
  total_answers    bigint,
  blank_answers    bigint,
  short_answers    bigint,
  substantive      bigint,
  avg_length       numeric
)
language plpgsql stable security invoker
set search_path = ''
as $$
begin
  perform public.analytics_admin_ok();
  return query
  with scoped as (
    select public.analytics_response_ids(
      p_cycle_id, p_stakeholder, p_program, p_course_key, p_stream_id, p_department_id
    ) as id
  )
  select q.question_key,
         cv.text,
         count(*)::bigint as total,
         count(*) filter (
           where trim(coalesce(a.value_text, '')) = ''
              or lower(trim(a.value_text)) in (
                   'na','n/a','nil','none','no','nope','nothing','-','--','...','.',
                   'ok','okay','fine','good enough','no comment','no comments','same'
                 )
         )::bigint as blank,
         count(*) filter (
           where length(trim(coalesce(a.value_text, ''))) between 1 and 15
             and lower(trim(a.value_text)) not in (
                   'na','n/a','nil','none','no','nope','nothing','-','--','...','.',
                   'ok','okay','fine','good enough','no comment','no comments','same'
                 )
         )::bigint as short,
         count(*) filter (
           where length(trim(coalesce(a.value_text, ''))) > 15
         )::bigint as substantive,
         round(avg(length(trim(coalesce(a.value_text, '')))))::numeric as avg_len
  from public.answers a
  join scoped s on s.id = a.response_id
  join public.question_versions qv on qv.id = a.question_version_id
  join public.questions q on q.id = qv.question_id
  left join public.question_versions cv on cv.id = q.current_version_id
  where qv.type in ('long_text', 'short_text')
  group by q.question_key, cv.text
  order by blank desc, total desc;
end;
$$;

-- ============================================================================
-- 5. Department benchmark — dept avg vs college avg per question
-- ============================================================================
create or replace function analytics_department_benchmark(
  p_cycle_id      uuid             default null,
  p_stakeholder   public.user_role default null,
  p_program       text             default null,
  p_stream_id     uuid             default null,
  p_department_id uuid             default null
)
returns table (
  question_key     text,
  question_text    text,
  dept_avg         numeric,
  college_avg      numeric,
  delta            numeric,
  dept_n           bigint,
  college_n        bigint
)
language plpgsql stable security invoker
set search_path = ''
as $$
begin
  perform public.analytics_admin_ok();
  return query
  with college as (
    select q.question_key as qk, cv.text as qt, qv.scale_id as s_id,
           avg(a.value_numeric) as avg_sc, count(*) as n
    from public.answers a
    join public.responses r on r.id = a.response_id
    join public.forms f on f.id = r.form_id
    join public.question_versions qv on qv.id = a.question_version_id
    join public.questions q on q.id = qv.question_id
    left join public.question_versions cv on cv.id = q.current_version_id
    where qv.type = 'rating' and a.value_numeric is not null
      and (p_cycle_id    is null or r.cycle_id         = p_cycle_id)
      and (p_stakeholder is null or f.stakeholder_type = p_stakeholder)
      and (p_program     is null or r.program          = p_program)
    group by q.question_key, cv.text, qv.scale_id
  ),
  dept as (
    select q.question_key as qk, qv.scale_id as s_id,
           avg(a.value_numeric) as avg_sc, count(*) as n
    from public.answers a
    join public.responses r on r.id = a.response_id
    join public.forms f on f.id = r.form_id
    join public.question_versions qv on qv.id = a.question_version_id
    join public.questions q on q.id = qv.question_id
    left join public.departments d on d.id = r.department_id
    where qv.type = 'rating' and a.value_numeric is not null
      and (p_cycle_id      is null or r.cycle_id         = p_cycle_id)
      and (p_stakeholder   is null or f.stakeholder_type = p_stakeholder)
      and (p_program       is null or r.program          = p_program)
      and (p_stream_id     is null or d.stream_id        = p_stream_id)
      and r.department_id  = p_department_id
    group by q.question_key, qv.scale_id
  ),
  bounds as (
    select o.scale_id as s_id, min(o.score) as lo, max(o.score) as hi
    from public.rating_scale_options o where o.score is not null group by o.scale_id
  )
  select c.qk, c.qt,
         case when bd.hi > bd.lo then round((dept.avg_sc - bd.lo) / (bd.hi - bd.lo), 3) else null end,
         case when bc.hi > bc.lo then round((c.avg_sc    - bc.lo) / (bc.hi - bc.lo), 3) else null end,
         case when bd.hi > bd.lo and bc.hi > bc.lo
              then round(((dept.avg_sc - bd.lo) / (bd.hi - bd.lo))
                       - ((c.avg_sc    - bc.lo) / (bc.hi - bc.lo)), 3)
              else null end,
         dept.n, c.n
  from college c
  left join dept on dept.qk = c.qk
  left join bounds bc on bc.s_id = c.s_id
  left join bounds bd on bd.s_id = dept.s_id
  where dept.avg_sc is not null
  order by delta asc nulls last;
end;
$$;

-- ============================================================================
-- 6. Permissions — same as existing analytics functions
-- ============================================================================
do $$
declare fn record;
begin
  for fn in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'analytics_course_ranking',
        'analytics_cycle_delta',
        'analytics_submission_timeline',
        'analytics_response_quality',
        'analytics_department_benchmark'
      )
  loop
    execute format('revoke all on function %s from public, anon', fn.sig);
    execute format('grant execute on function %s to authenticated, service_role', fn.sig);
  end loop;
end;
$$;

-- Statement timeout matching existing analytics functions
alter function analytics_course_ranking      set statement_timeout = '10s';
alter function analytics_cycle_delta         set statement_timeout = '10s';
alter function analytics_submission_timeline set statement_timeout = '10s';
alter function analytics_response_quality    set statement_timeout = '10s';
alter function analytics_department_benchmark set statement_timeout = '10s';

notify pgrst, 'reload schema';

-- ============================================================================
-- ROLLBACK
-- ============================================================================
-- drop function if exists analytics_department_benchmark(uuid, public.user_role, text, uuid, uuid);
-- drop function if exists analytics_response_quality(uuid, public.user_role, text, text, uuid, uuid);
-- drop function if exists analytics_submission_timeline(uuid, public.user_role, uuid, uuid);
-- drop function if exists analytics_cycle_delta(uuid, public.user_role, text, text, uuid, uuid);
-- drop function if exists analytics_course_ranking(uuid, public.user_role, text, uuid, uuid);
