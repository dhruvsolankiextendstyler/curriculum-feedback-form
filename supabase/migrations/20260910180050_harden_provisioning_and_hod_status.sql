-- Trust only server-controlled app metadata when provisioning profile privileges.
-- The invite-users Edge Function stamps this marker with service_role. Public
-- signups (even if the hosted signup switch is accidentally reopened) receive no
-- trusted profile, so client-supplied user_metadata cannot mint a role.
create or replace function handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  trusted_marker constant text := 'invite-users-v1';
  provisioning_marker text := nullif(new.raw_app_meta_data ->> 'provisioned_by', '');
  trusted_role text := nullif(new.raw_app_meta_data ->> 'role', '');
  trusted_dept text := nullif(new.raw_app_meta_data ->> 'department_id', '');
begin
  if provisioning_marker is distinct from trusted_marker
     or trusted_role is null
     or trusted_role not in (
       'admin', 'hod', 'academic_peer', 'student', 'employer', 'alumni', 'faculty'
     ) then
    return new;
  end if;

  insert into profiles (
    id, email, full_name, sap_id, role, department_id, must_change_password
  )
  values (
    new.id,
    new.email,
    nullif(new.raw_user_meta_data ->> 'full_name', ''),
    nullif(new.raw_user_meta_data ->> 'sap_id', ''),
    trusted_role::user_role,
    case
      when trusted_dept ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      then trusted_dept::uuid
    end,
    true
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

revoke all on function handle_new_auth_user() from public, anon, authenticated;

-- HODs may edit respondent identity fields in their own department, but account
-- activation is a global-admin action just like removal/restoration.
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
    if new.department_id is distinct from old.department_id then
      raise exception 'A head of department cannot move an account to another department.'
        using errcode = '42501';
    end if;
    if new.role in ('admin', 'hod') then
      raise exception 'Only an administrator can appoint an administrator or a head of department.'
        using errcode = '42501';
    end if;
    if new.status is distinct from old.status then
      raise exception 'Only an administrator can change account status.'
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

revoke all on function guard_profile_privilege_columns() from public, anon, authenticated;

notify pgrst, 'reload schema';
