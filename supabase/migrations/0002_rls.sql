-- =============================================================
-- 0002_rls.sql — Row-Level Security (PRD NFR-3, FR-5, FR-15, FR-16)
--
-- Design rule: the rules that protect data integrity (own-data-only, the
-- one-per-course key, and the edit window) are enforced HERE, not in the UI.
-- A stale browser tab cannot write after a cycle closes.
-- =============================================================

-- ---------- helpers ----------
-- SECURITY DEFINER + a locked search_path so policies can read profiles.role
-- without recursing through profiles' own RLS.
create or replace function is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from profiles
    where id = auth.uid()
      and role = 'admin'
      and status = 'active'
  );
$$;

create or replace function current_role_type()
returns user_role
language sql
stable
security definer
set search_path = public
as $$
  select role from profiles where id = auth.uid() and status = 'active';
$$;

-- FR-16: is this cycle still inside its editable window?
create or replace function cycle_is_open(target_cycle uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from academic_cycles c
    where c.id = target_cycle
      and now() >= c.opens_at
      and now() < c.closes_at
  );
$$;

comment on function cycle_is_open(uuid) is
  'FR-16 edit window. Used by responses/answers write policies.';

-- ---------- enable RLS everywhere ----------
alter table profiles             enable row level security;
alter table academic_cycles      enable row level security;
alter table rating_scales        enable row level security;
alter table rating_scale_options enable row level security;
alter table forms                enable row level security;
alter table questions            enable row level security;
alter table question_versions    enable row level security;
alter table question_options     enable row level security;
alter table responses            enable row level security;
alter table answers              enable row level security;
alter table question_audit       enable row level security;

-- ---------- profiles ----------
create policy profiles_read_own on profiles
  for select using (id = auth.uid() or is_admin());

-- A user may edit their own name, but NOT their own role or status.
-- The role/status lock lives in a trigger (see below), not in WITH CHECK:
-- a policy on `profiles` that subqueries `profiles` raises
-- "infinite recursion detected in policy for relation profiles".
create policy profiles_update_own on profiles
  for update
  using (id = auth.uid())
  with check (id = auth.uid());

create policy profiles_admin_all on profiles
  for all using (is_admin()) with check (is_admin());

-- ---------- academic cycles ----------
create policy cycles_read_all on academic_cycles
  for select using (auth.uid() is not null);

create policy cycles_admin_write on academic_cycles
  for all using (is_admin()) with check (is_admin());

-- ---------- form definition tables (read-only to respondents) ----------
create policy scales_read on rating_scales
  for select using (auth.uid() is not null);
create policy scales_admin_write on rating_scales
  for all using (is_admin()) with check (is_admin());

create policy scale_options_read on rating_scale_options
  for select using (auth.uid() is not null);
create policy scale_options_admin_write on rating_scale_options
  for all using (is_admin()) with check (is_admin());

create policy forms_read on forms
  for select using (auth.uid() is not null);
create policy forms_admin_write on forms
  for all using (is_admin()) with check (is_admin());

-- FR-32: respondents see only live questions; admins see soft-deleted ones too
-- (analytics and exports must still reach deleted questions' history).
create policy questions_read on questions
  for select using (auth.uid() is not null and (is_active or is_admin()));
create policy questions_admin_write on questions
  for all using (is_admin()) with check (is_admin());

-- Versions stay readable to everyone signed in: a respondent editing an old
-- submission must be able to render the exact wording they originally answered.
create policy question_versions_read on question_versions
  for select using (auth.uid() is not null);
create policy question_versions_admin_write on question_versions
  for all using (is_admin()) with check (is_admin());

create policy question_options_read on question_options
  for select using (auth.uid() is not null);
create policy question_options_admin_write on question_options
  for all using (is_admin()) with check (is_admin());

-- ---------- question audit (NFR-9) ----------
create policy question_audit_admin_read on question_audit
  for select using (is_admin());
create policy question_audit_admin_insert on question_audit
  for insert with check (is_admin());

-- ---------- responses (FR-15, FR-16) ----------
-- Read: own responses always (even after close, read-only); admins read all.
create policy responses_read_own on responses
  for select using (user_id = auth.uid() or is_admin());

-- Insert: only for yourself, only into the form matching your role, and only
-- while the cycle is open. The unique index on (user_id, cycle_id, course_key)
-- stops a second submission for the same course; the app upserts on it.
create policy responses_insert_own on responses
  for insert
  with check (
    user_id = auth.uid()
    and cycle_is_open(cycle_id)
    and exists (
      select 1 from forms f
      where f.id = form_id
        and f.stakeholder_type = current_role_type()
    )
  );

-- Update: own response, and ONLY while the cycle is open (FR-16).
-- USING gates the existing row. Re-parenting a response to another user, form
-- or cycle is blocked by a trigger rather than WITH CHECK, because a policy on
-- `responses` that subqueries `responses` would recurse.
create policy responses_update_own_while_open on responses
  for update
  using (user_id = auth.uid() and cycle_is_open(cycle_id))
  with check (user_id = auth.uid() and cycle_is_open(cycle_id));

-- Delete: a respondent may withdraw a mis-filed submission before close.
create policy responses_delete_own_while_open on responses
  for delete
  using (user_id = auth.uid() and cycle_is_open(cycle_id));

create policy responses_admin_all on responses
  for all using (is_admin()) with check (is_admin());

-- ---------- answers ----------
-- Answers inherit their parent response's ownership and edit window.
create policy answers_read_own on answers
  for select using (
    exists (
      select 1 from responses r
      where r.id = answers.response_id
        and (r.user_id = auth.uid() or is_admin())
    )
  );

create policy answers_insert_own on answers
  for insert
  with check (
    exists (
      select 1 from responses r
      where r.id = response_id
        and r.user_id = auth.uid()
        and cycle_is_open(r.cycle_id)
    )
  );

create policy answers_update_own_while_open on answers
  for update
  using (
    exists (
      select 1 from responses r
      where r.id = answers.response_id
        and r.user_id = auth.uid()
        and cycle_is_open(r.cycle_id)
    )
  )
  with check (
    exists (
      select 1 from responses r
      where r.id = response_id
        and r.user_id = auth.uid()
        and cycle_is_open(r.cycle_id)
    )
  );

create policy answers_delete_own_while_open on answers
  for delete
  using (
    exists (
      select 1 from responses r
      where r.id = answers.response_id
        and r.user_id = auth.uid()
        and cycle_is_open(r.cycle_id)
    )
  );

create policy answers_admin_all on answers
  for all using (is_admin()) with check (is_admin());

-- ---------- new-signup guard ----------
-- FR-2: no public signup. A profile row is created by an admin (or by the
-- invite flow running with elevated rights), never by the user themselves.
-- There is deliberately NO `profiles_insert_own` policy.

-- ---------- column-immutability triggers ----------
-- These enforce what RLS WITH CHECK cannot express without self-recursion.

-- Privileged writer = a signed-in admin, OR a trusted server-side connection.
-- Bulk import and invite flows (FR-23, FR-24) run under `service_role`, where
-- auth.uid() is NULL and is_admin() is therefore false. Without this, seeding
-- the first admin and every server-side role change would be blocked.
create or replace function is_privileged_writer()
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if coalesce(current_setting('request.jwt.claim.role', true), '') = 'service_role' then
    return true;
  end if;
  if current_user in ('postgres', 'supabase_admin', 'service_role') then
    return true;
  end if;
  return is_admin();
end;
$$;

comment on function is_privileged_writer() is
  'True for signed-in admins and for server-side/service_role connections that have no JWT.';

-- A respondent may rename themselves but not grant themselves a role or
-- reactivate a disabled account. Admins and service_role bypass both checks.
create or replace function guard_profile_privilege_columns()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if is_privileged_writer() then
    return new;
  end if;
  if new.role is distinct from old.role then
    raise exception 'role is not self-editable';
  end if;
  if new.status is distinct from old.status then
    raise exception 'status is not self-editable';
  end if;
  return new;
end;
$$;

create trigger profiles_guard_privileges
  before update on profiles
  for each row execute function guard_profile_privilege_columns();

-- A response cannot be re-parented to another user, form, or cycle after
-- creation; that would let an edit smuggle a row past the open-cycle gate.
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
  return new;
end;
$$;

create trigger responses_guard_identity
  before update on responses
  for each row execute function guard_response_identity_columns();
