-- Materialized analytics fact table.
--
-- Pre-joins the 5-table chain (answers → question_versions → questions →
-- responses → forms) that every analytics RPC traverses. A REFRESH replaces
-- live JOINs with a single-table scan against indexed columns.
--
-- Staleness: analytics are summaries, not live data. A 15-30 min lag is fine.
-- Refresh via pg_cron (if available) or the manual function below.
--
-- Safe to run on a live database: additive. Rollback block at bottom.

-- ============================================================================
-- 1. The fact view
-- ============================================================================
create materialized view if not exists analytics_facts as
select
  a.id              as answer_id,
  a.response_id,
  a.question_version_id,
  a.value_numeric,
  a.value_text,
  a.value_options,
  qv.question_id,
  qv.scale_id,
  qv.type           as question_type,
  qv.version_no,
  qv.text           as version_text,
  q.question_key,
  q.form_id,
  q.is_active       as question_active,
  q.display_order   as question_order,
  q.current_version_id,
  q.department_id   as question_department_id,
  r.cycle_id,
  r.user_id,
  r.program,
  r.course_key,
  r.course_title,
  r.department_id   as response_department_id,
  r.submitted_at,
  r.updated_at,
  f.stakeholder_type
from answers a
join question_versions qv on qv.id = a.question_version_id
join questions q           on q.id  = qv.question_id
join responses r           on r.id  = a.response_id
join forms f               on f.id  = r.form_id;

-- ============================================================================
-- 2. Indexes — covering the filter/group dimensions the RPCs use
-- ============================================================================
create unique index if not exists af_pk
  on analytics_facts (answer_id);

create index if not exists af_cycle
  on analytics_facts (cycle_id);

create index if not exists af_stakeholder
  on analytics_facts (stakeholder_type);

create index if not exists af_program
  on analytics_facts (program) where program is not null;

create index if not exists af_course
  on analytics_facts (course_key) where course_key is not null;

create index if not exists af_response_dept
  on analytics_facts (response_department_id) where response_department_id is not null;

create index if not exists af_question
  on analytics_facts (question_key, question_type);

create index if not exists af_response
  on analytics_facts (response_id);

create index if not exists af_scale
  on analytics_facts (scale_id) where scale_id is not null;

-- ============================================================================
-- 3. Refresh function (CONCURRENTLY requires the unique index above)
-- ============================================================================
create or replace function refresh_analytics()
returns void
language sql
security invoker
set search_path = ''
as $$
  refresh materialized view concurrently public.analytics_facts;
$$;

revoke all on function refresh_analytics() from public, anon;
grant execute on function refresh_analytics() to authenticated, service_role;

-- ============================================================================
-- 4. Optional: schedule automatic refresh via pg_cron (runs every 15 min).
--    Wrapped in a DO block so it silently skips if pg_cron is not enabled.
-- ============================================================================
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule(
      'refresh-analytics-facts',
      '*/15 * * * *',
      'select refresh_analytics()'
    );
  end if;
exception when others then
  raise notice 'pg_cron not available — refresh analytics_facts manually or via service_role call.';
end;
$$;

-- ============================================================================
-- ROLLBACK
-- ============================================================================
-- select cron.unschedule('refresh-analytics-facts'); -- if pg_cron was used
-- drop function if exists refresh_analytics();
-- drop materialized view if exists analytics_facts;
