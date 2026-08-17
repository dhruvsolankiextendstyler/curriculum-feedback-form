-- =============================================================
-- 0006_direct_users.sql — add users directly, and remove without deleting
--
-- Two changes to how accounts are managed.
--
-- 1. NO INVITE EMAIL. An admin now creates a working account there and then,
--    with a unique temporary password the user changes on first sign-in (FR-3
--    allows exactly this: "temporary password issued at registration"). The
--    invite_status column and its enum go with it — there is no invitation to
--    track a status for. `must_change_password` replaces it as the thing the app
--    actually needs to know about a brand-new account.
--
-- 2. REMOVE ≠ DELETE. Removing a user sets removed_at, mirroring how questions
--    are soft-deleted (FR-32). A hard delete would cascade through
--    responses -> answers and silently erase that person's feedback from every
--    past cycle's analytics. Removal is reversible; deletion is not.
--
-- Removal is a THIRD state, not a rename of deactivation:
--   active                       — signs in normally
--   inactive (status)            — temporarily blocked, still in the main list
--   removed  (removed_at)        — blocked and filed away, restorable
--
-- Run after 0005.
-- =============================================================

-- ---------- 1. first-sign-in password change ----------
-- Every account created by an admin starts with a temporary password. The route
-- guard reads this flag and lets such a session reach nothing except the
-- change-password screen. Database role helpers also reject the account until
-- the password has been replaced, so bypassing the UI does not bypass the rule.
--
-- Defaults to false so existing accounts (including the bootstrap admin, who
-- chose their own password in the dashboard) are not forced through it.
alter table profiles
  add column if not exists must_change_password boolean not null default false;

comment on column profiles.must_change_password is
  'True from admin creation until the user replaces the temporary password. App routing and database role helpers block normal access while it is set.';

-- Preserve the useful part of the old invitation state before removing it.
-- Previously invited-but-unused accounts still need to set a password, while
-- accepted and bootstrap accounts keep working normally.
do $$
begin
  if exists (
    select 1
      from information_schema.columns
     where table_schema = 'public'
       and table_name = 'profiles'
       and column_name = 'invite_status'
  ) then
    update profiles
       set must_change_password = invite_status <> 'accepted';
  end if;
end;
$$;

-- ---------- 2. drop the invite tracking ----------
-- The column first, then the type: an enum cannot be dropped while a column
-- still uses it.
drop trigger if exists on_auth_user_signed_in on auth.users;
drop function if exists handle_auth_user_signed_in();

alter table profiles drop column if exists invite_status;
drop type if exists invite_status;

-- ---------- 3. soft removal ----------
alter table profiles
  add column if not exists removed_at timestamptz,
  add column if not exists removed_by uuid references profiles (id) on delete set null;

comment on column profiles.removed_at is
  'Soft delete (mirrors questions.deleted_at). Set = the user cannot sign in and is filed under "removed"; their responses stay in analytics. Never hard-delete a profile: it cascades to responses and answers.';

-- Partial index: the common query is "the live list", and a partial index stays
-- small because it only covers rows that are not removed.
create index if not exists profiles_live
  on profiles (created_at desc) where removed_at is null;

create index if not exists profiles_removed
  on profiles (removed_at desc) where removed_at is not null;

create index if not exists profiles_removed_by
  on profiles (removed_by) where removed_by is not null;

-- ---------- 4. create profiles for direct Auth accounts ----------
-- auth.admin.createUser() inserts into auth.users. Keep the existing trigger,
-- but replace its function so it writes the new profile shape and does not
-- refer to invite_status after that column has been dropped.
create or replace function handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  meta_role text := nullif(new.raw_user_meta_data ->> 'role', '');
begin
  if meta_role is null or meta_role not in (
    'admin', 'academic_peer', 'student', 'employer', 'alumni', 'faculty'
  ) then
    return new;
  end if;

  insert into profiles (id, email, full_name, role, must_change_password)
  values (
    new.id,
    new.email,
    nullif(new.raw_user_meta_data ->> 'full_name', ''),
    meta_role::user_role,
    true
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

-- Password changes happen in Auth, so clear the first-sign-in flag from an Auth
-- trigger rather than allowing clients to clear it directly in profiles.
create or replace function handle_auth_user_password_changed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.encrypted_password is distinct from old.encrypted_password then
    update profiles
       set must_change_password = false
     where id = new.id;
  end if;
  return new;
end;
$$;

drop trigger if exists on_auth_user_password_changed on auth.users;
create trigger on_auth_user_password_changed
  after update of encrypted_password on auth.users
  for each row execute function handle_auth_user_password_changed();

-- Trigger functions are internal implementation details, not Data API RPCs.
revoke execute on function handle_new_auth_user() from public, anon, authenticated;
revoke execute on function handle_auth_user_password_changed() from public, anon, authenticated;

-- ---------- 5. a removed or first-sign-in user has no app role ----------
-- is_admin() and current_role_type() gate on status = 'active'. Removal has to
-- close the same door, or a removed admin would keep full access.
--
-- Rewritten rather than patched so the whole predicate is visible in one place.
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
      and removed_at is null
      and not must_change_password
  );
$$;

create or replace function current_role_type()
returns user_role
language sql
stable
security definer
set search_path = public
as $$
  select role from profiles
  where id = auth.uid()
    and status = 'active'
    and removed_at is null
    and not must_change_password;
$$;

-- Existing sessions are not enough to retain access after deactivation,
-- removal, or while a temporary password is still in use. Gate every app-data
-- read through current_role_type(). profiles_read_own deliberately remains in
-- place so the route guard can load the row and explain why access is blocked.
drop policy if exists profiles_update_own on profiles;
create policy profiles_update_own on profiles
  for update
  to authenticated
  using (
    id = (select auth.uid())
    and status = 'active'
    and removed_at is null
    and not must_change_password
  )
  with check (
    id = (select auth.uid())
    and status = 'active'
    and removed_at is null
    and not must_change_password
  );

drop policy if exists cycles_read_all on academic_cycles;
create policy cycles_read_all on academic_cycles
  for select
  to authenticated
  using ((select current_role_type()) is not null);

drop policy if exists scales_read on rating_scales;
create policy scales_read on rating_scales
  for select
  to authenticated
  using ((select current_role_type()) is not null);

drop policy if exists scale_options_read on rating_scale_options;
create policy scale_options_read on rating_scale_options
  for select
  to authenticated
  using ((select current_role_type()) is not null);

drop policy if exists forms_read on forms;
create policy forms_read on forms
  for select
  to authenticated
  using ((select current_role_type()) is not null);

drop policy if exists questions_read on questions;
create policy questions_read on questions
  for select
  to authenticated
  using (
    (select current_role_type()) is not null
    and (is_active or (select is_admin()))
  );

drop policy if exists question_versions_read on question_versions;
create policy question_versions_read on question_versions
  for select
  to authenticated
  using ((select current_role_type()) is not null);

drop policy if exists question_options_read on question_options;
create policy question_options_read on question_options
  for select
  to authenticated
  using ((select current_role_type()) is not null);

-- Re-check the same state for the user's own historical responses and answers
-- as well as for writes.
drop policy if exists responses_read_own on responses;
create policy responses_read_own on responses
  for select
  to authenticated
  using (
    (user_id = (select auth.uid()) and (select current_role_type()) is not null)
    or (select is_admin())
  );

drop policy if exists responses_update_own_while_open on responses;
create policy responses_update_own_while_open on responses
  for update
  to authenticated
  using (
    user_id = (select auth.uid())
    and (select current_role_type()) is not null
    and cycle_is_open(cycle_id)
  )
  with check (
    user_id = (select auth.uid())
    and (select current_role_type()) is not null
    and cycle_is_open(cycle_id)
  );

drop policy if exists responses_delete_own_while_open on responses;
create policy responses_delete_own_while_open on responses
  for delete
  to authenticated
  using (
    user_id = (select auth.uid())
    and (select current_role_type()) is not null
    and cycle_is_open(cycle_id)
  );

drop policy if exists answers_read_own on answers;
create policy answers_read_own on answers
  for select
  to authenticated
  using (
    exists (
      select 1 from responses r
      where r.id = answers.response_id
        and (
          (r.user_id = (select auth.uid()) and (select current_role_type()) is not null)
          or (select is_admin())
        )
    )
  );

drop policy if exists answers_insert_own on answers;
create policy answers_insert_own on answers
  for insert
  to authenticated
  with check (
    (select current_role_type()) is not null
    and exists (
      select 1 from responses r
      where r.id = response_id
        and r.user_id = (select auth.uid())
        and cycle_is_open(r.cycle_id)
    )
  );

drop policy if exists answers_update_own_while_open on answers;
create policy answers_update_own_while_open on answers
  for update
  to authenticated
  using (
    (select current_role_type()) is not null
    and exists (
      select 1 from responses r
      where r.id = answers.response_id
        and r.user_id = (select auth.uid())
        and cycle_is_open(r.cycle_id)
    )
  )
  with check (
    (select current_role_type()) is not null
    and exists (
      select 1 from responses r
      where r.id = response_id
        and r.user_id = (select auth.uid())
        and cycle_is_open(r.cycle_id)
    )
  );

drop policy if exists answers_delete_own_while_open on answers;
create policy answers_delete_own_while_open on answers
  for delete
  to authenticated
  using (
    (select current_role_type()) is not null
    and exists (
      select 1 from responses r
      where r.id = answers.response_id
        and r.user_id = (select auth.uid())
        and cycle_is_open(r.cycle_id)
    )
  );

-- ---------- 6. keep the privilege lock intact ----------
-- profiles_update_own lets a user edit their own row; a trigger stops them
-- touching role or status, because a policy on profiles that subqueries
-- profiles raises "infinite recursion detected in policy for relation
-- profiles". removed_at needs the same lock, otherwise a removed user could
-- clear their own removal and walk back in.
--
-- must_change_password is also locked. The auth.users password-change trigger
-- above is the only non-admin path that clears it.
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
revoke execute on function is_privileged_writer()
  from public, anon, authenticated;

notify pgrst, 'reload schema';
