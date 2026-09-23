-- Analytics views: participation rates and department heatmap.
--
-- Two new RPCs that reuse the existing analytics_response_ids filter and the
-- analytics_admin_ok guard. Safe to run on a live database: all changes are
-- additive and the rollback block at the bottom reverses every one of them.

-- ============================================================================
-- 1. Participation RPC
-- ============================================================================
-- Provisioned vs responded counts per (stakeholder, department).
--
-- "Provisioned" = active profiles (removed_at is null). "Responded" = distinct
-- users with at least one response in the filtered cycle. The cycle filter
-- affects only the responded count — a user is provisioned regardless of cycle.
--
-- program and course_key are intentionally absent: participation is about
-- whether someone submitted at all, not what they submitted about.

create or replace function analytics_participation(
  p_cycle_id      uuid             default null,
  p_stakeholder   public.user_role default null,
  p_stream_id     uuid             default null,
  p_department_id uuid             default null
)
returns table (
  stakeholder_type text,
  department_id    uuid,
  department_name  text,
  department_code  text,
  stream_name      text,
  provisioned      bigint,
  responded        bigint
)
language plpgsql stable security invoker
set search_path = ''
as $$
begin
  perform public.analytics_admin_ok();
  return query
  with eligible as (
    select p.id as user_id, p.role, p.department_id,
           d.name as dept_name, d.code as dept_code, s.name as s_name
    from public.profiles p
    left join public.departments d on d.id = p.department_id
    left join public.streams s on s.id = d.stream_id
    where p.removed_at is null
      and (p_stakeholder   is null or p.role          = p_stakeholder)
      and (p_department_id is null or p.department_id = p_department_id)
      and (p_stream_id     is null or d.stream_id    = p_stream_id)
  ),
  responders as (
    select distinct r.user_id
    from public.responses r
    where p_cycle_id is null or r.cycle_id = p_cycle_id
  )
  select
    e.role::text,
    e.department_id,
    e.dept_name,
    e.dept_code,
    e.s_name,
    count(distinct e.user_id)::bigint,
    count(distinct case when resp.user_id is not null then e.user_id end)::bigint
  from eligible e
  left join responders resp on resp.user_id = e.user_id
  group by e.role, e.department_id, e.dept_name, e.dept_code, e.s_name;
end;
$$;

-- ============================================================================
-- 2. Heatmap RPC
-- ============================================================================
-- Normalised average per (question, department) for the filtered slice.
-- Responses without a department are excluded — they carry no department
-- dimension, same caveat as the department filter in the main analytics.

create or replace function analytics_heatmap(
  p_cycle_id      uuid             default null,
  p_stakeholder   public.user_role default null,
  p_program       text             default null,
  p_course_key    text             default null,
  p_stream_id     uuid             default null,
  p_department_id uuid             default null
)
returns table (
  question_key    text,
  question_text   text,
  department_id   uuid,
  department_name text,
  department_code text,
  normalised_avg  numeric,
  n_scored        bigint,
  n_answers       bigint
)
language plpgsql stable security invoker
set search_path = ''
as $$
#variable_conflict use_column
begin
  perform public.analytics_admin_ok();
  return query
  with scoped as (
    select public.analytics_response_ids(
      p_cycle_id, p_stakeholder, p_program, p_course_key, p_stream_id, p_department_id
    ) as id
  ),
  ans as (
    select a.value_numeric as vn, qv.scale_id as s_id,
           q.question_key as q_key, q.id as q_id,
           r.department_id as dept_id
    from public.answers a
    join scoped s on s.id = a.response_id
    join public.responses r on r.id = a.response_id
    join public.question_versions qv on qv.id = a.question_version_id
    join public.questions q on q.id = qv.question_id
    where qv.type = 'rating'
      and r.department_id is not null
  ),
  bounds as (
    select o.scale_id as s_id, min(o.score) as lo, max(o.score) as hi
    from public.rating_scale_options o where o.score is not null group by o.scale_id
  ),
  grouped as (
    select ans.q_key, ans.q_id, ans.dept_id, ans.s_id,
           count(*) as n_ans, count(ans.vn) as n_sc,
           sum(ans.vn) as score_sum
    from ans group by 1, 2, 3, 4
  )
  select g.q_key, cv.text,
         g.dept_id, d.name, d.code,
         case when b.hi > b.lo and g.n_sc > 0
              then ((g.score_sum / g.n_sc) - b.lo) / (b.hi - b.lo) end,
         g.n_sc, g.n_ans
  from grouped g
  join public.questions q on q.id = g.q_id
  left join public.question_versions cv on cv.id = q.current_version_id
  left join bounds b on b.s_id = g.s_id
  left join public.departments d on d.id = g.dept_id
  order by g.q_key, d.name;
end;
$$;

-- ============================================================================
-- 3. Permissions
-- ============================================================================
do $$
declare fn record;
begin
  for fn in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('analytics_participation', 'analytics_heatmap')
  loop
    execute format('revoke all on function %s from public, anon', fn.sig);
    execute format('grant execute on function %s to authenticated, service_role', fn.sig);
  end loop;
end;
$$;

notify pgrst, 'reload schema';

-- ============================================================================
-- ROLLBACK (run this block to undo everything above)
-- ============================================================================
-- drop function if exists analytics_heatmap(uuid, public.user_role, text, text, uuid, uuid);
-- drop function if exists analytics_participation(uuid, public.user_role, uuid, uuid);
