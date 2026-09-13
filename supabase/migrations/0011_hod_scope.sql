-- =============================================================
-- 0011_hod_scope.sql — what a Head of Department can reach
--
-- An HOD is an administrator of ONE department. The rights are deliberately
-- asymmetric with a global admin:
--
--   users        their department only, and add/edit only — deactivating,
--                removing and restoring stay with an admin
--   questions    their department's own set; the college-wide set is readable
--                but not writable
--   departments  read-only. An HOD cannot create, rename or archive one
--   cycles       read-only. Academic years are set college-wide
--   analytics    their department's responses, plus a college-wide comparison
--
-- HOW THE SCOPING WORKS
-- One select policy on `responses` keyed on hod_department() narrows every one of
-- the eight analytics functions at once, because they are all SECURITY INVOKER and
-- therefore see exactly the rows RLS grants. No function body changes. The single
-- exception is the college-wide benchmark an HOD is *supposed* to see, which
-- cannot come from RLS by definition and gets one narrow SECURITY DEFINER
-- function at the end of this file.
--
-- Run after 0010, which adds the enum label. This file cannot be combined with it.
-- =============================================================

-- ---------- 1. who am I, and what do I run ----------
-- Same liveness predicate as current_role_type(): deactivated, removed, and
-- not-yet-password-changed accounts have no department for these purposes either.
--
-- DO NOT REVOKE THESE. An RLS policy expression is evaluated with the querying
-- role's privileges, so a policy calling a function `authenticated` may not
-- execute fails with "permission denied for function" rather than denying the
-- row. That is why is_admin() and current_role_type() are not revoked either.
-- Each one reports a fact about the caller themselves, so nothing is disclosed.
create or replace function my_department()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select department_id from profiles
  where id = auth.uid()
    and status = 'active'
    and removed_at is null
    and not must_change_password;
$$;

comment on function my_department() is
  'The caller''s own department, for any live role. Used by the respondent-facing question policy. Callable by authenticated on purpose — see 0011 header.';

create or replace function hod_department()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select department_id from profiles
  where id = auth.uid()
    and role = 'hod'
    and status = 'active'
    and removed_at is null
    and not must_change_password
    and department_id is not null;
$$;

comment on function hod_department() is
  'The department this caller heads, or NULL if they head none. Every HOD policy in this file is keyed on it, so an HOD without a department has no extra rights at all.';

create or replace function is_hod()
returns boolean
language sql
stable
security definer
set search_path = public
as $$ select hod_department() is not null; $$;

-- Staff = may reach the admin panel. NOT the same as is_admin(), which stays
-- strictly global: an HOD is never an admin.
create or replace function is_staff()
returns boolean
language sql
stable
security definer
set search_path = public
as $$ select is_admin() or hod_department() is not null; $$;

-- ---------- 2. a question set per department ----------
-- NULL means the college-wide set — which is what all 76 rows seeded from PRD §8
-- already are, so existing data needs no migration. A respondent answers the
-- college-wide questions PLUS their own department's.
--
-- `questions (form_id, question_key)` stays unique and untouched. The app
-- namespaces a department question's key with the department slug
-- ('computer_science__lab_facilities') because analytics_distribution and
-- analytics_choice_distribution group by (stakeholder, form, question_key, scale)
-- with no question id in the key: two departments both choosing 'lab_facilities'
-- would otherwise have their Likert bars silently pooled into one chart.
alter table questions
  add column if not exists department_id uuid references departments (id) on delete restrict;

comment on column questions.department_id is
  'NULL = the college-wide set, admin-only. Non-null = that department''s own set, editable by its HOD. A respondent sees both.';

create index if not exists questions_by_department
  on questions (department_id) where department_id is not null;

create index if not exists questions_by_form_department
  on questions (form_id, department_id, display_order);

-- ---------- 3. staff do not fill in forms ----------
alter table forms drop constraint if exists forms_not_admin;
alter table forms drop constraint if exists forms_respondent_only;
alter table forms
  add constraint forms_respondent_only
  check (stakeholder_type not in ('admin', 'hod'));

-- ---------- 4. an HOD account can be created like any other ----------
create or replace function handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  meta_role text := nullif(new.raw_user_meta_data ->> 'role', '');
  meta_dept text := nullif(new.raw_user_meta_data ->> 'department_id', '');
begin
  if meta_role is null or meta_role not in (
    'admin', 'hod', 'academic_peer', 'student', 'employer', 'alumni', 'faculty'
  ) then
    return new;
  end if;

  insert into profiles (id, email, full_name, sap_id, role, department_id, must_change_password)
  values (
    new.id,
    new.email,
    nullif(new.raw_user_meta_data ->> 'full_name', ''),
    nullif(new.raw_user_meta_data ->> 'sap_id', ''),
    meta_role::user_role,
    case
      when meta_dept ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      then meta_dept::uuid
    end,
    true
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

revoke execute on function handle_new_auth_user() from public, anon, authenticated;

-- ---------- 5. the profile guard gains a department-admin branch ----------
-- is_privileged_writer() is deliberately NOT widened to include an HOD. It is the
-- unconditional bypass at the top of this function, and an HOD who passed it would
-- get global write on every protected column of every profile. They get a narrower
-- branch below it instead, and only for a row already in their own department.
--
-- RLS (section 6) has separately confirmed the row is theirs and is not an admin or
-- another HOD, in both `using` and `with check`. This trigger is the second lock:
-- it names what not even a department administrator may do.
create or replace function guard_profile_privilege_columns()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  hod_dept uuid;
begin
  if is_privileged_writer() then
    return new;
  end if;

  hod_dept := hod_department();

  if hod_dept is not null and old.department_id = hod_dept then
    -- Moving someone in or out is how an HOD would grow their own scope, or
    -- quietly hand a colleague's students away.
    if new.department_id is distinct from old.department_id then
      raise exception 'A head of department cannot move an account to another department.'
        using errcode = '42501';
    end if;
    -- Minting a peer or a superior is how they would escape the department.
    if new.role in ('admin', 'hod') then
      raise exception 'Only an administrator can appoint an administrator or a head of department.'
        using errcode = '42501';
    end if;
    if new.removed_at is distinct from old.removed_at
       or new.removed_by is distinct from old.removed_by then
      raise exception 'Only an administrator can remove or restore an account.'
        using errcode = '42501';
    end if;
    if new.must_change_password is distinct from old.must_change_password then
      raise exception 'Password setup status is managed by authentication.'
        using errcode = '42501';
    end if;
    -- Everything else — name, SAP ID, and the role among the respondent types —
    -- is theirs to administer.
    return new;
  end if;

  if new.role is distinct from old.role then
    raise exception 'Only an administrator can change a role.' using errcode = '42501';
  end if;
  if new.status is distinct from old.status then
    raise exception 'Only an administrator can change account status.' using errcode = '42501';
  end if;
  if nullif(upper(trim(new.sap_id)), '') is distinct from old.sap_id then
    raise exception 'Only an administrator can change a SAP ID.' using errcode = '42501';
  end if;
  if new.department_id is distinct from old.department_id then
    raise exception 'Only an administrator can change a department.' using errcode = '42501';
  end if;
  if new.removed_at is distinct from old.removed_at then
    raise exception 'Only an administrator can remove or restore an account.' using errcode = '42501';
  end if;
  if new.removed_by is distinct from old.removed_by then
    raise exception 'Only an administrator can change account removal details.' using errcode = '42501';
  end if;
  if new.must_change_password is distinct from old.must_change_password then
    raise exception 'Password setup status is managed by authentication.' using errcode = '42501';
  end if;

  return new;
end;
$$;

revoke execute on function guard_profile_privilege_columns()
  from public, anon, authenticated;

-- =============================================================
-- 6. RLS
--
-- Policies are permissive and OR together, so each block below ADDS what an HOD
-- may reach without loosening anything for anyone else. Every one is keyed on
-- hod_department(), which is NULL for every other role — so for a respondent or an
-- admin these policies contribute nothing.
-- =============================================================

-- ---------- profiles ----------
drop policy if exists profiles_hod_read on profiles;
create policy profiles_hod_read on profiles
  for select
  to authenticated
  using (
    department_id is not null
    and department_id = (select hod_department())
  );

-- `role not in ('admin','hod')` appears in BOTH clauses on purpose. In `using` it
-- keeps an HOD away from an admin or a fellow HOD who happens to sit in their
-- department; in `with check` it stops the same statement from promoting an
-- ordinary account into one on the way past.
drop policy if exists profiles_hod_update on profiles;
create policy profiles_hod_update on profiles
  for update
  to authenticated
  using (
    department_id is not null
    and department_id = (select hod_department())
    and role not in ('admin', 'hod')
  )
  with check (
    department_id is not null
    and department_id = (select hod_department())
    and role not in ('admin', 'hod')
  );

-- Deliberately no insert and no delete policy for an HOD. Accounts are created by
-- the invite-users function under service_role, and removal stays with an admin.

-- ---------- responses and answers ----------
-- The single policy that scopes every analytics metric. department_id was snapshot
-- onto the response at submission time by 0008, so an HOD sees the feedback given
-- by their department and cannot see it drift when someone transfers.
drop policy if exists responses_hod_read on responses;
create policy responses_hod_read on responses
  for select
  to authenticated
  using (
    department_id is not null
    and department_id = (select hod_department())
  );

drop policy if exists answers_hod_read on answers;
create policy answers_hod_read on answers
  for select
  to authenticated
  using (
    exists (
      select 1 from responses r
      where r.id = answers.response_id
        and r.department_id is not null
        and r.department_id = (select hod_department())
    )
  );

-- ---------- questions ----------
-- Read: a respondent gets the college-wide set plus their own department's; an
-- admin gets every department's. The soft-delete clause widens from is_admin() to
-- is_staff() so an HOD can still reach a deleted question's history in analytics
-- (FR-32).
drop policy if exists questions_read on questions;
create policy questions_read on questions
  for select
  to authenticated
  using (
    (select current_role_type()) is not null
    and (
      department_id is null
      or department_id = (select my_department())
      or (select is_admin())
    )
    and (is_active or (select is_staff()))
  );

-- Write: the existing admin policy still covers every row. This one adds an HOD's
-- own set and nothing else. `department_id is not null` in `with check` is what
-- stops an HOD creating a college-wide question, and the equality is what stops
-- them reaching into a neighbour's set — including by moving one of their own rows
-- across in an UPDATE.
drop policy if exists questions_hod_write on questions;
create policy questions_hod_write on questions
  for all
  to authenticated
  using (
    department_id is not null
    and department_id = (select hod_department())
  )
  with check (
    department_id is not null
    and department_id = (select hod_department())
  );

-- Versions and options carry no department of their own; they inherit the parent
-- question's. Both clauses resolve through it, so an HOD can version their own
-- question and nothing else.
drop policy if exists question_versions_hod_write on question_versions;
create policy question_versions_hod_write on question_versions
  for all
  to authenticated
  using (
    exists (
      select 1 from questions q
      where q.id = question_versions.question_id
        and q.department_id is not null
        and q.department_id = (select hod_department())
    )
  )
  with check (
    exists (
      select 1 from questions q
      where q.id = question_versions.question_id
        and q.department_id is not null
        and q.department_id = (select hod_department())
    )
  );

drop policy if exists question_options_hod_write on question_options;
create policy question_options_hod_write on question_options
  for all
  to authenticated
  using (
    exists (
      select 1 from question_versions qv join questions q on q.id = qv.question_id
      where qv.id = question_options.question_version_id
        and q.department_id is not null
        and q.department_id = (select hod_department())
    )
  )
  with check (
    exists (
      select 1 from question_versions qv join questions q on q.id = qv.question_id
      where qv.id = question_options.question_version_id
        and q.department_id is not null
        and q.department_id = (select hod_department())
    )
  );

-- ---------- question audit (NFR-9) ----------
-- Scoped to the questions the caller administers rather than opened to all staff,
-- so an HOD's audit view is their own history.
drop policy if exists question_audit_admin_read on question_audit;
drop policy if exists question_audit_staff_read on question_audit;
create policy question_audit_staff_read on question_audit
  for select
  to authenticated
  using (
    (select is_admin())
    or exists (
      select 1 from questions q
      where q.id = question_audit.question_id
        and q.department_id is not null
        and q.department_id = (select hod_department())
    )
  );

drop policy if exists question_audit_admin_insert on question_audit;
drop policy if exists question_audit_staff_insert on question_audit;
create policy question_audit_staff_insert on question_audit
  for insert
  to authenticated
  with check (
    (select is_admin())
    or exists (
      select 1 from questions q
      where q.id = question_audit.question_id
        and q.department_id is not null
        and q.department_id = (select hod_department())
    )
  );

-- streams, departments and academic_cycles are deliberately untouched. Their read
-- policies already admit any live role, and their write policies stay is_admin() —
-- which is exactly what "an HOD cannot add a department" and "cycles are set
-- college-wide" mean.

-- =============================================================
-- 7. analytics
-- =============================================================

-- The guard under its true name. An HOD may read analytics; RLS on `responses`
-- above is what narrows the rows to their department, so no function body changes.
create or replace function analytics_reader_ok()
returns boolean
language plpgsql
stable
security invoker
set search_path = public
as $$
begin
  if not is_staff() then
    raise exception 'Admin or head-of-department access is required to read analytics.'
      using errcode = '42501';
  end if;
  return true;
end;
$$;

-- Kept under its original name because eight function bodies in 0005/0008 call it,
-- and re-creating 900 lines of them purely to rename it would be churn. Still
-- plpgsql, never `language sql`: an inlinable guard can be optimised out of the
-- row-producing path, which is the failure 0005's header records having observed.
create or replace function analytics_admin_ok()
returns boolean
language plpgsql
stable
security invoker
set search_path = public
as $$
begin
  return analytics_reader_ok();
end;
$$;

comment on function analytics_admin_ok is
  'Now means "may read analytics": a global admin, or an HOD whose rows RLS narrows to their own department. Use analytics_reader_ok() in new code; this name is kept only because eight existing function bodies call it.';

-- ---------- department vs college ----------
-- The ONE security-definer function in the analytics layer, because the figure it
-- exists to produce is by definition outside the caller's RLS view: an HOD is
-- supposed to see how their department compares with the college, and RLS shows
-- them only their department.
--
-- What keeps that narrow:
--   * the guard admits staff only
--   * an HOD gets their OWN department's rows and the college rows; never another
--     department's, which is enforced in the where clause rather than trusted to
--     the caller
--   * output is aggregate only. No response id, no user id, no free text
--   * the college row is withheld from an HOD when fewer than MIN_OTHERS scored
--     answers came from outside their own department, because below that "the
--     college minus me" approximates naming one other department's answers. It
--     also disposes of a department's private questions for free: nobody outside
--     Computer Science ever answered 'computer_science__*', so its college row is
--     withheld rather than reported as a self-comparison
--
-- Rows are shaped like analytics_question_stats so pool(), formatAvg,
-- formatNormalised and assertDenominators in src/lib/analytics/scales.js read them
-- unchanged — normalised_sum included, so a client folds by summing rather than
-- averaging averages.
create or replace function analytics_benchmark(
  p_cycle_id    uuid      default null,
  p_stakeholder user_role default null
)
returns table (
  department_id uuid, department_name text, stakeholder_type text,
  question_key text, question_text text, scale_id uuid, scale_name text,
  min_score numeric, max_score numeric,
  n_answers bigint, n_scored bigint, n_not_applicable bigint, n_respondents bigint,
  score_sum numeric, avg_score numeric, normalised_sum numeric, normalised_avg numeric
)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  min_others constant int := 5;
  caller_dept uuid;
  caller_admin boolean;
begin
  if not is_staff() then
    raise exception 'Admin or head-of-department access is required to read analytics.'
      using errcode = '42501';
  end if;

  caller_admin := is_admin();
  caller_dept  := hod_department();

  return query
  with ans as (
    select r.department_id as dep, f.stakeholder_type as st, q.question_key as q_key,
           cv.text as q_text, qv.scale_id as s_id, a.value_numeric as vn,
           a.response_id as rid
    from answers a
    join responses r on r.id = a.response_id
    join forms f on f.id = r.form_id
    join question_versions qv on qv.id = a.question_version_id
    join questions q on q.id = qv.question_id
    left join question_versions cv on cv.id = q.current_version_id
    where qv.type = 'rating'
      and (p_cycle_id is null or r.cycle_id = p_cycle_id)
      and (p_stakeholder is null or f.stakeholder_type = p_stakeholder)
  ),
  bounds as (
    select o.scale_id as s_id, min(o.score) as lo, max(o.score) as hi
    from rating_scale_options o where o.score is not null group by o.scale_id
  ),
  by_dep as (
    select ans.dep, ans.st, ans.q_key, ans.s_id, min(ans.q_text) as q_text,
           count(*) as n_ans, count(ans.vn) as n_sc,
           count(*) - count(ans.vn) as n_na, count(distinct ans.rid) as n_resp,
           sum(ans.vn) as sum_sc
    from ans where ans.dep is not null group by 1,2,3,4
  ),
  -- Every answer, department-stamped or not: this is the college line.
  college as (
    select ans.st, ans.q_key, ans.s_id, min(ans.q_text) as q_text,
           count(*) as n_ans, count(ans.vn) as n_sc,
           count(*) - count(ans.vn) as n_na, count(distinct ans.rid) as n_resp,
           sum(ans.vn) as sum_sc
    from ans group by 1,2,3
  )
  select d.dep, dpt.name, d.st::text, d.q_key, d.q_text, d.s_id, sc.name,
         b.lo, b.hi, d.n_ans, d.n_sc, d.n_na, d.n_resp, d.sum_sc,
         -- null, never 0, when nothing scored: recharts draws a gap for the first
         -- and a floor-scraping dip for the second.
         case when d.n_sc > 0 then d.sum_sc / d.n_sc end,
         case when b.hi > b.lo then (d.sum_sc - b.lo * d.n_sc) / (b.hi - b.lo) end,
         case when b.hi > b.lo and d.n_sc > 0
              then ((d.sum_sc / d.n_sc) - b.lo) / (b.hi - b.lo) end
  from by_dep d
  join departments dpt on dpt.id = d.dep
  left join bounds b on b.s_id = d.s_id
  left join rating_scales sc on sc.id = d.s_id
  where caller_admin or d.dep = caller_dept

  union all

  select null::uuid, null::text, c.st::text, c.q_key, c.q_text, c.s_id, sc.name,
         b.lo, b.hi, c.n_ans, c.n_sc, c.n_na, c.n_resp, c.sum_sc,
         case when c.n_sc > 0 then c.sum_sc / c.n_sc end,
         case when b.hi > b.lo then (c.sum_sc - b.lo * c.n_sc) / (b.hi - b.lo) end,
         case when b.hi > b.lo and c.n_sc > 0
              then ((c.sum_sc / c.n_sc) - b.lo) / (b.hi - b.lo) end
  from college c
  left join bounds b on b.s_id = c.s_id
  left join rating_scales sc on sc.id = c.s_id
  where caller_admin
     or c.n_sc - coalesce((
          select m.n_sc from by_dep m
          where m.dep = caller_dept and m.st = c.st
            and m.q_key = c.q_key and m.s_id is not distinct from c.s_id
        ), 0) >= min_others

  -- College row first within each question, so a client can read the baseline
  -- before the departments it is comparing.
  order by 3, 4, 1 nulls first;
end;
$$;

-- ---------- permissions ----------
-- create function grants EXECUTE to PUBLIC and anon inherits through it, so the two
-- new functions above would be anon-callable without this. Same loop that closes
-- 0005 and 0008; it must run after any change to an analytics_* function.
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

notify pgrst, 'reload schema';
