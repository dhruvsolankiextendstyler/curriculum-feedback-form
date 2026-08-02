-- =============================================================
-- 0004_auth_sync.sql — keep public.profiles in step with auth.users
--
-- Creating a user through the Auth API (admin invite, bulk import) does not
-- create our profile row. Without this trigger every new account signs in
-- successfully and then lands on "account not set up".
-- =============================================================

create or replace function handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  meta_role text := nullif(new.raw_user_meta_data ->> 'role', '');
begin
  -- FR-2: role is assigned by an admin at invite time and travels in the
  -- invite's user metadata. If it is absent or not a valid role we deliberately
  -- create NO profile: the user is then blocked at the route guard rather than
  -- silently defaulting into a stakeholder group and skewing that group's data.
  if meta_role is null or meta_role not in (
    'admin', 'academic_peer', 'student', 'employer', 'alumni', 'faculty'
  ) then
    return new;
  end if;

  insert into profiles (id, email, full_name, role, invite_status)
  values (
    new.id,
    new.email,
    nullif(new.raw_user_meta_data ->> 'full_name', ''),
    meta_role::user_role,
    'sent'
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_auth_user();

-- Once the user actually signs in, mark the invite accepted (FR-24 status).
create or replace function handle_auth_user_signed_in()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.last_sign_in_at is distinct from old.last_sign_in_at
     and new.last_sign_in_at is not null then
    update profiles
       set invite_status = 'accepted'
     where id = new.id
       and invite_status <> 'accepted';
  end if;
  return new;
end;
$$;

create trigger on_auth_user_signed_in
  after update on auth.users
  for each row execute function handle_auth_user_signed_in();

-- ---------- bootstrapping the first admin ----------
-- Chicken-and-egg: only an admin can register users, so the first admin must be
-- made by hand. Create the user in Dashboard → Authentication → Add user, then
-- run (replacing the address):
--
--   insert into public.profiles (id, email, full_name, role, status, invite_status)
--   select id, email, 'Your Name', 'admin', 'active', 'accepted'
--   from auth.users
--   where email = 'you@college.edu'
--   on conflict (id) do update
--     set role = 'admin', status = 'active';
