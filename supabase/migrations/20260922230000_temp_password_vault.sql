-- =============================================================
-- 20260922230000_temp_password_vault.sql — re-viewable temporary passwords
--
-- The temporary password an admin issues (invite-users) appears once at
-- creation and is then gone: only its bcrypt hash lives in auth.users. This
-- keeps the plaintext so an admin — or the head of the account's own
-- department — can read it back WHILE the account still carries it, and drops
-- it the instant the user replaces it with their own.
--
-- It is deliberately NOT a column on profiles: profiles_read_own lets a user
-- read their own row, which would hand every user their own "secret" temporary
-- password. A separate table with its own RLS keeps reads to staff only.
--
-- Written only by the invite-users edge function (service_role, bypasses RLS).
-- No client ever inserts, updates or deletes here.
-- =============================================================

create table if not exists user_temp_passwords (
  user_id uuid primary key references profiles (id) on delete cascade,
  temp_password text not null,
  created_at timestamptz not null default now()
);

comment on table user_temp_passwords is
  'Plaintext admin-issued temporary passwords, readable only by an admin or the owning department''s HOD, and deleted the moment the user sets their own password. Written by the invite-users edge function under service_role.';

alter table user_temp_passwords enable row level security;

-- Reads only, and only for staff: an admin sees every row; an HOD sees only the
-- accounts in the department they head (hod_department() is NULL for everyone
-- else, so the exists() matches nothing). The owner is deliberately excluded —
-- they never see their own temporary password here.
drop policy if exists temp_passwords_read_staff on user_temp_passwords;
create policy temp_passwords_read_staff on user_temp_passwords
  for select
  to authenticated
  using (
    (select is_admin())
    or exists (
      select 1 from profiles p
      where p.id = user_temp_passwords.user_id
        and p.department_id = (select hod_department())
    )
  );

-- Extend the first-sign-in trigger: when the user changes their password we
-- already clear must_change_password; now also purge the stored temporary
-- password, so "nobody can see it after the user sets their own" is enforced by
-- the database, not the UI. (Re-created whole from 0006 so the predicate is
-- visible in one place.)
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
    delete from user_temp_passwords where user_id = new.id;
  end if;
  return new;
end;
$$;

revoke execute on function handle_auth_user_password_changed()
  from public, anon, authenticated;

notify pgrst, 'reload schema';
