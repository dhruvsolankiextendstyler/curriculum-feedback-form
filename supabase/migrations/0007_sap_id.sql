-- =============================================================
-- 0007_sap_id.sql — sign in with an email address OR a SAP ID
--
-- FR-1 used to read "users log in with email + password". The college already
-- issues everyone a SAP ID and people know that number better than the address
-- the college assigned them, so from now on either identifier works with the
-- same password. It is OPTIONAL: an account without a SAP ID signs in by email
-- exactly as before.
--
-- WHY THERE IS NO LOOKUP FUNCTION HERE
-- Supabase Auth knows nothing about SAP IDs — `auth.users` is keyed by email —
-- so signing in with one is a lookup (SAP ID -> email) followed by an ordinary
-- password grant. That lookup deliberately gets NO anon-callable RPC. An
-- `email_for_sap_id()` exposed to the Data API would let anyone holding the
-- public anon key (it ships in the browser bundle) walk a range of SAP IDs and
-- harvest the email address of every student in the college, which is exactly
-- the disclosure NFR-4 exists to prevent. The lookup runs inside the `sign-in`
-- Edge Function under service_role instead, and that function returns a session
-- or a deliberately uninformative failure — never the address.
--
-- Run after 0006.
-- =============================================================

-- ---------- 1. the column ----------
alter table profiles
  add column if not exists sap_id text;

comment on column profiles.sap_id is
  'Optional institutional ID, usable in place of the email address at sign-in (FR-1). Stored trimmed and upper-cased so "ab12" and "AB12" cannot become two people. Admin-managed: the privilege guard below rejects self-edits.';

-- ---------- 2. one canonical form ----------
-- Normalising in a trigger rather than in the client is what makes the unique
-- index below genuinely case-insensitive: every write path — the admin panel,
-- the provisioning function, a psql session — lands on the same value.
create or replace function normalise_profile_sap_id()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.sap_id := nullif(upper(trim(new.sap_id)), '');
  return new;
end;
$$;

drop trigger if exists profiles_normalise_sap_id on profiles;
create trigger profiles_normalise_sap_id
  before insert or update on profiles
  for each row execute function normalise_profile_sap_id();

-- A trigger function is an internal detail, not a Data API RPC.
revoke execute on function normalise_profile_sap_id() from public, anon, authenticated;

-- ---------- 3. shape ----------
-- The '@' exclusion is load-bearing rather than cosmetic. The login screen has
-- ONE field for both kinds of identifier and tells them apart by the '@'; a SAP
-- ID containing one would be indistinguishable from an email address. The
-- lower-case range is redundant while the trigger above is in place, and is
-- kept so the constraint still means what it says if that ever changes.
alter table profiles
  drop constraint if exists profiles_sap_id_format;

alter table profiles
  add constraint profiles_sap_id_format check (
    sap_id is null or sap_id ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{2,31}$'
  );

-- ---------- 4. uniqueness ----------
-- "unique for everyone", but only for the people who have one: Postgres treats
-- NULLs as distinct, so a plain unique index still allows any number of
-- accounts with no SAP ID. It also serves the sign-in lookup's equality probe.
create unique index if not exists profiles_sap_id_unique on profiles (sap_id);

-- ---------- 5. only an administrator may set it ----------
-- Same reasoning as role and status: a respondent who could write their own
-- sap_id could claim a colleague's number, or free one up to be re-used.
--
-- The comparison re-applies the normalisation instead of trusting new.sap_id as
-- submitted. BEFORE triggers fire in alphabetical order, so this guard runs
-- before profiles_normalise_sap_id; without it, re-submitting an unchanged
-- value in different case would read as an attempted change.
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

-- ---------- 6. carry it through account creation ----------
-- The admin panel creates the Auth account and the profile row in one step, so
-- the SAP ID travels in the new user's metadata and is written by the same
-- trigger that writes the role. A duplicate therefore fails the whole account
-- creation rather than half-creating one; the provisioning function checks for
-- a clash first so an admin sees a sentence instead of a constraint name.
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

  insert into profiles (id, email, full_name, sap_id, role, must_change_password)
  values (
    new.id,
    new.email,
    nullif(new.raw_user_meta_data ->> 'full_name', ''),
    nullif(new.raw_user_meta_data ->> 'sap_id', ''),
    meta_role::user_role,
    true
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

revoke execute on function handle_new_auth_user() from public, anon, authenticated;

notify pgrst, 'reload schema';
