-- =============================================================
-- 0009_privilege_guard.sql — make the profile privilege guard actually guard
--
-- THE BUG
-- is_privileged_writer() (0002_rls.sql) decided "is this caller trusted?" partly
-- with `current_user in ('postgres', 'supabase_admin', 'service_role')`. It is
-- itself SECURITY DEFINER and owned by postgres — and inside a SECURITY DEFINER
-- function `current_user` is the function's OWNER, not the caller. So that test
-- was always true, the function always returned true, and every guard clause it
-- protects was a no-op:
--
--   role                 FR-5   a respondent could make themselves an admin
--   status                      a deactivated account could reactivate itself
--   sap_id               FR-1   a respondent could claim someone else's number
--   removed_at/_by       FR-21  a removed account could restore itself
--   must_change_password        the first-sign-in gate could be cleared directly
--   department_id        FR-46  a respondent could re-file their own feedback
--
-- Verified against this database before the fix: a student, signed in as
-- `authenticated` with only their own JWT, ran
-- `update profiles set role = 'admin' where id = auth.uid()` and it succeeded.
-- The trigger fired and waved it through.
--
-- THE FIX
-- Ask a question SECURITY DEFINER does not rewrite. PostgREST issues
-- `SET LOCAL ROLE` per request, and that GUC is still readable from inside a
-- definer function — measured on this project: `current_user` reads `postgres`
-- there while `role` still reads `authenticated`.
--
-- `anon` and `authenticated` are exactly the two roles reachable with the
-- published anon key or an end-user JWT, so they are the two that have to prove
-- themselves. Everything else already requires database credentials: a migration,
-- psql, the dashboard editor, the Auth service's own connection (which is what
-- clears must_change_password on first sign-in), or the service_role key behind
-- the Edge Functions.
--
-- The old `request.jwt.claim.role` check goes too. It is the pre-2022 spelling and
-- reads NULL on this project — Supabase publishes the verified JWT as the JSON
-- `request.jwt.claims`. It was dead code hiding behind the broken check above.
--
-- Run after 0008. Nothing else changes; the guard bodies are already correct.
-- =============================================================

create or replace function is_privileged_writer()
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  -- The `role` GUC PostgREST sets for the request. `none` is its default, which
  -- is what a direct connection that never issued SET ROLE reports.
  request_role text := nullif(current_setting('role', true), 'none');
begin
  -- The only callers that can arrive holding nothing but a public key or an
  -- end-user token. They are privileged if, and only if, they are an admin.
  if request_role in ('anon', 'authenticated') then
    return is_admin();
  end if;

  -- Anything else holds database credentials already: service_role, the Auth
  -- service, a migration, psql, the dashboard SQL editor.
  return true;
end;
$$;

comment on function is_privileged_writer() is
  'True for signed-in admins and for connections that already hold database credentials (service_role, Auth, psql, migrations). Reads the request role from the `role` GUC rather than current_user, which SECURITY DEFINER rewrites to this function''s owner — see 0009 header.';

revoke execute on function is_privileged_writer()
  from public, anon, authenticated;

notify pgrst, 'reload schema';
