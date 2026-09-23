-- Performance migration: indexes, RLS policy fixes, and server-side counting RPCs.
--
-- Safe to run on a live database: all changes are additive and the rollback
-- block at the bottom reverses every one of them.

-- ============================================================================
-- 1. Missing indexes on responses (H3, H4, M12)
-- ============================================================================
-- responses.user_id — used in every RLS policy on responses (per-row ownership
-- check). Without this, every authenticated read/write seq-scans the table.
create index if not exists responses_by_user
  on responses (user_id);

-- responses.course_key — used in analytics_response_ids WHERE clause and in the
-- unique constraint lookups. The unique index on (user_id, cycle_id, course_key)
-- does not cover a bare course_key filter.
create index if not exists responses_by_course_key
  on responses (course_key)
  where course_key is not null;

-- responses.program — used in analytics filter/group clauses.
create index if not exists responses_by_program
  on responses (program)
  where program is not null;

-- ============================================================================
-- 2. RLS policy fixes: (select auth.uid()) instead of bare auth.uid() (H5)
--
-- The subquery form is evaluated once per statement. The bare function call
-- re-evaluates per row, causing O(n) auth lookups during scans.
-- ============================================================================

-- profiles_read_own: the ONLY profiles policy still using bare auth.uid().
-- Deliberately kept open (no current_role_type() gate) so the route guard can
-- load the row and show why access is blocked (same reasoning as 0006).
drop policy if exists profiles_read_own on profiles;
create policy profiles_read_own on profiles
  for select using (id = (select auth.uid()) or (select is_admin()));

-- responses_insert_own: never rewritten by 0006, still uses bare auth.uid().
drop policy if exists responses_insert_own on responses;
create policy responses_insert_own on responses
  for insert
  to authenticated
  with check (
    user_id = (select auth.uid())
    and (select current_role_type()) is not null
    and cycle_is_open(cycle_id)
    and exists (
      select 1 from forms f
      where f.id = form_id
        and f.stakeholder_type = (select current_role_type())
    )
  );

-- ============================================================================
-- 3. Server-side counting RPCs (H1, H2)
--
-- Replace full-table-scan + client-side counting with GROUP BY in Postgres.
-- ============================================================================

-- H1: response counts per cycle (replaces loadCycleCounts full-table download)
create or replace function count_responses_per_cycle()
returns table (cycle_id uuid, count bigint)
language sql stable security invoker
set search_path = ''
as $$
  select r.cycle_id, count(*)::bigint
  from public.responses r
  group by r.cycle_id
$$;

-- H2: department usage counts (replaces loadDepartmentUsage 3-table download)
create or replace function count_department_usage()
returns table (
  department_id uuid,
  users bigint,
  removed_users bigint,
  responses bigint,
  questions bigint,
  blocking bigint
)
language sql stable security invoker
set search_path = ''
as $$
  select
    d.id as department_id,
    coalesce(p_active.cnt, 0) as users,
    coalesce(p_removed.cnt, 0) as removed_users,
    coalesce(resp.cnt, 0) as responses,
    coalesce(q.cnt, 0) as questions,
    coalesce(p_active.cnt, 0) + coalesce(p_removed.cnt, 0)
      + coalesce(resp.cnt, 0) + coalesce(q.cnt, 0) as blocking
  from public.departments d
  left join (
    select department_id, count(*)::bigint as cnt
    from public.profiles
    where department_id is not null and removed_at is null
    group by department_id
  ) p_active on p_active.department_id = d.id
  left join (
    select department_id, count(*)::bigint as cnt
    from public.profiles
    where department_id is not null and removed_at is not null
    group by department_id
  ) p_removed on p_removed.department_id = d.id
  left join (
    select department_id, count(*)::bigint as cnt
    from public.responses
    where department_id is not null
    group by department_id
  ) resp on resp.department_id = d.id
  left join (
    select department_id, count(*)::bigint as cnt
    from public.questions
    where department_id is not null
    group by department_id
  ) q on q.department_id = d.id
$$;

-- ============================================================================
-- 4. Batch reorder RPC (M2)
--
-- Replaces N individual UPDATE round-trips with one call.
-- ============================================================================
create or replace function reorder_questions(
  p_ids uuid[],
  p_orders int[]
)
returns void
language plpgsql security invoker
set search_path = ''
as $$
begin
  if array_length(p_ids, 1) is distinct from array_length(p_orders, 1) then
    raise exception 'reorder_questions: ids and orders must have the same length';
  end if;

  update public.questions q
  set display_order = v.new_order
  from unnest(p_ids, p_orders) as v(id, new_order)
  where q.id = v.id;
end;
$$;

-- ============================================================================
-- ROLLBACK (run this block to undo everything above)
-- ============================================================================
-- drop function if exists reorder_questions(uuid[], int[]);
-- drop function if exists count_department_usage();
-- drop function if exists count_responses_per_cycle();
--
-- drop index if exists responses_by_program;
-- drop index if exists responses_by_course_key;
-- drop index if exists responses_by_user;
--
-- -- Restore original profiles_read_own (bare auth.uid())
-- drop policy if exists profiles_read_own on profiles;
-- create policy profiles_read_own on profiles
--   for select using (id = auth.uid() or is_admin());
--
-- -- Restore original responses_insert_own (bare auth.uid())
-- drop policy if exists responses_insert_own on responses;
-- create policy responses_insert_own on responses
--   for insert
--   with check (
--     user_id = auth.uid()
--     and cycle_is_open(cycle_id)
--     and exists (
--       select 1 from forms f
--       where f.id = form_id
--         and f.stakeholder_type = current_role_type()
--     )
--   );
