-- =============================================================
-- 0008_departments.sql — streams, the departments inside them, and the
-- department a user belongs to
--
-- WHAT WAS MISSING
-- "Program" already existed, but only as a form ANSWER: the student form's
-- `program` single-select, lifted onto responses.program by the app so a
-- submission can be filtered by it. Nothing recorded which department a PERSON
-- belongs to, so an admin could not register a student against one, filter the
-- user list by one, or slice analytics by one.
--
-- Two levels, because a college has both: a stream (Science, Commerce, Arts)
-- containing departments (Computer Science, Accounting & Finance, English).
-- Both are admin-managed reference data — the seed below is a starting point,
-- not a fixed list.
--
-- WHY responses CARRIES ITS OWN department_id
-- 0005_analytics.sql takes the stakeholder dimension from responses.form_id and
-- never from profiles.role, because role is mutable and re-roling graduating
-- students to alumni would retroactively rewrite last year's totals. A student
-- transferring department is the same hazard, so the department is SNAPSHOT onto
-- the response when it is created rather than joined through the profile.
--
-- The student form's own `program` question is deliberately untouched. Its
-- options are immutable once answered (FR-31), so re-pointing them at this table
-- would need a new question version and an answer migration. Department is a new
-- analytics dimension alongside program, not a replacement for it.
--
-- Run after 0007.
-- =============================================================

-- ---------- 1. streams ----------
create table if not exists streams (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  -- Same normalisation as responses.course_key (0001_schema.sql): collapse
  -- internal runs of whitespace, trim, lower-case. It is what makes the unique
  -- index below mean what an admin expects — "Computer  Science" and
  -- "computer science" collide instead of becoming two streams.
  slug          text generated always as (
                  lower(btrim(regexp_replace(coalesce(name, ''), '\s+', ' ', 'g')))
                ) stored,
  display_order int         not null default 0,
  is_active     boolean     not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint streams_name_not_blank check (btrim(name) <> '')
);

create unique index if not exists streams_slug_unique on streams (slug);

comment on table streams is
  'Top-level grouping for departments (Science, Commerce, Arts). Admin-managed.';

-- ---------- 2. departments ----------
-- `on delete restrict` rather than cascade: a department that people belong to
-- must not be removable in a way that silently detaches them. Retiring a real
-- department is is_active = false (mirroring question soft-delete, FR-32); a hard
-- delete stays available only while nothing references the row, which is the
-- case an admin actually needs it for — a name they just mistyped.
create table if not exists departments (
  id            uuid primary key default gen_random_uuid(),
  stream_id     uuid not null references streams (id) on delete restrict,
  name          text not null,
  code          text,                      -- optional short form, e.g. 'CS'
  slug          text generated always as (
                  lower(btrim(regexp_replace(coalesce(name, ''), '\s+', ' ', 'g')))
                ) stored,
  display_order int         not null default 0,
  is_active     boolean     not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint departments_name_not_blank check (btrim(name) <> ''),
  constraint departments_code_shape check (
    code is null or code ~ '^[A-Za-z0-9][A-Za-z0-9 ._&/-]{0,15}$'
  )
);

-- Unique WITHIN a stream, not globally: Psychology is genuinely a Science
-- department and an Arts one, and the seeded program list contains both.
create unique index if not exists departments_slug_unique
  on departments (stream_id, slug);

create unique index if not exists departments_code_unique
  on departments (stream_id, code) where code is not null;

create index if not exists departments_by_stream on departments (stream_id);

comment on table departments is
  'A department inside a stream. Assigned to a user account by an admin, and snapshot onto each response.';

-- ---------- 3. one canonical form ----------
-- Normalising here rather than in the client is what makes the unique indexes
-- above genuinely case- and whitespace-insensitive: every write path — the admin
-- panel, a CSV import, a psql session — lands on the same value. STORED generated
-- columns are computed after BEFORE triggers, so `slug` sees the tidied name.
--
-- Two functions rather than one shared body, because a plpgsql trigger that
-- references new.code cannot be attached to `streams`, which has no such column.
create or replace function normalise_stream_row()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.name := btrim(regexp_replace(coalesce(new.name, ''), '\s+', ' ', 'g'));
  return new;
end;
$$;

create or replace function normalise_department_row()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.name := btrim(regexp_replace(coalesce(new.name, ''), '\s+', ' ', 'g'));
  new.code := nullif(upper(btrim(new.code)), '');
  return new;
end;
$$;

drop trigger if exists streams_normalise on streams;
create trigger streams_normalise
  before insert or update on streams
  for each row execute function normalise_stream_row();

drop trigger if exists departments_normalise on departments;
create trigger departments_normalise
  before insert or update on departments
  for each row execute function normalise_department_row();

-- touch_updated_at() comes from 0001_schema.sql.
drop trigger if exists streams_touch_updated_at on streams;
create trigger streams_touch_updated_at
  before update on streams
  for each row execute function touch_updated_at();

drop trigger if exists departments_touch_updated_at on departments;
create trigger departments_touch_updated_at
  before update on departments
  for each row execute function touch_updated_at();

-- Trigger functions are internal details, not Data API RPCs.
revoke execute on function normalise_stream_row() from public, anon, authenticated;
revoke execute on function normalise_department_row() from public, anon, authenticated;

-- ---------- 4. the department a user belongs to ----------
-- Nullable, and deliberately WITHOUT a check constraint tying it to the role.
-- The app requires a department for students and faculty, but expressing that in
-- the database would fire on UPDATE as well as INSERT, and every student account
-- that predates this migration has none. That would make those rows unsavable —
-- including by `update profiles set must_change_password = false`, which the Auth
-- password-change trigger runs on first sign-in. The rule is enforced at the
-- three write paths that create or edit an account instead.
alter table profiles
  add column if not exists department_id uuid references departments (id) on delete restrict;

comment on column profiles.department_id is
  'The department this person belongs to. Admin-managed: the privilege guard below rejects self-edits. Required for students and faculty in the app, not in the schema — see 0008 header.';

create index if not exists profiles_by_department
  on profiles (department_id) where department_id is not null;

-- ---------- 5. the department a response was given under ----------
alter table responses
  add column if not exists department_id uuid references departments (id) on delete restrict;

comment on column responses.department_id is
  'Snapshot of the respondent''s department at submission time. Not joined through profiles, because a transfer would retroactively rewrite past cycles'' totals (same reasoning as stakeholder_type coming from form_id in 0005_analytics.sql).';

create index if not exists responses_by_department
  on responses (department_id) where department_id is not null;

-- The client never sends this: the trigger reads it from the respondent's own
-- profile and overwrites whatever arrived. SECURITY DEFINER so the stamp does not
-- depend on the caller's RLS view of profiles, the same reason
-- freeze_answered_question_version() is definer.
--
-- INSERT only. Re-deriving on UPDATE would move an old submission when its author
-- changes department, which is precisely the retroactive rewrite the snapshot
-- exists to prevent.
create or replace function stamp_response_department()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  select p.department_id into new.department_id
  from profiles p where p.id = new.user_id;
  return new;
end;
$$;

drop trigger if exists responses_stamp_department on responses;
create trigger responses_stamp_department
  before insert on responses
  for each row execute function stamp_response_department();

revoke execute on function stamp_response_department() from public, anon, authenticated;

-- ---------- 6. only an administrator may set a department ----------
-- Same reasoning as role, status and sap_id: a respondent who could write their
-- own department_id could file their feedback under someone else's department and
-- skew that department's analytics.
--
-- Rewritten in full rather than patched, as 0006 and 0007 each did, so the whole
-- predicate stays visible in one place.
create or replace function guard_profile_privilege_columns()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if is_privileged_writer() then
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

-- ---------- 7. a response's department is fixed once stamped ----------
-- The stamp trigger only runs on INSERT, so without this a respondent editing
-- their submission could simply send a different department_id and re-file the
-- feedback. Admins and service_role still can, through is_privileged_writer().
create or replace function guard_response_identity_columns()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if is_privileged_writer() then
    return new;
  end if;
  if new.user_id is distinct from old.user_id
     or new.form_id is distinct from old.form_id
     or new.cycle_id is distinct from old.cycle_id then
    raise exception 'user_id, form_id and cycle_id are immutable on an existing response';
  end if;
  if new.department_id is distinct from old.department_id then
    raise exception 'A response keeps the department it was submitted under.'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke execute on function guard_response_identity_columns()
  from public, anon, authenticated;

-- ---------- 8. carry the department through account creation ----------
-- The admin panel creates the Auth account and the profile row in one step, so
-- the department travels in the new user's metadata next to the role and SAP ID.
--
-- Cast only when the value looks like a uuid: metadata is free-form JSON, and a
-- malformed id raising inside this trigger would abort account creation with an
-- opaque "database error creating new user". A well-formed id that does not exist
-- is still rejected by the foreign key, which is why invite-users looks it up
-- before calling createUser.
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
    'admin', 'academic_peer', 'student', 'employer', 'alumni', 'faculty'
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

-- ---------- 9. RLS ----------
-- Exposed exactly as the other reference tables are (forms, rating_scales,
-- academic_cycles): readable by anyone with a live app role, writable only by an
-- admin. A respondent needs the read so the app can name their own department;
-- current_role_type() is null for a deactivated, removed or temporary-password
-- account, which closes that door with the same key as everywhere else.
alter table streams     enable row level security;
alter table departments enable row level security;

drop policy if exists streams_read on streams;
create policy streams_read on streams
  for select
  to authenticated
  using ((select current_role_type()) is not null);

drop policy if exists streams_admin_write on streams;
create policy streams_admin_write on streams
  for all
  to authenticated
  using ((select is_admin())) with check ((select is_admin()));

drop policy if exists departments_read on departments;
create policy departments_read on departments
  for select
  to authenticated
  using ((select current_role_type()) is not null);

drop policy if exists departments_admin_write on departments;
create policy departments_admin_write on departments
  for all
  to authenticated
  using ((select is_admin())) with check ((select is_admin()));

-- =============================================================
-- 10. analytics gains a stream and a department filter (FR-37)
--
-- These are DROPPED before being recreated, not simply replaced. `create or
-- replace function` with a different argument list creates an OVERLOAD rather
-- than replacing anything, and PostgREST then refuses to pick between the two
-- ("Could not choose the best candidate function"). Dropping by the exact old
-- signature is what makes this a change instead of a second copy.
--
-- Nothing here re-aggregates or changes an existing return shape: every function
-- gains the same two optional parameters and passes them into the one shared
-- definition of "the requested slice".
-- =============================================================
drop function if exists analytics_response_ids(uuid, user_role, text, text);
drop function if exists analytics_filter_options(uuid);
drop function if exists analytics_totals(uuid, user_role, text, text);
drop function if exists analytics_question_stats(uuid, user_role, text, text);
drop function if exists analytics_distribution(uuid, user_role, text, text);
drop function if exists analytics_choice_distribution(uuid, user_role, text, text);
drop function if exists analytics_trends(user_role, text, text);
drop function if exists analytics_text_answers(uuid, user_role, text, text, int, int);
drop function if exists analytics_export_rows(uuid, user_role, text, text, int, int);

-- ---------- shared filter ----------
-- The join to departments is LEFT, so a response with no department stays visible
-- while neither new filter is set. With p_stream_id set, `d.stream_id = ...` is
-- NULL for those rows and they drop out, which is the wanted behaviour: they
-- cannot be claimed by any stream.
create or replace function analytics_response_ids(
  p_cycle_id      uuid      default null,
  p_stakeholder   user_role default null,
  p_program       text      default null,
  p_course_key    text      default null,
  p_stream_id     uuid      default null,
  p_department_id uuid      default null
)
returns setof uuid
language sql
stable
security invoker
set search_path = public
as $$
  select r.id
  from responses r
  join forms f on f.id = r.form_id
  left join departments d on d.id = r.department_id
  where analytics_admin_ok()
    and (p_cycle_id      is null or r.cycle_id         = p_cycle_id)
    and (p_stakeholder   is null or f.stakeholder_type = p_stakeholder)
    and (p_program       is null or r.program          = p_program)
    and (p_course_key    is null or r.course_key       = p_course_key)
    and (p_stream_id     is null or d.stream_id        = p_stream_id)
    and (p_department_id is null or r.department_id    = p_department_id);
$$;

-- ---------- FR-37: filter dropdowns ----------
-- streams and departments are returned in FULL, unlike `programs` which is
-- distinct-over-responses. A department with no responses yet is a real choice an
-- admin may want to select — the empty result that follows is information, not a
-- broken dropdown — and it is also what the add-user form needs. `isActive` rides
-- along so the UI can mark an archived one rather than hide it.
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
        group by r.course_key) t),
    'streams', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', s.id, 'name', s.name, 'isActive', s.is_active)
        order by s.display_order, s.name), '[]'::jsonb)
      from streams s),
    'departments', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', d.id, 'name', d.name, 'code', d.code,
        'streamId', d.stream_id, 'isActive', d.is_active)
        order by d.display_order, d.name), '[]'::jsonb)
      from departments d)
  ) end;
$$;

-- ---------- FR-35: totals ----------
-- byStream and byDepartment are built the same way as byProgram: off `scoped`
-- directly, never off a rowset joined to `answers`, which would report one row per
-- answer and turn 2 responses into 24.
create or replace function analytics_totals(
  p_cycle_id      uuid      default null,
  p_stakeholder   user_role default null,
  p_program       text      default null,
  p_course_key    text      default null,
  p_stream_id     uuid      default null,
  p_department_id uuid      default null
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
           r.department_id, f.stakeholder_type as st
    from responses r join forms f on f.id = r.form_id
    where r.id in (select analytics_response_ids(
      p_cycle_id, p_stakeholder, p_program, p_course_key, p_stream_id, p_department_id))
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
    'byStream', (select coalesce(jsonb_agg(jsonb_build_object(
        'streamId', t.stream_id, 'stream', t.name, 'responseCount', t.rc)
        order by t.rc desc, t.name), '[]'::jsonb)
      from (select st.id as stream_id, st.name, count(*) as rc
            from scoped s
            join departments d on d.id = s.department_id
            join streams st on st.id = d.stream_id
            group by st.id, st.name) t),
    'byDepartment', (select coalesce(jsonb_agg(jsonb_build_object(
        'departmentId', t.department_id, 'department', t.name, 'code', t.code,
        'stream', t.stream_name, 'responseCount', t.rc)
        order by t.rc desc, t.name), '[]'::jsonb)
      from (select d.id as department_id, d.name, d.code, st.name as stream_name,
                   count(*) as rc
            from scoped s
            join departments d on d.id = s.department_id
            join streams st on st.id = d.stream_id
            group by d.id, d.name, d.code, st.name) t),
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
create or replace function analytics_question_stats(
  p_cycle_id      uuid      default null,
  p_stakeholder   user_role default null,
  p_program       text      default null,
  p_course_key    text      default null,
  p_stream_id     uuid      default null,
  p_department_id uuid      default null
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
    select analytics_response_ids(
      p_cycle_id, p_stakeholder, p_program, p_course_key, p_stream_id, p_department_id) as id
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
  version_totals as (
    select qv.question_id as q_id, count(*) as total from question_versions qv group by qv.question_id
  ),
  grouped as (
    select ans.st, ans.f_id, ans.q_key, ans.q_id, ans.q_active, ans.s_id,
           count(*) as n_ans, count(ans.vn) as n_sc,
           count(*) - count(ans.vn) as n_na, count(distinct ans.rid) as n_resp,
           sum(ans.vn) as score_sum, avg(ans.vn) as avg_sc,
           count(distinct ans.qvid) as v_ans,
           array_agg(distinct ans.vno order by ans.vno) as vnos
    from ans group by 1,2,3,4,5,6
  )
  select g.st::text, g.f_id, g.q_key, g.q_id,
         cv.text, g.q_active, g.s_id, sc.name,
         b.lo, b.hi, g.n_ans, g.n_sc, g.n_na, g.n_resp, g.score_sum, g.avg_sc,
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
create or replace function analytics_distribution(
  p_cycle_id      uuid      default null,
  p_stakeholder   user_role default null,
  p_program       text      default null,
  p_course_key    text      default null,
  p_stream_id     uuid      default null,
  p_department_id uuid      default null
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
    select analytics_response_ids(
      p_cycle_id, p_stakeholder, p_program, p_course_key, p_stream_id, p_department_id) as id
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
create or replace function analytics_choice_distribution(
  p_cycle_id      uuid      default null,
  p_stakeholder   user_role default null,
  p_program       text      default null,
  p_course_key    text      default null,
  p_stream_id     uuid      default null,
  p_department_id uuid      default null
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
    select analytics_response_ids(
      p_cycle_id, p_stakeholder, p_program, p_course_key, p_stream_id, p_department_id) as id
  ),
  ans as (
    select a.response_id as rid, a.question_version_id as qvid, a.value_options as vo,
           qv.type as qtype, q.form_id as f_id, q.question_key as q_key, f.stakeholder_type as st
    from answers a
    join scoped s on s.id = a.response_id
    join question_versions qv on qv.id = a.question_version_id
    join questions q on q.id = qv.question_id
    join forms f on f.id = q.form_id
    where qv.type in ('single_select', 'multi_select')
  ),
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
-- This one builds its own rowset rather than calling analytics_response_ids,
-- because the cycle is the axis here and not a filter. The two new predicates are
-- therefore inlined, with the same LEFT JOIN so department-less responses are only
-- excluded when a stream or department is actually asked for.
create or replace function analytics_trends(
  p_stakeholder   user_role default null,
  p_program       text      default null,
  p_course_key    text      default null,
  p_stream_id     uuid      default null,
  p_department_id uuid      default null
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
    left join departments dep on dep.id = r.department_id
    where qv.type = 'rating'
      and (p_stakeholder is null or f.stakeholder_type = p_stakeholder)
      and (p_program is null or r.program = p_program)
      and (p_course_key is null or r.course_key = p_course_key)
      and (p_stream_id is null or dep.stream_id = p_stream_id)
      and (p_department_id is null or r.department_id = p_department_id)
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
create or replace function analytics_text_answers(
  p_cycle_id      uuid      default null,
  p_stakeholder   user_role default null,
  p_program       text      default null,
  p_course_key    text      default null,
  p_stream_id     uuid      default null,
  p_department_id uuid      default null,
  p_limit         int       default 1000,
  p_offset        int       default 0
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
    and r.id in (select analytics_response_ids(
      p_cycle_id, p_stakeholder, p_program, p_course_key, p_stream_id, p_department_id))
  order by a.response_id, a.id
  limit p_limit offset p_offset;
end;
$$;

-- ---------- FR-42: CSV export rows ----------
-- The new parameters FILTER the export; they add no COLUMN to it. NFR-4 is why:
-- src/lib/analytics/csv.js already strips the faculty form's `department` answer
-- from the file as identifying data, and a downloaded file has left the app's
-- access controls behind. Exporting the assigned department would undo that
-- decision by another route.
create or replace function analytics_export_rows(
  p_cycle_id      uuid      default null,
  p_stakeholder   user_role default null,
  p_program       text      default null,
  p_course_key    text      default null,
  p_stream_id     uuid      default null,
  p_department_id uuid      default null,
  p_limit         int       default 5000,
  p_offset        int       default 0
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
  where r.id in (select analytics_response_ids(
    p_cycle_id, p_stakeholder, p_program, p_course_key, p_stream_id, p_department_id))
  order by r.submitted_at, r.id, q.question_key, qv.version_no
  limit p_limit offset p_offset;
end;
$$;

-- ---------- 11. permissions, re-applied ----------
-- Every function recreated above was granted EXECUTE to PUBLIC by `create
-- function`, and `anon` inherits through PUBLIC — so the drop/recreate silently
-- handed the analytics layer back to unauthenticated callers. Revoking from anon
-- alone is a no-op; the revoke has to name PUBLIC. This is the same loop that
-- closes 0005_analytics.sql, and it must run after any change to these functions.
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

-- ---------- 12. a starting point, not a fixed list ----------
-- Derived from the programs the student form already offers (0003_seed.sql), so
-- an admin opens the new page to the college's actual departments rather than an
-- empty table. Everything here is editable, archivable and deletable from
-- /admin/departments; add what is missing there rather than in a migration.
--
-- Idempotent: the arbiter is the case- and whitespace-insensitive slug, so
-- re-running this cannot produce a second "Computer Science".
insert into streams (name, display_order) values
  ('Science', 1),
  ('Commerce', 2),
  ('Arts', 3)
on conflict (slug) do nothing;

-- Psychology appears under both Science and Arts, which is why the unique index
-- is on (stream_id, slug) rather than slug alone. PSY is likewise reused as a
-- code, which the per-stream code index permits.
insert into departments (stream_id, name, code, display_order)
select s.id, d.name, d.code, d.ord
from (values
  ('science',  'Computer Science',                    'CS'::text,  1),
  ('science',  'Information Technology',              'IT',        2),
  ('science',  'Data Science',                        'DS',        3),
  ('science',  'Applied Statistics & Data Analytics', 'ASDA',      4),
  ('science',  'Mathematics',                         'MATH',      5),
  ('science',  'Statistics',                          'STAT',      6),
  ('science',  'Physics',                             'PHY',       7),
  ('science',  'Chemistry',                           'CHEM',      8),
  ('science',  'Botany',                              'BOT',       9),
  ('science',  'Zoology',                             'ZOO',      10),
  ('science',  'Microbiology',                        'MICRO',    11),
  ('science',  'Biochemistry',                        'BCHEM',    12),
  ('science',  'Biotechnology',                       'BIOTECH',  13),
  ('science',  'Psychology',                          'PSY',      14),

  ('commerce', 'Commerce',                            'COM',       1),
  ('commerce', 'Accounting & Finance',                'AF',        2),
  ('commerce', 'Banking & Insurance',                 'BI',        3),
  ('commerce', 'Financial Markets',                   'FM',        4),
  ('commerce', 'Management Studies',                  'BMS',       5),
  ('commerce', 'Business Management',                 'BM',        6),
  ('commerce', 'Advanced Accountancy',                'AA',        7),

  ('arts',     'English',                             'ENG',       1),
  ('arts',     'Economics',                           'ECO',       2),
  ('arts',     'Psychology',                          'PSY',       3),
  ('arts',     'Sociology',                           'SOC',       4),
  ('arts',     'Mass Media & Communication',          'MMC',       5)
) as d(stream, name, code, ord)
join streams s on s.slug = d.stream
on conflict (stream_id, slug) do nothing;

-- PostgREST caches the schema; without this the new tables and the recreated
-- functions 404 until it reloads on its own.
notify pgrst, 'reload schema';

